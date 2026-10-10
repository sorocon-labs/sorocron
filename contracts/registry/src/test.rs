use crate::{
    events, Error, JobParams, JobUpdate, Schedule, SoroCron, SoroCronClient, MAX_BATCH, VERSION,
};
use soroban_sdk::testutils::Deployer as _;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::ToXdr,
    Address, BytesN, Env, Event as _, IntoVal, Symbol, Val, Vec,
};
use sorocron_executor::Executor;
use sorocron_ttl_guardian::TtlGuardian;

pub(crate) const MIN_STAKE: i128 = 1_000;
pub(crate) const UNBONDING: u64 = 3_600;
pub(crate) const START: u64 = 1_700_000_000;
pub(crate) const FEE: i128 = 10;
pub(crate) const INTERVAL: u64 = 60;
pub(crate) const INITIAL_BALANCE: i128 = 1_000_000;

// ---------------------------------------------------------------------------
// Mock contracts
// ---------------------------------------------------------------------------

#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    pub fn bump(env: Env, by: u32) -> u32 {
        let key = symbol_short!("count");
        let count: u32 = env.storage().instance().get(&key).unwrap_or(0) + by;
        env.storage().instance().set(&key, &count);
        count
    }

    pub fn fail(_env: Env) {
        panic!("target always fails");
    }

    pub fn count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }
}

#[contract]
pub struct MockResolver;

#[contractimpl]
impl MockResolver {
    pub fn set_ready(env: Env, ready: bool) {
        env.storage()
            .instance()
            .set(&symbol_short!("ready"), &ready);
    }

    pub fn should_run(env: Env, _job_id: u64) -> bool {
        env.storage()
            .instance()
            .get(&symbol_short!("ready"))
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(crate) struct Setup {
    pub(crate) env: Env,
    pub(crate) cron: SoroCronClient<'static>,
    pub(crate) token: TokenClient<'static>,
    pub(crate) sac: StellarAssetClient<'static>,
    pub(crate) target: MockTargetClient<'static>,
    pub(crate) admin: Address,
    pub(crate) owner: Address,
    pub(crate) keeper: Address,
}

pub(crate) fn setup() -> Setup {
    let s = setup_without_executor();
    let executor_id = s.env.register(Executor, (s.cron.address.clone(),));
    s.cron.set_executor(&executor_id);
    s
}

pub(crate) fn setup_without_executor() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &token_id);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    sac.mint(&owner, &INITIAL_BALANCE);
    sac.mint(&keeper, &INITIAL_BALANCE);

    let cron_id = env.register(
        SoroCron,
        (
            admin.clone(),
            token_id.clone(),
            token_id.clone(),
            MIN_STAKE,
            UNBONDING,
        ),
    );
    let target_id = env.register(MockTarget, ());

    let cron = SoroCronClient::new(&env, &cron_id);
    cron.stake(&keeper, &MIN_STAKE);

    Setup {
        cron,
        token: TokenClient::new(&env, &token_id),
        sac,
        target: MockTargetClient::new(&env, &target_id),
        admin,
        owner,
        keeper,
        env,
    }
}

pub(crate) fn params(s: &Setup) -> JobParams {
    let args: Vec<Val> = vec![&s.env, 1u32.into_val(&s.env)];
    JobParams {
        target: s.target.address.clone(),
        function: Symbol::new(&s.env, "bump"),
        args,
        interval: INTERVAL,
        start_at: 0,
        fee_per_run: FEE,
        max_runs: 0,
        end_at: 0,
        resolver: None,
        schedule: Schedule::Interval,
        max_fee_per_run: 0,
        keepers: None,
        after: None,
    }
}

pub(crate) fn advance(env: &Env, seconds: u64) {
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + seconds);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

#[test]
fn constructor_stores_config() {
    let s = setup();
    let config = s.cron.config();
    assert_eq!(config.admin, s.admin);
    assert_eq!(config.fee_token, s.token.address);
    assert_eq!(config.min_stake, MIN_STAKE);
    assert_eq!(config.unbonding_period, UNBONDING);
    assert!(!config.paused);
    assert_eq!(s.cron.job_count(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn constructor_rejects_negative_min_stake() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    env.register(
        SoroCron,
        (
            admin.clone(),
            token_id.clone(),
            token_id.clone(),
            -1_i128,
            UNBONDING,
        ),
    );
}

// ---------------------------------------------------------------------------
// Job creation
// ---------------------------------------------------------------------------

#[test]
fn create_job_escrows_deposit_and_stores_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    assert_eq!(id, 0);
    assert_eq!(s.cron.job_count(), 1);
    assert_eq!(s.token.balance(&s.owner), INITIAL_BALANCE - 100);

    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.owner, s.owner);
    assert_eq!(job.balance, 100);
    assert_eq!(job.next_run, START);
    assert_eq!(job.runs, 0);
}

#[test]
fn create_job_assigns_sequential_ids() {
    let s = setup();
    assert_eq!(s.cron.create_job(&s.owner, &params(&s), &100), 0);
    assert_eq!(s.cron.create_job(&s.owner, &params(&s), &100), 1);
    assert_eq!(s.cron.job_count(), 2);
}

#[test]
fn create_job_validates_params() {
    let s = setup();

    let mut p = params(&s);
    p.interval = 0;
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::InvalidInterval))
    );

    let mut p = params(&s);
    p.fee_per_run = 0;
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::InvalidFee))
    );

    assert_eq!(
        s.cron.try_create_job(&s.owner, &params(&s), &(FEE - 1)),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn create_job_rejects_custodied_token_and_self_as_target() {
    let s = setup();

    let mut p = params(&s);
    p.target = s.token.address.clone();
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::ForbiddenTarget))
    );

    let mut p = params(&s);
    p.target = s.cron.address.clone();
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::ForbiddenTarget))
    );

    let mut p = params(&s);
    p.target = s.cron.config().executor.unwrap();
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::ForbiddenTarget))
    );
}

#[test]
fn start_at_in_future_delays_first_run() {
    let s = setup();
    let mut p = params(&s);
    p.start_at = START + 500;
    let id = s.cron.create_job(&s.owner, &p, &100);

    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobNotDue))
    );

    advance(&s.env, 500);
    assert!(s.cron.is_due(&id));
    s.cron.execute(&s.keeper, &id);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

#[test]
fn execute_calls_target_pays_keeper_and_advances_schedule() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    let keeper_before = s.token.balance(&s.keeper);

    s.cron.execute(&s.keeper, &id);

    assert_eq!(s.target.count(), 1);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + FEE);

    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.runs, 1);
    assert_eq!(job.balance, 100 - FEE);
    assert_eq!(job.next_run, START + INTERVAL);
    assert_eq!(s.cron.get_keeper(&s.keeper).unwrap().executions, 1);
}

#[test]
fn execute_respects_interval() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.execute(&s.keeper, &id);

    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobNotDue))
    );

    advance(&s.env, INTERVAL - 1);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobNotDue))
    );

    advance(&s.env, 1);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.target.count(), 2);
}

#[test]
fn missed_runs_do_not_fire_back_to_back() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    s.cron.execute(&s.keeper, &id);

    // Keepers offline for 10 intervals.
    advance(&s.env, INTERVAL * 10);
    s.cron.execute(&s.keeper, &id);

    let now = s.env.ledger().timestamp();
    assert_eq!(s.cron.get_job(&id).unwrap().next_run, now + INTERVAL);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobNotDue))
    );
}

#[test]
fn execute_stops_at_max_runs() {
    let s = setup();
    let mut p = params(&s);
    p.max_runs = 2;
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    s.cron.execute(&s.keeper, &id);
    advance(&s.env, INTERVAL);
    s.cron.execute(&s.keeper, &id);
    advance(&s.env, INTERVAL);

    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::MaxRunsReached))
    );
}

#[test]
fn execute_succeeds_before_end_at() {
    let s = setup();
    let mut p = params(&s);
    p.end_at = START + INTERVAL + 1;
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    advance(&s.env, INTERVAL);
    assert!(s.cron.is_due(&id));
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.target.count(), 1);
}

#[test]
fn execute_rejects_at_end_at() {
    let s = setup();
    let mut p = params(&s);
    p.end_at = START + INTERVAL;
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    advance(&s.env, INTERVAL);
    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobExpired))
    );
}

#[test]
fn execute_rejects_after_end_at() {
    let s = setup();
    let mut p = params(&s);
    p.end_at = START + INTERVAL;
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    advance(&s.env, INTERVAL * 2);
    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobExpired))
    );
}

#[test]
fn execute_stops_when_balance_runs_out_and_resumes_after_funding() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &FEE);
    s.cron.execute(&s.keeper, &id);
    advance(&s.env, INTERVAL);

    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::InsufficientJobBalance))
    );

    let funder = Address::generate(&s.env);
    s.sac.mint(&funder, &FEE);
    assert_eq!(s.cron.fund_job(&funder, &id, &FEE), FEE);

    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.target.count(), 2);
}

#[test]
fn execute_requires_registered_staked_keeper() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.cron.try_execute(&stranger, &id),
        Err(Ok(Error::KeeperNotFound))
    );

    let small = Address::generate(&s.env);
    s.sac.mint(&small, &MIN_STAKE);
    s.cron.stake(&small, &(MIN_STAKE - 1));
    assert_eq!(
        s.cron.try_execute(&small, &id),
        Err(Ok(Error::InsufficientStake))
    );

    s.cron.stake(&small, &1);
    s.cron.execute(&small, &id);
}

#[test]
fn raising_min_stake_disqualifies_underbonded_keepers() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    s.cron.set_min_stake(&(MIN_STAKE + 1));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::InsufficientStake))
    );
}

#[test]
fn execute_missing_job_fails() {
    let s = setup();
    assert_eq!(
        s.cron.try_execute(&s.keeper, &42),
        Err(Ok(Error::JobNotFound))
    );
    assert!(!s.cron.is_due(&42));
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

#[test]
fn resolver_gates_execution() {
    let s = setup();
    let resolver_id = s.env.register(MockResolver, ());
    let resolver = MockResolverClient::new(&s.env, &resolver_id);

    let mut p = params(&s);
    p.resolver = Some(resolver_id);
    let id = s.cron.create_job(&s.owner, &p, &100);

    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::ResolverRejected))
    );

    resolver.set_ready(&true);
    assert!(s.cron.is_due(&id));
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.target.count(), 1);
}

#[test]
fn broken_resolver_blocks_instead_of_panicking() {
    let s = setup();
    let mut p = params(&s);
    // MockTarget has no `should_run`, so the resolver call fails.
    p.resolver = Some(s.target.address.clone());
    let id = s.cron.create_job(&s.owner, &p, &100);

    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::ResolverRejected))
    );
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

#[test]
fn cancel_job_refunds_owner_and_removes_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.execute(&s.keeper, &id);

    assert_eq!(s.cron.cancel_job(&id), 100 - FEE);
    assert_eq!(s.token.balance(&s.owner), INITIAL_BALANCE - FEE);
    assert!(s.cron.get_job(&id).is_none());
    assert_eq!(s.cron.try_cancel_job(&id), Err(Ok(Error::JobNotFound)));
}

#[test]
fn jobs_by_owner_tracks_creation_and_cancellation() {
    let s = setup();
    assert_eq!(s.cron.jobs_by_owner(&s.owner), Vec::new(&s.env));

    let first = s.cron.create_job(&s.owner, &params(&s), &100);
    let second = s.cron.create_job(&s.owner, &params(&s), &100);
    assert_eq!(s.cron.jobs_by_owner(&s.owner), vec![&s.env, first, second]);

    s.cron.cancel_job(&first);
    assert_eq!(s.cron.jobs_by_owner(&s.owner), vec![&s.env, second]);
}

/// Whether the registry emitted an event matching `expected` at any point
/// during this test (unlike `last_event`, does not require it to be last).
pub(crate) fn emitted(s: &Setup, expected: &soroban_sdk::xdr::ContractEvent) -> bool {
    s.env
        .events()
        .all()
        .filter_by_contract(&s.cron.address)
        .events()
        .contains(expected)
}

#[test]
fn job_exhausted_event_fires_exactly_when_balance_drops_below_one_fee() {
    let s = setup();
    // Deposit covers exactly two runs; after the second, balance (0) < FEE.
    let id = s.cron.create_job(&s.owner, &params(&s), &(FEE * 2));

    s.cron.execute(&s.keeper, &id);
    let not_yet = events::JobExhausted {
        job_id: id,
        balance: FEE,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert!(!emitted(&s, &not_yet));

    advance(&s.env, INTERVAL);
    s.env.mock_auths(&[MockAuth {
        address: &s.keeper,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "execute",
            args: (s.keeper.clone(), id).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.cron.execute(&s.keeper, &id);
    let expected = events::JobExhausted {
        job_id: id,
        balance: 0,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert!(emitted(&s, &expected));
}

#[test]
fn get_jobs_returns_empty_range() {
    let s = setup();
    s.cron.create_job(&s.owner, &params(&s), &100);
    assert_eq!(s.cron.get_jobs(&5, &10), Vec::new(&s.env));
    assert_eq!(s.cron.get_jobs(&0, &0), Vec::new(&s.env));
}

#[test]
fn get_jobs_skips_cancelled_ids() {
    let s = setup();
    let first = s.cron.create_job(&s.owner, &params(&s), &100);
    let second = s.cron.create_job(&s.owner, &params(&s), &100);
    let third = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.cancel_job(&second);

    let jobs = s.cron.get_jobs(&0, &10);
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs.get(0).unwrap().id, first);
    assert_eq!(jobs.get(1).unwrap().id, third);
}

#[test]
fn get_jobs_caps_limit() {
    let s = setup();
    for _ in 0..(crate::MAX_GET_JOBS_LIMIT + 5) {
        s.cron.create_job(&s.owner, &params(&s), &100);
    }
    assert_eq!(s.cron.get_jobs(&0, &1_000).len(), crate::MAX_GET_JOBS_LIMIT);
}

#[test]
fn withdraw_job_balance_partial() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let remaining = s.cron.withdraw_job_balance(&id, &40);
    assert_eq!(remaining, 60);
    assert_eq!(s.cron.get_job(&id).unwrap().balance, 60);
    assert_eq!(s.token.balance(&s.owner), INITIAL_BALANCE - 100 + 40);
}

#[test]
fn withdraw_job_balance_rejects_over_withdrawal() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    assert_eq!(
        s.cron.try_withdraw_job_balance(&id, &101),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.cron.try_withdraw_job_balance(&id, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn withdraw_job_balance_works_while_paused() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    s.cron.set_paused(&true);
    assert_eq!(s.cron.withdraw_job_balance(&id, &40), 60);
}

#[test]
fn only_owner_can_withdraw_job_balance() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "withdraw_job_balance",
            args: (id, 40i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_withdraw_job_balance(&id, &40).is_err());
    assert_eq!(s.cron.get_job(&id).unwrap().balance, 100);
}

#[test]
fn min_interval_boundary() {
    let s = setup();
    s.cron.set_min_interval(&INTERVAL);

    let mut too_short = params(&s);
    too_short.interval = INTERVAL - 1;
    assert_eq!(
        s.cron.try_create_job(&s.owner, &too_short, &100),
        Err(Ok(Error::IntervalTooShort))
    );

    let mut at_min = params(&s);
    at_min.interval = INTERVAL;
    assert!(s.cron.try_create_job(&s.owner, &at_min, &100).is_ok());
}

#[test]
fn max_args_boundary() {
    let s = setup();
    s.cron.set_max_args(&2);

    let mut too_many = params(&s);
    too_many.args = vec![
        &s.env,
        1u32.into_val(&s.env),
        2u32.into_val(&s.env),
        3u32.into_val(&s.env),
    ];
    assert_eq!(
        s.cron.try_create_job(&s.owner, &too_many, &100),
        Err(Ok(Error::TooManyArgs))
    );

    let mut at_max = params(&s);
    at_max.args = vec![&s.env, 1u32.into_val(&s.env), 2u32.into_val(&s.env)];
    assert!(s.cron.try_create_job(&s.owner, &at_max, &100).is_ok());
}

#[test]
fn min_interval_and_max_args_disabled_by_default() {
    let s = setup();
    let config = s.cron.config();
    assert_eq!(config.min_interval, 0);
    assert_eq!(config.max_args, 0);
}

#[test]
fn only_admin_sets_min_interval_and_max_args() {
    let s = setup();
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "set_min_interval",
            args: (5u64,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_set_min_interval(&5).is_err());

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "set_max_args",
            args: (5u32,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_set_max_args(&5).is_err());
}

// ---------------------------------------------------------------------------
// Keeper staking
// ---------------------------------------------------------------------------

#[test]
fn unbonding_disables_keeper_and_releases_stake_after_delay() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let withdrawable_at = s.cron.begin_unbonding(&s.keeper);
    assert_eq!(withdrawable_at, START + UNBONDING);

    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::KeeperUnbonding))
    );
    assert_eq!(
        s.cron.try_stake(&s.keeper, &1),
        Err(Ok(Error::KeeperUnbonding))
    );
    assert_eq!(
        s.cron.try_begin_unbonding(&s.keeper),
        Err(Ok(Error::KeeperUnbonding))
    );

    advance(&s.env, UNBONDING - 1);
    assert_eq!(
        s.cron.try_withdraw_stake(&s.keeper),
        Err(Ok(Error::UnbondingNotFinished))
    );

    advance(&s.env, 1);
    assert_eq!(s.cron.withdraw_stake(&s.keeper), MIN_STAKE);
    assert_eq!(s.token.balance(&s.keeper), INITIAL_BALANCE);
    assert!(s.cron.get_keeper(&s.keeper).is_none());
}

#[test]
fn withdraw_without_unbonding_fails() {
    let s = setup();
    assert_eq!(
        s.cron.try_withdraw_stake(&s.keeper),
        Err(Ok(Error::UnbondingNotStarted))
    );
}

#[test]
fn stake_rejects_non_positive_amount() {
    let s = setup();
    assert_eq!(
        s.cron.try_stake(&s.keeper, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_activity_but_not_exits() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    s.cron.set_paused(&true);
    assert!(s.cron.config().paused);
    assert!(!s.cron.is_due(&id));
    assert_eq!(s.cron.try_execute(&s.keeper, &id), Err(Ok(Error::Paused)));
    assert_eq!(
        s.cron.try_create_job(&s.owner, &params(&s), &100),
        Err(Ok(Error::Paused))
    );
    assert_eq!(
        s.cron.try_fund_job(&s.owner, &id, &10),
        Err(Ok(Error::Paused))
    );

    // Exits keep working while paused.
    assert_eq!(s.cron.cancel_job(&id), 100);
    s.cron.begin_unbonding(&s.keeper);
    advance(&s.env, UNBONDING);
    assert_eq!(s.cron.withdraw_stake(&s.keeper), MIN_STAKE);

    s.cron.set_paused(&false);
    assert!(!s.cron.config().paused);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

#[test]
fn execute_requires_executor() {
    let s = setup_without_executor();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::ExecutorNotSet))
    );
}

#[test]
fn executor_can_only_be_set_once() {
    let s = setup();
    let other = Address::generate(&s.env);
    assert_eq!(
        s.cron.try_set_executor(&other),
        Err(Ok(Error::ExecutorAlreadySet))
    );
}

/// A job must not be able to act with the registry's authority, even
/// against a token the registry holds but doesn't list as fee/stake token.
#[test]
fn targets_cannot_use_registry_authority() {
    let s = setup();

    let other_token = s
        .env
        .register_stellar_asset_contract_v2(s.admin.clone())
        .address();
    StellarAssetClient::new(&s.env, &other_token).mint(&s.cron.address, &500);
    let attacker = Address::generate(&s.env);

    let benign = s.cron.create_job(&s.owner, &params(&s), &100);

    let mut p = params(&s);
    p.target = other_token.clone();
    p.function = Symbol::new(&s.env, "transfer");
    p.args = vec![
        &s.env,
        s.cron.address.into_val(&s.env),
        attacker.into_val(&s.env),
        500i128.into_val(&s.env),
    ];
    let malicious = s.cron.create_job(&s.owner, &p, &100);

    // From here on only the keeper's signature exists; nothing is mocked for
    // the registry. The benign job proves that is enough for a normal run.
    s.env.mock_auths(&[MockAuth {
        address: &s.keeper,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "execute",
            args: (s.keeper.clone(), benign).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.cron.execute(&s.keeper, &benign);
    assert_eq!(s.target.count(), 1);

    s.env.mock_auths(&[MockAuth {
        address: &s.keeper,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "execute",
            args: (s.keeper.clone(), malicious).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    // The transfer fails inside the executor for lack of the registry's
    // authority. Since v4 that failure is recorded on the job instead of
    // reverting, so the run itself goes through.
    s.cron.execute(&s.keeper, &malicious);
    assert_eq!(s.cron.get_job(&malicious).unwrap().failures, 1);

    let other = TokenClient::new(&s.env, &other_token);
    assert_eq!(other.balance(&s.cron.address), 500);
    assert_eq!(other.balance(&attacker), 0);
}

// ---------------------------------------------------------------------------
// Admin handover
// ---------------------------------------------------------------------------

#[test]
fn two_step_admin_transfer() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    assert_eq!(s.cron.pending_admin(), None);

    s.cron.propose_admin(&new_admin);
    assert_eq!(s.cron.pending_admin(), Some(new_admin.clone()));
    assert_eq!(s.cron.config().admin, s.admin, "unchanged until accepted");

    s.cron.accept_admin();
    assert_eq!(s.cron.config().admin, new_admin);
    assert_eq!(s.cron.pending_admin(), None);
}

#[test]
fn accept_admin_without_proposal_fails() {
    let s = setup();
    assert_eq!(s.cron.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
}

#[test]
fn cancel_admin_proposal_clears_pending_and_blocks_accept() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.cron.propose_admin(&new_admin);
    assert_eq!(s.cron.pending_admin(), Some(new_admin.clone()));

    s.cron.cancel_admin_proposal();
    assert_eq!(s.cron.pending_admin(), None);
    assert_eq!(s.cron.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
    assert_eq!(s.cron.config().admin, s.admin);
}

#[test]
fn cancel_admin_proposal_requires_no_pending_proposal() {
    let s = setup();
    assert_eq!(
        s.cron.try_cancel_admin_proposal(),
        Err(Ok(Error::NoPendingAdmin))
    );
}

#[test]
fn only_admin_can_cancel_admin_proposal() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    s.cron.propose_admin(&new_admin);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "cancel_admin_proposal",
            args: ().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_cancel_admin_proposal().is_err());
    assert_eq!(s.cron.pending_admin(), Some(new_admin));
}

#[test]
fn new_admin_proposal_replaces_pending_one() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);

    s.cron.propose_admin(&first);
    s.cron.propose_admin(&second);
    assert_eq!(s.cron.pending_admin(), Some(second.clone()));

    s.cron.accept_admin();
    assert_eq!(s.cron.config().admin, second);
}

#[test]
fn only_admin_proposes_and_only_proposed_accepts() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    let propose_args: Vec<Val> = vec![&s.env, new_admin.into_val(&s.env)];
    let no_args: Vec<Val> = Vec::new(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "propose_admin",
            args: propose_args.clone(),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_propose_admin(&new_admin).is_err());

    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "propose_admin",
            args: propose_args,
            sub_invokes: &[],
        },
    }]);
    s.cron.propose_admin(&new_admin);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "accept_admin",
            args: no_args.clone(),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_accept_admin().is_err());

    s.env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "accept_admin",
            args: no_args,
            sub_invokes: &[],
        },
    }]);
    s.cron.accept_admin();
    assert_eq!(s.cron.config().admin, new_admin);
}

// ---------------------------------------------------------------------------
// TTL Guardian integration
// ---------------------------------------------------------------------------

#[test]
fn guardian_job_keeps_target_contract_from_being_archived() {
    let s = setup();
    let guardian = s.env.register(TtlGuardian, ());
    let original_ttl = s
        .env
        .deployer()
        .get_contract_instance_ttl(&s.target.address);
    let extend_to: u32 = 50_000;

    let mut p = params(&s);
    p.target = guardian;
    p.function = Symbol::new(&s.env, "extend");
    p.args = vec![
        &s.env,
        s.target.address.into_val(&s.env),
        extend_to.into_val(&s.env),
        extend_to.into_val(&s.env),
    ];
    p.interval = 86_400;
    let id = s.cron.create_job(&s.owner, &p, &100);

    // One ledger before the target would expire, a keeper runs the job.
    s.env.ledger().with_mut(|l| {
        l.sequence_number += original_ttl - 1;
        l.timestamp += 86_400;
    });
    s.cron.execute(&s.keeper, &id);
    assert_eq!(
        s.env
            .deployer()
            .get_contract_instance_ttl(&s.target.address),
        extend_to
    );

    // Long past the original expiry, the target still works.
    s.env
        .ledger()
        .with_mut(|l| l.sequence_number += original_ttl * 2);
    assert_eq!(s.target.count(), 0);
}

// ---------------------------------------------------------------------------
// Per-job pause
// ---------------------------------------------------------------------------

#[test]
fn owner_can_pause_and_resume_a_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    assert!(s.cron.get_job(&id).unwrap().active);

    s.cron.set_job_active(&id, &false);
    assert!(!s.cron.get_job(&id).unwrap().active);
    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobPaused))
    );

    // Funding still works while paused.
    assert_eq!(s.cron.fund_job(&s.owner, &id, &10), 110);

    s.cron.set_job_active(&id, &true);
    assert!(s.cron.is_due(&id));
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.target.count(), 1);
}

#[test]
fn paused_job_can_still_be_cancelled() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.set_job_active(&id, &false);
    assert_eq!(s.cron.cancel_job(&id), 100);
}

#[test]
fn only_owner_can_pause_a_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "set_job_active",
            args: (id, false).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_set_job_active(&id, &false).is_err());
    assert!(s.cron.get_job(&id).unwrap().active);
}

#[test]
fn only_admin_can_pause() {
    let s = setup();
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "set_paused",
            args: (true,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_set_paused(&true).is_err());
    assert!(!s.cron.config().paused);
}

#[test]
fn only_admin_can_change_min_stake() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let new_min = MIN_STAKE + 1;

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "set_min_stake",
            args: (new_min,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_set_min_stake(&new_min).is_err());
    assert_eq!(s.cron.config().min_stake, MIN_STAKE);
}

#[test]
fn only_owner_can_cancel_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "cancel_job",
            args: (id,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_cancel_job(&id).is_err());
    assert!(s.cron.get_job(&id).is_some());
}

#[test]
fn pausing_missing_job_fails() {
    let s = setup();
    assert_eq!(
        s.cron.try_set_job_active(&7, &false),
        Err(Ok(Error::JobNotFound))
    );
}

// ---------------------------------------------------------------------------
// Events (#14: every state change is checked against the event it emits)
// ---------------------------------------------------------------------------

/// Last event the registry emitted, as XDR, for comparison with `Event::to_xdr`.
pub(crate) fn last_event(s: &Setup) -> soroban_sdk::xdr::ContractEvent {
    s.env
        .events()
        .all()
        .filter_by_contract(&s.cron.address)
        .events()
        .last()
        .cloned()
        .expect("no event was emitted")
}

#[test]
fn job_created_event() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let expected = events::JobCreated {
        job_id: id,
        owner: s.owner.clone(),
        target: s.target.address.clone(),
        interval: INTERVAL,
        fee_per_run: FEE,
        deposit: 100,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn job_funded_event() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.fund_job(&s.owner, &id, &50);

    let expected = events::JobFunded {
        job_id: id,
        from: s.owner.clone(),
        amount: 50,
        balance: 150,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn job_executed_event() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.execute(&s.keeper, &id);

    // MockTarget::bump(1) on a fresh counter returns 1.
    let expected_result: Val = 1u32.into_val(&s.env);
    let result_hash = s
        .env
        .crypto()
        .sha256(&expected_result.to_xdr(&s.env))
        .to_bytes();

    let expected = events::JobExecuted {
        job_id: id,
        keeper: s.keeper.clone(),
        success: true,
        fee: FEE,
        protocol_fee: 0,
        run: 1,
        next_run: START + INTERVAL,
        lateness: 0,
        failures: 0,
        result_hash,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert!(emitted(&s, &expected));
}

#[test]
fn job_cancelled_event() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.cancel_job(&id);

    let expected = events::JobCancelled {
        job_id: id,
        refund: 100,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn keeper_staked_event() {
    let s = setup();
    let newcomer = Address::generate(&s.env);
    s.sac.mint(&newcomer, &MIN_STAKE);
    s.cron.stake(&newcomer, &MIN_STAKE);

    let expected = events::KeeperStaked {
        keeper: newcomer,
        amount: MIN_STAKE,
        total: MIN_STAKE,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn keeper_unbonding_event() {
    let s = setup();
    let withdrawable_at = s.cron.begin_unbonding(&s.keeper);

    let expected = events::KeeperUnbonding {
        keeper: s.keeper.clone(),
        withdrawable_at,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn keeper_withdrawn_event() {
    let s = setup();
    s.cron.begin_unbonding(&s.keeper);
    advance(&s.env, UNBONDING);
    s.cron.withdraw_stake(&s.keeper);

    let expected = events::KeeperWithdrawn {
        keeper: s.keeper.clone(),
        amount: MIN_STAKE,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn paused_set_event() {
    let s = setup();
    s.cron.set_paused(&true);

    let expected = events::PausedSet { paused: true }.to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

#[test]
fn min_stake_set_event() {
    let s = setup();
    s.cron.set_min_stake(&(MIN_STAKE + 1));

    let expected = events::MinStakeSet {
        min_stake: MIN_STAKE + 1,
    }
    .to_xdr(&s.env, &s.cron.address);
    assert_eq!(last_event(&s), expected);
}

// ---------------------------------------------------------------------------
// Batch creation
// ---------------------------------------------------------------------------

#[test]
fn create_jobs_escrows_total_in_one_transfer_and_returns_ids_in_order() {
    let s = setup();
    let jobs = vec![&s.env, params(&s), params(&s), params(&s)];
    let deposits = vec![&s.env, 100_i128, 200, 300];

    let ids = s.cron.create_jobs(&s.owner, &jobs, &deposits);

    assert_eq!(ids, vec![&s.env, 0_u64, 1, 2]);
    assert_eq!(s.token.balance(&s.owner), INITIAL_BALANCE - 600);
    assert_eq!(s.cron.get_job(&1).unwrap().balance, 200);
    assert_eq!(s.cron.jobs_by_owner(&s.owner), ids);
}

#[test]
fn create_jobs_is_all_or_nothing() {
    let s = setup();
    let mut bad = params(&s);
    bad.interval = 0;
    let jobs = vec![&s.env, params(&s), bad];
    let deposits = vec![&s.env, 100_i128, 100];

    assert_eq!(
        s.cron.try_create_jobs(&s.owner, &jobs, &deposits),
        Err(Ok(Error::InvalidInterval))
    );
    assert_eq!(s.cron.job_count(), 0);
    assert_eq!(s.token.balance(&s.owner), INITIAL_BALANCE);
}

#[test]
fn create_jobs_rejects_bad_batch_shapes() {
    let s = setup();
    let empty: Vec<JobParams> = Vec::new(&s.env);
    assert_eq!(
        s.cron.try_create_jobs(&s.owner, &empty, &Vec::new(&s.env)),
        Err(Ok(Error::InvalidBatchSize))
    );

    assert_eq!(
        s.cron.try_create_jobs(
            &s.owner,
            &vec![&s.env, params(&s)],
            &vec![&s.env, 100_i128, 100]
        ),
        Err(Ok(Error::LengthMismatch))
    );

    let mut jobs = Vec::new(&s.env);
    let mut deposits = Vec::new(&s.env);
    for _ in 0..=MAX_BATCH {
        jobs.push_back(params(&s));
        deposits.push_back(100_i128);
    }
    assert_eq!(
        s.cron.try_create_jobs(&s.owner, &jobs, &deposits),
        Err(Ok(Error::InvalidBatchSize))
    );
}

// ---------------------------------------------------------------------------
// Updating jobs
// ---------------------------------------------------------------------------

pub(crate) fn update_from(s: &Setup, job_id: u64) -> JobUpdate {
    let job = s.cron.get_job(&job_id).unwrap();
    JobUpdate {
        function: job.function,
        args: job.args,
        interval: job.interval,
        fee_per_run: job.fee_per_run,
        max_runs: job.max_runs,
        end_at: job.end_at,
        resolver: job.resolver,
        schedule: job.schedule,
        max_fee_per_run: job.max_fee_per_run,
        keepers: job.keepers,
        after: job.after,
    }
}

#[test]
fn update_job_changes_settings_and_keeps_schedule_and_balance() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.execute(&s.keeper, &id);
    let before = s.cron.get_job(&id).unwrap();

    let mut u = update_from(&s, id);
    u.args = vec![&s.env, 5u32.into_val(&s.env)];
    u.interval = 3_600;
    u.fee_per_run = 20;
    u.max_runs = 4;
    s.cron.update_job(&id, &u);

    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.interval, 3_600);
    assert_eq!(job.fee_per_run, 20);
    assert_eq!(job.max_runs, 4);
    assert_eq!(job.next_run, before.next_run);
    assert_eq!(job.balance, before.balance);
    assert_eq!(job.runs, 1);

    // The next run uses the new args and fee.
    advance(&s.env, INTERVAL);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.target.count(), 6);
    assert_eq!(s.cron.get_job(&id).unwrap().balance, before.balance - 20);
}

#[test]
fn update_job_validates_like_create_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let mut u = update_from(&s, id);
    u.interval = 0;
    assert_eq!(
        s.cron.try_update_job(&id, &u),
        Err(Ok(Error::InvalidInterval))
    );

    let mut u = update_from(&s, id);
    u.fee_per_run = 0;
    assert_eq!(s.cron.try_update_job(&id, &u), Err(Ok(Error::InvalidFee)));

    s.cron.set_min_interval(&120);
    let u = update_from(&s, id);
    assert_eq!(
        s.cron.try_update_job(&id, &u),
        Err(Ok(Error::IntervalTooShort))
    );

    assert_eq!(
        s.cron.try_update_job(&99, &update_from(&s, id)),
        Err(Ok(Error::JobNotFound))
    );
}

#[test]
fn only_owner_can_update_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    let u = update_from(&s, id);
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "update_job",
            args: (id, u.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_update_job(&id, &u).is_err());
}

#[test]
fn job_updated_event() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    let mut u = update_from(&s, id);
    u.end_at = START + 1_000;
    s.cron.update_job(&id, &u);

    assert_eq!(
        last_event(&s),
        events::JobUpdated {
            job_id: id,
            interval: INTERVAL,
            fee_per_run: FEE,
            max_runs: 0,
            end_at: START + 1_000,
        }
        .to_xdr(&s.env, &s.cron.address)
    );
}

// ---------------------------------------------------------------------------
// Batch execution and failing targets
// ---------------------------------------------------------------------------

pub(crate) fn failing_params(s: &Setup) -> JobParams {
    let mut p = params(s);
    p.function = Symbol::new(&s.env, "fail");
    p.args = Vec::new(&s.env);
    p
}

#[test]
fn failing_target_is_charged_and_recorded() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &failing_params(&s), &100);
    let keeper_before = s.token.balance(&s.keeper);

    s.cron.execute(&s.keeper, &id);

    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.runs, 1);
    assert_eq!(job.failures, 1);
    assert_eq!(job.balance, 100 - FEE);
    assert_eq!(job.next_run, START + INTERVAL);
    assert!(job.active);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + FEE);
    assert_eq!(s.cron.get_keeper(&s.keeper).unwrap().executions, 1);
}

#[test]
fn execute_batch_runs_due_jobs_and_skips_the_rest() {
    let s = setup();
    let due = s.cron.create_job(&s.owner, &params(&s), &100);

    let mut later = params(&s);
    later.start_at = START + 1_000;
    let not_due = s.cron.create_job(&s.owner, &later, &100);

    let broken = s.cron.create_job(&s.owner, &failing_params(&s), &100);
    let due_too = s.cron.create_job(&s.owner, &params(&s), &100);
    let keeper_before = s.token.balance(&s.keeper);

    let ran = s
        .cron
        .execute_batch(&s.keeper, &vec![&s.env, due, not_due, broken, 999, due_too]);

    // The broken job runs too: its failure is recorded and charged.
    assert_eq!(ran, vec![&s.env, true, false, true, false, true]);
    assert_eq!(s.target.count(), 2);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + 3 * FEE);
    assert_eq!(s.cron.get_keeper(&s.keeper).unwrap().executions, 3);
    assert_eq!(s.cron.get_job(&broken).unwrap().balance, 100 - FEE);
    assert_eq!(s.cron.get_job(&broken).unwrap().failures, 1);
    assert_eq!(s.cron.get_job(&not_due).unwrap().runs, 0);
}

#[test]
fn execute_batch_with_nothing_due_pays_nothing() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);
    s.cron.execute(&s.keeper, &id);
    let keeper_before = s.token.balance(&s.keeper);

    let ran = s.cron.execute_batch(&s.keeper, &vec![&s.env, id]);
    assert_eq!(ran, vec![&s.env, false]);
    assert_eq!(s.token.balance(&s.keeper), keeper_before);
}

#[test]
fn execute_batch_checks_keeper_and_batch_size() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.cron.try_execute_batch(&stranger, &vec![&s.env, id]),
        Err(Ok(Error::KeeperNotFound))
    );
    assert_eq!(
        s.cron.try_execute_batch(&s.keeper, &Vec::new(&s.env)),
        Err(Ok(Error::InvalidBatchSize))
    );

    let mut ids = Vec::new(&s.env);
    for _ in 0..=MAX_BATCH {
        ids.push_back(id);
    }
    assert_eq!(
        s.cron.try_execute_batch(&s.keeper, &ids),
        Err(Ok(Error::InvalidBatchSize))
    );

    s.cron.set_paused(&true);
    assert_eq!(
        s.cron.try_execute_batch(&s.keeper, &vec![&s.env, id]),
        Err(Ok(Error::Paused))
    );
}

#[test]
fn same_job_twice_in_a_batch_runs_once() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &100);

    let ran = s.cron.execute_batch(&s.keeper, &vec![&s.env, id, id]);
    assert_eq!(ran, vec![&s.env, true, false]);
    assert_eq!(s.cron.get_job(&id).unwrap().runs, 1);
}

// ---------------------------------------------------------------------------
// Upgrades
// ---------------------------------------------------------------------------

#[test]
fn version_is_exposed() {
    let s = setup();
    assert_eq!(s.cron.version(), VERSION);
}

#[test]
fn only_admin_can_propose_an_upgrade() {
    let s = setup();
    let hash = BytesN::from_array(&s.env, &[7; 32]);
    let stranger = Address::generate(&s.env);

    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "propose_upgrade",
            args: (hash.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.cron.try_propose_upgrade(&hash).is_err());
}
