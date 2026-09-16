#![no_std]
//! # SoroCron TTL Guardian
//!
//! Stellar archives contract data whose TTL (time-to-live, in ledgers) runs
//! out. An archived contract stops working until someone restores it.
//! Extending TTL is permissionless, but somebody has to remember to do it.
//!
//! The guardian turns that chore into a SoroCron job: schedule
//! `extend(contract, threshold, extend_to)` and keepers keep the contract's
//! instance and code alive, paid from the job's deposit.
//!
//! Scope: a contract can extend another contract's **instance and code**
//! entries, not its persistent or temporary storage. Contracts that need
//! their persistent entries kept alive should expose their own
//! permissionless `extend_ttl` function and schedule that directly.

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, Address, Env, Vec};

/// Hard cap on how many contracts `extend_many` will process in one call.
pub const MAX_EXTEND_MANY: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `threshold` must not exceed `extend_to` (after capping to the network maximum).
    InvalidTtl = 1,
    /// `contracts` passed to `extend_many` is longer than `MAX_EXTEND_MANY`.
    TooManyContracts = 2,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TtlExtended {
    #[topic]
    pub contract: Address,
    pub threshold: u32,
    pub extend_to: u32,
}

#[contract]
pub struct TtlGuardian;

#[contractimpl]
impl TtlGuardian {
    /// If `contract`'s instance or code TTL is below `threshold` ledgers,
    /// extends it to `extend_to` ledgers. `extend_to` is capped at the
    /// network's maximum TTL. Returns the `extend_to` that was applied.
    pub fn extend(
        env: Env,
        contract: Address,
        threshold: u32,
        extend_to: u32,
    ) -> Result<u32, Error> {
        extend_one(&env, contract, threshold, extend_to)
    }

    /// Like `extend`, but for several contracts in one call. Every contract
    /// gets the same `threshold`/`extend_to`. Bounded to `MAX_EXTEND_MANY`
    /// contracts so one job can't grow unboundedly expensive.
    /// Returns the `extend_to` applied to each, in the same order.
    pub fn extend_many(
        env: Env,
        contracts: Vec<Address>,
        threshold: u32,
        extend_to: u32,
    ) -> Result<Vec<u32>, Error> {
        if contracts.len() > MAX_EXTEND_MANY {
            return Err(Error::TooManyContracts);
        }
        let mut applied = Vec::new(&env);
        for contract in contracts.iter() {
            applied.push_back(extend_one(&env, contract, threshold, extend_to)?);
        }
        Ok(applied)
    }
}

fn extend_one(env: &Env, contract: Address, threshold: u32, extend_to: u32) -> Result<u32, Error> {
    let extend_to = extend_to.min(env.storage().max_ttl());
    if threshold > extend_to {
        return Err(Error::InvalidTtl);
    }
    env.deployer()
        .extend_ttl(contract.clone(), threshold, extend_to);

    TtlExtended {
        contract,
        threshold,
        extend_to,
    }
    .publish(env);
    Ok(extend_to)
}

#[cfg(test)]
mod test {
    use super::{Error, TtlGuardian, TtlGuardianClient};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Deployer as _, Ledger},
        Address, Env,
    };

    #[contract]
    pub struct Dummy;

    #[contractimpl]
    impl Dummy {
        pub fn ping(_env: Env) -> u32 {
            1
        }
    }

    fn setup() -> (Env, Address, TtlGuardianClient<'static>) {
        let env = Env::default();
        let dummy = env.register(Dummy, ());
        let guardian = TtlGuardianClient::new(&env, &env.register(TtlGuardian, ()));
        (env, dummy, guardian)
    }

    #[test]
    fn extends_instance_ttl_below_threshold() {
        let (env, dummy, guardian) = setup();
        let before = env.deployer().get_contract_instance_ttl(&dummy);
        let target = before + 10_000;

        assert_eq!(guardian.extend(&dummy, &target, &target), target);
        assert_eq!(env.deployer().get_contract_instance_ttl(&dummy), target);
    }

    #[test]
    fn leaves_ttl_alone_above_threshold() {
        let (env, dummy, guardian) = setup();
        let before = env.deployer().get_contract_instance_ttl(&dummy);

        guardian.extend(&dummy, &(before / 2), &(before + 10_000));
        assert_eq!(env.deployer().get_contract_instance_ttl(&dummy), before);
    }

    #[test]
    fn caps_extension_at_network_maximum() {
        let (env, dummy, guardian) = setup();
        let max = env.storage().max_ttl();

        assert_eq!(guardian.extend(&dummy, &max, &u32::MAX), max);
        assert_eq!(env.deployer().get_contract_instance_ttl(&dummy), max);
    }

    #[test]
    fn extends_many_contracts_in_one_call() {
        let env = Env::default();
        let a = env.register(Dummy, ());
        let b = env.register(Dummy, ());
        let c = env.register(Dummy, ());
        let guardian = TtlGuardianClient::new(&env, &env.register(TtlGuardian, ()));

        let before = env.deployer().get_contract_instance_ttl(&a);
        let target = before + 10_000;
        let contracts = soroban_sdk::vec![&env, a.clone(), b.clone(), c.clone()];

        let applied = guardian.extend_many(&contracts, &target, &target);
        assert_eq!(applied, soroban_sdk::vec![&env, target, target, target]);
        assert_eq!(env.deployer().get_contract_instance_ttl(&a), target);
        assert_eq!(env.deployer().get_contract_instance_ttl(&b), target);
        assert_eq!(env.deployer().get_contract_instance_ttl(&c), target);
    }

    #[test]
    fn extend_many_rejects_too_many_contracts() {
        let env = Env::default();
        let guardian = TtlGuardianClient::new(&env, &env.register(TtlGuardian, ()));
        let dummy = env.register(Dummy, ());

        let mut contracts = soroban_sdk::Vec::new(&env);
        for _ in 0..=super::MAX_EXTEND_MANY {
            contracts.push_back(dummy.clone());
        }
        assert_eq!(
            guardian.try_extend_many(&contracts, &1_000, &1_000),
            Err(Ok(Error::TooManyContracts))
        );
    }

    #[test]
    fn rejects_threshold_above_extend_to() {
        let (_env, dummy, guardian) = setup();
        assert_eq!(
            guardian.try_extend(&dummy, &2_000, &1_000),
            Err(Ok(Error::InvalidTtl))
        );
    }

    #[test]
    fn keeps_contract_alive_past_original_expiry() {
        let (env, dummy, guardian) = setup();
        let ttl = env.deployer().get_contract_instance_ttl(&dummy);

        // Just before expiry, the guardian extends the contract.
        env.ledger().with_mut(|l| l.sequence_number += ttl - 1);
        guardian.extend(&dummy, &50_000, &50_000);

        // Well past the original expiry, the contract still works.
        env.ledger().with_mut(|l| l.sequence_number += ttl * 2);
        let client = DummyClient::new(&env, &dummy);
        assert_eq!(client.ping(), 1);
    }
}
