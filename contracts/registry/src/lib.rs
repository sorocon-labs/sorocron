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
#[cfg(test)]
mod invariants;
#[cfg(test)]
mod proptests;
mod schedule;
mod storage;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_v4;
mod types;

pub use errors::Error;
pub use schedule::{first_calendar_run, next_run_after, ramped_fee, split_fee};
pub use types::{
    Config, Job, JobParams, JobSpec, JobState, JobUpdate, Keeper, KeeperStats, Schedule,
};

use executor::ExecutorClient;
use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, vec, xdr::ToXdr, Address, Bytes, BytesN,
    ContractExecutable, Env, IntoVal, Symbol, Vec,
};

/// Function a resolver contract must expose: `should_run(job_id: u64) -> bool`.
pub const RESOLVER_FN: &str = "should_run";

/// Hard cap on `limit` in `get_jobs`, regardless of what the caller passes.
pub const MAX_GET_JOBS_LIMIT: u32 = 50;

/// Maximum number of jobs in one `create_jobs` or `execute_batch` call, and
/// of keepers in one `withdraw_stakes` call.
pub const MAX_BATCH: u32 = 20;

/// Maximum length of a job's keeper allowlist.
pub const MAX_JOB_KEEPERS: u32 = 10;

/// Maximum number of keepers in the assigned-window rotation. Keepers that
/// stake once it is full can still execute any run after its window.
pub const MAX_ACTIVE_KEEPERS: u32 = 64;

/// Upper bound for `protocol_fee_bps` and `slash_bps` (10%).
pub const MAX_BPS: u32 = 1_000;

/// Consecutive failures before a job pauses itself, until the admin changes it.
pub const DEFAULT_MAX_FAILURES: u32 = 3;

/// Returned by `version()`. See its doc comment.
pub const VERSION: u32 = 4;

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
                min_interval: 0,
                max_args: 0,
                protocol_fee_bps: 0,
                treasury: None,
                max_failures: DEFAULT_MAX_FAILURES,
                grace_period: 0,
                slash_bps: 0,
                unbonding_epoch: 0,
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

        validate_job(&env, &config, &params, deposit)?;
        token::TokenClient::new(&env, &config.fee_token).transfer(
            &owner,
            env.current_contract_address(),
            &deposit,
        );
        Ok(insert_job(&env, &owner, params, deposit))
    }

    /// Registers several jobs for one owner with a single token transfer.
    /// `deposits[i]` funds `jobs[i]`. All-or-nothing: if any job is invalid,
    /// none are created. Returns the new ids in input order.
    pub fn create_jobs(
        env: Env,
        owner: Address,
        jobs: Vec<JobParams>,
        deposits: Vec<i128>,
    ) -> Result<Vec<u64>, Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        owner.require_auth();

        if jobs.is_empty() || jobs.len() > MAX_BATCH {
            return Err(Error::InvalidBatchSize);
        }
        if jobs.len() != deposits.len() {
            return Err(Error::LengthMismatch);
        }
        let mut total: i128 = 0;
        for (params, deposit) in jobs.iter().zip(deposits.iter()) {
            validate_job(&env, &config, &params, deposit)?;
            total = total.checked_add(deposit).ok_or(Error::InvalidAmount)?;
        }

        token::TokenClient::new(&env, &config.fee_token).transfer(
            &owner,
            env.current_contract_address(),
            &total,
        );
        let mut ids = Vec::new(&env);
        for (params, deposit) in jobs.iter().zip(deposits.iter()) {
            ids.push_back(insert_job(&env, &owner, params, deposit));
        }
        Ok(ids)
    }

    /// Changes a job's call, schedule, fees, limits, resolver and keeper
    /// allowlist. Owner only. The target can't change (cancel and recreate
    /// instead). `next_run` is kept unless the calendar changes, so a new
    /// interval takes effect after the next run.
    pub fn update_job(env: Env, job_id: u64, update: JobUpdate) -> Result<(), Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        let (mut spec, mut state) =
            storage::get_job_parts(&env, job_id).ok_or(Error::JobNotFound)?;
        spec.owner.require_auth();

        let interval = validate_schedule(
            &config,
            update.interval,
            &update.schedule,
            update.args.len(),
            update.fee_per_run,
            update.max_fee_per_run,
            &update.keepers,
        )?;

        if update.schedule != Schedule::Interval && update.schedule != spec.schedule {
            state.next_run = first_calendar_run(&update.schedule, env.ledger().timestamp());
        }
        spec.function = update.function;
        spec.args = update.args;
        spec.interval = interval;
        spec.schedule = update.schedule;
        spec.fee_per_run = update.fee_per_run;
        spec.max_fee_per_run = update.max_fee_per_run;
        spec.max_runs = update.max_runs;
        spec.end_at = update.end_at;
        spec.resolver = update.resolver;
        spec.keepers = update.keepers;
        storage::set_spec(&env, job_id, &spec);
        storage::set_state(&env, job_id, &state);

        events::JobUpdated {
            job_id,
            interval: spec.interval,
            fee_per_run: spec.fee_per_run,
            max_runs: spec.max_runs,
            end_at: spec.end_at,
        }
        .publish(&env);
        Ok(())
    }

    /// Tops up a job's fee balance. Anyone may fund any job.
    pub fn fund_job(env: Env, from: Address, job_id: u64, amount: i128) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        ensure_not_paused(&config)?;
        from.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut state = storage::get_state(&env, job_id).ok_or(Error::JobNotFound)?;

        token::TokenClient::new(&env, &config.fee_token).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        state.balance += amount;
        storage::set_state(&env, job_id, &state);

        events::JobFunded {
            job_id,
            from,
            amount,
            balance: state.balance,
        }
        .publish(&env);
        Ok(state.balance)
    }

    /// Deletes a job and refunds its remaining balance to the owner.
    /// Always allowed, even while the registry is paused.
    pub fn cancel_job(env: Env, job_id: u64) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        let (spec, state) = storage::get_job_parts(&env, job_id).ok_or(Error::JobNotFound)?;
        spec.owner.require_auth();

        storage::remove_job(&env, job_id);
        storage::remove_owner_job(&env, &spec.owner, job_id);
        if state.balance > 0 {
            token::TokenClient::new(&env, &config.fee_token).transfer(
                &env.current_contract_address(),
                &spec.owner,
                &state.balance,
            );
        }

        events::JobCancelled {
            job_id,
            refund: state.balance,
        }
        .publish(&env);
        Ok(state.balance)
    }

    /// Withdraws part of a job's fee balance back to the owner, without
    /// cancelling the job. Allowed while the registry is paused or the
    /// target is halted (it is an exit, like `cancel_job`).
    pub fn withdraw_job_balance(env: Env, job_id: u64, amount: i128) -> Result<i128, Error> {
        let config = storage::load_config(&env);
        let (spec, mut state) = storage::get_job_parts(&env, job_id).ok_or(Error::JobNotFound)?;
        spec.owner.require_auth();

        if amount <= 0 || amount > state.balance {
            return Err(Error::InvalidAmount);
        }

        state.balance -= amount;
        storage::set_state(&env, job_id, &state);
        token::TokenClient::new(&env, &config.fee_token).transfer(
            &env.current_contract_address(),
            &spec.owner,
            &amount,
        );

        events::JobWithdrawn {
            job_id,
            amount,
            balance: state.balance,
        }
        .publish(&env);
        Ok(state.balance)
    }

    /// Pauses (`active = false`) or resumes a job. A paused job keeps its
    /// balance and schedule but can't be executed; funding and cancelling
    /// still work. Resuming clears the failure count. Owner only.
    pub fn set_job_active(env: Env, job_id: u64, active: bool) -> Result<(), Error> {
        let (spec, mut state) = storage::get_job_parts(&env, job_id).ok_or(Error::JobNotFound)?;
        spec.owner.require_auth();

        state.active = active;
        if active {
            state.failures = 0;
        }
        storage::set_state(&env, job_id, &state);

        events::JobActiveSet { job_id, active }.publish(&env);
        Ok(())
    }

    /// Executes a due job: calls the target through the executor, advances
    /// the schedule and pays the run's fee to the calling keeper (minus the
    /// protocol fee). A failed target call is still charged and recorded.
    pub fn execute(env: Env, keeper: Address, job_id: u64) -> Result<(), Error> {
        let config = storage::load_config(&env);
        let (executor, mut keeper_info) = authorize_keeper(&env, &config, &keeper)?;

        let mut payout = Payout::default();
        run_job(
            &env,
            &config,
            &executor,
            &keeper,
            &mut keeper_info,
            job_id,
            &mut payout,
        )?;
        storage::set_keeper(&env, &keeper, &keeper_info);
        settle(&env, &config, &keeper, &payout);
        Ok(())
    }

    /// Executes every job in `job_ids` that this keeper may run now, in
    /// order, and pays all earnings in one transfer. Jobs that aren't due,
    /// are reserved for another keeper, or are rejected by their resolver are
    /// skipped instead of reverting the batch. Returns, per input id, whether
    /// it ran (a run whose target failed still counts as run).
    pub fn execute_batch(env: Env, keeper: Address, job_ids: Vec<u64>) -> Result<Vec<bool>, Error> {
        if job_ids.is_empty() || job_ids.len() > MAX_BATCH {
            return Err(Error::InvalidBatchSize);
        }
        let config = storage::load_config(&env);
        let (executor, mut keeper_info) = authorize_keeper(&env, &config, &keeper)?;

        let mut ran = Vec::new(&env);
        let mut payout = Payout::default();
        for job_id in job_ids.iter() {
            let ok = run_job(
                &env,
                &config,
                &executor,
                &keeper,
                &mut keeper_info,
                job_id,
                &mut payout,
            )
            .is_ok();
            ran.push_back(ok);
        }
        storage::set_keeper(&env, &keeper, &keeper_info);
        settle(&env, &config, &keeper, &payout);
        Ok(ran)
    }

    // ------------------------------------------------------------------
    // Keepers
    // ------------------------------------------------------------------

    /// Stakes `amount` of the stake token. Registers the keeper on first call
    /// and adds it to the assigned-window rotation while there is room.
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
            total_lateness: 0,
            missed: 0,
            slashed: 0,
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
        storage::add_active_keeper(&env, &keeper, MAX_ACTIVE_KEEPERS);

        events::KeeperStaked {
            keeper,
            amount,
            total: info.stake,
        }
        .publish(&env);
        Ok(info.stake)
    }

    /// Starts the unbonding period. The keeper stops being eligible to
    /// execute immediately and leaves the window rotation. With an unbonding
    /// epoch configured, the period starts when the current epoch ends, so
    /// every keeper unbonding in the same epoch can withdraw together.
    /// Returns the timestamp when stake is withdrawable.
    pub fn begin_unbonding(env: Env, keeper: Address) -> Result<u64, Error> {
        let config = storage::load_config(&env);
        keeper.require_auth();

        let mut info = storage::get_keeper(&env, &keeper).ok_or(Error::KeeperNotFound)?;
        if info.unbonding_at.is_some() {
            return Err(Error::KeeperUnbonding);
        }
        let withdrawable_at = schedule::unbonding_release(
            env.ledger().timestamp(),
            config.unbonding_period,
            config.unbonding_epoch,
        );
        info.unbonding_at = Some(withdrawable_at);
        storage::set_keeper(&env, &keeper, &info);
        storage::remove_active_keeper(&env, &keeper);

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
        release_stake(&env, &config, &keeper)
    }

    /// Pays out every listed keeper whose unbonding has finished, to that
    /// keeper. Anyone may call it, so one transaction can settle a whole
    /// unbonding epoch. Returns the amount released per keeper (`0` for
    /// keepers that aren't ready or don't exist).
    pub fn withdraw_stakes(env: Env, keepers: Vec<Address>) -> Result<Vec<i128>, Error> {
        if keepers.is_empty() || keepers.len() > MAX_BATCH {
            return Err(Error::InvalidBatchSize);
        }
        let config = storage::load_config(&env);
        let mut released = Vec::new(&env);
        for keeper in keepers.iter() {
            released.push_back(release_stake(&env, &config, &keeper).unwrap_or(0));
        }
        Ok(released)
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

    /// Circuit breaker for one contract: while halted, no job that calls
    /// `target` can run, without pausing the rest of the registry. Owners
    /// keep withdrawing and cancelling as usual. Works while paused.
    pub fn set_target_halted(env: Env, target: Address, halted: bool) {
        let config = storage::load_config(&env);
        config.admin.require_auth();
        storage::set_target_halted(&env, &target, halted);
        events::TargetHaltSet { target, halted }.publish(&env);
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

    /// Sets the minimum `interval` new jobs may schedule. `0` disables the check.
    pub fn set_min_interval(env: Env, min_interval: u64) {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        config.min_interval = min_interval;
        storage::set_config(&env, &config);
        events::MinIntervalSet { min_interval }.publish(&env);
    }

    /// Sets the maximum length of a job's `args` vector. `0` disables the check.
    pub fn set_max_args(env: Env, max_args: u32) {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        config.max_args = max_args;
        storage::set_config(&env, &config);
        events::MaxArgsSet { max_args }.publish(&env);
    }

    /// Sends `protocol_fee_bps` (at most `MAX_BPS`) of every run's fee to
    /// `treasury`. `0` turns the protocol fee off.
    pub fn set_protocol_fee(
        env: Env,
        protocol_fee_bps: u32,
        treasury: Option<Address>,
    ) -> Result<(), Error> {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        if protocol_fee_bps > MAX_BPS || (protocol_fee_bps > 0 && treasury.is_none()) {
            return Err(Error::InvalidSetting);
        }
        config.protocol_fee_bps = protocol_fee_bps;
        config.treasury = treasury.clone();
        storage::set_config(&env, &config);
        events::ProtocolFeeSet {
            protocol_fee_bps,
            treasury,
        }
        .publish(&env);
        Ok(())
    }

    /// Consecutive target failures after which a job pauses itself. `0` never pauses.
    pub fn set_max_failures(env: Env, max_failures: u32) {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        config.max_failures = max_failures;
        storage::set_config(&env, &config);
        events::MaxFailuresSet { max_failures }.publish(&env);
    }

    /// Turns on assigned keeper windows: for `grace_period` seconds after a
    /// run is due only its assigned keeper may execute it, and if another
    /// keeper has to run it afterwards the assigned keeper loses `slash_bps`
    /// (at most `MAX_BPS`) of its stake to that keeper. `grace_period = 0`
    /// returns to first come, first served.
    pub fn set_keeper_windows(env: Env, grace_period: u64, slash_bps: u32) -> Result<(), Error> {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        if slash_bps > MAX_BPS {
            return Err(Error::InvalidSetting);
        }
        config.grace_period = grace_period;
        config.slash_bps = slash_bps;
        storage::set_config(&env, &config);
        events::KeeperWindowsSet {
            grace_period,
            slash_bps,
        }
        .publish(&env);
        Ok(())
    }

    /// Groups unbonding into epochs of this many seconds. `0` disables epochs.
    pub fn set_unbonding_epoch(env: Env, unbonding_epoch: u64) {
        let mut config = storage::load_config(&env);
        config.admin.require_auth();
        config.unbonding_epoch = unbonding_epoch;
        storage::set_config(&env, &config);
        events::UnbondingEpochSet { unbonding_epoch }.publish(&env);
    }

    /// Replaces the registry's code, keeping its storage and address.
    /// Admin only. Job owners trust the admin with this power, so production
    /// deployments should put the admin behind a multisig or timelock.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        let config = storage::load_config(&env);
        config.admin.require_auth();
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(wasm_hash.clone()));
        events::Upgraded {
            wasm_hash,
            previous_version: VERSION,
        }
        .publish(&env);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// Interface version of this code. Bumped whenever functions, types or
    /// events change, so clients can tell which registry they're talking to.
    pub fn version() -> u32 {
        VERSION
    }

    pub fn config(env: Env) -> Config {
        storage::load_config(&env)
    }

    pub fn get_job(env: Env, job_id: u64) -> Option<Job> {
        storage::get_job(&env, job_id)
    }

    pub fn get_keeper(env: Env, keeper: Address) -> Option<Keeper> {
        storage::get_keeper(&env, &keeper)
    }

    /// Reputation summary for a keeper: executions, average lateness, missed
    /// windows and stake lost to slashing.
    pub fn keeper_stats(env: Env, keeper: Address) -> Option<KeeperStats> {
        let config = storage::load_config(&env);
        let info = storage::get_keeper(&env, &keeper)?;
        Some(KeeperStats {
            stake: info.stake,
            executions: info.executions,
            average_lateness: if info.executions == 0 {
                0
            } else {
                info.total_lateness / info.executions as u64
            },
            missed: info.missed,
            slashed: info.slashed,
            eligible: ensure_active_keeper(&config, &info).is_ok(),
        })
    }

    /// Keepers taking part in assigned windows, in the order they staked.
    pub fn active_keepers(env: Env) -> Vec<Address> {
        storage::active_keepers(&env)
    }

    /// The keeper reserved for this job's next run, while assigned windows
    /// are on and that keeper is eligible. `None` means any keeper may run it.
    pub fn assigned_keeper(env: Env, job_id: u64) -> Option<Address> {
        let config = storage::load_config(&env);
        let (spec, state) = storage::get_job_parts(&env, job_id)?;
        assigned_keeper_for(&env, &config, job_id, &spec, &state)
    }

    pub fn is_target_halted(env: Env, target: Address) -> bool {
        storage::is_target_halted(&env, &target)
    }

    /// Jobs with ids in `[start, start + limit)`, skipping cancelled ids.
    /// `limit` is capped at `MAX_GET_JOBS_LIMIT`.
    pub fn get_jobs(env: Env, start: u64, limit: u32) -> Vec<Job> {
        let limit = limit.min(MAX_GET_JOBS_LIMIT);
        let end = start
            .saturating_add(limit as u64)
            .min(storage::next_job_id(&env));

        let mut jobs = Vec::new(&env);
        let mut id = start;
        while id < end {
            if let Some(job) = storage::get_job(&env, id) {
                jobs.push_back(job);
            }
            id += 1;
        }
        jobs
    }

    /// Ids of jobs currently owned by `owner`, most recently created last.
    /// Cancelled jobs are removed from this list.
    pub fn jobs_by_owner(env: Env, owner: Address) -> Vec<u64> {
        storage::owner_jobs(&env, &owner)
    }

    /// Number of job ids ever issued. Ids run from `0` to `job_count - 1`;
    /// cancelled ids are not reused.
    pub fn job_count(env: Env) -> u64 {
        storage::next_job_id(&env)
    }

    /// Whether some eligible keeper could execute this job now (ignoring
    /// which keeper: allowlists and assigned windows aren't checked).
    pub fn is_due(env: Env, job_id: u64) -> bool {
        let config = storage::load_config(&env);
        if config.paused || config.executor.is_none() {
            return false;
        }
        match storage::get_job_parts(&env, job_id) {
            Some((spec, state)) => {
                ensure_due(&spec, &state, env.ledger().timestamp()).is_ok()
                    && !storage::is_target_halted(&env, &spec.target)
                    && resolver_allows(&env, job_id, &spec)
            }
            None => false,
        }
    }

    /// The fee a run would pay if executed now, including any late-run ramp.
    pub fn current_fee(env: Env, job_id: u64) -> Option<i128> {
        let (spec, state) = storage::get_job_parts(&env, job_id)?;
        Some(ramped_fee(&spec, &state, env.ledger().timestamp()))
    }
}

// ----------------------------------------------------------------------
// Job creation and validation
// ----------------------------------------------------------------------

/// Checks a new job's parameters and deposit against the registry's limits.
fn validate_job(
    env: &Env,
    config: &Config,
    params: &JobParams,
    deposit: i128,
) -> Result<(), Error> {
    validate_schedule(
        config,
        params.interval,
        &params.schedule,
        params.args.len(),
        params.fee_per_run,
        params.max_fee_per_run,
        &params.keepers,
    )?;
    if deposit < params.fee_per_run {
        return Err(Error::InvalidAmount);
    }
    if is_forbidden_target(env, config, &params.target) {
        return Err(Error::ForbiddenTarget);
    }
    Ok(())
}

/// Checks the settings shared by `create_job` and `update_job` and returns
/// the effective interval (a calendar's period for calendar schedules).
fn validate_schedule(
    config: &Config,
    interval: u64,
    schedule: &Schedule,
    args_len: u32,
    fee_per_run: i128,
    max_fee_per_run: i128,
    keepers: &Option<Vec<Address>>,
) -> Result<u64, Error> {
    let interval = match schedule::calendar_period(schedule) {
        Some(period) => {
            if interval != 0 || !schedule::schedule_is_valid(schedule) {
                return Err(Error::InvalidCalendar);
            }
            period
        }
        None => {
            if interval == 0 {
                return Err(Error::InvalidInterval);
            }
            interval
        }
    };
    if config.min_interval != 0 && interval < config.min_interval {
        return Err(Error::IntervalTooShort);
    }
    if config.max_args != 0 && args_len > config.max_args {
        return Err(Error::TooManyArgs);
    }
    if fee_per_run <= 0 {
        return Err(Error::InvalidFee);
    }
    if max_fee_per_run != 0 && max_fee_per_run < fee_per_run {
        return Err(Error::InvalidSetting);
    }
    if let Some(list) = keepers {
        if list.len() > MAX_JOB_KEEPERS {
            return Err(Error::TooManyKeepers);
        }
    }
    Ok(interval)
}

/// Stores a validated job whose deposit has already been transferred in.
fn insert_job(env: &Env, owner: &Address, params: JobParams, deposit: i128) -> u64 {
    let id = storage::take_next_job_id(env);
    let earliest = params.start_at.max(env.ledger().timestamp());
    let interval = schedule::calendar_period(&params.schedule).unwrap_or(params.interval);
    let next_run = first_calendar_run(&params.schedule, earliest);
    let spec = JobSpec {
        owner: owner.clone(),
        target: params.target,
        function: params.function,
        args: params.args,
        interval,
        schedule: params.schedule,
        fee_per_run: params.fee_per_run,
        max_fee_per_run: params.max_fee_per_run,
        max_runs: params.max_runs,
        end_at: params.end_at,
        resolver: params.resolver,
        keepers: params.keepers,
    };
    storage::set_spec(env, id, &spec);
    storage::set_state(
        env,
        id,
        &JobState {
            next_run,
            balance: deposit,
            runs: 0,
            failures: 0,
            active: true,
        },
    );
    storage::add_owner_job(env, owner, id);

    events::JobCreated {
        job_id: id,
        owner: owner.clone(),
        target: spec.target,
        interval,
        fee_per_run: spec.fee_per_run,
        deposit,
    }
    .publish(env);
    id
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

// ----------------------------------------------------------------------
// Execution
// ----------------------------------------------------------------------

/// What a keeper earned over one `execute` or `execute_batch` call.
#[derive(Default)]
struct Payout {
    /// Fee-token amount for the keeper.
    keeper_fees: i128,
    /// Fee-token amount for the treasury.
    protocol_fees: i128,
    /// Stake-token amount slashed from keepers that missed their windows.
    slash_rewards: i128,
}

/// Checks the registry state and keeper shared by `execute` and
/// `execute_batch`, returning the executor and the keeper's record.
fn authorize_keeper(
    env: &Env,
    config: &Config,
    keeper: &Address,
) -> Result<(Address, Keeper), Error> {
    ensure_not_paused(config)?;
    let executor = config.executor.clone().ok_or(Error::ExecutorNotSet)?;
    keeper.require_auth();
    let info = storage::get_keeper(env, keeper).ok_or(Error::KeeperNotFound)?;
    ensure_active_keeper(config, &info)?;
    Ok((executor, info))
}

/// Runs one job if this keeper may run it now, records the outcome and adds
/// the earnings to `payout`. Nothing is written when it returns an error.
fn run_job(
    env: &Env,
    config: &Config,
    executor: &Address,
    keeper: &Address,
    keeper_info: &mut Keeper,
    job_id: u64,
    payout: &mut Payout,
) -> Result<(), Error> {
    let (spec, mut state) = storage::get_job_parts(env, job_id).ok_or(Error::JobNotFound)?;
    let now = env.ledger().timestamp();
    ensure_due(&spec, &state, now)?;
    if storage::is_target_halted(env, &spec.target) {
        return Err(Error::TargetHalted);
    }
    if let Some(allowed) = &spec.keepers {
        if !allowed.contains(keeper) {
            return Err(Error::KeeperNotAllowed);
        }
    }
    let assigned = assigned_keeper_for(env, config, job_id, &spec, &state).filter(|a| a != keeper);
    if assigned.is_some() && now < state.next_run.saturating_add(config.grace_period) {
        return Err(Error::NotAssignedKeeper);
    }
    if !resolver_allows(env, job_id, &spec) {
        return Err(Error::ResolverRejected);
    }

    // Budget and footprint errors are not recoverable by try_execute, so a
    // keeper can't fake a failure by starving the call of resources.
    let outcome =
        ExecutorClient::new(env, executor).try_execute(&spec.target, &spec.function, &spec.args);
    let (success, result_hash) = match outcome {
        Ok(Ok(value)) => (true, env.crypto().sha256(&value.to_xdr(env)).to_bytes()),
        Ok(Err(_)) => (true, env.crypto().sha256(&Bytes::new(env)).to_bytes()),
        Err(Ok(err)) => (false, env.crypto().sha256(&err.to_xdr(env)).to_bytes()),
        Err(Err(_)) => (false, env.crypto().sha256(&Bytes::new(env)).to_bytes()),
    };

    let fee = ramped_fee(&spec, &state, now);
    let (keeper_fee, protocol_fee) = split_fee(fee, config.protocol_fee_bps);
    let lateness = now.saturating_sub(state.next_run);

    state.runs = state.runs.saturating_add(1);
    state.balance -= fee;
    state.next_run = next_run_after(state.next_run, spec.interval, now);
    if success {
        state.failures = 0;
    } else {
        state.failures = state.failures.saturating_add(1);
        if config.max_failures != 0 && state.failures >= config.max_failures {
            state.active = false;
            events::JobDeactivated {
                job_id,
                failures: state.failures,
            }
            .publish(env);
        }
    }
    storage::set_state(env, job_id, &state);

    if state.balance < spec.fee_per_run {
        events::JobExhausted {
            job_id,
            balance: state.balance,
        }
        .publish(env);
    }

    keeper_info.executions = keeper_info.executions.saturating_add(1);
    keeper_info.total_lateness = keeper_info.total_lateness.saturating_add(lateness);
    if let Some(missed) = assigned {
        payout.slash_rewards += slash_missed_keeper(env, config, &missed, keeper, job_id);
    }
    payout.keeper_fees += keeper_fee;
    payout.protocol_fees += protocol_fee;

    events::JobExecuted {
        job_id,
        keeper: keeper.clone(),
        success,
        fee,
        protocol_fee,
        run: state.runs,
        next_run: state.next_run,
        lateness,
        failures: state.failures,
        result_hash,
    }
    .publish(env);
    Ok(())
}

/// Takes `slash_bps` of a keeper's stake for a run it was assigned but
/// missed. Returns the amount, which goes to the keeper that ran the job.
fn slash_missed_keeper(
    env: &Env,
    config: &Config,
    missed: &Address,
    beneficiary: &Address,
    job_id: u64,
) -> i128 {
    let Some(mut info) = storage::get_keeper(env, missed) else {
        return 0;
    };
    let amount = split_fee(info.stake, config.slash_bps).1;
    info.stake -= amount;
    info.slashed += amount;
    info.missed = info.missed.saturating_add(1);
    storage::set_keeper(env, missed, &info);
    events::KeeperSlashed {
        keeper: missed.clone(),
        job_id,
        amount,
        remaining: info.stake,
        beneficiary: beneficiary.clone(),
    }
    .publish(env);
    amount
}

/// Pays out a keeper's earnings and the treasury's share.
fn settle(env: &Env, config: &Config, keeper: &Address, payout: &Payout) {
    let registry = env.current_contract_address();
    if payout.keeper_fees > 0 {
        token::TokenClient::new(env, &config.fee_token).transfer(
            &registry,
            keeper,
            &payout.keeper_fees,
        );
    }
    if payout.protocol_fees > 0 {
        if let Some(treasury) = &config.treasury {
            token::TokenClient::new(env, &config.fee_token).transfer(
                &registry,
                treasury,
                &payout.protocol_fees,
            );
        }
    }
    if payout.slash_rewards > 0 {
        token::TokenClient::new(env, &config.stake_token).transfer(
            &registry,
            keeper,
            &payout.slash_rewards,
        );
    }
}

/// The keeper reserved for the job's next run: chosen deterministically from
/// the job's allowlist (or the window rotation) by `sha256(job_id, runs)`.
/// `None` when windows are off or the chosen keeper can't execute, in which
/// case the run is open to everyone and nobody is slashed.
fn assigned_keeper_for(
    env: &Env,
    config: &Config,
    job_id: u64,
    spec: &JobSpec,
    state: &JobState,
) -> Option<Address> {
    if config.grace_period == 0 {
        return None;
    }
    let candidates = match &spec.keepers {
        Some(list) => list.clone(),
        None => storage::active_keepers(env),
    };
    if candidates.is_empty() {
        return None;
    }
    let mut seed = [0u8; 12];
    seed[..8].copy_from_slice(&job_id.to_be_bytes());
    seed[8..].copy_from_slice(&state.runs.to_be_bytes());
    let digest = env
        .crypto()
        .sha256(&Bytes::from_array(env, &seed))
        .to_array();
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    let index = (u64::from_be_bytes(head) % candidates.len() as u64) as u32;

    let chosen = candidates.get(index)?;
    let info = storage::get_keeper(env, &chosen)?;
    ensure_active_keeper(config, &info).ok()?;
    Some(chosen)
}

fn release_stake(env: &Env, config: &Config, keeper: &Address) -> Result<i128, Error> {
    let info = storage::get_keeper(env, keeper).ok_or(Error::KeeperNotFound)?;
    let withdrawable_at = info.unbonding_at.ok_or(Error::UnbondingNotStarted)?;
    if env.ledger().timestamp() < withdrawable_at {
        return Err(Error::UnbondingNotFinished);
    }

    storage::remove_keeper(env, keeper);
    if info.stake > 0 {
        token::TokenClient::new(env, &config.stake_token).transfer(
            &env.current_contract_address(),
            keeper,
            &info.stake,
        );
    }
    events::KeeperWithdrawn {
        keeper: keeper.clone(),
        amount: info.stake,
    }
    .publish(env);
    Ok(info.stake)
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

/// Whether the job's own settings allow a run at `now`, in this order:
/// paused, max runs, expiry, funding, schedule.
pub(crate) fn ensure_due(spec: &JobSpec, state: &JobState, now: u64) -> Result<(), Error> {
    if !state.active {
        return Err(Error::JobPaused);
    }
    if spec.max_runs != 0 && state.runs >= spec.max_runs {
        return Err(Error::MaxRunsReached);
    }
    if spec.end_at != 0 && now >= spec.end_at {
        return Err(Error::JobExpired);
    }
    if state.balance < spec.fee_per_run {
        return Err(Error::InsufficientJobBalance);
    }
    if now < state.next_run {
        return Err(Error::JobNotDue);
    }
    Ok(())
}

/// A job without a resolver always passes. A resolver that panics or returns
/// anything other than `true` blocks execution.
fn resolver_allows(env: &Env, job_id: u64, spec: &JobSpec) -> bool {
    match &spec.resolver {
        None => true,
        Some(resolver) => {
            let res = env.try_invoke_contract::<bool, soroban_sdk::Error>(
                resolver,
                &Symbol::new(env, RESOLVER_FN),
                vec![env, job_id.into_val(env)],
            );
            matches!(res, Ok(Ok(true)))
        }
    }
}
