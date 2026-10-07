//! The registry calls the keeper makes: two reads (`job_count`, `is_due`)
//! answered by simulation, and `execute`, which is simulated, assembled,
//! signed and sent.

use stellar_rpc_client::{Client, SimulateTransactionResponse};
use stellar_xdr::{ScVal, Transaction, TransactionEnvelope, TransactionV1Envelope, VecM};

use crate::config::{address, Config};
use crate::tx::{self, Error};

/// Registry error names by code (contracts/registry/src/errors.rs).
const ERRORS: [&str; 32] = [
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

pub enum Outcome {
    /// Sent and applied; the transaction hash.
    Executed(String),
    /// Dry run: simulation said it would succeed.
    Simulated,
    /// The registry refused (not due, someone else ran it, ...).
    Skipped(String),
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

    /// Runs a job: simulate, assemble, sign, send and wait for the result.
    pub async fn execute(&self, job_id: u64) -> Result<Outcome, Error> {
        let args = vec![tx::account_address(&self.config.keeper), ScVal::U64(job_id)];
        let (unsigned, sim, _) = match self.simulate("execute", args).await? {
            Ok(simulated) => simulated,
            Err(reason) => return Ok(Outcome::Skipped(reason)),
        };
        if self.config.dry_run {
            return Ok(Outcome::Simulated);
        }
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
        Ok(Outcome::Executed(hash))
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
    fn error_table_matches_the_contract() {
        // Codes are stable: 11 is KeeperNotFound, 23 TargetFailed, 27 NotAssignedKeeper.
        assert_eq!(ERRORS[10], "KeeperNotFound");
        assert_eq!(ERRORS[22], "TargetFailed");
        assert_eq!(ERRORS[26], "NotAssignedKeeper");
    }
}
