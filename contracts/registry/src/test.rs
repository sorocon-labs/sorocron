use crate::{Error, JobParams, SoroCron, SoroCronClient};
use soroban_sdk::testutils::Deployer as _;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol, Val, Vec,
};
use sorocron_executor::Executor;
use sorocron_ttl_guardian::TtlGuardian;

const MIN_STAKE: i128 = 1_000;
const UNBONDING: u64 = 3_600;
const START: u64 = 1_700_000_000;
const FEE: i128 = 10;
const INTERVAL: u64 = 60;
const INITIAL_BALANCE: i128 = 1_000_000;

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

struct Setup {
    env: Env,
    cron: SoroCronClient<'static>,
    token: TokenClient<'static>,
    sac: StellarAssetClient<'static>,
    target: MockTargetClient<'static>,
    admin: Address,
    owner: Address,
    keeper: Address,
}

fn setup() -> Setup {
    let s = setup_without_executor();
    let executor_id = s.env.register(Executor, (s.cron.address.clone(),));
    s.cron.set_executor(&executor_id);
    s
}

fn setup_without_executor() -> Setup {
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

fn params(s: &Setup) -> JobParams {
    let args: Vec<Val> = vec![&s.env, 1u32.into_val(&s.env)];
    JobParams {
        target: s.target.address.clone(),
        function: Symbol::new(&s.env, "bump"),
        args,
        interval: INTERVAL,
        start_at: 0,
        fee_per_run: FEE,
        max_runs: 0,
        resolver: None,
    }
}

fn advance(env: &Env, seconds: u64) {
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
    assert!(s.cron.try_execute(&s.keeper, &malicious).is_err());

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
fn pausing_missing_job_fails() {
    let s = setup();
    assert_eq!(
        s.cron.try_set_job_active(&7, &false),
        Err(Ok(Error::JobNotFound))
    );
}
