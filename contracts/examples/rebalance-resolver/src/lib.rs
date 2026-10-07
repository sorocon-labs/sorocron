#![no_std]
//! # Rebalance resolver
//!
//! Vaults that keep a pool position at a target ratio (delta-neutral
//! strategies, LP managers, flash-loan rebalancers) need a keeper to act
//! when the pool drifts. Use this as the rebalance job's resolver: it reads
//! the pool's reserves and answers `true` once the reserve ratio deviates
//! from the target by at least `threshold_bps`.
//!
//! The pool can be any contract exposing Soroswap's pair view
//! `get_reserves() -> (i128, i128)`. The ratio is `reserve0 / reserve1`,
//! scaled by `RATIO_SCALE`, so a 1:1 pool has ratio `RATIO_SCALE`.
//!
//! ```text
//! target:   <your vault>, function: rebalance
//! resolver: <rebalance-resolver>
//! interval: 60   (check every minute; runs only when drifted)
//! ```

use soroban_sdk::{contract, contractclient, contractimpl, contracttype, Address, Env};

pub const RATIO_SCALE: i128 = 10_000_000;

#[allow(dead_code)]
#[contractclient(name = "PairClient")]
pub trait Pair {
    fn get_reserves(env: Env) -> (i128, i128);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Target {
    pub pair: Address,
    /// Desired `reserve0 / reserve1`, scaled by `RATIO_SCALE`.
    pub ratio: i128,
    /// Deviation, in basis points of the target, that triggers a rebalance.
    pub threshold_bps: u32,
}

#[contracttype]
enum Key {
    Admin,
    Target,
}

#[contract]
pub struct RebalanceResolver;

#[contractimpl]
impl RebalanceResolver {
    pub fn __constructor(env: Env, admin: Address, target: Target) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::Target, &target);
    }

    /// Replaces the target. Admin only.
    pub fn set_target(env: Env, target: Target) {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&Key::Target, &target);
    }

    pub fn target(env: Env) -> Target {
        env.storage().instance().get(&Key::Target).unwrap()
    }

    /// Current deviation from the target ratio in basis points, or `None`
    /// if the pool can't be read or is empty.
    pub fn deviation_bps(env: Env) -> Option<i128> {
        let t = Self::target(env.clone());
        let (r0, r1) = PairClient::new(&env, &t.pair)
            .try_get_reserves()
            .ok()?
            .ok()?;
        if r0 <= 0 || r1 <= 0 || t.ratio <= 0 {
            return None;
        }
        let ratio = r0.checked_mul(RATIO_SCALE)? / r1;
        let diff = (ratio - t.ratio).abs();
        diff.checked_mul(10_000).map(|d| d / t.ratio)
    }

    /// SoroCron resolver: `true` once the pool has drifted past the threshold.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let threshold = Self::target(env.clone()).threshold_bps as i128;
        Self::deviation_bps(env).is_some_and(|d| d >= threshold)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, symbol_short, testutils::Address as _, vec};
    use sorocron_testkit::Harness;

    #[contract]
    pub struct MockPair;

    #[contractimpl]
    impl MockPair {
        pub fn set(env: Env, r0: i128, r1: i128) {
            env.storage().instance().set(&symbol_short!("r"), &(r0, r1));
        }
        pub fn get_reserves(env: Env) -> (i128, i128) {
            env.storage()
                .instance()
                .get(&symbol_short!("r"))
                .unwrap_or((0, 0))
        }
    }

    /// Target 1:1 with a 2% band.
    fn setup(h: &Harness) -> (MockPairClient<'static>, RebalanceResolverClient<'static>) {
        let pair = MockPairClient::new(&h.env, &h.env.register(MockPair, ()));
        let target = Target {
            pair: pair.address.clone(),
            ratio: RATIO_SCALE,
            threshold_bps: 200,
        };
        let r = RebalanceResolverClient::new(
            &h.env,
            &h.env
                .register(RebalanceResolver, (Address::generate(&h.env), target)),
        );
        (pair, r)
    }

    #[test]
    fn balanced_pool_does_not_trigger() {
        let h = Harness::new();
        let (pair, r) = setup(&h);
        pair.set(&1_000_000, &1_000_000);
        assert_eq!(r.deviation_bps(), Some(0));
        assert!(!r.should_run(&0));
        pair.set(&1_019_000, &1_000_000); // 1.9%: inside the band
        assert!(!r.should_run(&0));
    }

    #[test]
    fn drift_in_either_direction_triggers() {
        let h = Harness::new();
        let (pair, r) = setup(&h);
        pair.set(&1_020_000, &1_000_000); // +2.0%
        assert_eq!(r.deviation_bps(), Some(200));
        assert!(r.should_run(&0));
        pair.set(&1_000_000, &1_030_000); // ratio 0.9709: -2.9%
        assert!(r.should_run(&0));
    }

    #[test]
    fn empty_or_unreadable_pool_never_triggers() {
        let h = Harness::new();
        let (pair, r) = setup(&h);
        assert_eq!(r.deviation_bps(), None);
        assert!(!r.should_run(&0));
        pair.set(&0, &5);
        assert!(!r.should_run(&0));

        let broken = Target {
            pair: h.probe().address,
            ratio: RATIO_SCALE,
            threshold_bps: 1,
        };
        r.set_target(&broken);
        assert!(!r.should_run(&0));
    }

    #[test]
    fn rebalance_job_runs_only_when_drifted() {
        let h = Harness::new();
        let (pair, r) = setup(&h);
        let vault = h.probe();
        let mut p = h.params(&vault.address, "hit", vec![&h.env], 60);
        p.resolver = Some(r.address.clone());
        let job = h.create(&p);

        pair.set(&1_000_000, &1_000_000);
        assert!(!h.is_due(job));
        pair.set(&1_100_000, &1_000_000);
        h.run(job);
        assert_eq!(vault.hits(), 1);
    }
}
