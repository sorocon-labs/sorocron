#![no_std]
//! # Self-extending storage
//!
//! Stellar archives any ledger entry whose TTL runs out. The TTL Guardian can
//! keep another contract's *instance and code* alive, but only the contract
//! that owns a *persistent* entry can extend it. This example shows the
//! pattern for that case: the contract exposes a permissionless
//! `extend_ttl()` that bumps every entry it owns, and a SoroCron job calls it
//! on a schedule.
//!
//! ```text
//! target:   <this contract>
//! function: extend_ttl
//! args:     []
//! interval: 86400 (daily)
//! ```
//!
//! When to use which: schedule the TTL Guardian when you only need a
//! contract's code and instance to survive (most contracts with instance
//! storage). Add a self-extending function like this one when the contract
//! keeps data in persistent storage that must never be archived.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
/// Entries are topped up to 30 days whenever they drop below 20.
pub const EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
pub const THRESHOLD: u32 = 20 * DAY_IN_LEDGERS;
/// Bound on stored keys, so `extend_ttl` stays within one transaction's limits.
pub const MAX_KEYS: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    TooManyKeys = 1,
}

#[contracttype]
enum Key {
    Admin,
    /// Every key ever stored, so `extend_ttl` knows what to bump.
    Index,
    Entry(Symbol),
}

#[contract]
pub struct SelfExtending;

#[contractimpl]
impl SelfExtending {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage()
            .instance()
            .set(&Key::Index, &Vec::<Symbol>::new(&env));
    }

    /// Stores `value` under `key` in persistent storage. Admin only.
    pub fn put(env: Env, key: Symbol, value: Bytes) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();

        let mut index: Vec<Symbol> = env.storage().instance().get(&Key::Index).unwrap();
        if !index.contains(&key) {
            if index.len() >= MAX_KEYS {
                return Err(Error::TooManyKeys);
            }
            index.push_back(key.clone());
            env.storage().instance().set(&Key::Index, &index);
        }
        let entry = Key::Entry(key);
        env.storage().persistent().set(&entry, &value);
        env.storage()
            .persistent()
            .extend_ttl(&entry, THRESHOLD, EXTEND_TO);
        Ok(())
    }

    pub fn get(env: Env, key: Symbol) -> Option<Bytes> {
        env.storage().persistent().get(&Key::Entry(key))
    }

    /// Extends the instance, code and every stored entry to `EXTEND_TO`
    /// ledgers if they are below `THRESHOLD`. Permissionless, so a keeper
    /// can call it. Returns how many entries were checked.
    pub fn extend_ttl(env: Env) -> u32 {
        env.storage().instance().extend_ttl(THRESHOLD, EXTEND_TO);
        let index: Vec<Symbol> = env.storage().instance().get(&Key::Index).unwrap();
        for key in index.iter() {
            let entry = Key::Entry(key);
            if env.storage().persistent().has(&entry) {
                env.storage()
                    .persistent()
                    .extend_ttl(&entry, THRESHOLD, EXTEND_TO);
            }
        }
        index.len()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Ledger},
        vec,
    };
    use sorocron_testkit::Harness;

    const DAY: u64 = 86_400;

    fn setup(h: &Harness) -> SelfExtendingClient<'static> {
        let client =
            SelfExtendingClient::new(&h.env, &h.env.register(SelfExtending, (h.admin.clone(),)));
        client.put(
            &Symbol::new(&h.env, "config"),
            &Bytes::from_array(&h.env, &[1, 2, 3]),
        );
        client
    }

    /// Ledgers left before the entry expires. Panics once it has expired.
    fn entry_ttl(h: &Harness, store: &SelfExtendingClient, key: &str) -> u32 {
        h.env.as_contract(&store.address, || {
            h.env
                .storage()
                .persistent()
                .get_ttl(&Key::Entry(Symbol::new(&h.env, key)))
        })
    }

    /// Advances a day of wall-clock time and ledgers.
    fn next_day(h: &Harness) {
        h.env.ledger().with_mut(|l| {
            l.timestamp += DAY;
            l.sequence_number += DAY_IN_LEDGERS;
        });
    }

    #[test]
    fn scheduled_job_keeps_persistent_data_alive() {
        let h = Harness::new();
        let store = setup(&h);
        let job = h.schedule(&store.address, "extend_ttl", vec![&h.env], DAY);

        // 45 days: well past the entry's original 30-day TTL.
        for _ in 0..45 {
            h.run(job);
            next_day(&h);
        }
        assert!(entry_ttl(&h, &store, "config") >= THRESHOLD);
        assert_eq!(
            store.get(&Symbol::new(&h.env, "config")),
            Some(Bytes::from_array(&h.env, &[1, 2, 3]))
        );
        assert_eq!(h.job(job).runs, 45);
    }

    /// The control for the test above: same timeline, no job. The entry's
    /// TTL runs out, so it is archived. Reading it afterwards restores it
    /// with only the network's minimum TTL (on a live network, at the cost
    /// of a restore fee paid by whoever touches it next), far below what
    /// the scheduled job maintains.
    #[test]
    fn without_the_job_the_data_lapses() {
        let h = Harness::new();
        let store = setup(&h);
        let live_until = h.env.ledger().sequence() + entry_ttl(&h, &store, "config");
        for _ in 0..45 {
            next_day(&h);
        }
        assert!(
            h.env.ledger().sequence() > live_until,
            "entry outlived its TTL"
        );
        assert!(entry_ttl(&h, &store, "config") < THRESHOLD);
    }

    #[test]
    fn key_count_is_bounded() {
        let h = Harness::new();
        let store = setup(&h);
        for i in 1..MAX_KEYS {
            let key = Symbol::new(&h.env, &["k", &i.to_string()].concat());
            store.put(&key, &Bytes::new(&h.env));
        }
        assert_eq!(
            store.try_put(&Symbol::new(&h.env, "overflow"), &Bytes::new(&h.env)),
            Err(Ok(Error::TooManyKeys))
        );
        // Overwriting an existing key is still fine.
        store.put(&Symbol::new(&h.env, "config"), &Bytes::new(&h.env));
        assert_eq!(store.extend_ttl(), MAX_KEYS);
    }

    extern crate std;
    use std::string::ToString;
}
