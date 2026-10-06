//! Pure schedule and fee arithmetic. No storage, no host calls beyond
//! plain integers, so every function here is easy to fuzz (see
//! `proptests.rs`). All time values are unix seconds in UTC.

use crate::types::{JobSpec, JobState, Schedule};

pub const DAY: u64 = 86_400;
pub const WEEK: u64 = 7 * DAY;

/// 1970-01-01 was a Thursday; Monday 1970-01-05 is 4 days in.
const FIRST_MONDAY_OFFSET_DAYS: u64 = 4;

/// Whether a calendar schedule's fields are in range. `Interval` is always valid.
pub fn schedule_is_valid(schedule: &Schedule) -> bool {
    match *schedule {
        Schedule::Interval => true,
        Schedule::Daily(hour, minute) => hour < 24 && minute < 60,
        Schedule::Weekly(weekday, hour, minute) => weekday < 7 && hour < 24 && minute < 60,
    }
}

/// Seconds between runs of a calendar schedule: a day or a week. `None`
/// for `Interval`, whose period is the job's own `interval`.
pub fn calendar_period(schedule: &Schedule) -> Option<u64> {
    match schedule {
        Schedule::Interval => None,
        Schedule::Daily(..) => Some(DAY),
        Schedule::Weekly(..) => Some(WEEK),
    }
}

/// Position of the calendar's time within its period, in seconds from the
/// start of a period (midnight UTC for daily, Thursday midnight for weekly,
/// because periods are counted from the unix epoch).
fn calendar_offset(schedule: &Schedule) -> u64 {
    match *schedule {
        Schedule::Interval => 0,
        Schedule::Daily(hour, minute) => hour as u64 * 3_600 + minute as u64 * 60,
        Schedule::Weekly(weekday, hour, minute) => {
            ((weekday as u64 + FIRST_MONDAY_OFFSET_DAYS) % 7) * DAY
                + hour as u64 * 3_600
                + minute as u64 * 60
        }
    }
}

/// The first time at or after `from` that matches a calendar schedule.
/// For `Interval` this is simply `from`.
pub fn first_calendar_run(schedule: &Schedule, from: u64) -> u64 {
    let Some(period) = calendar_period(schedule) else {
        return from;
    };
    let offset = calendar_offset(schedule);
    let into_period = from % period;
    let period_start = from - into_period;
    if into_period <= offset {
        period_start.saturating_add(offset)
    } else {
        period_start.saturating_add(period).saturating_add(offset)
    }
}

/// Next run after one at `scheduled` executes at `now`. Stays on the
/// original grid (`scheduled + k * interval`), so calendar jobs never drift
/// and missed runs are skipped instead of firing back-to-back: the result is
/// always after `now`. Saturates at `u64::MAX` instead of wrapping.
pub fn next_run_after(scheduled: u64, interval: u64, now: u64) -> u64 {
    if interval == 0 {
        return scheduled.max(now);
    }
    let elapsed = now.saturating_sub(scheduled);
    let steps = elapsed / interval + 1;
    match steps.checked_mul(interval) {
        Some(delta) => scheduled.saturating_add(delta),
        None => u64::MAX,
    }
}

/// Fee for a run executed at `now`. Flat when `max_fee_per_run` is `0`;
/// otherwise rises linearly from `fee_per_run` when the run is due to
/// `max_fee_per_run` once it is a full interval late. Never more than the
/// job's balance, which `ensure_due` guarantees covers `fee_per_run`.
pub fn ramped_fee(spec: &JobSpec, state: &JobState, now: u64) -> i128 {
    let base = spec.fee_per_run;
    let fee = if spec.max_fee_per_run <= base || spec.interval == 0 {
        base
    } else {
        let late = now.saturating_sub(state.next_run);
        let span = spec.max_fee_per_run - base;
        if late >= spec.interval {
            spec.max_fee_per_run
        } else {
            // late < interval, so this never exceeds span.
            let extra = span
                .checked_mul(late as i128)
                .map(|v| v / spec.interval as i128)
                .unwrap_or(span);
            base + extra
        }
    };
    fee.min(state.balance)
}

/// Splits `amount` into `(rest, share)` where `share = amount * bps / 10_000`
/// rounded down. Computed without overflow for any non-negative `amount`.
pub fn split_fee(amount: i128, bps: u32) -> (i128, i128) {
    if amount <= 0 || bps == 0 {
        return (amount, 0);
    }
    let bps = bps as i128;
    let share = (amount / 10_000) * bps + (amount % 10_000) * bps / 10_000;
    (amount - share, share)
}

/// When stake becomes withdrawable for a keeper that starts unbonding at
/// `now`. With epochs, the unbonding period starts at the end of the current
/// epoch, so every keeper that unbonds within one epoch is released together.
pub fn unbonding_release(now: u64, period: u64, epoch: u64) -> u64 {
    let start = match now.checked_div(epoch) {
        None => now,
        Some(epochs) => epochs.saturating_add(1).saturating_mul(epoch),
    };
    start.saturating_add(period)
}
