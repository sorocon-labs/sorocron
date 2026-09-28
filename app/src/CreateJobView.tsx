import { useMemo, useState } from "react";
import {
  depositFor,
  formatAmount,
  formatDuration,
  parseAmount,
  parseArg,
  ttlGuardianArgs,
  type ArgType,
  type Config,
  type JobParams,
  type SoroCron,
} from "@sorocron/sdk";
import { StrKey, type xdr } from "@stellar/stellar-sdk";
import { Field } from "./ui";
import { NETWORK } from "./useRegistry";
import type { Run } from "./App";

type Template = "counter" | "guardian" | "custom";

const UNITS = { minutes: 60, hours: 3_600, days: 86_400 } as const;
type Unit = keyof typeof UNITS;

const ARG_TYPES: ArgType[] = ["u32", "i32", "u64", "i64", "u128", "i128", "bool", "symbol", "string", "address", "bytes"];

interface ArgRow {
  type: ArgType;
  value: string;
}

export function CreateJobView({
  cron,
  config,
  account,
  connect,
  run,
}: {
  cron?: SoroCron;
  config?: Config;
  account?: string;
  connect: () => void;
  run: Run;
}) {
  const [template, setTemplate] = useState<Template>("counter");
  const [target, setTarget] = useState("");
  const [fn, setFn] = useState("");
  const [args, setArgs] = useState<ArgRow[]>([{ type: "u32", value: "1" }]);
  const [guarded, setGuarded] = useState("");
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [fee, setFee] = useState("0.1");
  const [prepaid, setPrepaid] = useState("24");
  const [maxRuns, setMaxRuns] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [resolver, setResolver] = useState("");

  const plan = useMemo(() => {
    const errors: string[] = [];
    let encoded: xdr.ScVal[] = [];
    let jobTarget = target.trim();
    let jobFn = fn.trim();

    if (template === "counter") {
      jobTarget = NETWORK.contracts.counter ?? "";
      jobFn = "increment";
      encoded = [parseArg("u32", "1")];
    } else if (template === "guardian") {
      jobTarget = NETWORK.contracts.ttlGuardian;
      jobFn = "extend";
      if (!StrKey.isValidContract(guarded.trim())) errors.push("Enter the contract address (C…) to keep alive.");
      else encoded = ttlGuardianArgs(guarded.trim());
    } else {
      if (!StrKey.isValidContract(jobTarget)) errors.push("Target must be a contract address (C…).");
      if (!/^[A-Za-z0-9_]{1,32}$/.test(jobFn)) errors.push("Function must be a valid Soroban symbol.");
      try {
        encoded = args.map((a) => parseArg(a.type, a.value));
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    const interval = BigInt(Math.round(Number(every) * UNITS[unit]));
    if (!(Number(every) > 0)) errors.push("Interval must be greater than zero.");
    else if (config && config.min_interval > 0n && interval < config.min_interval) {
      errors.push(`This registry's minimum interval is ${formatDuration(config.min_interval)}.`);
    }
    if (config && config.max_args > 0 && encoded.length > config.max_args) {
      errors.push(`This registry allows at most ${config.max_args} arguments.`);
    }

    let feePerRun = 0n;
    try {
      feePerRun = parseAmount(fee);
      if (feePerRun <= 0n) errors.push("Fee per run must be greater than zero.");
    } catch (err) {
      errors.push(`Fee: ${(err as Error).message}`);
    }
    const runs = Number(prepaid);
    if (!Number.isInteger(runs) || runs < 1) errors.push("Prepay at least one run.");
    const limit = maxRuns.trim() ? Number(maxRuns) : 0;
    if (!Number.isInteger(limit) || limit < 0) errors.push("Max runs must be a whole number (empty for no limit).");
    if (resolver.trim() && !StrKey.isValidContract(resolver.trim())) errors.push("Resolver must be a contract address (C…).");

    const start = startAt ? BigInt(Math.floor(new Date(startAt).getTime() / 1000)) : 0n;
    const end = endAt ? BigInt(Math.floor(new Date(endAt).getTime() / 1000)) : 0n;
    if (end && end <= (start || BigInt(Math.floor(Date.now() / 1000)))) errors.push("End time must be after the start.");

    const params: JobParams = {
      target: jobTarget,
      function: jobFn,
      args: encoded,
      interval,
      start_at: start,
      fee_per_run: feePerRun,
      max_runs: limit,
      end_at: end,
      resolver: resolver.trim() || undefined,
    };
    const deposit = feePerRun > 0n && runs > 0 ? depositFor(runs, feePerRun) : 0n;
    return { params, deposit, runs, errors };
  }, [template, target, fn, args, guarded, every, unit, fee, prepaid, maxRuns, startAt, endAt, resolver, config]);

  const covers = plan.runs > 0 && plan.params.interval > 0n ? formatDuration(plan.params.interval * BigInt(plan.runs)) : "—";

  return (
    <section className="panel create">
      <div className="create-form">
        <fieldset className="templates">
          <legend>What should run?</legend>
          {(
            [
              ["counter", "Demo counter", "Call increment(1) on the example counter contract."],
              ["guardian", "Keep a contract alive", "Extend a contract's TTL so it's never archived."],
              ["custom", "Any contract call", "Pick a contract, function and typed arguments."],
            ] as const
          ).map(([value, title, body]) => (
            <label key={value} className={`template ${template === value ? "active" : ""}`}>
              <input type="radio" name="template" checked={template === value} onChange={() => setTemplate(value)} />
              <span className="template-title">{title}</span>
              <span className="template-body">{body}</span>
            </label>
          ))}
        </fieldset>

        {template === "guardian" && (
          <Field label="Contract to keep alive" hint="Extended to 90 days whenever its TTL drops below 60 days.">
            <input className="mono" placeholder="C…" value={guarded} onChange={(e) => setGuarded(e.target.value)} />
          </Field>
        )}

        {template === "custom" && (
          <>
            <div className="row">
              <Field label="Target contract">
                <input className="mono" placeholder="C…" value={target} onChange={(e) => setTarget(e.target.value)} />
              </Field>
              <Field label="Function">
                <input className="mono" placeholder="increment" value={fn} onChange={(e) => setFn(e.target.value)} />
              </Field>
            </div>
            <div className="field">
              <span className="field-label">Arguments</span>
              {args.map((a, i) => (
                <div key={i} className="arg-row">
                  <select
                    value={a.type}
                    aria-label={`Argument ${i + 1} type`}
                    onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, type: e.target.value as ArgType } : x)))}
                  >
                    {ARG_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    className="mono"
                    value={a.value}
                    aria-label={`Argument ${i + 1} value`}
                    onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                  <button type="button" className="btn btn-ghost" aria-label="Remove argument" onClick={() => setArgs(args.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-ghost add" onClick={() => setArgs([...args, { type: "u32", value: "" }])}>
                + Add argument
              </button>
              <span className="field-hint">Types must match the function's signature exactly (u32 and u64 are different).</span>
            </div>
          </>
        )}

        <div className="row">
          <Field label="Run every">
            <div className="joined">
              <input inputMode="decimal" value={every} onChange={(e) => setEvery(e.target.value)} />
              <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Interval unit">
                {Object.keys(UNITS).map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="Fee per run (XLM)" hint="Paid to the keeper who runs it. Must cover their network fee.">
            <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
          </Field>
        </div>
        <div className="row">
          <Field label="Prepay runs" hint="You can top up or withdraw later.">
            <input inputMode="numeric" value={prepaid} onChange={(e) => setPrepaid(e.target.value)} />
          </Field>
          <Field label="Max runs" hint="Empty for no limit.">
            <input inputMode="numeric" placeholder="no limit" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />
          </Field>
        </div>

        <details className="advanced">
          <summary>Advanced: start, end and resolver</summary>
          <div className="row">
            <Field label="First run" hint="Empty to start now.">
              <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </Field>
            <Field label="Stop after" hint="Empty to never expire.">
              <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
            </Field>
          </div>
          <Field label="Resolver contract" hint="Optional. Runs only when its should_run(job_id) returns true.">
            <input className="mono" placeholder="C…" value={resolver} onChange={(e) => setResolver(e.target.value)} />
          </Field>
        </details>
      </div>

      <aside className="summary">
        <h3>Summary</h3>
        <dl>
          <div>
            <dt>Calls</dt>
            <dd className="mono">
              {plan.params.function || "…"}({plan.params.args.length} args)
            </dd>
          </div>
          <div>
            <dt>Every</dt>
            <dd>{plan.params.interval > 0n ? formatDuration(plan.params.interval) : "—"}</dd>
          </div>
          <div>
            <dt>Deposit</dt>
            <dd className="big mono">{formatAmount(plan.deposit)} XLM</dd>
          </div>
          <div>
            <dt>Covers</dt>
            <dd>
              {plan.runs > 0 ? plan.runs : 0} runs, about {covers}
            </dd>
          </div>
        </dl>
        {plan.errors.length > 0 && (
          <ul className="errors">
            {plan.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {account ? (
          <button
            type="button"
            className="btn btn-primary wide"
            disabled={plan.errors.length > 0 || !cron}
            onClick={() => run("Job scheduled", () => cron!.createJob(plan.params, plan.deposit))}
          >
            Schedule job
          </button>
        ) : (
          <button type="button" className="btn btn-primary wide" onClick={connect}>
            Connect Freighter to schedule
          </button>
        )}
        <p className="fine">
          Funds are escrowed by the registry. Cancel any time for a full refund of what's left.
        </p>
      </aside>
    </section>
  );
}
