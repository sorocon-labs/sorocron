//! Tests for the v4 registry features. Each section names the issue whose
//! acceptance criteria it covers.

extern crate std;

use crate::test::*;
use crate::{events, Error, Schedule, MAX_BPS, MAX_JOB_KEEPERS, VERSION};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    vec,
    xdr::{ContractEventBody, ScSymbol, ScVal},
    Address, Bytes, Env, Event as _, IntoVal, Symbol, Val, Vec,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Fails while its flag is set; otherwise returns how many times it ran.
#[contract]
pub struct FlakyTarget;

#[contractimpl]
impl FlakyTarget {
    pub fn set_failing(env: Env, failing: bool) {
        env.storage()
            .instance()
            .set(&symbol_short!("failing"), &failing);
    }

    pub fn run(env: Env) -> u32 {
        if env
            .storage()
            .instance()
            .get(&symbol_short!("failing"))
            .unwrap_or(false)
        {
            panic!("flaky target failed");
        }
        let n: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("n"))
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&symbol_short!("n"), &n);
        n
    }
}

fn flaky_params(s: &Setup) -> (Address, crate::JobParams) {
    let flaky = s.env.register(FlakyTarget, ());
    let mut p = params(s);
    p.target = flaky.clone();
    p.function = Symbol::new(&s.env, "run");
    p.args = Vec::new(&s.env);
    (flaky, p)
}

fn set_failing(s: &Setup, target: &Address, failing: bool) {
    s.env.invoke_contract::<()>(
        target,
        &Symbol::new(&s.env, "set_failing"),
        vec![&s.env, failing.into_val(&s.env)],
    );
}

/// A second keeper, funded and staked with `MIN_STAKE`.
fn new_keeper(s: &Setup) -> Address {
    let k = Address::generate(&s.env);
    s.sac.mint(&k, &INITIAL_BALANCE);
    s.cron.stake(&k, &MIN_STAKE);
    k
}

fn at(s: &Setup, timestamp: u64) {
    s.env.ledger().set_timestamp(timestamp);
}

// ---------------------------------------------------------------------------
// #7 Protocol fee to a treasury
// ---------------------------------------------------------------------------

#[test]
fn protocol_fee_is_split_from_each_run() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    s.cron.set_protocol_fee(&500, &Some(treasury.clone())); // 5%

    let mut p = params(&s);
    p.fee_per_run = 1_000;
    let id = s.cron.create_job(&s.owner, &p, &10_000);
    let keeper_before = s.token.balance(&s.keeper);

    s.cron.execute(&s.keeper, &id);

    assert_eq!(s.token.balance(&treasury), 50);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + 950);
    assert_eq!(s.cron.get_job(&id).unwrap().balance, 9_000);
}

#[test]
fn protocol_fee_rounds_down_on_tiny_fees() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    s.cron.set_protocol_fee(&MAX_BPS, &Some(treasury.clone()));

    let mut p = params(&s);
    p.fee_per_run = 1;
    let id = s.cron.create_job(&s.owner, &p, &10);
    let keeper_before = s.token.balance(&s.keeper);
    s.cron.execute(&s.keeper, &id);

    // 10% of 1 stroop rounds to 0: the keeper keeps the whole stroop.
    assert_eq!(s.token.balance(&treasury), 0);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + 1);
}

#[test]
fn protocol_fee_at_zero_and_maximum() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let mut p = params(&s);
    p.fee_per_run = 10_000;
    let id = s.cron.create_job(&s.owner, &p, &100_000);

    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.token.balance(&treasury), 0);

    s.cron.set_protocol_fee(&MAX_BPS, &Some(treasury.clone()));
    advance(&s.env, INTERVAL);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.token.balance(&treasury), 1_000);
}

#[test]
fn set_protocol_fee_validates() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    assert_eq!(
        s.cron
            .try_set_protocol_fee(&(MAX_BPS + 1), &Some(treasury.clone())),
        Err(Ok(Error::InvalidSetting))
    );
    assert_eq!(
        s.cron.try_set_protocol_fee(&100, &None),
        Err(Ok(Error::InvalidSetting))
    );
    s.cron.set_protocol_fee(&0, &None);
    let config = s.cron.config();
    assert_eq!(config.protocol_fee_bps, 0);
    assert_eq!(config.treasury, None);
}

// ---------------------------------------------------------------------------
// #8 / #66 Failure tracking, auto-deactivation and execution receipts
// ---------------------------------------------------------------------------

#[test]
fn always_failing_target_pauses_after_max_failures() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &failing_params(&s), &1_000);

    for run in 1..=3u32 {
        s.cron.execute(&s.keeper, &id);
        // Events are kept only for the latest call, so check before reading.
        let deactivated = events::JobDeactivated {
            job_id: id,
            failures: 3,
        }
        .to_xdr(&s.env, &s.cron.address);
        assert_eq!(emitted(&s, &deactivated), run == 3);
        let job = s.cron.get_job(&id).unwrap();
        assert_eq!(job.failures, run);
        assert_eq!(job.balance, 1_000 - FEE * run as i128);
        advance(&s.env, INTERVAL);
    }
    assert!(!s.cron.get_job(&id).unwrap().active);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobPaused))
    );

    // Resuming clears the count so the owner gets a fresh set of attempts.
    s.cron.set_job_active(&id, &true);
    assert_eq!(s.cron.get_job(&id).unwrap().failures, 0);
}

#[test]
fn flaky_target_resets_failures_on_success() {
    let s = setup();
    let (flaky, p) = flaky_params(&s);
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    set_failing(&s, &flaky, true);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.cron.get_job(&id).unwrap().failures, 1);

    set_failing(&s, &flaky, false);
    advance(&s.env, INTERVAL);
    s.cron.execute(&s.keeper, &id);
    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.failures, 0);
    assert_eq!(job.runs, 2);
    assert!(job.active);
}

#[test]
fn max_failures_zero_never_pauses() {
    let s = setup();
    s.cron.set_max_failures(&0);
    let id = s.cron.create_job(&s.owner, &failing_params(&s), &1_000);
    for _ in 0..5 {
        s.cron.execute(&s.keeper, &id);
        advance(&s.env, INTERVAL);
    }
    let job = s.cron.get_job(&id).unwrap();
    assert!(job.active);
    assert_eq!(job.failures, 5);
}

/// Fields of the most recent `job_executed` event, as XDR map entries.
fn last_receipt(s: &Setup) -> std::vec::Vec<(std::string::String, ScVal)> {
    let topic = ScVal::Symbol(ScSymbol("job_executed".try_into().unwrap()));
    let events = s.env.events().all().filter_by_contract(&s.cron.address);
    let event = events
        .events()
        .iter()
        .rev()
        .find(|e| {
            let ContractEventBody::V0(body) = &e.body;
            body.topics.first() == Some(&topic)
        })
        .cloned()
        .expect("JobExecuted was emitted");
    let ContractEventBody::V0(body) = event.body;
    let ScVal::Map(Some(map)) = body.data else {
        panic!("event data is a map")
    };
    map.iter()
        .map(|entry| {
            let ScVal::Symbol(key) = &entry.key else {
                panic!("symbol keys")
            };
            (key.to_utf8_string_lossy(), entry.val.clone())
        })
        .collect()
}

fn field(receipt: &[(std::string::String, ScVal)], name: &str) -> ScVal {
    receipt
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
        .expect(name)
}

#[test]
fn every_run_emits_a_receipt_with_its_outcome() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &failing_params(&s), &1_000);
    advance(&s.env, 7);
    s.cron.execute(&s.keeper, &id);

    let receipt = last_receipt(&s);
    assert_eq!(field(&receipt, "success"), ScVal::Bool(false));
    assert_eq!(field(&receipt, "lateness"), ScVal::U64(7));
    assert_eq!(field(&receipt, "failures"), ScVal::U32(1));
    assert_eq!(field(&receipt, "run"), ScVal::U32(1));

    let ok = s.cron.create_job(&s.owner, &params(&s), &1_000);
    s.cron.execute(&s.keeper, &ok);
    let receipt = last_receipt(&s);
    assert_eq!(field(&receipt, "success"), ScVal::Bool(true));
    assert_eq!(field(&receipt, "failures"), ScVal::U32(0));
}

// ---------------------------------------------------------------------------
// #12 Calendar schedules
// ---------------------------------------------------------------------------

/// 2023-11-14 00:00:00 UTC, a Tuesday.
const MIDNIGHT: u64 = 1_699_920_000;

fn daily(hour: u32, minute: u32) -> Schedule {
    Schedule::Daily(hour, minute)
}

#[test]
fn daily_calendar_runs_at_the_next_matching_time_across_midnight() {
    let s = setup();
    at(&s, MIDNIGHT - 30); // 23:59:30 the day before
    let mut p = params(&s);
    p.interval = 0;
    p.schedule = daily(0, 0);
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.next_run, MIDNIGHT);
    assert_eq!(job.interval, 86_400);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::JobNotDue))
    );

    at(&s, MIDNIGHT);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.cron.get_job(&id).unwrap().next_run, MIDNIGHT + 86_400);
}

#[test]
fn calendar_job_keeps_its_time_after_missed_runs() {
    let s = setup();
    at(&s, MIDNIGHT);
    let mut p = params(&s);
    p.interval = 0;
    p.schedule = daily(12, 0);
    let id = s.cron.create_job(&s.owner, &p, &1_000);
    assert_eq!(s.cron.get_job(&id).unwrap().next_run, MIDNIGHT + 12 * 3_600);

    // Keepers were offline for three days and a few hours.
    at(&s, MIDNIGHT + 3 * 86_400 + 17 * 3_600);
    s.cron.execute(&s.keeper, &id);
    let next = s.cron.get_job(&id).unwrap().next_run;
    assert_eq!(next, MIDNIGHT + 4 * 86_400 + 12 * 3_600);
    assert_eq!(next % 86_400, 12 * 3_600);
}

#[test]
fn weekly_calendar_runs_on_the_requested_weekday() {
    let s = setup();
    at(&s, MIDNIGHT); // Tuesday
    let mut p = params(&s);
    p.interval = 0;
    p.schedule = Schedule::Weekly(0, 9, 30); // Monday 09:30
    let id = s.cron.create_job(&s.owner, &p, &1_000);
    let job = s.cron.get_job(&id).unwrap();
    // Next Monday is 6 days after Tuesday.
    assert_eq!(job.next_run, MIDNIGHT + 6 * 86_400 + 9 * 3_600 + 30 * 60);
    assert_eq!(job.interval, 7 * 86_400);
}

#[test]
fn invalid_calendars_are_rejected() {
    let s = setup();
    for (interval, cal) in [
        (60u64, daily(1, 0)),
        (0, daily(24, 0)),
        (0, daily(0, 60)),
        (0, Schedule::Weekly(7, 0, 0)),
    ] {
        let mut p = params(&s);
        p.interval = interval;
        p.schedule = cal;
        assert_eq!(
            s.cron.try_create_job(&s.owner, &p, &100),
            Err(Ok(Error::InvalidCalendar))
        );
    }
}

#[test]
fn update_job_to_a_new_calendar_reschedules() {
    let s = setup();
    at(&s, MIDNIGHT);
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let mut u = update_from(&s, id);
    u.interval = 0;
    u.schedule = daily(6, 0);
    s.cron.update_job(&id, &u);
    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.next_run, MIDNIGHT + 6 * 3_600);
    assert_eq!(job.schedule, daily(6, 0));
}

// ---------------------------------------------------------------------------
// #63 Priority fee ramp
// ---------------------------------------------------------------------------

#[test]
fn fee_ramps_with_lateness_up_to_the_ceiling() {
    let s = setup();
    let mut p = params(&s);
    p.fee_per_run = 10;
    p.max_fee_per_run = 20;
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    assert_eq!(s.cron.current_fee(&id), Some(10));
    advance(&s.env, INTERVAL / 2);
    assert_eq!(s.cron.current_fee(&id), Some(15));
    advance(&s.env, INTERVAL * 5);
    assert_eq!(s.cron.current_fee(&id), Some(20));

    let keeper_before = s.token.balance(&s.keeper);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + 20);
    assert_eq!(s.cron.get_job(&id).unwrap().balance, 980);
}

#[test]
fn ramped_fee_never_exceeds_the_balance() {
    let s = setup();
    let mut p = params(&s);
    p.fee_per_run = 10;
    p.max_fee_per_run = 1_000;
    let id = s.cron.create_job(&s.owner, &p, &25);
    advance(&s.env, INTERVAL * 10);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.cron.get_job(&id).unwrap().balance, 0);
}

#[test]
fn fee_ceiling_below_base_fee_is_rejected() {
    let s = setup();
    let mut p = params(&s);
    p.fee_per_run = 10;
    p.max_fee_per_run = 9;
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::InvalidSetting))
    );
}

// ---------------------------------------------------------------------------
// #38 Keeper allowlist
// ---------------------------------------------------------------------------

#[test]
fn allowlisted_job_only_runs_for_listed_keepers() {
    let s = setup();
    let outsider = new_keeper(&s);
    let mut p = params(&s);
    p.keepers = Some(vec![&s.env, s.keeper.clone()]);
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    assert_eq!(
        s.cron.try_execute(&outsider, &id),
        Err(Ok(Error::KeeperNotAllowed))
    );
    s.cron.execute(&s.keeper, &id);

    // `None` opens the job to everyone.
    let open = s.cron.create_job(&s.owner, &params(&s), &1_000);
    s.cron.execute(&outsider, &open);
}

#[test]
fn allowlist_size_is_bounded() {
    let s = setup();
    let mut list = Vec::new(&s.env);
    for _ in 0..=MAX_JOB_KEEPERS {
        list.push_back(Address::generate(&s.env));
    }
    let mut p = params(&s);
    p.keepers = Some(list);
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &100),
        Err(Ok(Error::TooManyKeepers))
    );
}

// ---------------------------------------------------------------------------
// #2 Assigned keeper windows and #3 slashing
// ---------------------------------------------------------------------------

const GRACE: u64 = 30;

/// Two staked keepers with windows on; returns (job id, assigned, other).
fn windowed_job(s: &Setup, slash_bps: u32) -> (u64, Address, Address) {
    let second = new_keeper(s);
    s.cron.set_keeper_windows(&GRACE, &slash_bps);
    let id = s.cron.create_job(&s.owner, &params(s), &1_000);
    let assigned = s.cron.assigned_keeper(&id).expect("windows are on");
    let other = if assigned == s.keeper {
        second
    } else {
        s.keeper.clone()
    };
    (id, assigned, other)
}

#[test]
fn only_the_assigned_keeper_may_run_inside_the_window() {
    let s = setup();
    let (id, assigned, other) = windowed_job(&s, 0);

    assert_eq!(
        s.cron.try_execute(&other, &id),
        Err(Ok(Error::NotAssignedKeeper))
    );
    s.cron.execute(&assigned, &id);
}

#[test]
fn anyone_may_run_after_the_window_and_the_assigned_keeper_is_slashed() {
    let s = setup();
    let (id, assigned, other) = windowed_job(&s, 1_000); // 10%
    let other_before = s.token.balance(&other);

    advance(&s.env, GRACE);
    s.cron.execute(&other, &id);
    let slashed_event = emitted(
        &s,
        &events::KeeperSlashed {
            keeper: assigned.clone(),
            job_id: id,
            amount: 100,
            remaining: MIN_STAKE - 100,
            beneficiary: other.clone(),
        }
        .to_xdr(&s.env, &s.cron.address),
    );
    assert!(slashed_event);

    let missed = s.cron.get_keeper(&assigned).unwrap();
    assert_eq!(missed.stake, MIN_STAKE - 100);
    assert_eq!(missed.slashed, 100);
    assert_eq!(missed.missed, 1);
    // Fee and token are the same here: other gets the run fee plus the slash.
    assert_eq!(s.token.balance(&other), other_before + FEE + 100);
}

#[test]
fn slashed_keeper_below_min_stake_loses_its_windows() {
    let s = setup();
    let (id, assigned, other) = windowed_job(&s, 1_000);
    advance(&s.env, GRACE);
    s.cron.execute(&other, &id);

    let stats = s.cron.keeper_stats(&assigned).unwrap();
    assert!(!stats.eligible);
    assert_eq!(
        s.cron.try_execute(&assigned, &id),
        Err(Ok(Error::InsufficientStake))
    );

    // From now on the ineligible keeper is never reserved a run, so `other`
    // can run every one of them on time and nobody is slashed again.
    for _ in 0..8 {
        advance(&s.env, INTERVAL);
        assert_ne!(s.cron.assigned_keeper(&id), Some(assigned.clone()));
        s.cron.execute(&other, &id);
    }
    let after = s.cron.get_keeper(&assigned).unwrap();
    assert_eq!(after.missed, 1);
    assert_eq!(after.slashed, 100);
}

#[test]
fn unbonding_keeper_is_never_assigned_or_slashed() {
    let s = setup();
    let (id, assigned, other) = windowed_job(&s, 1_000);
    s.cron.begin_unbonding(&assigned);

    assert!(!s.cron.active_keepers().contains(&assigned));
    // Only `other` is left in the rotation, so it holds the window.
    assert_eq!(s.cron.assigned_keeper(&id), Some(other.clone()));
    s.cron.execute(&other, &id);
    assert_eq!(s.cron.get_keeper(&assigned).unwrap().slashed, 0);
}

#[test]
fn keeper_rotation_tracks_stake_unbond_and_withdraw() {
    let s = setup();
    let a = new_keeper(&s);
    let b = new_keeper(&s);
    assert_eq!(
        s.cron.active_keepers(),
        vec![&s.env, s.keeper.clone(), a.clone(), b.clone()]
    );

    s.cron.stake(&a, &10); // topping up doesn't duplicate
    assert_eq!(s.cron.active_keepers().len(), 3);

    s.cron.begin_unbonding(&a);
    assert_eq!(
        s.cron.active_keepers(),
        vec![&s.env, s.keeper.clone(), b.clone()]
    );

    advance(&s.env, UNBONDING);
    s.cron.withdraw_stake(&a);
    assert_eq!(s.cron.active_keepers(), vec![&s.env, s.keeper.clone(), b]);
}

#[test]
fn windows_off_means_no_assigned_keeper() {
    let s = setup();
    new_keeper(&s);
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    assert_eq!(s.cron.assigned_keeper(&id), None);
}

#[test]
fn set_keeper_windows_caps_slashing() {
    let s = setup();
    assert_eq!(
        s.cron.try_set_keeper_windows(&GRACE, &(MAX_BPS + 1)),
        Err(Ok(Error::InvalidSetting))
    );
}

// ---------------------------------------------------------------------------
// #40 Keeper reputation
// ---------------------------------------------------------------------------

#[test]
fn keeper_stats_track_average_lateness() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);

    advance(&s.env, 10);
    s.cron.execute(&s.keeper, &id); // 10s late; next due at START + 60
    at(&s, START + INTERVAL + 30);
    s.cron.execute(&s.keeper, &id); // 30s late

    let stats = s.cron.keeper_stats(&s.keeper).unwrap();
    assert_eq!(stats.executions, 2);
    assert_eq!(stats.average_lateness, 20);
    assert_eq!(stats.missed, 0);
    assert!(stats.eligible);
    assert_eq!(s.cron.keeper_stats(&Address::generate(&s.env)), None);
}

// ---------------------------------------------------------------------------
// #65 Per-target circuit breaker
// ---------------------------------------------------------------------------

#[test]
fn halting_a_target_stops_its_jobs_but_not_owner_exits() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let other_target = s.env.register(FlakyTarget, ());
    let mut p = params(&s);
    p.target = other_target;
    p.function = Symbol::new(&s.env, "run");
    p.args = Vec::new(&s.env);
    let unaffected = s.cron.create_job(&s.owner, &p, &1_000);

    // Simulated exploit: the admin halts the compromised target.
    s.cron.set_target_halted(&s.target.address, &true);
    assert!(s.cron.is_target_halted(&s.target.address));
    assert!(!s.cron.is_due(&id));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &id),
        Err(Ok(Error::TargetHalted))
    );
    s.cron.execute(&s.keeper, &unaffected);

    // Owners keep full control of their funds.
    assert_eq!(s.cron.withdraw_job_balance(&id, &400), 600);
    assert_eq!(s.cron.cancel_job(&id), 600);

    s.cron.set_target_halted(&s.target.address, &false);
    assert!(!s.cron.is_target_halted(&s.target.address));
}

#[test]
fn only_admin_can_halt_targets() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "set_target_halted",
            args: (s.target.address.clone(), true).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s
        .cron
        .try_set_target_halted(&s.target.address, &true)
        .is_err());
}

// ---------------------------------------------------------------------------
// #81 Split job storage
// ---------------------------------------------------------------------------

#[test]
fn execute_rewrites_only_the_small_state_entry() {
    let s = setup();
    // ~2 KB of arguments. `FlakyTarget::run` takes none, so the run fails,
    // which is fine: a failed run writes exactly what a successful one does
    // on the registry side. Before v4 the whole job, arguments included,
    // was rewritten on every run.
    let mut args: Vec<Val> = Vec::new(&s.env);
    for _ in 0..8 {
        args.push_back(Bytes::from_array(&s.env, &[7u8; 256]).into_val(&s.env));
    }
    let (_, mut p) = flaky_params(&s);
    p.args = args;
    let id = s.cron.create_job(&s.owner, &p, &1_000);
    s.cron.execute(&s.keeper, &id);

    let written = s.env.cost_estimate().resources().write_bytes;
    assert!(
        written < 1_500,
        "execute wrote {written} bytes for a job with 2 KB of arguments"
    );
}

#[test]
fn job_state_view_matches_the_full_job() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    s.cron.execute(&s.keeper, &id);
    let job = s.cron.get_job(&id).unwrap();
    let state = s.cron.get_job_state(&id).unwrap();
    assert_eq!(
        (
            state.next_run,
            state.balance,
            state.runs,
            state.failures,
            state.active
        ),
        (
            job.next_run,
            job.balance,
            job.runs,
            job.failures,
            job.active
        )
    );
    assert_eq!(s.cron.get_job_state(&99), None);
}

#[test]
fn job_view_combines_spec_and_state() {
    let s = setup();
    let mut p = params(&s);
    p.max_fee_per_run = 15;
    let id = s.cron.create_job(&s.owner, &p, &1_000);
    s.cron.execute(&s.keeper, &id);
    let job = s.cron.get_job(&id).unwrap();
    assert_eq!(job.id, id);
    assert_eq!(job.owner, s.owner);
    assert_eq!(job.target, s.target.address);
    assert_eq!(job.fee_per_run, FEE);
    assert_eq!(job.max_fee_per_run, 15);
    assert_eq!(job.runs, 1);
    assert_eq!(job.balance, 1_000 - FEE);
    assert_eq!(job.schedule, Schedule::Interval);
    assert_eq!(job.keepers, None);
}

// ---------------------------------------------------------------------------
// #82 Epoch-based unbonding
// ---------------------------------------------------------------------------

#[test]
fn keepers_unbonding_in_one_epoch_withdraw_together() {
    let s = setup();
    let epoch = 1_000;
    s.cron.set_unbonding_epoch(&epoch);
    let a = new_keeper(&s);
    let b = new_keeper(&s);

    let epoch_start = START / epoch * epoch;
    at(&s, epoch_start + 10);
    let ra = s.cron.begin_unbonding(&a);
    at(&s, epoch_start + 990);
    let rb = s.cron.begin_unbonding(&b);
    assert_eq!(ra, rb);
    assert_eq!(ra, epoch_start + epoch + UNBONDING);

    at(&s, ra - 1);
    assert_eq!(
        s.cron.withdraw_stakes(&vec![&s.env, a.clone(), b.clone()]),
        vec![&s.env, 0, 0]
    );

    at(&s, ra);
    let a_before = s.token.balance(&a);
    // Anyone may settle the epoch; funds go to each keeper.
    let released = s
        .cron
        .withdraw_stakes(&vec![&s.env, a.clone(), b.clone(), s.keeper.clone()]);
    assert_eq!(released, vec![&s.env, MIN_STAKE, MIN_STAKE, 0]);
    assert_eq!(s.token.balance(&a), a_before + MIN_STAKE);
    assert_eq!(s.cron.get_keeper(&a), None);
}

#[test]
fn without_epochs_each_keeper_has_its_own_timer() {
    let s = setup();
    let released_at = s.cron.begin_unbonding(&s.keeper);
    assert_eq!(released_at, START + UNBONDING);
}

// ---------------------------------------------------------------------------
// #11 Upgrades keep state
// ---------------------------------------------------------------------------

#[test]
fn upgrade_to_real_wasm_preserves_state() {
    // Built by `stellar contract build`, which CI runs before the tests.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/wasm32v1-none/release/sorocron_registry.wasm"
    );
    let Ok(wasm) = std::fs::read(path) else {
        std::eprintln!("skipping: {path} not built (run `stellar contract build`)");
        return;
    };
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    s.cron.execute(&s.keeper, &id);
    let before = s.cron.get_job(&id).unwrap();

    let hash = s
        .env
        .deployer()
        .upload_contract_wasm(Bytes::from_slice(&s.env, &wasm));
    s.cron.propose_upgrade(&hash);
    advance(&s.env, s.cron.upgrade_delay());
    s.cron.apply_upgrade();
    assert_eq!(s.cron.pending_upgrade(), None);

    // Now running the uploaded WASM against the same storage.
    assert_eq!(s.cron.version(), VERSION);
    let after = s.cron.get_job(&id).unwrap();
    assert_eq!(after.balance, before.balance);
    assert_eq!(after.runs, before.runs);
    assert_eq!(after.next_run, before.next_run);
    assert_eq!(s.cron.get_keeper(&s.keeper).unwrap().executions, 1);
    assert_eq!(s.cron.config().admin, s.admin);

    advance(&s.env, INTERVAL);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.cron.get_job(&id).unwrap().runs, 2);
}

// ---------------------------------------------------------------------------
// #44 Job chaining: run B after A
// ---------------------------------------------------------------------------

#[test]
fn follower_runs_once_per_run_of_its_leader() {
    let s = setup();
    let harvest = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let (compound_target, mut p) = flaky_params(&s);
    p.after = Some(harvest);
    let compound = s.cron.create_job(&s.owner, &p, &1_000);

    // The follower waits for its leader even though its own time has come.
    assert!(!s.cron.is_due(&compound));
    assert_eq!(
        s.cron.try_execute(&s.keeper, &compound),
        Err(Ok(Error::AwaitingDependency))
    );

    s.cron.execute(&s.keeper, &harvest);
    assert!(s.cron.is_due(&compound));
    s.cron.execute(&s.keeper, &compound);

    // Next interval: the follower is due by time but the leader hasn't run.
    advance(&s.env, INTERVAL);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &compound),
        Err(Ok(Error::AwaitingDependency))
    );
    s.cron.execute(&s.keeper, &harvest);
    s.cron.execute(&s.keeper, &compound);

    let target = FlakyTargetClient::new(&s.env, &compound_target);
    assert_eq!(s.target.count(), 2);
    assert_eq!(target.run(), 3); // two runs by keepers, plus this direct call
    assert_eq!(s.cron.get_job(&compound).unwrap().after, Some(harvest));
}

#[test]
fn following_a_job_starts_from_its_current_run_count() {
    let s = setup();
    let leader = s.cron.create_job(&s.owner, &params(&s), &1_000);
    for _ in 0..3 {
        s.cron.execute(&s.keeper, &leader);
        advance(&s.env, INTERVAL);
    }
    let mut p = params(&s);
    p.after = Some(leader);
    let follower = s.cron.create_job(&s.owner, &p, &1_000);
    assert_eq!(s.cron.get_job_state(&follower).unwrap().leader_runs, 3);
    assert!(!s.cron.is_due(&follower));
    s.cron.execute(&s.keeper, &leader);
    assert!(s.cron.is_due(&follower));
}

#[test]
fn dependency_must_exist_and_cancelling_the_leader_stops_the_follower() {
    let s = setup();
    let mut p = params(&s);
    p.after = Some(42);
    assert_eq!(
        s.cron.try_create_job(&s.owner, &p, &1_000),
        Err(Ok(Error::JobNotFound))
    );

    let leader = s.cron.create_job(&s.owner, &params(&s), &1_000);
    p.after = Some(leader);
    let follower = s.cron.create_job(&s.owner, &p, &1_000);
    s.cron.execute(&s.keeper, &leader);
    s.cron.cancel_job(&leader);
    assert_eq!(
        s.cron.try_execute(&s.keeper, &follower),
        Err(Ok(Error::AwaitingDependency))
    );

    // The owner can drop the dependency, or point it at a job of their own.
    let mut u = update_from(&s, follower);
    u.after = Some(follower);
    assert_eq!(
        s.cron.try_update_job(&follower, &u),
        Err(Ok(Error::AwaitingDependency))
    );
    u.after = None;
    s.cron.update_job(&follower, &u);
    s.cron.execute(&s.keeper, &follower);
}
