#![no_std]
//! # Price resolver (Reflector)
//!
//! Lets a SoroCron job run only while an asset's price is above or below a
//! threshold, read from a [Reflector](https://reflector.network) oracle. Use
//! it as a job's `resolver` to build stop-losses, take-profits, liquidation
//! triggers or "buy the dip" jobs without changing the target contract.
//!
//! ```text
//! resolver: <price-resolver>
//! target:   <your contract>, function: <what to do when the condition holds>
//! ```
//!
//! The threshold is in the oracle's own units (Reflector reports prices with
//! `decimals()` decimal places, 14 on mainnet). Prices older than `max_age`
//! seconds are treated as unknown, so a stalled oracle never triggers a job.

use soroban_sdk::{contract, contractclient, contractimpl, contracttype, Address, Env, Symbol};

/// Reflector's asset identifier.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// Reflector's price record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// The part of Reflector's SEP-40 interface this resolver uses.
#[allow(dead_code)]
#[contractclient(name = "ReflectorClient")]
pub trait Reflector {
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
    fn decimals(env: Env) -> u32;
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    /// Run while `price >= threshold`.
    Above,
    /// Run while `price <= threshold`.
    Below,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Condition {
    pub oracle: Address,
    pub asset: Asset,
    /// In the oracle's units (see `decimals()` on the oracle).
    pub threshold: i128,
    pub direction: Direction,
    /// Ignore prices older than this many seconds.
    pub max_age: u64,
}

#[contracttype]
enum Key {
    Admin,
    Condition,
}

#[contract]
pub struct PriceResolver;

#[contractimpl]
impl PriceResolver {
    pub fn __constructor(env: Env, admin: Address, condition: Condition) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::Condition, &condition);
    }

    /// Replaces the condition. Admin only.
    pub fn set_condition(env: Env, condition: Condition) {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&Key::Condition, &condition);
    }

    pub fn condition(env: Env) -> Condition {
        env.storage().instance().get(&Key::Condition).unwrap()
    }

    /// The oracle's latest price if it is fresh, otherwise `None`.
    pub fn price(env: Env) -> Option<i128> {
        let c = Self::condition(env.clone());
        fresh_price(&env, &c)
    }

    /// SoroCron resolver: `true` while the condition holds. A missing,
    /// stale or failing oracle answers `false`.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let c = Self::condition(env.clone());
        match fresh_price(&env, &c) {
            Some(price) => match c.direction {
                Direction::Above => price >= c.threshold,
                Direction::Below => price <= c.threshold,
            },
            None => false,
        }
    }
}

fn fresh_price(env: &Env, c: &Condition) -> Option<i128> {
    env.storage().instance().extend_ttl(17_280, 7 * 17_280);
    let data = ReflectorClient::new(env, &c.oracle)
        .try_lastprice(&c.asset)
        .ok()?
        .ok()??;
    let age = env.ledger().timestamp().saturating_sub(data.timestamp);
    (age <= c.max_age).then_some(data.price)
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{symbol_short, testutils::Address as _, vec, Address};
    use sorocron_testkit::Harness;

    /// Reflector stand-in: returns whatever price was last set.
    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn set(env: Env, price: i128, timestamp: u64) {
            env.storage()
                .instance()
                .set(&symbol_short!("p"), &PriceData { price, timestamp });
        }
        pub fn lastprice(env: Env, _asset: Asset) -> Option<PriceData> {
            env.storage().instance().get(&symbol_short!("p"))
        }
        pub fn decimals(_env: Env) -> u32 {
            14
        }
    }

    const ONE: i128 = 100_000_000_000_000; // 1.0 with 14 decimals

    fn setup(
        h: &Harness,
        direction: Direction,
    ) -> (MockOracleClient<'static>, PriceResolverClient<'static>) {
        let oracle = MockOracleClient::new(&h.env, &h.env.register(MockOracle, ()));
        let condition = Condition {
            oracle: oracle.address.clone(),
            asset: Asset::Other(Symbol::new(&h.env, "XLM")),
            threshold: ONE / 10, // 0.10
            direction,
            max_age: 600,
        };
        let resolver = PriceResolverClient::new(
            &h.env,
            &h.env
                .register(PriceResolver, (Address::generate(&h.env), condition)),
        );
        (oracle, resolver)
    }

    #[test]
    fn below_threshold_triggers_only_on_a_fresh_low_price() {
        let h = Harness::new();
        let (oracle, resolver) = setup(&h, Direction::Below);
        let now = h.env.ledger().timestamp();

        assert!(!resolver.should_run(&0), "no price yet");
        oracle.set(&(ONE / 8), &now); // 0.125
        assert!(!resolver.should_run(&0));
        oracle.set(&(ONE / 10), &now); // exactly 0.10
        assert!(resolver.should_run(&0));
        oracle.set(&(ONE / 20), &(now - 601)); // low but stale
        assert!(!resolver.should_run(&0));
        assert_eq!(resolver.price(), None);
    }

    #[test]
    fn above_threshold() {
        let h = Harness::new();
        let (oracle, resolver) = setup(&h, Direction::Above);
        let now = h.env.ledger().timestamp();
        oracle.set(&(ONE / 20), &now);
        assert!(!resolver.should_run(&0));
        oracle.set(&ONE, &now);
        assert!(resolver.should_run(&0));
        assert_eq!(resolver.price(), Some(ONE));
    }

    #[test]
    fn broken_oracle_never_triggers() {
        let h = Harness::new();
        let condition = Condition {
            oracle: h.probe().address, // not an oracle at all
            asset: Asset::Other(Symbol::new(&h.env, "XLM")),
            threshold: i128::MAX,
            direction: Direction::Below,
            max_age: 600,
        };
        let resolver = PriceResolverClient::new(
            &h.env,
            &h.env
                .register(PriceResolver, (Address::generate(&h.env), condition)),
        );
        assert!(!resolver.should_run(&0));
    }

    #[test]
    fn job_runs_through_the_registry_only_when_the_price_crosses() {
        let h = Harness::new();
        let (oracle, resolver) = setup(&h, Direction::Below);
        let target = h.probe();
        let mut params = h.params(&target.address, "hit", vec![&h.env], 60);
        params.resolver = Some(resolver.address.clone());
        let job = h.create(&params);

        oracle.set(&ONE, &h.env.ledger().timestamp());
        assert!(!h.is_due(job));

        oracle.set(&(ONE / 20), &h.env.ledger().timestamp());
        assert!(h.is_due(job));
        h.run(job);
        assert_eq!(target.hits(), 1);
    }
}
