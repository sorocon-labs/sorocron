/**
 * Registry error codes (contracts/registry/src/errors.rs). Codes are part of
 * the contract's public interface and never renumbered.
 */
export const ERRORS = {
  1: ["Paused", "The registry is paused by its admin."],
  2: ["JobNotFound", "No job with that id (it may have been cancelled)."],
  3: ["InvalidInterval", "Interval must be greater than zero."],
  4: ["InvalidFee", "Fee per run must be greater than zero."],
  5: ["InvalidAmount", "Amount is zero, negative, or more than is available."],
  6: ["ForbiddenTarget", "Jobs can't target SoroCron's own contracts or the tokens it holds."],
  7: ["JobNotDue", "The job isn't due yet."],
  8: ["InsufficientJobBalance", "The job's balance can't cover another run. Fund it to resume."],
  9: ["MaxRunsReached", "The job has used all of its runs."],
  10: ["ResolverRejected", "The job's resolver said not to run."],
  11: ["KeeperNotFound", "That account isn't a registered keeper. Stake first."],
  12: ["InsufficientStake", "The keeper's stake is below the registry minimum."],
  13: ["KeeperUnbonding", "The keeper is unbonding and can't execute or add stake."],
  14: ["UnbondingNotStarted", "Call begin_unbonding before withdrawing stake."],
  15: ["UnbondingNotFinished", "The unbonding period hasn't ended yet."],
  16: ["ExecutorNotSet", "The registry has no executor connected yet."],
  17: ["ExecutorAlreadySet", "The executor can only be set once."],
  18: ["NoPendingAdmin", "There is no pending admin proposal."],
  19: ["JobPaused", "The job is paused by its owner."],
  20: ["JobExpired", "The job is past its end time."],
  21: ["IntervalTooShort", "Interval is below the registry's minimum."],
  22: ["TooManyArgs", "Too many arguments for this registry."],
  23: ["TargetFailed", "The target contract call failed."],
  24: ["InvalidBatchSize", "A batch must contain between 1 and 20 items."],
  25: ["LengthMismatch", "Jobs and deposits must have the same length."],
  26: ["KeeperNotAllowed", "This job only accepts keepers on its allowlist."],
  27: ["NotAssignedKeeper", "Another keeper is assigned to this run until its window ends."],
  28: ["TargetHalted", "The admin has halted jobs that call this contract."],
  29: ["InvalidCalendar", "Calendar time out of range, or a calendar schedule with an interval."],
  30: ["InvalidSetting", "A fee or share is above its maximum, or a fee ceiling is below the base fee."],
  31: ["TooManyKeepers", "A job's keeper allowlist can have at most 10 keepers."],
  32: ["AwaitingDependency", "This job waits for the job it follows to run again."],
} as const satisfies Record<number, readonly [string, string]>;

export type ErrorCode = keyof typeof ERRORS;
export type ErrorName = (typeof ERRORS)[ErrorCode][0];

const BY_NAME = new Map<string, ErrorCode>(
  Object.entries(ERRORS).map(([code, [name]]) => [name, Number(code) as ErrorCode]),
);

/** A registry call rejected by the contract, with its code and a readable message. */
export class SoroCronError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly errorName: ErrorName,
    message: string,
  ) {
    super(message);
    this.name = "SoroCronError";
  }
}

/**
 * Turns whatever a failed call threw or returned (a simulation `Err`, an
 * `Error(Contract, #N)` diagnostic string, a bare name) into a
 * SoroCronError. Returns undefined when it isn't a registry error.
 */
export function parseContractError(input: unknown): SoroCronError | undefined {
  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message
        : input && typeof input === "object" && "message" in input
          ? String((input as { message: unknown }).message)
          : "";

  const numeric = /Error\(Contract, #(\d+)\)/.exec(text);
  let code: ErrorCode | undefined;
  if (numeric && Number(numeric[1]) in ERRORS) {
    code = Number(numeric[1]) as ErrorCode;
  } else {
    const name = /\b([A-Z][A-Za-z]+)\b/g;
    for (const match of text.matchAll(name)) {
      code = BY_NAME.get(match[1]);
      if (code) break;
    }
  }
  if (!code) return undefined;
  const [errorName, message] = ERRORS[code];
  return new SoroCronError(code, errorName, message);
}
