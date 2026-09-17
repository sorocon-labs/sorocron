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

use crate::{ensure_due, next_run_after, Error, Job};

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
fn sample_job(env: &Env) -> Job {
    Job {
        id: 0,
        owner: Address::generate(env),
        target: Address::generate(env),
        function: Symbol::new(env, "fuzz"),
        args: Vec::new(env),
        interval: 1,
        next_run: 0,
        fee_per_run: 1,
        balance: i128::MAX,
        max_runs: 0,
        runs: 0,
        end_at: 0,
        resolver: None,
        active: true,
    }
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
        let mut job = sample_job(&env);
        job.active = active;
        job.runs = runs;
        job.max_runs = max_runs;
        job.end_at = end_at;
        job.balance = balance;
        job.fee_per_run = fee_per_run;
        job.next_run = next_run;

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
        prop_assert_eq!(ensure_due(&job, now), expected);
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
        let mut job = sample_job(&env);
        job.active = active;
        job.runs = runs;
        job.max_runs = max_runs;
        job.end_at = end_at;
        job.balance = balance;
        job.fee_per_run = fee_per_run;
        job.next_run = next_run;

        if ensure_due(&job, now).is_ok() {
            let remaining = job.balance.checked_sub(job.fee_per_run);
            prop_assert!(
                matches!(remaining, Some(paid) if paid >= 0),
                "fee payment of {} from balance {} underflowed i128 \
                 despite ensure_due admitting the job",
                job.fee_per_run,
                job.balance
            );
        }
    }

    /// The due boundary is inclusive: at `now == next_run` the job runs,
    /// one tick earlier it does not. `next_run >= 1` so `delta = -1` is a
    /// genuine earlier tick instead of saturating back onto the boundary.
    #[test]
    fn due_boundary_is_inclusive(next_run in 1..=u64::MAX, delta in -1i64..=1) {
        let env = Env::default();
        let mut job = sample_job(&env);
        job.next_run = next_run;
        let now = next_run.saturating_add_signed(delta);
        prop_assert_eq!(ensure_due(&job, now).is_ok(), delta >= 0);
    }

    /// The expiry boundary is exclusive: at `now == end_at` the job has
    /// already expired; `end_at == 0` is excluded here because it means
    /// "never expires".
    #[test]
    fn expiry_boundary_is_exclusive(end_at in 1..=u64::MAX, delta in -1i64..=1) {
        let env = Env::default();
        let mut job = sample_job(&env);
        job.end_at = end_at;
        let now = end_at.saturating_add_signed(delta);
        prop_assert_eq!(ensure_due(&job, now).is_ok(), delta < 0);
    }
}
