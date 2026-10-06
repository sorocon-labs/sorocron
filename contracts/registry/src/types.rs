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
    /// Seconds between `begin_unbonding` (or the end of its epoch) and `withdraw_stake`.
    pub unbonding_period: u64,
    pub paused: bool,
    /// Contract that performs target calls. Set once via `set_executor`.
    pub executor: Option<Address>,
    /// Minimum `interval` a job may schedule, in seconds. `0` means no minimum.
    pub min_interval: u64,
    /// Maximum length of a job's `args` vector. `0` means no maximum.
    pub max_args: u32,
    /// Share of every run's fee sent to `treasury`, in basis points.
    pub protocol_fee_bps: u32,
    pub treasury: Option<Address>,
    /// Consecutive target failures after which a job is paused. `0` never pauses.
    pub max_failures: u32,
    /// Seconds after `next_run` during which only the run's assigned keeper
    /// may execute. `0` disables assigned windows (first come, first served).
    pub grace_period: u64,
    /// Share of an assigned keeper's stake slashed when another keeper has to
    /// run its job after the window, in basis points.
    pub slash_bps: u32,
    /// Unbonding epoch length in seconds. Keepers that start unbonding in the
    /// same epoch can all withdraw at the same time. `0` disables epochs.
    pub unbonding_epoch: u64,
}

/// When a job runs. Calendar schedules are in UTC and never drift.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Schedule {
    /// Every `interval` seconds from the first run.
    Interval,
    /// Every day at `(hour, minute)`.
    Daily(u32, u32),
    /// Every week on `(weekday, hour, minute)`, with Monday as weekday `0`.
    Weekly(u32, u32, u32),
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
    /// Seconds between runs for `Schedule::Interval`; must be `0` otherwise.
    pub interval: u64,
    pub schedule: Schedule,
    /// Unix timestamp of the first eligible run. `0` (or any past time) means now.
    pub start_at: u64,
    /// Fee-token amount paid for each run.
    pub fee_per_run: i128,
    /// Highest fee a late run pays. `0` keeps the fee flat; otherwise it rises
    /// linearly from `fee_per_run` when the run is due to this after one interval.
    pub max_fee_per_run: i128,
    /// Maximum number of runs. `0` means unlimited.
    pub max_runs: u32,
    /// Unix timestamp after which the job can no longer run. `0` means never.
    pub end_at: u64,
    /// Optional contract exposing `should_run(job_id: u64) -> bool`.
    pub resolver: Option<Address>,
    /// Keepers allowed to run the job. `None` lets any staked keeper.
    pub keepers: Option<Vec<Address>>,
}

/// Input to `update_job`. Replaces every mutable setting of a job at once;
/// pass the current value for anything you don't want to change.
#[contracttype]
#[derive(Clone, Debug)]
pub struct JobUpdate {
    pub function: Symbol,
    pub args: Vec<Val>,
    /// `0` unless `schedule` is `Interval`. A new interval takes effect after the next run.
    pub interval: u64,
    /// Switching to a different calendar time reschedules the next run to it.
    pub schedule: Schedule,
    pub fee_per_run: i128,
    pub max_fee_per_run: i128,
    /// `0` means unlimited. Setting it at or below the current `runs` stops the job.
    pub max_runs: u32,
    /// `0` means never.
    pub end_at: u64,
    pub resolver: Option<Address>,
    pub keepers: Option<Vec<Address>>,
}

/// A job as returned by the views: its settings and its current state.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: u64,
    pub owner: Address,
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    /// Seconds between runs (a day or a week for calendar schedules).
    pub interval: u64,
    pub schedule: Schedule,
    /// Earliest timestamp at which the job may run next.
    pub next_run: u64,
    pub fee_per_run: i128,
    pub max_fee_per_run: i128,
    /// Remaining escrowed fee-token balance.
    pub balance: i128,
    pub max_runs: u32,
    pub runs: u32,
    /// Unix timestamp after which the job can no longer run. `0` means never.
    pub end_at: u64,
    pub resolver: Option<Address>,
    pub keepers: Option<Vec<Address>>,
    /// `false` while paused, by the owner or after `max_failures` failures.
    pub active: bool,
    /// Consecutive runs whose target call failed. Reset by a successful run.
    pub failures: u32,
}

/// A job's settings, which change only through `update_job`. Stored apart
/// from `JobState` so every run rewrites only the small state entry.
#[contracttype]
#[derive(Clone, Debug)]
pub struct JobSpec {
    pub owner: Address,
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub interval: u64,
    pub schedule: Schedule,
    pub fee_per_run: i128,
    pub max_fee_per_run: i128,
    pub max_runs: u32,
    pub end_at: u64,
    pub resolver: Option<Address>,
    pub keepers: Option<Vec<Address>>,
}

/// The part of a job that changes on every run.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobState {
    pub next_run: u64,
    pub balance: i128,
    pub runs: u32,
    pub failures: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Keeper {
    pub stake: i128,
    /// Set once unbonding starts: timestamp when stake becomes withdrawable.
    pub unbonding_at: Option<u64>,
    pub executions: u32,
    /// Sum over executions of how late each ran (`now - next_run`), in seconds.
    pub total_lateness: u64,
    /// Assigned runs this keeper missed, so another keeper ran them.
    pub missed: u32,
    /// Stake lost to slashing for missed runs.
    pub slashed: i128,
}

/// Reputation summary returned by `keeper_stats`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperStats {
    pub stake: i128,
    pub executions: u32,
    /// Average seconds between a run becoming due and this keeper running it.
    pub average_lateness: u64,
    pub missed: u32,
    pub slashed: i128,
    /// Whether the keeper can currently execute (staked enough, not unbonding).
    pub eligible: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    NextJobId,
    /// `JobSpec` of a job.
    Job(u64),
    Keeper(Address),
    PendingAdmin,
    OwnerJobs(Address),
    /// `JobState` of a job.
    JobState(u64),
    /// Keepers taking part in assigned windows, in staking order.
    ActiveKeepers,
    /// Present while the admin has halted every job calling this contract.
    HaltedTarget(Address),
}
