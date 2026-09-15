use soroban_sdk::{contracttype, Address, Symbol, Val, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// SEP-41 token that job owners deposit and keepers are paid in.
    pub fee_token: Address,
    /// SEP-41 token keepers stake. May be the same as `fee_token`.
    pub stake_token: Address,
    pub min_stake: i128,
    /// Seconds between `begin_unbonding` and `withdraw_stake`.
    pub unbonding_period: u64,
    pub paused: bool,
}

/// Input to `create_job`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct JobParams {
    /// Contract to call.
    pub target: Address,
    /// Function to call on `target`.
    pub function: Symbol,
    /// Arguments passed to `function`.
    pub args: Vec<Val>,
    /// Minimum seconds between runs.
    pub interval: u64,
    /// Unix timestamp of the first eligible run. `0` (or any past time) means now.
    pub start_at: u64,
    /// Fee-token amount paid to the keeper for each run.
    pub fee_per_run: i128,
    /// Maximum number of runs. `0` means unlimited.
    pub max_runs: u32,
    /// Optional contract exposing `should_run(job_id: u64) -> bool`.
    pub resolver: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: u64,
    pub owner: Address,
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub interval: u64,
    /// Earliest timestamp at which the job may run next.
    pub next_run: u64,
    pub fee_per_run: i128,
    /// Remaining escrowed fee-token balance.
    pub balance: i128,
    pub max_runs: u32,
    pub runs: u32,
    pub resolver: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Keeper {
    pub stake: i128,
    /// Set once unbonding starts: timestamp when stake becomes withdrawable.
    pub unbonding_at: Option<u64>,
    pub executions: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    NextJobId,
    Job(u64),
    Keeper(Address),
}
