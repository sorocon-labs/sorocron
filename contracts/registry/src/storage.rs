//! Storage helpers. Every read or write of long-lived data extends its TTL,
//! so active jobs and keepers are never archived.

use soroban_sdk::{Address, Env, Vec};

use crate::types::{Config, DataKey, Job, Keeper};

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

pub fn get_job(env: &Env, id: u64) -> Option<Job> {
    let key = DataKey::Job(id);
    let job = env.storage().persistent().get(&key);
    if job.is_some() {
        extend_persistent(env, &key);
    }
    job
}

pub fn set_job(env: &Env, job: &Job) {
    let key = DataKey::Job(job.id);
    env.storage().persistent().set(&key, job);
    extend_persistent(env, &key);
}

pub fn remove_job(env: &Env, id: u64) {
    env.storage().persistent().remove(&DataKey::Job(id));
}

pub fn get_keeper(env: &Env, keeper: &Address) -> Option<Keeper> {
    let key = DataKey::Keeper(keeper.clone());
    let info = env.storage().persistent().get(&key);
    if info.is_some() {
        extend_persistent(env, &key);
    }
    info
}

pub fn set_keeper(env: &Env, keeper: &Address, info: &Keeper) {
    let key = DataKey::Keeper(keeper.clone());
    env.storage().persistent().set(&key, info);
    extend_persistent(env, &key);
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

pub fn remove_keeper(env: &Env, keeper: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Keeper(keeper.clone()));
}

pub fn owner_jobs(env: &Env, owner: &Address) -> Vec<u64> {
    let key = DataKey::OwnerJobs(owner.clone());
    let ids = env.storage().persistent().get(&key);
    if ids.is_some() {
        extend_persistent(env, &key);
    }
    ids.unwrap_or_else(|| Vec::new(env))
}

pub fn add_owner_job(env: &Env, owner: &Address, job_id: u64) {
    let key = DataKey::OwnerJobs(owner.clone());
    let mut ids = owner_jobs(env, owner);
    ids.push_back(job_id);
    env.storage().persistent().set(&key, &ids);
    extend_persistent(env, &key);
}

pub fn remove_owner_job(env: &Env, owner: &Address, job_id: u64) {
    let key = DataKey::OwnerJobs(owner.clone());
    let mut ids = owner_jobs(env, owner);
    if let Some(index) = ids.iter().position(|id| id == job_id) {
        ids.remove(index as u32);
        env.storage().persistent().set(&key, &ids);
        extend_persistent(env, &key);
    }
}
