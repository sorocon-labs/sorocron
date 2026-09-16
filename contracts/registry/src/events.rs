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

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobExecuted {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub keeper: Address,
    pub fee: i128,
    pub run: u32,
    pub next_run: u64,
    /// sha256 of the XDR-serialized return value of the target call.
    /// Lets indexers verify a run's outcome without re-simulating it.
    pub result_hash: BytesN<32>,
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
