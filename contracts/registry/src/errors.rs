use soroban_sdk::contracterror;

/// Error codes are part of the public interface. Never renumber them;
/// only append.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Paused = 1,
    JobNotFound = 2,
    InvalidInterval = 3,
    InvalidFee = 4,
    InvalidAmount = 5,
    ForbiddenTarget = 6,
    JobNotDue = 7,
    InsufficientJobBalance = 8,
    MaxRunsReached = 9,
    ResolverRejected = 10,
    KeeperNotFound = 11,
    InsufficientStake = 12,
    KeeperUnbonding = 13,
    UnbondingNotStarted = 14,
    UnbondingNotFinished = 15,
    ExecutorNotSet = 16,
    ExecutorAlreadySet = 17,
    NoPendingAdmin = 18,
    JobPaused = 19,
    JobExpired = 20,
    IntervalTooShort = 21,
    TooManyArgs = 22,
    /// Not returned since v4: failed target calls are recorded on the job
    /// (`failures`, `JobExecuted.success`) instead of reverting.
    TargetFailed = 23,
    /// A batch was empty or longer than `MAX_BATCH`.
    InvalidBatchSize = 24,
    /// Parallel input vectors had different lengths.
    LengthMismatch = 25,
    /// The job has a keeper allowlist and the caller isn't on it.
    KeeperNotAllowed = 26,
    /// Within the grace period only the run's assigned keeper may execute.
    NotAssignedKeeper = 27,
    /// The admin halted every job calling this target.
    TargetHalted = 28,
    /// Calendar hour, minute or weekday out of range, or set together with an interval.
    InvalidCalendar = 29,
    /// A fee or slashing share above its maximum, a fee ceiling below the
    /// base fee, or a protocol fee without a treasury.
    InvalidSetting = 30,
    /// Keeper allowlist longer than `MAX_JOB_KEEPERS`.
    TooManyKeepers = 31,
}
