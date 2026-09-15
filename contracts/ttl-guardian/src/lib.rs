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

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `threshold` must not exceed `extend_to` (after capping to the network maximum).
    InvalidTtl = 1,
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
        .publish(&env);
        Ok(extend_to)
    }
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
