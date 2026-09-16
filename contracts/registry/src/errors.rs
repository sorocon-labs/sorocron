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
}
