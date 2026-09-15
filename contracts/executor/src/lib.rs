#![no_std]
//! # SoroCron Executor
//!
//! The only contract that calls job targets. It is deliberately tiny: it
//! stores the registry address, holds no funds, and has no privileges.
//!
//! Why it exists: inside a target contract, the direct invoker's
//! `require_auth()` succeeds automatically. If the registry called targets
//! itself, every job could act with the registry's authority, which is the
//! authority that custodies job deposits and keeper stakes. Routing calls
//! through this executor means targets only ever see an address that owns
//! nothing.

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Val, Vec};

const REGISTRY: Symbol = symbol_short!("REGISTRY");

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_EXTEND_TO - DAY_IN_LEDGERS;

#[contract]
pub struct Executor;

#[contractimpl]
impl Executor {
    pub fn __constructor(env: Env, registry: Address) {
        env.storage().instance().set(&REGISTRY, &registry);
    }

    /// Calls `target.function(args)` and returns its result.
    /// Only the registry may call this.
    pub fn execute(env: Env, target: Address, function: Symbol, args: Vec<Val>) -> Val {
        Self::registry(env.clone()).require_auth();
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND_TO);
        env.invoke_contract(&target, &function, args)
    }

    /// The registry this executor serves.
    pub fn registry(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&REGISTRY)
            .expect("registry is set in the constructor")
    }
}

#[cfg(test)]
mod test {
    use super::{Executor, ExecutorClient};
    use soroban_sdk::{
        contract, contractimpl, testutils::Address as _, vec, Address, Env, IntoVal, Symbol,
        TryFromVal, Val, Vec,
    };

    #[contract]
    pub struct Echo;

    #[contractimpl]
    impl Echo {
        pub fn echo(_env: Env, value: u32) -> u32 {
            value
        }
    }

    fn setup(env: &Env) -> (Address, ExecutorClient<'static>, Address) {
        let registry = Address::generate(env);
        let executor = ExecutorClient::new(env, &env.register(Executor, (registry.clone(),)));
        let echo = env.register(Echo, ());
        (registry, executor, echo)
    }

    #[test]
    fn stores_registry() {
        let env = Env::default();
        let (registry, executor, _) = setup(&env);
        assert_eq!(executor.registry(), registry);
    }

    #[test]
    fn forwards_call_and_returns_result() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, executor, echo) = setup(&env);

        let args: Vec<Val> = vec![&env, 7u32.into_val(&env)];
        let out = executor.execute(&echo, &Symbol::new(&env, "echo"), &args);
        assert_eq!(u32::try_from_val(&env, &out).unwrap(), 7);
    }

    #[test]
    #[should_panic]
    fn rejects_callers_other_than_registry() {
        let env = Env::default();
        let (_, executor, echo) = setup(&env);

        let args: Vec<Val> = vec![&env, 7u32.into_val(&env)];
        executor.execute(&echo, &Symbol::new(&env, "echo"), &args);
    }
}
