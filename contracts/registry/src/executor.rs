use soroban_sdk::{contractclient, Address, Env, Symbol, Val, Vec};

/// Interface of `contracts/executor`. Declared here rather than depending on
/// the executor crate so its functions aren't linked into the registry WASM.
#[allow(dead_code)]
#[contractclient(name = "ExecutorClient")]
pub trait ExecutorInterface {
    fn execute(env: Env, target: Address, function: Symbol, args: Vec<Val>) -> Val;
}
