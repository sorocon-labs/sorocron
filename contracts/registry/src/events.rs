//! Events emitted by the registry. Indexers and keeper bots rely on these,
//! so treat field changes as breaking.

use soroban_sdk::{contractevent, Address, BytesN};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobCreated {
    #[topic]
    pub job_id: u64,
    pub owner: Address,
    pub target: Address,
    pub interval: u64,
    pub fee_per_run: i128,
    pub deposit: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobFunded {
    #[topic]
    pub job_id: u64,
    pub from: Address,
    pub amount: i128,
    pub balance: i128,
}

/// Receipt for every run, successful or not.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobExecuted {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub keeper: Address,
    /// Whether the target call succeeded. A failed run is still charged:
    /// the keeper did the work and the schedule advances.
    pub success: bool,
    /// Total fee charged to the job for this run.
    pub fee: i128,
    /// Part of `fee` sent to the treasury; the keeper received the rest.
    pub protocol_fee: i128,
    pub run: u32,
    pub next_run: u64,
    /// Seconds between the run becoming due and this execution.
    pub lateness: u64,
    /// Consecutive failures after this run (`0` after a success).
    pub failures: u32,
    /// sha256 of the XDR-serialized return value (or error) of the target
    /// call. Lets indexers verify a run's outcome without re-simulating it.
    pub result_hash: BytesN<32>,
}

/// A job paused itself after `max_failures` consecutive failed runs.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobDeactivated {
    #[topic]
    pub job_id: u64,
    pub failures: u32,
}

/// An assigned keeper missed its window and another keeper ran the job.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperSlashed {
    #[topic]
    pub keeper: Address,
    pub job_id: u64,
    pub amount: i128,
    /// Stake left after slashing.
    pub remaining: i128,
    /// Keeper that ran the job and received the slashed amount.
    pub beneficiary: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobExhausted {
    #[topic]
    pub job_id: u64,
    pub balance: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobCancelled {
    #[topic]
    pub job_id: u64,
    pub refund: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobWithdrawn {
    #[topic]
    pub job_id: u64,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobActiveSet {
    #[topic]
    pub job_id: u64,
    pub active: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperStaked {
    #[topic]
    pub keeper: Address,
    pub amount: i128,
    pub total: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperUnbonding {
    #[topic]
    pub keeper: Address,
    pub withdrawable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperWithdrawn {
    #[topic]
    pub keeper: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    pub current: Address,
    pub proposed: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposalCancelled {
    pub current: Address,
    pub cancelled: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub previous: Address,
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutorSet {
    pub executor: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedSet {
    pub paused: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MinStakeSet {
    pub min_stake: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MinIntervalSet {
    pub min_interval: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxArgsSet {
    pub max_args: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobUpdated {
    #[topic]
    pub job_id: u64,
    pub interval: u64,
    pub fee_per_run: i128,
    pub max_runs: u32,
    pub end_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    pub wasm_hash: BytesN<32>,
    pub previous_version: u32,
}

/// An upgrade announced with `propose_upgrade`; it can't be applied before
/// `available_at`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposed {
    pub wasm_hash: BytesN<32>,
    pub available_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeCancelled {
    pub wasm_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeDelaySet {
    pub upgrade_delay: u64,
}

/// A job handover started with `propose_job_owner`. `proposed` equal to
/// `owner` means the pending proposal was withdrawn.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobOwnerProposed {
    #[topic]
    pub job_id: u64,
    pub owner: Address,
    pub proposed: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobOwnerChanged {
    #[topic]
    pub job_id: u64,
    pub previous: Address,
    pub new_owner: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetHaltSet {
    #[topic]
    pub target: Address,
    pub halted: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolFeeSet {
    pub protocol_fee_bps: u32,
    pub treasury: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxFailuresSet {
    pub max_failures: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperWindowsSet {
    pub grace_period: u64,
    pub slash_bps: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnbondingEpochSet {
    pub unbonding_epoch: u64,
}
