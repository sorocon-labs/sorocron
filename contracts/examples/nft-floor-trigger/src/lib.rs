#![no_std]
//! # NFT floor price trigger
//!
//! NFT liquidity pools, auction liquidators and floor-sweeping strategies
//! need to act when a collection's floor drops below a target bid. This
//! resolver reads a floor-price index and answers `true` only while the
//! floor is strictly below the threshold and the index's data is fresh.
//!
//! The index can be any contract exposing
//! `floor_price(collection: Address) -> Option<FloorPrice>`, where the price
//! is in the units of the bidding token. Stale data (older than `max_age`)
//! never triggers, so a stalled index can't make a strategy sweep blind.
//!
//! ```text
//! target:   <your pool or bidder>, function: sweep_floor
//! resolver: <nft-floor-trigger>
//! interval: 300
//! ```

use soroban_sdk::{contract, contractclient, contractimpl, contracttype, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FloorPrice {
    pub price: i128,
    pub timestamp: u64,
}

#[allow(dead_code)]
#[contractclient(name = "FloorIndexClient")]
pub trait FloorIndex {
    fn floor_price(env: Env, collection: Address) -> Option<FloorPrice>;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Trigger {
    pub index: Address,
    pub collection: Address,
    /// Fire while the floor is strictly below this.
    pub threshold: i128,
    pub max_age: u64,
}

#[contracttype]
enum Key {
    Admin,
    Trigger,
}

#[contract]
pub struct NftFloorTrigger;

#[contractimpl]
impl NftFloorTrigger {
    pub fn __constructor(env: Env, admin: Address, trigger: Trigger) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::Trigger, &trigger);
    }

    /// Replaces the trigger, for example to move the threshold. Admin only.
    pub fn set_trigger(env: Env, trigger: Trigger) {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&Key::Trigger, &trigger);
    }

    pub fn trigger(env: Env) -> Trigger {
        env.storage().instance().get(&Key::Trigger).unwrap()
    }

    /// The fresh floor price, or `None` if missing, stale or unreadable.
    pub fn floor(env: Env) -> Option<i128> {
        let t = Self::trigger(env.clone());
        let data = FloorIndexClient::new(&env, &t.index)
            .try_floor_price(&t.collection)
            .ok()?
            .ok()??;
        let age = env.ledger().timestamp().saturating_sub(data.timestamp);
        (age <= t.max_age).then_some(data.price)
    }

    /// SoroCron resolver: `true` while the floor is below the threshold.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let threshold = Self::trigger(env.clone()).threshold;
        Self::floor(env).is_some_and(|p| p < threshold)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, symbol_short, testutils::Address as _, vec};
    use sorocron_testkit::Harness;

    #[contract]
    pub struct MockIndex;

    #[contractimpl]
    impl MockIndex {
        pub fn set(env: Env, price: i128, timestamp: u64) {
            env.storage()
                .instance()
                .set(&symbol_short!("f"), &FloorPrice { price, timestamp });
        }
        pub fn floor_price(env: Env, _collection: Address) -> Option<FloorPrice> {
            env.storage().instance().get(&symbol_short!("f"))
        }
    }

    const BID: i128 = 500 * 10_000_000; // 500 XLM

    fn setup(h: &Harness) -> (MockIndexClient<'static>, NftFloorTriggerClient<'static>) {
        let index = MockIndexClient::new(&h.env, &h.env.register(MockIndex, ()));
        let trigger = Trigger {
            index: index.address.clone(),
            collection: Address::generate(&h.env),
            threshold: BID,
            max_age: 900,
        };
        let t = NftFloorTriggerClient::new(
            &h.env,
            &h.env
                .register(NftFloorTrigger, (Address::generate(&h.env), trigger)),
        );
        (index, t)
    }

    #[test]
    fn fires_only_when_the_floor_drops_below_the_bid() {
        let h = Harness::new();
        let (index, t) = setup(&h);
        let now = h.env.ledger().timestamp();
        index.set(&(BID + 1), &now);
        assert!(!t.should_run(&0));
        index.set(&BID, &now);
        assert!(!t.should_run(&0), "at the bid is not below it");
        index.set(&(BID - 1), &now);
        assert!(t.should_run(&0));
    }

    #[test]
    fn stale_or_missing_data_never_fires() {
        let h = Harness::new();
        let (index, t) = setup(&h);
        assert!(!t.should_run(&0));
        index.set(&1, &(h.env.ledger().timestamp() - 901));
        assert!(!t.should_run(&0));
        assert_eq!(t.floor(), None);
    }

    #[test]
    fn sweep_job_runs_after_a_floor_drop() {
        let h = Harness::new();
        let (index, t) = setup(&h);
        let pool = h.probe();
        let mut p = h.params(&pool.address, "hit", vec![&h.env], 300);
        p.resolver = Some(t.address.clone());
        let job = h.create(&p);

        index.set(&(BID * 2), &h.env.ledger().timestamp());
        assert!(!h.is_due(job));
        index.set(&(BID / 2), &h.env.ledger().timestamp());
        h.run(job);
        assert_eq!(pool.hits(), 1);
    }
}
