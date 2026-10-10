//! The registry calls the keeper makes: reads answered by simulation
//! (`job_count`, `is_due`, `current_fee`, `config`) and `execute_batch`,
//! which is simulated, checked, assembled, signed and sent.

use sha2::{Digest, Sha256};
use stellar_rpc_client::{Client, SimulateTransactionResponse};
use stellar_xdr::{
    Asset, ContractIdPreimage, Hash, HashIdPreimage, HashIdPreimageContractId, Limits, ScAddress,
    ScVal, Transaction, TransactionEnvelope, TransactionV1Envelope, VecM, WriteXdr,
};

use crate::config::{address, Config};
use crate::tx::{self, Error};

/// Registry error names by code (contracts/registry/src/errors.rs).
const ERRORS: [&str; 35] = [
    "Paused",
    "JobNotFound",
    "InvalidInterval",
    "InvalidFee",
    "InvalidAmount",
    "ForbiddenTarget",
    "JobNotDue",
    "InsufficientJobBalance",
    "MaxRunsReached",
    "ResolverRejected",
    "KeeperNotFound",
    "InsufficientStake",
    "KeeperUnbonding",
    "UnbondingNotStarted",
    "UnbondingNotFinished",
    "ExecutorNotSet",
    "ExecutorAlreadySet",
    "NoPendingAdmin",
    "JobPaused",
    "JobExpired",
    "IntervalTooShort",
    "TooManyArgs",
    "TargetFailed",
    "InvalidBatchSize",
    "LengthMismatch",
    "KeeperNotAllowed",
    "NotAssignedKeeper",
    "TargetHalted",
    "InvalidCalendar",
    "InvalidSetting",
    "TooManyKeepers",
    "AwaitingDependency",
    "NoPendingUpgrade",
    "UpgradeNotReady",
    "NoPendingOwner",
];

/// Turns a simulation error into `Name (#code)` when it is a registry error.
pub fn describe_error(message: &str) -> String {
    let code = message
        .split("Error(Contract, #")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .and_then(|n| n.parse::<usize>().ok());
    match code {
        Some(c) if (1..=ERRORS.len()).contains(&c) => format!("{} (#{c})", ERRORS[c - 1]),
        Some(c) => format!("contract error #{c}"),
        None => message.lines().next().unwrap_or(message).to_owned(),
    }
}

/// What happened to one `execute_batch` attempt.
#[derive(Debug, PartialEq)]
pub enum BatchOutcome {
    /// Sent and applied: the jobs that ran, the fees they earned and the hash.
    Executed {
        ran: Vec<u64>,
        earned: i128,
        hash: String,
    },
    /// Dry run: the jobs simulation says would run.
    Simulated(Vec<u64>),
    /// Nothing in the batch would run, or simulation failed; the reason.
    Skipped(String),
    /// The runnable jobs earn less than the transaction costs.
    Unprofitable {
        ran: Vec<u64>,
        earned: i128,
        cost: i128,
    },
}

/// Splits due jobs into batches of at most `size` (the registry allows 20).
pub fn batches(ids: &[u64], size: usize) -> Vec<Vec<u64>> {
    ids.chunks(size.clamp(1, 20)).map(<[u64]>::to_vec).collect()
}

/// `execute_batch` returns, per job, whether it would run.
pub fn ran_flags(value: &ScVal, len: usize) -> Vec<bool> {
    let flags: Vec<bool> = match value {
        ScVal::Vec(Some(items)) => items
            .iter()
            .map(|v| matches!(v, ScVal::Bool(true)))
            .collect(),
        _ => vec![],
    };
    (0..len)
        .map(|i| flags.get(i).copied().unwrap_or(false))
        .collect()
}

/// A batch is worth sending when its fees, less the network cost, reach
/// `min_profit`. Only meaningful when fees are paid in XLM like the network fee.
pub fn profitable(earned: i128, cost: i128, min_profit: i128) -> bool {
    earned - cost >= min_profit
}

/// Contract id of the native XLM token on the network with this passphrase.
pub fn native_token_id(passphrase: &str) -> [u8; 32] {
    let preimage = HashIdPreimage::ContractId(HashIdPreimageContractId {
        network_id: Hash(tx::network_id(passphrase)),
        contract_id_preimage: ContractIdPreimage::Asset(Asset::Native),
    });
    let bytes = preimage
        .to_xdr(Limits::none())
        .expect("a fixed-size preimage encodes");
    Sha256::digest(bytes).into()
}

fn i128_of(value: &ScVal) -> Option<i128> {
    match value {
        ScVal::I128(parts) => Some(((parts.hi as i128) << 64) | parts.lo as i128),
        _ => None,
    }
}

pub struct Registry {
    rpc: Client,
    config: Config,
}

impl Registry {
    pub fn new(config: Config) -> Result<Self, Error> {
        Ok(Registry {
            rpc: Client::new(&config.rpc_url)?,
            config,
        })
    }

    pub fn keeper_address(&self) -> String {
        address(&self.config.keeper)
    }

    /// Next sequence number for the keeper's account, or 0 when it doesn't
    /// exist yet (fine for simulating reads).
    async fn next_sequence(&self) -> i64 {
        match self.rpc.get_account(&self.keeper_address()).await {
            Ok(account) => account.seq_num.0 + 1,
            Err(_) => 0,
        }
    }

    async fn simulate(
        &self,
        function: &str,
        args: Vec<ScVal>,
    ) -> Result<Result<(Transaction, SimulateTransactionResponse, ScVal), String>, Error> {
        let tx = tx::invoke(
            &self.config.keeper,
            self.next_sequence().await,
            self.config.registry,
            function,
            args,
            self.config.inclusion_fee,
        )?;
        let envelope = TransactionEnvelope::Tx(TransactionV1Envelope {
            tx: tx.clone(),
            signatures: VecM::default(),
        });
        let sim = self
            .rpc
            .simulate_transaction_envelope(&envelope, None)
            .await?;
        if let Some(error) = &sim.error {
            return Ok(Err(describe_error(error)));
        }
        let value = sim
            .results()?
            .into_iter()
            .next()
            .map(|r| r.xdr)
            .unwrap_or(ScVal::Void);
        Ok(Ok((tx, sim, value)))
    }

    pub async fn job_count(&self) -> Result<u64, Error> {
        match self.simulate("job_count", vec![]).await? {
            Ok((_, _, ScVal::U64(n))) => Ok(n),
            Ok((_, _, other)) => Err(format!("job_count returned {other:?}").into()),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn is_due(&self, job_id: u64) -> Result<bool, Error> {
        Ok(matches!(
            self.simulate("is_due", vec![ScVal::U64(job_id)]).await?,
            Ok((_, _, ScVal::Bool(true)))
        ))
    }

    /// The fee a run of `job_id` would pay now (0 when it can't be read).
    pub async fn current_fee(&self, job_id: u64) -> Result<i128, Error> {
        Ok(
            match self
                .simulate("current_fee", vec![ScVal::U64(job_id)])
                .await?
            {
                Ok((_, _, value)) => i128_of(&value).unwrap_or(0),
                Err(_) => 0,
            },
        )
    }

    /// Whether jobs pay keepers in native XLM, so fees and network cost compare.
    pub async fn fee_is_native(&self) -> Result<bool, Error> {
        let config = match self.simulate("config", vec![]).await? {
            Ok((_, _, value)) => value,
            Err(e) => return Err(e.into()),
        };
        let native = native_token_id(&self.config.passphrase);
        let ScVal::Map(Some(entries)) = config else {
            return Ok(false);
        };
        Ok(entries.iter().any(|e| {
            matches!(&e.key, ScVal::Symbol(s) if s.0.as_slice() == b"fee_token")
                && matches!(&e.val, ScVal::Address(ScAddress::Contract(id)) if id.0 .0 == native)
        }))
    }

    /// Runs every job in `job_ids` that may run now in one transaction, once
    /// simulation shows something runs and, when fees are in XLM, that the
    /// fees cover the cost by `min_profit` stroops.
    pub async fn execute_batch(
        &self,
        job_ids: &[u64],
        fee_is_native: bool,
    ) -> Result<BatchOutcome, Error> {
        let ids = ScVal::Vec(Some(
            job_ids
                .iter()
                .map(|id| ScVal::U64(*id))
                .collect::<Vec<_>>()
                .try_into()?,
        ));
        let args = vec![tx::account_address(&self.config.keeper), ids];
        let (unsigned, sim, value) = match self.simulate("execute_batch", args).await? {
            Ok(simulated) => simulated,
            Err(reason) => return Ok(BatchOutcome::Skipped(reason)),
        };
        let ran: Vec<u64> = job_ids
            .iter()
            .zip(ran_flags(&value, job_ids.len()))
            .filter_map(|(id, ran)| ran.then_some(*id))
            .collect();
        if ran.is_empty() {
            return Ok(BatchOutcome::Skipped("nothing would run".into()));
        }

        let mut earned = 0i128;
        for id in &ran {
            earned += self.current_fee(*id).await?;
        }
        let cost = sim.min_resource_fee as i128 + self.config.inclusion_fee as i128;
        if fee_is_native && !profitable(earned, cost, self.config.min_profit) {
            return Ok(BatchOutcome::Unprofitable { ran, earned, cost });
        }
        if self.config.dry_run {
            return Ok(BatchOutcome::Simulated(ran));
        }
        let hash = self.send(unsigned, sim).await?;
        Ok(BatchOutcome::Executed { ran, earned, hash })
    }

    /// Assembles a simulated call, signs it and waits for it to apply.
    async fn send(
        &self,
        unsigned: Transaction,
        sim: SimulateTransactionResponse,
    ) -> Result<String, Error> {
        let auth = sim
            .results()?
            .into_iter()
            .next()
            .map(|r| r.auth)
            .unwrap_or_default();
        let assembled = tx::assemble(
            unsigned,
            sim.transaction_data()?,
            auth,
            sim.min_resource_fee,
        )?;
        let envelope = tx::sign(assembled, &self.config.keeper, &self.config.passphrase)?;
        let hash = hex_hash(&envelope, &self.config.passphrase)?;
        let response = self.rpc.send_transaction_polling(&envelope).await?;
        if response.status != "SUCCESS" {
            return Err(format!(
                "transaction {hash} finished with status {}",
                response.status
            )
            .into());
        }
        Ok(hash)
    }
}

fn hex_hash(envelope: &TransactionEnvelope, passphrase: &str) -> Result<String, Error> {
    let hash = envelope.hash(tx::network_id(passphrase))?;
    Ok(hash.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_registry_errors() {
        assert_eq!(
            describe_error("HostError: Error(Contract, #7)\n..."),
            "JobNotDue (#7)"
        );
        assert_eq!(
            describe_error("Error(Contract, #32)"),
            "AwaitingDependency (#32)"
        );
        assert_eq!(describe_error("Error(Contract, #99)"), "contract error #99");
        assert_eq!(describe_error("network down\ndetails"), "network down");
    }

    #[test]
    fn splits_due_jobs_into_batches() {
        assert_eq!(
            batches(&[1, 2, 3, 4, 5], 2),
            vec![vec![1, 2], vec![3, 4], vec![5]]
        );
        assert_eq!(batches(&[1, 2, 3], 50), vec![vec![1, 2, 3]]);
        assert_eq!(batches(&(0..25).collect::<Vec<_>>(), 100).len(), 2);
        assert!(batches(&[], 10).is_empty());
    }

    #[test]
    fn reads_which_jobs_would_run() {
        let value = ScVal::Vec(Some(
            vec![ScVal::Bool(true), ScVal::Bool(false), ScVal::Bool(true)]
                .try_into()
                .unwrap(),
        ));
        assert_eq!(ran_flags(&value, 3), vec![true, false, true]);
        // A short or odd result never claims a job ran.
        assert_eq!(ran_flags(&value, 4), vec![true, false, true, false]);
        assert_eq!(ran_flags(&ScVal::Void, 2), vec![false, false]);
    }

    #[test]
    fn sends_only_batches_that_pay() {
        assert!(profitable(3_000_000, 2_200_000, 0));
        assert!(!profitable(2_000_000, 2_200_000, 0));
        assert!(!profitable(3_000_000, 2_200_000, 1_000_000));
    }

    #[test]
    fn knows_the_native_token() {
        let testnet = stellar_strkey::Contract(native_token_id(crate::config::TESTNET_PASSPHRASE));
        assert_eq!(
            testnet.to_string().as_str(),
            "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
        );
        let parts = stellar_xdr::Int128Parts {
            hi: 0,
            lo: 2_500_000,
        };
        assert_eq!(i128_of(&ScVal::I128(parts)), Some(2_500_000));
        assert_eq!(i128_of(&ScVal::Void), None);
    }

    #[test]
    fn error_table_matches_the_contract() {
        // Codes are stable: 11 is KeeperNotFound, 23 TargetFailed, 27 NotAssignedKeeper.
        assert_eq!(ERRORS[10], "KeeperNotFound");
        assert_eq!(ERRORS[22], "TargetFailed");
        assert_eq!(ERRORS[26], "NotAssignedKeeper");
    }
}
