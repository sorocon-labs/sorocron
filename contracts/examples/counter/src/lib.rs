#![no_std]
//! Minimal SoroCron job target.
//!
//! `increment` is permissionless: calling it at any time, from anyone, is
//! safe. That is the shape of function SoroCron is designed to automate
//! (think `release_vested`, `harvest`, `liquidate`, `rebalance`).

use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

const COUNT: Symbol = symbol_short!("COUNT");

#[contract]
pub struct Counter;

#[contractimpl]
impl Counter {
    /// Adds `by` to the counter and returns the new value.
    pub fn increment(env: Env, by: u32) -> u32 {
        let count = Self::count(env.clone()).saturating_add(by);
        env.storage().instance().set(&COUNT, &count);
        env.storage().instance().extend_ttl(100_000, 500_000);
        count
    }

    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&COUNT).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::{Counter, CounterClient};
    use soroban_sdk::Env;

    #[test]
    fn increments() {
        let env = Env::default();
        let client = CounterClient::new(&env, &env.register(Counter, ()));
        assert_eq!(client.count(), 0);
        assert_eq!(client.increment(&2), 2);
        assert_eq!(client.increment(&3), 5);
        assert_eq!(client.count(), 5);
    }
}
