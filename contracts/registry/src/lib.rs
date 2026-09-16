#![no_std]
//! # SoroCron Registry
//!
//! Decentralized automation for Soroban. Job owners register calls to be
//! made on a schedule (and optionally only when a resolver contract agrees),
//! prepaying a per-run fee. Staked keepers watch for due jobs, execute them,
//! and collect the fee.
//!
//! Security model (see `docs/security.md`): the registry custodies funds but
//! never calls job targets itself. Target calls go through a separate
//! executor contract that holds nothing, so jobs can't borrow the registry's
//! authority.

mod errors;
mod events;
mod executor;
mod storage;
#[cfg(test)]
mod test;
mod types;

pub use errors::Error;
pub use types::{Config, Job, JobParams, Keeper};

use executor::ExecutorClient;
use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, vec, Address, Env, IntoVal, Symbol,
};

/// Function a resolver contract must expose: `should_run(job_id: u64) -> bool`.
pub const RESOLVER_FN: &str = "should_run";

#[contract]
pub struct SoroCron;

#[contractimpl]
impl SoroCron {
    /// Initializes the registry. Runs exactly once, at deploy time.
    /// The executor is connected afterwards with `set_executor`, because it
    /// needs the registry's address in its own constructor.
    pub fn __constructor(
        env: Env,
        admin: Address,
        fee_token: Address,
        stake_token: Address,
        min_stake: i128,
        unbonding_period: u64,
    ) {
        if min_stake < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        storage::set_config(
            &env,
            &Config {
                admin,
                fee_token,
                stake_token,
                min_stake,
                unbonding_period,
                paused: false,
                executor: None,
            },
        );
    }

    // ------------------------------------------------------------------
    // Jobs
    // ------------------------------------------------------------------

    /// Registers a new job and escrows `deposit` of the fee token.
    /// Returns the new job id.
    pub fn create_job(
        env: Env,
        owner: Address,
        params: JobParams,
        deposit: i128,
    ) -> Result<u64, Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        owner.require_auth();

        if params.interval == 0 {
            return Err(Error::InvalidInterval);
        }
        if params.fee_per_run <= 0 {
            return Err(Error::InvalidFee);
        }
        if deposit < params.fee_per_run {
            return Err(Error::InvalidAmount);
        }
        if is_forbidden_target(&env, &config, &params.target) {
            return Err(Error::ForbiddenTarget);
        }

        token::TokenClient::new(&env, &config.fee_token).transfer(
            &owner,
            env.current_contract_address(),
            &deposit,
        );

        let id = storage::take_next_job_id(&env);
        let now = env.ledger().timestamp();
        let job = Job {
            id,
            owner: owner.clone(),
            target: params.target,
            function: params.function,
            args: params.args,
            interval: params.interval,
            next_run: params.start_at.max(now),
            fee_per_run: params.fee_per_run,
            balance: deposit,
            max_runs: params.max_runs,
            runs: 0,
            resolver: params.resolver,
            active: true,
        };
        storage::set_job(&env, &job);

        events::JobCreated {
            job_id: id,
            owner,
            target: job.target,
            interval: job.interval,
            fee_per_run: job.fee_per_run,
            deposit,
        }
        .publish(&env);
        Ok(id)
    }

    /// Tops up a job's fee balance. Anyone may fund any job.
    pub fn fund_job(env: Env, from: Address, job_id: u64, amount: i128) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        from.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut job = storage::get_job(&env, job_id).ok_or(Error::JobNotFound)?;

        token::TokenClient::new(&env, &config.fee_token).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        job.balance += amount;
        storage::set_job(&env, &job);

        events::JobFunded {
            job_id,
            from,
            amount,
            balance: job.balance,
        }
        .publish(&env);
        Ok(job.balance)
    }

    /// Deletes a job and refunds its remaining balance to the owner.
    /// Always allowed, even while the registry is paused.
    pub fn cancel_job(env: Env, job_id: u64) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        let job = storage::get_job(&env, job_id).ok_or(Error::JobNotFound)?;
        job.owner.require_auth();

        storage::remove_job(&env, job_id);
        if job.balance > 0 {
            token::TokenClient::new(&env, &config.fee_token).transfer(
                &env.current_contract_address(),
                &job.owner,
                &job.balance,
            );
        }

        events::JobCancelled {
            job_id,
            refund: job.balance,
        }
        .publish(&env);
        Ok(job.balance)
    }

    /// Pauses (`active = false`) or resumes a job. A paused job keeps its
    /// balance and schedule but can't be executed; funding and cancelling
    /// still work. Owner only.
    pub fn set_job_active(env: Env, job_id: u64, active: bool) -> Result<(), Error> {
        let mut job = storage::get_job(&env, job_id).ok_or(Error::JobNotFound)?;
        job.owner.require_auth();

        job.active = active;
        storage::set_job(&env, &job);

        events::JobActiveSet { job_id, active }.publish(&env);
        Ok(())
    }

    /// Executes a due job: calls the target through the executor, advances
    /// the schedule and pays `fee_per_run` to the calling keeper.
    pub fn execute(env: Env, keeper: Address, job_id: u64) -> Result<(), Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        let executor = config.executor.clone().ok_or(Error::ExecutorNotSet)?;
        keeper.require_auth();

        let mut keeper_info = storage::get_keeper(&env, &keeper).ok_or(Error::KeeperNotFound)?;
        ensure_active_keeper(&config, &keeper_info)?;

        let mut job = storage::get_job(&env, job_id).ok_or(Error::JobNotFound)?;
        let now = env.ledger().timestamp();
        ensure_due(&job, now)?;
        if !resolver_allows(&env, &job) {
            return Err(Error::ResolverRejected);
        }

        // Effects before interactions. (Soroban also forbids re-entrancy.)
        job.runs += 1;
        job.balance -= job.fee_per_run;
        job.next_run = next_run_after(job.next_run, job.interval, now);
        storage::set_job(&env, &job);

        keeper_info.executions = keeper_info.executions.saturating_add(1);
        storage::set_keeper(&env, &keeper, &keeper_info);

        // Interactions.
        ExecutorClient::new(&env, &executor).execute(&job.target, &job.function, &job.args);
        token::TokenClient::new(&env, &config.fee_token).transfer(
            &env.current_contract_address(),
            &keeper,
            &job.fee_per_run,
        );

        events::JobExecuted {
            job_id,
            keeper,
            fee: job.fee_per_run,
            run: job.runs,
            next_run: job.next_run,
        }
        .publish(&env);
        Ok(())
    }

    // ------------------------------------------------------------------
    // Keepers
    // ------------------------------------------------------------------

    /// Stakes `amount` of the stake token. Registers the keeper on first call.
    pub fn stake(env: Env, keeper: Address, amount: i128) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        keeper.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut info = storage::get_keeper(&env, &keeper).unwrap_or(Keeper {
            stake: 0,
            unbonding_at: None,
            executions: 0,
        });
        if info.unbonding_at.is_some() {
            return Err(Error::KeeperUnbonding);
        }

        token::TokenClient::new(&env, &config.stake_token).transfer(
            &keeper,
            env.current_contract_address(),
            &amount,
        );
        info.stake += amount;
        storage::set_keeper(&env, &keeper, &info);

        events::KeeperStaked {
            keeper,
            amount,
            total: info.stake,
        }
        .publish(&env);
        Ok(info.stake)
    }

    /// Starts the unbonding period. The keeper stops being eligible to
    /// execute immediately. Returns the timestamp when stake is withdrawable.
    pub fn begin_unbonding(env: Env, keeper: Address) -> Result<u64, Error> {
        let config = storage::load_config(&env);
        keeper.require_auth();

        let mut info = storage::get_keeper(&env, &keeper).ok_or(Error::KeeperNotFound)?;
        if info.unbonding_at.is_some() {
            return Err(Error::KeeperUnbonding);
        }
        let withdrawable_at = env
            .ledger()
            .timestamp()
            .saturating_add(config.unbonding_period);
        info.unbonding_at = Some(withdrawable_at);
        storage::set_keeper(&env, &keeper, &info);

        events::KeeperUnbonding {
            keeper,
            withdrawable_at,
        }
        .publish(&env);
        Ok(withdrawable_at)
    }

    /// Withdraws the full stake once unbonding has finished.
    /// Always allowed, even while the registry is paused.
    pub fn withdraw_stake(env: Env, keeper: Address) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        keeper.require_auth();

        let info = storage::get_keeper(&env, &keeper).ok_or(Error::KeeperNotFound)?;
        let withdrawable_at = info.unbonding_at.ok_or(Error::UnbondingNotStarted)?;
        if env.ledger().timestamp() < withdrawable_at {
            return Err(Error::UnbondingNotFinished);
        }

        storage::remove_keeper(&env, &keeper);
        token::TokenClient::new(&env, &config.stake_token).transfer(
            &env.current_contract_address(),
            &keeper,
            &info.stake,
        );

        events::KeeperWithdrawn {
            keeper,
            amount: info.stake,
        }
        .publish(&env);
        Ok(info.stake)
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// Connects the executor contract. Can only be done once, so users can
    /// verify which executor their jobs will run through.
    pub fn set_executor(env: Env, executor: Address) -> Result<(), Error> {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        if config.executor.is_some() {
            return Err(Error::ExecutorAlreadySet);
        }
        config.executor = Some(executor.clone());
        storage::set_config(&env, &config);
        events::ExecutorSet { executor }.publish(&env);
        Ok(())
    }

    /// Starts an admin handover. The proposed admin must call `accept_admin`
    /// to take over. Proposing again replaces the pending proposal.
    pub fn propose_admin(env: Env, new_admin: Address) {
        let config = storage::load_config(&env);
        config.admin.require_auth();
        storage::set_pending_admin(&env, &new_admin);
        events::AdminProposed {
            current: config.admin,
            proposed: new_admin,
        }
        .publish(&env);
    }

    /// Completes an admin handover. Must be signed by the proposed admin,
    /// which proves the new key is controlled before the old one lets go.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let mut config = storage::load_config(&env);
        let pending = storage::get_pending_admin(&env).ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();

        storage::remove_pending_admin(&env);
        let previous = core::mem::replace(&mut config.admin, pending.clone());
        storage::set_config(&env, &config);

        events::AdminChanged {
            previous,
            new_admin: pending,
        }
        .publish(&env);
        Ok(())
    }

    /// Admin proposed with `propose_admin` that hasn't accepted yet.
    pub fn pending_admin(env: Env) -> Option<Address> {
        storage::get_pending_admin(&env)
    }

    /// Withdraws a pending admin proposal. Current admin only.
    pub fn cancel_admin_proposal(env: Env) -> Result<(), Error> {
        let config = storage::load_config(&env);
        config.admin.require_auth();

        let pending = storage::get_pending_admin(&env).ok_or(Error::NoPendingAdmin)?;
        storage::remove_pending_admin(&env);

        events::AdminProposalCancelled {
            current: config.admin,
            cancelled: pending,
        }
        .publish(&env);
        Ok(())
    }

    /// Emergency switch. While paused, no jobs run and no new funds enter;
    /// cancellations and stake withdrawals keep working.
    pub fn set_paused(env: Env, paused: bool) {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        config.paused = paused;
        storage::set_config(&env, &config);
        events::PausedSet { paused }.publish(&env);
    }

    pub fn set_min_stake(env: Env, min_stake: i128) -> Result<(), Error> {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        if min_stake < 0 {
            return Err(Error::InvalidAmount);
        }
        config.min_stake = min_stake;
        storage::set_config(&env, &config);
        events::MinStakeSet { min_stake }.publish(&env);
        Ok(())
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn config(env: Env) -> Config {
        storage::load_config(&env)
    }

    pub fn get_job(env: Env, job_id: u64) -> Option<Job> {
        storage::get_job(&env, job_id)
    }

    pub fn get_keeper(env: Env, keeper: Address) -> Option<Keeper> {
        storage::get_keeper(&env, &keeper)
    }

    /// Number of job ids ever issued. Ids run from `0` to `job_count - 1`;
    /// cancelled ids are not reused.
    pub fn job_count(env: Env) -> u64 {
        storage::next_job_id(&env)
    }

    /// Whether `execute` would currently succeed for this job
    /// (ignoring keeper eligibility).
    pub fn is_due(env: Env, job_id: u64) -> bool {
        let config = storage::load_config(&env);
        if config.paused || config.executor.is_none() {
            return false;
        }
        match storage::get_job(&env, job_id) {
            Some(job) => {
                ensure_due(&job, env.ledger().timestamp()).is_ok() && resolver_allows(&env, &job)
            }
            None => false,
        }
    }
}

/// Jobs may not target SoroCron's own contracts or the tokens it custodies.
/// The executor split already stops targets from using the registry's
/// authority; this is defence in depth.
fn is_forbidden_target(env: &Env, config: &Config, target: &Address) -> bool {
    *target == env.current_contract_address()
        || config.executor.as_ref() == Some(target)
        || *target == config.fee_token
        || *target == config.stake_token
}

fn ensure_not_paused(config: &Config) -> Result<(), Error> {
    if config.paused {
        Err(Error::Paused)
    } else {
        Ok(())
    }
}

fn ensure_active_keeper(config: &Config, keeper: &Keeper) -> Result<(), Error> {
    if keeper.unbonding_at.is_some() {
        return Err(Error::KeeperUnbonding);
    }
    if keeper.stake < config.min_stake {
        return Err(Error::InsufficientStake);
    }
    Ok(())
}

fn ensure_due(job: &Job, now: u64) -> Result<(), Error> {
    if !job.active {
        return Err(Error::JobPaused);
    }
    if job.max_runs != 0 && job.runs >= job.max_runs {
        return Err(Error::MaxRunsReached);
    }
    if job.balance < job.fee_per_run {
        return Err(Error::InsufficientJobBalance);
    }
    if now < job.next_run {
        return Err(Error::JobNotDue);
    }
    Ok(())
}

/// A job without a resolver always passes. A resolver that panics or returns
/// anything other than `true` blocks execution.
fn resolver_allows(env: &Env, job: &Job) -> bool {
    match &job.resolver {
        None => true,
        Some(resolver) => {
            let res = env.try_invoke_contract::<bool, soroban_sdk::Error>(
                resolver,
                &Symbol::new(env, RESOLVER_FN),
                vec![env, job.id.into_val(env)],
            );
            matches!(res, Ok(Ok(true)))
        }
    }
}

/// Next scheduled time. Keeps the original cadence, but if keepers were
/// offline for several intervals it skips the missed runs instead of
/// letting them fire back-to-back.
fn next_run_after(scheduled: u64, interval: u64, now: u64) -> u64 {
    let next = scheduled.saturating_add(interval);
    if next <= now {
        now.saturating_add(interval)
    } else {
        next
    }
}
