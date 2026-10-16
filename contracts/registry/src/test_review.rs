//! Second-round review leads from KupiaSec (October 2026):
//!
//! 1. `update_job` and the keeper rotation can change who a live job's run is
//!    assigned to mid-window. No change may strand a job's balance or charge
//!    a miss to a keeper that wasn't assigned for its whole window.
//! 2. `execute_batch` must do exactly what the same `execute` calls would do
//!    one after another, including per-job checks that depend on state an
//!    earlier job in the batch changed.
//! 3. The executor split must keep every job away from escrowed fees and
//!    stakes: no target, and nobody but the registry, can make it move them.

extern crate std;

use crate::test::*;
use crate::{Error, JobUpdate};
use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::TokenClient,
    vec, Address, Env, IntoVal, Symbol, Val,
};
use sorocron_executor::{Executor, ExecutorClient};

const GRACE: u64 = 30;

/// The registry's token balance equals what it owes: every job's balance
/// plus every keeper's stake (fees and stakes share one token here).
fn assert_books_balance(s: &Setup, keepers: &[&Address]) {
    let jobs: i128 = s.cron.get_jobs(&0, &100).iter().map(|j| j.balance).sum();
    let stakes: i128 = keepers
        .iter()
        .map(|k| s.cron.get_keeper(k).map_or(0, |i| i.stake))
        .sum();
    assert_eq!(
        s.token.balance(&s.cron.address),
        jobs + stakes,
        "books don't balance"
    );
}

fn staked_keeper(s: &Setup) -> Address {
    let k = Address::generate(&s.env);
    s.sac.mint(&k, &INITIAL_BALANCE);
    s.cron.stake(&k, &MIN_STAKE);
    k
}

fn missed(s: &Setup, keeper: &Address) -> u32 {
    s.cron.keeper_stats(keeper).unwrap().missed
}

// ---------------------------------------------------------------------------
// Lead 1: changes mid-window
// ---------------------------------------------------------------------------

#[test]
fn an_allowlist_swap_mid_window_restarts_the_window_for_the_new_assignee() {
    let s = setup();
    let owner_keeper = staked_keeper(&s);
    s.cron.set_keeper_windows(&GRACE);
    // The owner, also a keeper, runs jobs only it may run, then adds the
    // victim to a job's allowlist part way through the run's window.
    let mut p = params(&s);
    p.keepers = Some(vec![&s.env, owner_keeper.clone()]);
    let mut target = None;
    for _ in 0..32 {
        let id = s.cron.create_job(&s.owner, &p, &1_000);
        let mut update = update_from(&s, id);
        update.keepers = Some(vec![&s.env, owner_keeper.clone(), s.keeper.clone()]);
        // Find a job whose next run would be assigned to the victim once it's listed.
        let probe = s.env.as_contract(&s.cron.address, || {
            let (spec, state) = crate::storage::get_job_parts(&s.env, id).unwrap();
            let mut spec = spec;
            spec.keepers = update.keepers.clone();
            let config = crate::storage::load_config(&s.env);
            crate::assigned_keeper_for(&s.env, &config, id, &spec, &state)
        });
        if probe == Some(s.keeper.clone()) {
            target = Some((id, update));
            break;
        }
    }
    let (id, update) = target.expect("a job that would be assigned to the victim");
    advance(&s.env, GRACE - 10);
    s.cron.update_job(&id, &update);
    assert_eq!(s.cron.assigned_keeper(&id), Some(s.keeper.clone()));

    // The run's window (from its due time) is over, so the owner may run it,
    // but the victim was assigned for only 11 seconds: no miss.
    advance(&s.env, 11);
    s.cron.execute(&owner_keeper, &id);
    assert_eq!(missed(&s, &s.keeper), 0);
    assert_books_balance(&s, &[&s.keeper, &owner_keeper]);
}

/// `update_job` input that keeps every setting of `id` as it is.
fn update_from(s: &Setup, id: u64) -> JobUpdate {
    let j = s.cron.get_job(&id).unwrap();
    JobUpdate {
        function: j.function,
        args: j.args,
        interval: j.interval,
        schedule: j.schedule,
        fee_per_run: j.fee_per_run,
        max_fee_per_run: j.max_fee_per_run,
        max_runs: j.max_runs,
        end_at: j.end_at,
        resolver: j.resolver,
        keepers: j.keepers,
        after: j.after,
    }
}

#[test]
fn a_keeper_moved_into_a_window_by_someone_elses_stake_isnt_charged_a_miss() {
    let s = setup();
    let other = staked_keeper(&s);
    s.cron.set_keeper_windows(&GRACE);
    let ids: std::vec::Vec<u64> = (0..24)
        .map(|_| s.cron.create_job(&s.owner, &params(&s), &1_000))
        .collect();

    // 20 seconds into every run's window a new keeper stakes, which reshuffles
    // the rotation: some runs are now assigned to keepers that weren't before.
    advance(&s.env, GRACE - 10);
    let before: std::vec::Vec<_> = ids.iter().map(|id| s.cron.assigned_keeper(id)).collect();
    let newcomer = staked_keeper(&s);
    let moved: std::vec::Vec<u64> = ids
        .iter()
        .zip(&before)
        .filter(|(id, was)| {
            let now = s.cron.assigned_keeper(id);
            now.is_some() && now != **was && now != Some(other.clone())
        })
        .map(|(id, _)| *id)
        .collect();
    assert!(!moved.is_empty(), "the stake moved no run to a new keeper");

    // Past the due-time window, `other` runs them all: those moved keepers had
    // less than a whole window, so nothing is recorded against them.
    advance(&s.env, 11);
    for id in &moved {
        s.cron.execute(&other, id);
    }
    assert_eq!(missed(&s, &s.keeper), 0);
    assert_eq!(missed(&s, &newcomer), 0);
    assert_books_balance(&s, &[&s.keeper, &other, &newcomer]);
}

#[test]
fn a_whole_window_after_a_rotation_change_still_counts() {
    let s = setup();
    let other = staked_keeper(&s);
    s.cron.set_keeper_windows(&GRACE);
    let _newcomer = staked_keeper(&s);
    // A job assigned to the victim, with the rotation now settled.
    let id = loop {
        let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
        if s.cron.assigned_keeper(&id) == Some(s.keeper.clone()) {
            break id;
        }
    };
    advance(&s.env, GRACE);
    s.cron.execute(&other, &id);
    assert_eq!(missed(&s, &s.keeper), 1, "an honest miss must still count");
}

#[test]
fn turning_windows_on_doesnt_charge_misses_for_runs_already_overdue() {
    let s = setup();
    let other = staked_keeper(&s);
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    // Overdue for an hour before the admin turns windows on. The run stays
    // open to everyone (re-reserving overdue runs would let anyone delay
    // jobs by changing the rotation), but its assigned keeper never had a
    // window, so running it isn't a miss.
    advance(&s.env, 3_600);
    s.cron.set_keeper_windows(&GRACE);
    let assigned = s.cron.assigned_keeper(&id).unwrap();
    let runner = if assigned == s.keeper {
        other.clone()
    } else {
        s.keeper.clone()
    };
    s.cron.execute(&runner, &id);
    assert_eq!(missed(&s, &assigned), 0);

    // From then on, whole windows count again.
    let next = loop {
        let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
        if s.cron.assigned_keeper(&id) == Some(assigned.clone()) {
            break id;
        }
    };
    advance(&s.env, GRACE);
    s.cron.execute(&runner, &next);
    assert_eq!(missed(&s, &assigned), 1);
}

#[test]
fn lowering_the_minimum_stake_doesnt_charge_newly_eligible_keepers() {
    let s = setup();
    s.cron.set_keeper_windows(&GRACE);
    // A keeper below the minimum is in the rotation but can't be assigned.
    let small = Address::generate(&s.env);
    s.sac.mint(&small, &INITIAL_BALANCE);
    s.cron.stake(&small, &(MIN_STAKE / 2));
    let ids: std::vec::Vec<u64> = (0..16)
        .map(|_| s.cron.create_job(&s.owner, &params(&s), &1_000))
        .collect();
    advance(&s.env, GRACE - 10);
    s.cron.set_min_stake(&(MIN_STAKE / 2));
    let now_small: std::vec::Vec<u64> = ids
        .iter()
        .filter(|id| s.cron.assigned_keeper(id) == Some(small.clone()))
        .copied()
        .collect();
    assert!(!now_small.is_empty());
    advance(&s.env, 11);
    for id in &now_small {
        s.cron.execute(&s.keeper, id);
    }
    assert_eq!(missed(&s, &small), 0);
}

#[test]
fn updating_a_live_job_never_strands_its_balance() {
    let s = setup();
    s.cron.set_keeper_windows(&GRACE);
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    advance(&s.env, GRACE - 10);
    // Mid-window the owner raises the fee above the balance and swaps the
    // allowlist to a keeper that isn't staked: nobody can run it now...
    let mut update = update_from(&s, id);
    update.fee_per_run = 5_000;
    update.max_fee_per_run = 0;
    update.keepers = Some(vec![&s.env, Address::generate(&s.env)]);
    s.cron.update_job(&id, &update);
    advance(&s.env, GRACE);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::InsufficientJobBalance))
    );
    // ...and the whole balance is still the owner's to take back.
    let before = s.token.balance(&s.owner);
    s.cron.withdraw_job_balance(&id, &1_000);
    assert_eq!(s.token.balance(&s.owner), before + 1_000);
    assert_eq!(missed(&s, &s.keeper), 0);
    assert_books_balance(&s, &[&s.keeper]);
}

// ---------------------------------------------------------------------------
// Lead 2: batched order
// ---------------------------------------------------------------------------

#[test]
fn a_job_listed_twice_in_a_batch_runs_once() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let ran = s.cron.execute_batch(&s.keeper, &vec![&s.env, id, id]);
    assert_eq!(ran, vec![&s.env, true, false]);
    assert_eq!(s.cron.get_job(&id).unwrap().runs, 1);
    assert_eq!(
        s.token.balance(&s.keeper),
        INITIAL_BALANCE - MIN_STAKE + FEE
    );
    assert_books_balance(&s, &[&s.keeper]);
}

#[test]
fn a_follower_runs_in_the_same_batch_only_after_its_leader() {
    let s = setup();
    let leader = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let mut p = params(&s);
    p.after = Some(leader);
    let follower = s.cron.create_job(&s.owner, &p, &1_000);
    // Follower first: its leader hasn't run again yet, so it's skipped.
    let ran = s
        .cron
        .execute_batch(&s.keeper, &vec![&s.env, follower, leader]);
    assert_eq!(ran, vec![&s.env, false, true]);
    advance(&s.env, INTERVAL);
    // Leader first: the follower sees that run and goes in the same batch.
    let ran = s
        .cron
        .execute_batch(&s.keeper, &vec![&s.env, leader, follower]);
    assert_eq!(ran, vec![&s.env, true, true]);
    assert_eq!(s.cron.get_job(&follower).unwrap().runs, 1);
}

/// One job in a generated world.
#[derive(Clone, Debug)]
struct JobPlan {
    ramp: bool,
    max_runs: u32,
    /// `Some(ready)`: a resolver that answers `ready`.
    resolver: Option<bool>,
    follow_previous: bool,
    /// Bit `i` allows keeper `i`; `0` allows any staked keeper.
    allow: u8,
    funded_runs: i128,
    start_offset: u64,
}

#[derive(Clone, Debug)]
struct World {
    jobs: std::vec::Vec<JobPlan>,
    /// Indices into `jobs`, repeats allowed.
    batch: std::vec::Vec<usize>,
    windows: bool,
    protocol_fee: bool,
    elapsed: u64,
    caller: usize,
}

fn job_plan() -> impl Strategy<Value = JobPlan> {
    (
        any::<bool>(),
        0u32..3,
        prop::option::of(any::<bool>()),
        any::<bool>(),
        0u8..8,
        1i128..4,
        prop::sample::select(std::vec![0u64, 0, 30, 400]),
    )
        .prop_map(
            |(ramp, max_runs, resolver, follow_previous, allow, funded_runs, start_offset)| {
                JobPlan {
                    ramp,
                    max_runs,
                    resolver,
                    follow_previous,
                    allow,
                    funded_runs,
                    start_offset,
                }
            },
        )
}

fn world() -> impl Strategy<Value = World> {
    prop::collection::vec(job_plan(), 1..6).prop_flat_map(|jobs| {
        let n = jobs.len();
        (
            Just(jobs),
            prop::collection::vec(0..n, 1..8),
            any::<bool>(),
            any::<bool>(),
            prop::sample::select(std::vec![0u64, 10, 31, 90, 500]),
            0usize..3,
        )
            .prop_map(
                |(jobs, batch, windows, protocol_fee, elapsed, caller)| World {
                    jobs,
                    batch,
                    windows,
                    protocol_fee,
                    elapsed,
                    caller,
                },
            )
    })
}

/// Builds `w` in a fresh environment: three staked keepers, the jobs, and
/// the time passed. Returns the setup, keepers, treasury and job ids.
fn build(w: &World) -> (Setup, [Address; 3], Address, std::vec::Vec<u64>) {
    let s = setup();
    let keepers = [s.keeper.clone(), staked_keeper(&s), staked_keeper(&s)];
    let treasury = Address::generate(&s.env);
    if w.windows {
        s.cron.set_keeper_windows(&GRACE);
    }
    if w.protocol_fee {
        s.cron.set_protocol_fee(&500, &Some(treasury.clone()));
    }
    let mut ids = std::vec::Vec::new();
    for (i, plan) in w.jobs.iter().enumerate() {
        let mut p = params(&s);
        if plan.ramp {
            p.max_fee_per_run = FEE * 3;
        }
        p.max_runs = plan.max_runs;
        p.start_at = s.env.ledger().timestamp() + plan.start_offset;
        if let Some(ready) = plan.resolver {
            let r = MockResolverClient::new(&s.env, &s.env.register(MockResolver, ()));
            r.set_ready(&ready);
            p.resolver = Some(r.address.clone());
        }
        if plan.follow_previous && i > 0 {
            p.after = Some(ids[i - 1]);
        }
        if plan.allow != 0 {
            let mut list = vec![&s.env];
            for (k, keeper) in keepers.iter().enumerate() {
                if plan.allow & (1 << k) != 0 {
                    list.push_back(keeper.clone());
                }
            }
            p.keepers = Some(list);
        }
        ids.push(s.cron.create_job(&s.owner, &p, &(FEE * plan.funded_runs)));
    }
    advance(&s.env, w.elapsed);
    (s, keepers, treasury, ids)
}

/// Everything a run can change, in a form two environments can compare.
fn snapshot(
    s: &Setup,
    keepers: &[Address; 3],
    treasury: &Address,
    ids: &[u64],
) -> std::vec::Vec<std::string::String> {
    let mut out = std::vec::Vec::new();
    for id in ids {
        out.push(std::format!("job {id}: {:?}", s.cron.get_job_state(id)));
    }
    for (i, k) in keepers.iter().enumerate() {
        out.push(std::format!(
            "keeper {i}: {:?} balance {}",
            s.cron.keeper_stats(k),
            s.token.balance(k)
        ));
    }
    out.push(std::format!("treasury {}", s.token.balance(treasury)));
    out.push(std::format!(
        "registry {}",
        s.token.balance(&s.cron.address)
    ));
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]

    #[test]
    fn a_batch_does_exactly_what_the_same_executes_in_order_do(w in world()) {
        let (batched, keepers_b, treasury_b, ids_b) = build(&w);
        let order: std::vec::Vec<u64> = w.batch.iter().map(|&i| ids_b[i]).collect();
        let mut list = vec![&batched.env];
        for id in &order {
            list.push_back(*id);
        }
        let ran_b = batched.cron.execute_batch(&keepers_b[w.caller], &list);

        let (single, keepers_s, treasury_s, ids_s) = build(&w);
        let ran_s: std::vec::Vec<bool> = w
            .batch
            .iter()
            .map(|&i| single.cron.try_execute(&keepers_s[w.caller], &ids_s[i]).is_ok())
            .collect();

        prop_assert_eq!(ran_b.iter().collect::<std::vec::Vec<_>>(), ran_s);
        prop_assert_eq!(
            snapshot(&batched, &keepers_b, &treasury_b, &ids_b),
            snapshot(&single, &keepers_s, &treasury_s, &ids_s)
        );
    }
}

// ---------------------------------------------------------------------------
// Lead 3: executor isolation
// ---------------------------------------------------------------------------

/// A job target that tries to spend the registry's tokens.
#[contract]
pub struct Grabber;

#[contractimpl]
impl Grabber {
    pub fn transfer(env: Env, token: Address, registry: Address, to: Address, amount: i128) {
        TokenClient::new(&env, &token).transfer(&registry, &to, &amount);
    }

    pub fn approve(env: Env, token: Address, registry: Address, to: Address, amount: i128) {
        TokenClient::new(&env, &token).approve(&registry, &to, &amount, &1_000_000);
    }

    pub fn burn(env: Env, token: Address, registry: Address, amount: i128) {
        TokenClient::new(&env, &token).burn(&registry, &amount);
    }

    /// Asks the executor to make the call for it, as if it were the registry.
    pub fn relay(env: Env, executor: Address, token: Address, registry: Address, to: Address) {
        let args = vec![
            &env,
            registry.into_val(&env),
            to.into_val(&env),
            1_000i128.into_val(&env),
        ];
        ExecutorClient::new(&env, &executor).execute(&token, &Symbol::new(&env, "transfer"), &args);
    }
}

/// Runs `id` with only the keeper's authorization of the registry call, as
/// on-chain: no other address has signed anything.
fn execute_signed_by_keeper_only(s: &Setup, id: u64) {
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
}

#[test]
fn no_job_target_can_move_the_registrys_tokens() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    let grabber = s.env.register(Grabber, ());
    let executor = s.cron.config().executor.unwrap();
    let token = s.token.address.clone();
    let registry = s.cron.address.clone();
    let calls = [
        (
            "transfer",
            vec![
                &s.env,
                token.into_val(&s.env),
                registry.into_val(&s.env),
                attacker.into_val(&s.env),
                500i128.into_val(&s.env),
            ],
        ),
        (
            "approve",
            vec![
                &s.env,
                token.into_val(&s.env),
                registry.into_val(&s.env),
                attacker.into_val(&s.env),
                500i128.into_val(&s.env),
            ],
        ),
        (
            "burn",
            vec![
                &s.env,
                token.into_val(&s.env),
                registry.into_val(&s.env),
                500i128.into_val(&s.env),
            ],
        ),
        (
            "relay",
            vec![
                &s.env,
                executor.into_val(&s.env),
                token.into_val(&s.env),
                registry.into_val(&s.env),
                attacker.into_val(&s.env),
            ],
        ),
    ];
    let mut ids = std::vec::Vec::new();
    for (function, args) in calls {
        let mut p = params(&s);
        p.target = grabber.clone();
        p.function = Symbol::new(&s.env, function);
        p.args = args;
        ids.push(s.cron.create_job(&s.owner, &p, &1_000));
    }
    let held = s.token.balance(&registry);

    for id in &ids {
        execute_signed_by_keeper_only(&s, *id);
        // The run happened, and failed: the keeper is paid from the job's own
        // balance, the target got nothing.
        let job = s.cron.get_job(id).unwrap();
        assert_eq!((job.runs, job.failures), (1, 1));
    }
    s.env.mock_all_auths();
    assert_eq!(s.token.balance(&attacker), 0);
    assert_eq!(s.token.allowance(&registry, &attacker), 0);
    assert_eq!(s.token.balance(&registry), held - 4 * FEE);
    assert_books_balance(&s, &[&s.keeper]);
}

#[test]
fn nobody_but_the_registry_can_drive_the_executor() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    let executor = ExecutorClient::new(&s.env, &s.cron.config().executor.unwrap());
    let args = vec![
        &s.env,
        s.cron.address.into_val(&s.env),
        attacker.into_val(&s.env),
        1_000i128.into_val(&s.env),
    ];
    // The attacker signs its own call; the executor wants the registry's.
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &executor.address,
            fn_name: "execute",
            args: (
                s.token.address.clone(),
                Symbol::new(&s.env, "transfer"),
                args.clone(),
            )
                .into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(executor
        .try_execute(&s.token.address, &Symbol::new(&s.env, "transfer"), &args)
        .is_err());
    s.env.mock_all_auths();
    assert_eq!(s.token.balance(&attacker), 0);
}

#[test]
fn a_job_aimed_at_the_executor_before_it_was_connected_never_runs() {
    let s = setup_without_executor();
    // The executor's address is known before the admin connects it.
    let executor = s.env.register(Executor, (s.cron.address.clone(),));
    let transfer: soroban_sdk::Vec<Val> = vec![
        &s.env,
        s.cron.address.into_val(&s.env),
        s.owner.into_val(&s.env),
        1i128.into_val(&s.env),
    ];
    let mut p = params(&s);
    p.target = executor.clone();
    p.function = Symbol::new(&s.env, "execute");
    p.args = vec![
        &s.env,
        s.token.address.into_val(&s.env),
        Symbol::new(&s.env, "transfer").into_val(&s.env),
        transfer.into_val(&s.env),
    ];
    let id = s.cron.create_job(&s.owner, &p, &1_000);
    s.cron.set_executor(&executor);

    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::ForbiddenTarget))
    );
    // The owner gets the deposit back.
    let before = s.token.balance(&s.owner);
    s.cron.cancel_job(&id);
    assert_eq!(s.token.balance(&s.owner), before + 1_000);
}
