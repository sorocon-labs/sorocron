#![no_std]
//! # SoroCron Oracle Trigger Resolver Example
//!
//! State-dependent conditional resolver for SoroCron.
//! Evaluates asset prices or collateral health factors against configured thresholds.
//! SoroCron only executes associated jobs (such as liquidations, rebalances, or stop-loss orders)
//! when `should_run` evaluates to true.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const CONFIG: Symbol = symbol_short!("CONFIG");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    Unauthorized = 1,
    InvalidPrice = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TriggerConfig {
    pub current_price: i128,
    pub threshold_price: i128,
    pub trigger_below: bool,
    pub active: bool,
}

#[contract]
pub struct OracleTriggerResolver;

#[contractimpl]
impl OracleTriggerResolver {
    /// Initializes the trigger resolver with admin authority and initial threshold.
    pub fn __constructor(
        env: Env,
        admin: Address,
        threshold_price: i128,
        trigger_below: bool,
    ) {
        if threshold_price <= 0 {
            panic!("threshold price must be positive");
        }

        let config = TriggerConfig {
            current_price: threshold_price,
            threshold_price,
            trigger_below,
            active: true,
        };

        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&CONFIG, &config);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Feeds a new price into the trigger resolver (simulating oracle update or relay).
    pub fn update_price(env: Env, price: i128) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("admin not set");
        admin.require_auth();

        if price <= 0 {
            panic!("price must be positive");
        }

        let mut config: TriggerConfig = env
            .storage()
            .instance()
            .get(&CONFIG)
            .expect("config not set");
        config.current_price = price;
        env.storage().instance().set(&CONFIG, &config);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Updates the threshold and trigger condition.
    pub fn set_threshold(env: Env, threshold_price: i128, trigger_below: bool) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("admin not set");
        admin.require_auth();

        if threshold_price <= 0 {
            panic!("threshold price must be positive");
        }

        let mut config: TriggerConfig = env
            .storage()
            .instance()
            .get(&CONFIG)
            .expect("config not set");
        config.threshold_price = threshold_price;
        config.trigger_below = trigger_below;
        env.storage().instance().set(&CONFIG, &config);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// SoroCron Resolver interface: called by SoroCron registry before executing a job.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let config: TriggerConfig = match env.storage().instance().get(&CONFIG) {
            Some(c) => c,
            None => return false,
        };

        if !config.active {
            return false;
        }

        if config.trigger_below {
            config.current_price <= config.threshold_price
        } else {
            config.current_price >= config.threshold_price
        }
    }

    /// Returns current configuration and price.
    pub fn get_config(env: Env) -> TriggerConfig {
        env.storage()
            .instance()
            .get(&CONFIG)
            .expect("config not set")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_oracle_trigger_below_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // Trigger when price <= 100 (e.g. liquidation condition)
        let contract_id =
            env.register(OracleTriggerResolver, (admin.clone(), 100i128, true));
        let client = OracleTriggerResolverClient::new(&env, &contract_id);

        // At 100, trigger_below is satisfied
        assert!(client.should_run(&1));

        // Price goes up to 150 (healthy) -> should not run
        client.update_price(&150);
        assert!(!client.should_run(&1));

        // Price drops to 90 -> should trigger
        client.update_price(&90);
        assert!(client.should_run(&1));
    }

    #[test]
    fn test_oracle_trigger_above_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // Trigger when price >= 200 (e.g. take-profit or rebalance)
        let contract_id =
            env.register(OracleTriggerResolver, (admin.clone(), 200i128, false));
        let client = OracleTriggerResolverClient::new(&env, &contract_id);

        client.update_price(&180);
        assert!(!client.should_run(&1));

        client.update_price(&220);
        assert!(client.should_run(&1));
    }
}
