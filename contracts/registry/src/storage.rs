//! Storage helpers. Every read or write of long-lived data extends its TTL,
//! so active jobs and keepers are never archived.
//!
//! A job is stored as two entries: its `JobSpec` (target, args and other
//! settings, written on create and update) and its `JobState` (schedule and
//! balance, written on every run). Runs rewrite only the small state entry,
//! which keeps execution fees low no matter how large the job's arguments are.

use soroban_sdk::{Address, Env, Vec};

use crate::types::{Config, DataKey, Job, JobSpec, JobState, Keeper, KeeperRecent, PendingUpgrade};

const DAY_IN_LEDGERS: u32 = 17_280;

const INSTANCE_EXTEND_TO: u32 = 7 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_EXTEND_TO - DAY_IN_LEDGERS;

const PERSISTENT_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_THRESHOLD: u32 = PERSISTENT_EXTEND_TO - DAY_IN_LEDGERS;

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND_TO);
}

fn extend_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_EXTEND_TO);
}

fn get_persistent<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
) -> Option<T> {
    let value = env.storage().persistent().get(key);
    if value.is_some() {
        extend_persistent(env, key);
    }
    value
}

fn set_persistent<T: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
    value: &T,
) {
    env.storage().persistent().set(key, value);
    extend_persistent(env, key);
}

// ---------------------------------------------------------------- config

pub fn load_config(env: &Env) -> Config {
    extend_instance(env);
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("config is set in the constructor")
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
    extend_instance(env);
}

pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn set_pending_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::PendingAdmin, admin);
}

pub fn remove_pending_admin(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingAdmin);
}

pub fn get_upgrade_delay(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::UpgradeDelay)
        .unwrap_or(0)
}

pub fn set_upgrade_delay(env: &Env, delay: u64) {
    env.storage().instance().set(&DataKey::UpgradeDelay, &delay);
}

pub fn get_pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().instance().get(&DataKey::PendingUpgrade)
}

pub fn set_pending_upgrade(env: &Env, upgrade: &PendingUpgrade) {
    env.storage()
        .instance()
        .set(&DataKey::PendingUpgrade, upgrade);
}

pub fn remove_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgrade);
}

// ---------------------------------------------------------------- jobs

pub fn next_job_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextJobId)
        .unwrap_or(0)
}

/// Returns the next free job id and reserves it.
pub fn take_next_job_id(env: &Env) -> u64 {
    let id = next_job_id(env);
    env.storage().instance().set(&DataKey::NextJobId, &(id + 1));
    id
}

pub fn get_spec(env: &Env, id: u64) -> Option<JobSpec> {
    get_persistent(env, &DataKey::Job(id))
}

pub fn set_spec(env: &Env, id: u64, spec: &JobSpec) {
    set_persistent(env, &DataKey::Job(id), spec);
}

pub fn get_state(env: &Env, id: u64) -> Option<JobState> {
    get_persistent(env, &DataKey::JobState(id))
}

pub fn set_state(env: &Env, id: u64, state: &JobState) {
    set_persistent(env, &DataKey::JobState(id), state);
}

/// Both halves of a job, or `None` if it doesn't exist.
pub fn get_job_parts(env: &Env, id: u64) -> Option<(JobSpec, JobState)> {
    let state = get_state(env, id)?;
    let spec = get_spec(env, id)?;
    Some((spec, state))
}

pub fn remove_job(env: &Env, id: u64) {
    env.storage().persistent().remove(&DataKey::Job(id));
    env.storage().persistent().remove(&DataKey::JobState(id));
    remove_pending_owner(env, id);
}

pub fn get_pending_owner(env: &Env, id: u64) -> Option<Address> {
    get_persistent(env, &DataKey::PendingJobOwner(id))
}

pub fn set_pending_owner(env: &Env, id: u64, owner: &Address) {
    set_persistent(env, &DataKey::PendingJobOwner(id), owner);
}

pub fn remove_pending_owner(env: &Env, id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingJobOwner(id));
}

/// The public view of a job, assembled from its two entries.
pub fn job_view(id: u64, spec: JobSpec, state: JobState) -> Job {
    Job {
        id,
        owner: spec.owner,
        target: spec.target,
        function: spec.function,
        args: spec.args,
        interval: spec.interval,
        schedule: spec.schedule,
        next_run: state.next_run,
        fee_per_run: spec.fee_per_run,
        max_fee_per_run: spec.max_fee_per_run,
        balance: state.balance,
        max_runs: spec.max_runs,
        runs: state.runs,
        end_at: spec.end_at,
        resolver: spec.resolver,
        keepers: spec.keepers,
        after: spec.after,
        active: state.active,
        failures: state.failures,
    }
}

pub fn get_job(env: &Env, id: u64) -> Option<Job> {
    get_job_parts(env, id).map(|(spec, state)| job_view(id, spec, state))
}

pub fn owner_jobs(env: &Env, owner: &Address) -> Vec<u64> {
    get_persistent(env, &DataKey::OwnerJobs(owner.clone())).unwrap_or_else(|| Vec::new(env))
}

pub fn add_owner_job(env: &Env, owner: &Address, job_id: u64) {
    let mut ids = owner_jobs(env, owner);
    ids.push_back(job_id);
    set_persistent(env, &DataKey::OwnerJobs(owner.clone()), &ids);
}

pub fn remove_owner_job(env: &Env, owner: &Address, job_id: u64) {
    let mut ids = owner_jobs(env, owner);
    if let Some(index) = ids.iter().position(|id| id == job_id) {
        ids.remove(index as u32);
        set_persistent(env, &DataKey::OwnerJobs(owner.clone()), &ids);
    }
}

// ---------------------------------------------------------------- keepers

pub fn get_keeper(env: &Env, keeper: &Address) -> Option<Keeper> {
    get_persistent(env, &DataKey::Keeper(keeper.clone()))
}

pub fn set_keeper(env: &Env, keeper: &Address, info: &Keeper) {
    set_persistent(env, &DataKey::Keeper(keeper.clone()), info);
}

pub fn remove_keeper(env: &Env, keeper: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Keeper(keeper.clone()));
    env.storage()
        .persistent()
        .remove(&DataKey::KeeperRecent(keeper.clone()));
}

pub fn get_keeper_recent(env: &Env, keeper: &Address) -> KeeperRecent {
    get_persistent(env, &DataKey::KeeperRecent(keeper.clone())).unwrap_or_default()
}

pub fn set_keeper_recent(env: &Env, keeper: &Address, recent: &KeeperRecent) {
    set_persistent(env, &DataKey::KeeperRecent(keeper.clone()), recent);
}

/// Keepers taking part in assigned windows, in the order they staked.
pub fn active_keepers(env: &Env) -> Vec<Address> {
    get_persistent(env, &DataKey::ActiveKeepers).unwrap_or_else(|| Vec::new(env))
}

/// Adds `keeper` to the window rotation if it isn't there and there is room.
pub fn add_active_keeper(env: &Env, keeper: &Address, max: u32) {
    let mut list = active_keepers(env);
    if !list.contains(keeper) && list.len() < max {
        list.push_back(keeper.clone());
        set_persistent(env, &DataKey::ActiveKeepers, &list);
    }
}

pub fn remove_active_keeper(env: &Env, keeper: &Address) {
    let mut list = active_keepers(env);
    if let Some(index) = list.first_index_of(keeper) {
        list.remove(index);
        set_persistent(env, &DataKey::ActiveKeepers, &list);
    }
}

// ---------------------------------------------------------------- targets

pub fn is_target_halted(env: &Env, target: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::HaltedTarget(target.clone()))
}

pub fn set_target_halted(env: &Env, target: &Address, halted: bool) {
    let key = DataKey::HaltedTarget(target.clone());
    if halted {
        set_persistent(env, &key, &true);
    } else {
        env.storage().persistent().remove(&key);
    }
}
