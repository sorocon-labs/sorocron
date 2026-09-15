#![no_std]
//! Minimal SoroCron resolver.
//!
//! A resolver is any contract exposing `should_run(job_id: u64) -> bool`.
//! The registry only executes a job whose resolver returns `true`. Real
//! resolvers read on-chain state (an oracle price, a health factor, a vault
//! balance); this one is a switch the admin flips, which makes it handy for
//! demos and integration tests.

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const ADMIN: Symbol = symbol_short!("ADMIN");
const READY: Symbol = symbol_short!("READY");

#[contract]
pub struct FlagResolver;

#[contractimpl]
impl FlagResolver {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&ADMIN, &admin);
    }

    pub fn set_ready(env: Env, ready: bool) {
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();
        env.storage().instance().set(&READY, &ready);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    pub fn should_run(env: Env, _job_id: u64) -> bool {
        env.storage().instance().get(&READY).unwrap_or(false)
    }
}

#[cfg(test)]
mod test {
    use super::{FlagResolver, FlagResolverClient};
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn toggles() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = FlagResolverClient::new(&env, &env.register(FlagResolver, (admin,)));

        assert!(!client.should_run(&0));
        client.set_ready(&true);
        assert!(client.should_run(&0));
        client.set_ready(&false);
        assert!(!client.should_run(&7));
    }

    #[test]
    #[should_panic]
    fn only_admin_can_toggle() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let client = FlagResolverClient::new(&env, &env.register(FlagResolver, (admin,)));
        client.set_ready(&true);
    }
}
