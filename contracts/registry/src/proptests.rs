//! Property-based fuzz tests for the registry's schedule and fee math
//! (sorocon-labs/sorocron#77).
//!
//! The pure calculation paths — `next_run_after`, `ensure_due`, and the
//! balance subtraction in `execute` that `ensure_due` guards — are exercised
//! against generated inputs biased toward the edges where arithmetic panics
//! would live: `u64::MAX` timestamps, zero intervals, one-tick boundaries,
//! and `i128` extremes for fees and balances.
//!
//! Acceptance criterion for #77: the suite finds zero arithmetic panics or
//! infinite loops. Every property below doubles as a regression tripwire: if
//! any of the saturating operations ever regresses to plain arithmetic, a
//! generated case will panic here.

use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::{
    ensure_due, first_calendar_run, next_run_after, ramped_fee, schedule, split_fee, Error,
    JobSpec, JobState, Schedule,
};

// ---------------------------------------------------------------------------
// Strategies biased toward boundary values
// ---------------------------------------------------------------------------

/// Timestamps: mostly ordinary seconds, but a quarter of draws land on the
/// `u64` edges and the first few ticks after `0`.
fn ts() -> impl Strategy<Value = u64> {
    prop_oneof![
        6 => 0..64u64,
        4 => any::<u64>(),
        2 => u64::MAX - 63..=u64::MAX,
    ]
}

/// Fee-token amounts: arbitrary `i128`s plus the extremes that would
/// overflow a naive `+=`/`-=`: `0`, `i128::MAX`, `i128::MIN`.
fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        8 => any::<i128>(),
        2 => 0..=4i128,
        1 => Just(0i128),
        1 => Just(i128::MAX),
        1 => Just(i128::MIN),
    ]
}

/// `(runs, max_runs)` pairs biased so the `runs == max_runs` and the
/// unlimited (`max_runs == 0`) boundaries are hit often.
fn run_counts() -> impl Strategy<Value = (u32, u32)> {
    prop_oneof![
        6 => (any::<u32>(), any::<u32>()),
        2 => (0..=4u32, 0..=4u32),
        1 => Just((u32::MAX, u32::MAX)),
        1 => Just((0u32, 0)),
    ]
}

/// Fees a stored job can actually carry: `create_job` rejects
/// `fee_per_run <= 0` (`Error::InvalidFee`), so fees are strictly positive.
fn fee() -> impl Strategy<Value = i128> {
    prop_oneof![
        4 => 1..=4i128,
        6 => 1..=i128::MAX,
        1 => Just(i128::MAX),
    ]
}

/// A full `ensure_due` scenario. `now` is generated *after* the job so it
/// can land exactly on `next_run` or `end_at` and one tick on either side,
/// which is where off-by-one regressions would show up.
type DueCase = (bool, u32, u32, u64, i128, i128, u64, u64);

fn due_case() -> impl Strategy<Value = DueCase> {
    (
        any::<bool>(),
        run_counts(),
        amount(),
        amount(),
        ts(),
        ts(),
        ts(),
    )
        .prop_flat_map(
            |(active, (runs, max_runs), balance, fee_per_run, end_at, next_run, base)| {
                let now = prop_oneof![
                    4 => Just(next_run),
                    2 => Just(end_at),
                    1 => Just(next_run.saturating_sub(1)),
                    1 => Just(next_run.saturating_add(1)),
                    1 => Just(end_at.saturating_sub(1)),
                    1 => Just(end_at.saturating_add(1)),
                    3 => Just(base),
                    2 => ts(),
                ];
                (
                    Just(active),
                    Just(runs),
                    Just(max_runs),
                    Just(end_at),
                    Just(balance),
                    Just(fee_per_run),
                    Just(next_run),
                    now,
                )
            },
        )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A job that is due right now: active, funded, unlimited runs, no expiry.
/// Tests overlay the fields under test on top of this baseline.
fn sample_job(env: &Env) -> (JobSpec, JobState) {
    let spec = JobSpec {
        owner: Address::generate(env),
        target: Address::generate(env),
        function: Symbol::new(env, "fuzz"),
        args: Vec::new(env),
        interval: 1,
        schedule: Schedule::Interval,
        fee_per_run: 1,
        max_fee_per_run: 0,
        max_runs: 0,
        end_at: 0,
        resolver: None,
        keepers: None,
        after: None,
    };
    let state = JobState {
        next_run: 0,
        balance: i128::MAX,
        runs: 0,
        failures: 0,
        active: true,
        leader_runs: 0,
    };
    (spec, state)
}

// ---------------------------------------------------------------------------
// `next_run_after`: schedule advancement
// ---------------------------------------------------------------------------

proptest! {
    /// The function is total over all of `u64` (no arithmetic panic) and its
    /// result never moves a schedule backwards: it is never earlier than the
    /// previously scheduled time nor than `now`. When the cadence addition
    /// fits in `u64` the exact schedule is kept; when it saturates the run
    /// is pinned at `u64::MAX` instead of wrapping into the past.
    #[test]
    fn next_run_after_never_regresses_or_panics(
        scheduled in ts(),
        interval in ts(),
        now in ts(),
    ) {
        let next = next_run_after(scheduled, interval, now);
        prop_assert!(next >= scheduled, "next_run {} went before scheduled {}", next, scheduled);
        prop_assert!(next >= now, "next_run {} went before now {}", next, now);
        if let Some(exact) = scheduled.checked_add(interval) {
            if exact > now {
                prop_assert_eq!(next, exact, "must keep the exact cadence when it fits");
            }
        } else {
            prop_assert_eq!(next, u64::MAX, "saturated cadence must pin at u64::MAX, not wrap");
        }
    }

    /// With a zero interval there is no cadence to keep; the run time must
    /// degenerate to `max(scheduled, now)` rather than panic or go backwards.
    #[test]
    fn zero_interval_never_goes_backwards(scheduled in ts(), now in ts()) {
        prop_assert_eq!(next_run_after(scheduled, 0, now), scheduled.max(now));
    }

    /// Simulates 64 keeper executions against an adversarial ledger clock.
    /// `create_job` rejects zero intervals, so with `interval >= 1` the
    /// schedule must strictly advance on every execution — this rules out
    /// both the back-to-back loop the catch-up rule exists to prevent and
    /// any stuck state short of the `u64` ceiling.
    #[test]
    fn schedule_always_advances_until_ceiling(
        start in ts(),
        interval in 1..=u64::MAX,
        skip in ts(),
    ) {
        let mut next_run = start;
        for _ in 0..64 {
            let now = next_run.saturating_add(skip);
            let advanced = next_run_after(next_run, interval, now);
            prop_assert!(
                advanced > next_run || next_run == u64::MAX,
                "schedule stalled at {} (interval {}, now {})",
                next_run,
                interval,
                now
            );
            prop_assert!(advanced >= now, "advanced run {} fell behind now {}", advanced, now);
            next_run = advanced;
        }
    }
}

/// `u64::MAX` in every position leaves the function at the ceiling for any
/// combination of the remaining arguments.
#[test]
fn next_run_after_is_total_at_timestamp_ceiling() {
    for interval in [0u64, 1, 60, u64::MAX] {
        for now in [0u64, 1, u64::MAX - 1, u64::MAX] {
            assert_eq!(next_run_after(u64::MAX, interval, now), u64::MAX);
        }
    }
}

// ---------------------------------------------------------------------------
// `ensure_due`: due-ness gates
// ---------------------------------------------------------------------------

proptest! {
    /// `ensure_due` must decide exactly per its documented gate order:
    /// paused, then max runs, then expiry (`0` = never), then funding, then
    /// schedule (`now >= next_run` is due, inclusive).
    #[test]
    fn ensure_due_matches_gate_specification(
        (active, runs, max_runs, end_at, balance, fee_per_run, next_run, now) in due_case(),
    ) {
        let env = Env::default();
        let (mut spec, mut state) = sample_job(&env);
        state.active = active;
        state.runs = runs;
        spec.max_runs = max_runs;
        spec.end_at = end_at;
        state.balance = balance;
        spec.fee_per_run = fee_per_run;
        state.next_run = next_run;

        let expected = if !active {
            Err(Error::JobPaused)
        } else if max_runs != 0 && runs >= max_runs {
            Err(Error::MaxRunsReached)
        } else if end_at != 0 && now >= end_at {
            Err(Error::JobExpired)
        } else if balance < fee_per_run {
            Err(Error::InsufficientJobBalance)
        } else if now < next_run {
            Err(Error::JobNotDue)
        } else {
            Ok(())
        };
        prop_assert_eq!(ensure_due(&spec, &state, now), expected);
    }

    /// Whatever `ensure_due` admits, `execute` must be able to pay for:
    /// `job.balance -= job.fee_per_run` is unguarded arithmetic, so the
    /// gate has to make an `i128` underflow impossible. The fee strategy
    /// mirrors the reachable state: `create_job` rejects non-positive fees
    /// with `Error::InvalidFee` before one is ever stored.
    #[test]
    fn admitted_jobs_can_pay_their_fee(
        (active, runs, max_runs, end_at, balance, _unused, next_run, now) in due_case(),
        fee_per_run in fee(),
    ) {
        let env = Env::default();
        let (mut spec, mut state) = sample_job(&env);
        state.active = active;
        state.runs = runs;
        spec.max_runs = max_runs;
        spec.end_at = end_at;
        state.balance = balance;
        spec.fee_per_run = fee_per_run;
        state.next_run = next_run;

        if ensure_due(&spec, &state, now).is_ok() {
            let remaining = state.balance.checked_sub(spec.fee_per_run);
            prop_assert!(
                matches!(remaining, Some(paid) if paid >= 0),
                "fee payment of {} from balance {} underflowed i128 \
                 despite ensure_due admitting the job",
                spec.fee_per_run,
                state.balance
            );
        }
    }

    /// The due boundary is inclusive: at `now == next_run` the job runs,
    /// one tick earlier it does not. `next_run >= 1` so `delta = -1` is a
    /// genuine earlier tick instead of saturating back onto the boundary.
    #[test]
    fn due_boundary_is_inclusive(next_run in 1..=u64::MAX, delta in -1i64..=1) {
        let env = Env::default();
        let (spec, mut state) = sample_job(&env);
        state.next_run = next_run;
        let now = next_run.saturating_add_signed(delta);
        prop_assert_eq!(ensure_due(&spec, &state, now).is_ok(), delta >= 0);
    }

    /// The expiry boundary is exclusive: at `now == end_at` the job has
    /// already expired; `end_at == 0` is excluded here because it means
    /// "never expires".
    #[test]
    fn expiry_boundary_is_exclusive(end_at in 1..=u64::MAX, delta in -1i64..=1) {
        let env = Env::default();
        let (mut spec, state) = sample_job(&env);
        spec.end_at = end_at;
        let now = end_at.saturating_add_signed(delta);
        prop_assert_eq!(ensure_due(&spec, &state, now).is_ok(), delta < 0);
    }
}

// ---------------------------------------------------------------------------
// v4 math: calendars, fee ramps, protocol fee split, unbonding epochs
// ---------------------------------------------------------------------------

/// A valid calendar schedule with its (weekday, hour, minute).
fn calendar() -> impl Strategy<Value = (Schedule, Option<u32>, u32, u32)> {
    (prop::option::of(0u32..7), 0u32..24, 0u32..60).prop_map(
        |(weekday, hour, minute)| match weekday {
            None => (Schedule::Daily(hour, minute), None, hour, minute),
            Some(d) => (Schedule::Weekly(d, hour, minute), Some(d), hour, minute),
        },
    )
}

proptest! {
    /// The first calendar run is the earliest matching wall-clock time at or
    /// after `from`: never before it, less than one period after it, and on
    /// the requested hour, minute and weekday.
    #[test]
    fn first_calendar_run_is_the_next_matching_time(
        (cal, weekday, hour, minute) in calendar(),
        from in 0u64..=4_000_000_000,
    ) {
        let period = schedule::calendar_period(&cal).unwrap();
        let t = first_calendar_run(&cal, from);
        prop_assert!(t >= from);
        prop_assert!(t - from < period);
        prop_assert_eq!((t % 86_400) / 3_600, hour as u64);
        prop_assert_eq!((t % 3_600) / 60, minute as u64);
        prop_assert_eq!(t % 60, 0);
        if let Some(weekday) = weekday {
            // Days since epoch + 3 makes Monday 0 (1970-01-01 was a Thursday).
            prop_assert_eq!((t / 86_400 + 3) % 7, weekday as u64);
        }
    }

    /// Rescheduling a calendar job after any delay lands on the same
    /// wall-clock time again: grid alignment means calendar jobs never drift.
    #[test]
    fn calendar_jobs_never_drift(
        (cal, _, _, _) in calendar(),
        from in 0u64..=4_000_000_000,
        delay in 0u64..=10_000_000,
    ) {
        let period = schedule::calendar_period(&cal).unwrap();
        let first = first_calendar_run(&cal, from);
        let now = first + delay;
        let next = next_run_after(first, period, now);
        prop_assert!(next > now);
        prop_assert_eq!((next - first) % period, 0);
    }

    /// A ramped fee is never below the base fee, never above the ceiling,
    /// never above the balance, and never decreases as the run gets later.
    #[test]
    fn ramped_fee_stays_within_bounds(
        base in 1i128..=1_000_000_000,
        extra in 0i128..=1_000_000_000,
        interval in 1u64..=1_000_000,
        late in 0u64..=2_000_000,
        balance_slack in 0i128..=2_000_000_000,
    ) {
        let env = Env::default();
        let (mut spec, mut state) = sample_job(&env);
        spec.fee_per_run = base;
        spec.max_fee_per_run = base + extra;
        spec.interval = interval;
        state.next_run = 1_000;
        state.balance = base + balance_slack;

        let fee = ramped_fee(&spec, &state, 1_000 + late);
        prop_assert!(fee >= base);
        prop_assert!(fee <= spec.max_fee_per_run);
        prop_assert!(fee <= state.balance);
        let later = ramped_fee(&spec, &state, 1_000 + late + 1);
        prop_assert!(later >= fee);
    }

    /// The protocol fee split never creates or loses value and never takes
    /// more than its share, even at the extremes of `i128`.
    #[test]
    fn split_fee_conserves_amount(amount in 0i128..=i128::MAX, bps in 0u32..=10_000) {
        let (rest, share) = split_fee(amount, bps);
        prop_assert_eq!(rest + share, amount);
        prop_assert!(share >= 0 && rest >= 0);
        prop_assert!(share <= amount / 10_000 * bps as i128 + bps as i128);
    }

    /// Everyone who starts unbonding in the same epoch is released at the
    /// same moment, no earlier than the full unbonding period from now.
    #[test]
    fn unbonding_epochs_release_together(
        epoch in 1u64..=1_000_000,
        period in 0u64..=1_000_000,
        start in 0u64..=1_000_000_000,
        a in 0u64..=1_000_000,
        b in 0u64..=1_000_000,
    ) {
        let epoch_start = start / epoch * epoch;
        let t1 = epoch_start + a % epoch;
        let t2 = epoch_start + b % epoch;
        let r1 = schedule::unbonding_release(t1, period, epoch);
        prop_assert_eq!(r1, schedule::unbonding_release(t2, period, epoch));
        prop_assert!(r1 >= t1 + period);
    }
}
