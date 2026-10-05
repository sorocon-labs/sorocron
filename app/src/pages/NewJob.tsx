import { useMemo, useState } from "react";
import {
  depositFor,
  formatAmount,
  formatDuration,
  parseAmount,
  parseArg,
  ttlGuardianArgs,
  type ArgType,
  type JobParams,
} from "@sorocron/sdk";
import { StrKey, type xdr } from "@stellar/stellar-sdk";
import { DatePicker, formatDateTime } from "../components/DatePicker";
import { Icon, type IconName } from "../components/Icon";
import { Modal, TxStatus, useTx } from "../components/Modal";
import { Select, type Option } from "../components/Select";
import { Button, Disclosure, Field, PageHeader, Switch, TextInput } from "../components/ui";
import { Link } from "../router";
import { NETWORK, useRegistry } from "../state/registry";
import { useWallet } from "../state/wallet";

type Template = "counter" | "guardian" | "custom";
type Unit = "minutes" | "hours" | "days";
const UNIT_SECONDS: Record<Unit, number> = { minutes: 60, hours: 3_600, days: 86_400 };
const UNITS: Option<Unit>[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];
const ARG_TYPES: Option<ArgType>[] = (
  [
    ["u32", "Unsigned 32-bit"],
    ["i32", "Signed 32-bit"],
    ["u64", "Unsigned 64-bit"],
    ["i64", "Signed 64-bit"],
    ["u128", "Unsigned 128-bit"],
    ["i128", "Signed 128-bit, token amounts"],
    ["bool", "true or false"],
    ["symbol", "Short identifier"],
    ["string", "Text"],
    ["address", "G… or C… address"],
    ["bytes", "Hex bytes"],
  ] as const
).map(([value, hint]) => ({ value, label: value, hint }));

const STEPS = [
  { key: "action", title: "Action", hint: "What to call" },
  { key: "schedule", title: "Schedule", hint: "When it runs" },
  { key: "funding", title: "Funding", hint: "What it pays" },
  { key: "review", title: "Review", hint: "Sign and schedule" },
] as const;

const TEMPLATES: { value: Template; icon: IconName; title: string; body: string }[] = [
  { value: "custom", icon: "code", title: "Contract call", body: "Any function on any contract, with typed arguments." },
  { value: "guardian", icon: "shield", title: "Keep a contract alive", body: "Extend a contract's TTL daily so it's never archived." },
  { value: "counter", icon: "bolt", title: "Demo counter", body: "Call increment(1) on the example counter. Good for a first try." },
];

interface ArgRow {
  id: number;
  type: ArgType;
  value: string;
}

export function NewJob() {
  const { cron, config } = useRegistry();
  const { account, promptConnect } = useWallet();
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);

  const [template, setTemplate] = useState<Template>("custom");
  const [target, setTarget] = useState("");
  const [fn, setFn] = useState("");
  const [args, setArgs] = useState<ArgRow[]>([]);
  const [guarded, setGuarded] = useState("");

  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [endAt, setEndAt] = useState<Date | null>(null);
  const [limitRuns, setLimitRuns] = useState(false);
  const [maxRuns, setMaxRuns] = useState("");
  const [resolver, setResolver] = useState("");

  const [fee, setFee] = useState("0.1");
  const [prepaid, setPrepaid] = useState("24");

  const [submitOpen, setSubmitOpen] = useState(false);
  const [newId, setNewId] = useState<bigint>();
  const tx = useTx();

  // ---------------------------------------------------------- validation

  const action = useMemo(() => {
    const errors: Record<string, string> = {};
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
      if (!StrKey.isValidContract(guarded.trim())) errors.guarded = "Enter a contract address starting with C.";
      else encoded = ttlGuardianArgs(guarded.trim());
    } else {
      if (!StrKey.isValidContract(jobTarget)) errors.target = "Enter a contract address starting with C.";
      if (!/^[A-Za-z0-9_]{1,32}$/.test(jobFn)) errors.fn = "Letters, digits and underscores, up to 32 characters.";
      args.forEach((a) => {
        if (!a.value.trim()) {
          errors[`arg${a.id}`] = "Enter a value.";
          return;
        }
        try {
          encoded.push(parseArg(a.type, a.value));
        } catch (err) {
          errors[`arg${a.id}`] = (err as Error).message;
        }
      });
      if (config && config.max_args > 0 && args.length > config.max_args) {
        errors.args = `This registry allows at most ${config.max_args} arguments.`;
      }
    }
    return { errors, target: jobTarget, fn: jobFn, encoded };
  }, [template, target, fn, args, guarded, config]);

  const schedule = useMemo(() => {
    const errors: Record<string, string> = {};
    const n = Number(every);
    const interval = BigInt(Math.round((Number.isFinite(n) ? n : 0) * UNIT_SECONDS[unit]));
    if (!(n > 0)) errors.every = "Enter a number above zero.";
    else if (config && config.min_interval > 0n && interval < config.min_interval) {
      errors.every = `The registry's minimum is ${formatDuration(config.min_interval)}.`;
    }
    const runs = limitRuns ? Number(maxRuns) : 0;
    if (limitRuns && !(Number.isInteger(runs) && runs > 0)) errors.maxRuns = "Enter a whole number above zero.";
    if (endAt && endAt.getTime() <= (startAt ?? new Date()).getTime()) errors.endAt = "Must be after the first run.";
    if (resolver.trim() && !StrKey.isValidContract(resolver.trim())) errors.resolver = "Enter a contract address starting with C.";
    return { errors, interval, maxRuns: runs };
  }, [every, unit, limitRuns, maxRuns, startAt, endAt, resolver, config]);

  const funding = useMemo(() => {
    const errors: Record<string, string> = {};
    let feePerRun = 0n;
    try {
      feePerRun = parseAmount(fee);
      if (feePerRun <= 0n) errors.fee = "Enter an amount above zero.";
    } catch (err) {
      errors.fee = (err as Error).message;
    }
    const runs = Number(prepaid);
    if (!(Number.isInteger(runs) && runs > 0)) errors.prepaid = "Prepay at least one run.";
    const deposit = !errors.fee && !errors.prepaid ? depositFor(runs, feePerRun) : 0n;
    return { errors, feePerRun, runs, deposit };
  }, [fee, prepaid]);

  const stepErrors = [action.errors, schedule.errors, funding.errors, {}];
  const valid = (i: number) => Object.keys(stepErrors[i]).length === 0;
  const show = (errors: Record<string, string>, key: string) => (attempted ? errors[key] : undefined);

  const params: JobParams = {
    target: action.target,
    function: action.fn,
    args: action.encoded,
    interval: schedule.interval,
    start_at: startAt ? BigInt(Math.floor(startAt.getTime() / 1000)) : 0n,
    fee_per_run: funding.feePerRun,
    max_runs: schedule.maxRuns,
    end_at: endAt ? BigInt(Math.floor(endAt.getTime() / 1000)) : 0n,
    resolver: resolver.trim() || undefined,
  };

  const next = () => {
    if (!valid(step)) return setAttempted(true);
    setAttempted(false);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const goTo = (i: number) => {
    // Only allow jumping back, or forward over steps that are already valid.
    if (i <= step || [...Array(i).keys()].every(valid)) {
      setAttempted(false);
      setStep(i);
    }
  };

  // ---------------------------------------------------------- render

  return (
    <>
      <div className="desktop-only">
        <PageHeader title="New job" description="Schedule a contract call. Keepers run it on time and are paid from the deposit." />
      </div>

      <div className="wizard-progress">
        <div className="wizard-progress-text">
          <span>
            Step {step + 1} of {STEPS.length}
          </span>
          <strong>{STEPS[step].title}</strong>
        </div>
        <div className="wizard-bars" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s.key} className={i <= step ? "on" : ""} />
          ))}
        </div>
      </div>

      <div className="wizard">
        <nav className="stepper" aria-label="Steps">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.key}>
                <button
                  type="button"
                  className={`${i === step ? "current" : ""} ${i < step ? "complete" : ""}`}
                  aria-current={i === step ? "step" : undefined}
                  onClick={() => goTo(i)}
                >
                  <span className="step-n">{i < step ? <Icon name="check" size={13} /> : i + 1}</span>
                  <span>
                    <strong>{s.title}</strong>
                    <small>{s.hint}</small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section className="card wizard-body" key={step}>
          {step === 0 && (
            <div className="form">
              <div className="choice-grid" role="radiogroup" aria-label="Job type">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={template === t.value}
                    className={`choice ${template === t.value ? "selected" : ""}`}
                    onClick={() => setTemplate(t.value)}
                  >
                    <span className="choice-icon">
                      <Icon name={t.icon} size={18} />
                    </span>
                    <strong>{t.title}</strong>
                    <span>{t.body}</span>
                  </button>
                ))}
              </div>

              {template === "custom" && (
                <>
                  <div className="grid-2">
                    <Field label="Contract" error={show(action.errors, "target")} htmlFor="target">
                      <TextInput id="target" mono value={target} onChange={setTarget} placeholder="C…" />
                    </Field>
                    <Field label="Function" error={show(action.errors, "fn")} htmlFor="fn">
                      <TextInput id="fn" mono value={fn} onChange={setFn} placeholder="increment" />
                    </Field>
                  </div>
                  <div className="field">
                    <span className="field-label">Arguments</span>
                    {args.length === 0 && <p className="field-hint">This call takes no arguments.</p>}
                    {args.map((a, i) => (
                      <div key={a.id} className="arg-row">
                        <span className="arg-index">{i}</span>
                        <Select
                          label={`Argument ${i} type`}
                          value={a.type}
                          options={ARG_TYPES}
                          onChange={(type) => setArgs(args.map((x) => (x.id === a.id ? { ...x, type } : x)))}
                        />
                        <div className="arg-value">
                          <TextInput
                            mono
                            aria-label={`Argument ${i} value`}
                            value={a.value}
                            onChange={(value) => setArgs(args.map((x) => (x.id === a.id ? { ...x, value } : x)))}
                            placeholder={a.type === "address" ? "G… or C…" : a.type === "bool" ? "true" : "value"}
                          />
                          {show(action.errors, `arg${a.id}`) && <span className="field-error">{action.errors[`arg${a.id}`]}</span>}
                        </div>
                        <button type="button" className="icon-btn" aria-label={`Remove argument ${i}`} onClick={() => setArgs(args.filter((x) => x.id !== a.id))}>
                          <Icon name="close" size={16} />
                        </button>
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" icon="plus" className="add-arg" onClick={() => setArgs([...args, { id: Date.now(), type: "u32", value: "" }])}>
                      Add argument
                    </Button>
                    {show(action.errors, "args") && <span className="field-error">{action.errors.args}</span>}
                    <span className="field-hint">Types must match the function's signature exactly; u32 and u64 are different arguments on-chain.</span>
                  </div>
                </>
              )}

              {template === "guardian" && (
                <Field
                  label="Contract to keep alive"
                  htmlFor="guarded"
                  error={show(action.errors, "guarded")}
                  hint="Its instance and code TTL are extended to 90 days whenever they drop below 60. Run it daily."
                >
                  <TextInput id="guarded" mono value={guarded} onChange={setGuarded} placeholder="C…" />
                </Field>
              )}

              {template === "counter" && (
                <div className="callout">
                  <Icon name="info" size={16} />
                  <span>
                    Calls <span className="mono">increment(1)</span> on the example counter at <span className="mono">{NETWORK.contracts.counter?.slice(0, 6)}…</span>. Useful for
                    trying the flow before automating your own contract.
                  </span>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="form">
              <Field label="Run every" error={show(schedule.errors, "every")} htmlFor="every">
                <div className="joined">
                  <TextInput id="every" value={every} onChange={setEvery} inputMode="decimal" />
                  <Select label="Interval unit" value={unit} options={UNITS} onChange={setUnit} />
                </div>
              </Field>
              <div className="grid-2">
                <Field label="First run" hint="Leave empty to start right away.">
                  <DatePicker label="First run" value={startAt} onChange={setStartAt} placeholder="Immediately" />
                </Field>
                <Field label="Stop after" error={show(schedule.errors, "endAt")} hint="Leave empty to run until funds or runs are used up.">
                  <DatePicker label="Stop after" value={endAt} onChange={setEndAt} placeholder="No end date" />
                </Field>
              </div>
              <div className="field">
                <Switch checked={limitRuns} onChange={setLimitRuns} label="Limit the number of runs" />
                {limitRuns && (
                  <div className="nested">
                    <Field label="Maximum runs" error={show(schedule.errors, "maxRuns")} htmlFor="maxRuns">
                      <TextInput id="maxRuns" value={maxRuns} onChange={setMaxRuns} inputMode="numeric" placeholder="12" />
                    </Field>
                  </div>
                )}
              </div>
              <Disclosure title="Run only when a condition holds">
                <Field
                  label="Resolver contract"
                  htmlFor="resolver"
                  error={show(schedule.errors, "resolver")}
                  hint="A contract exposing should_run(job_id) -> bool. The job runs only when it returns true."
                >
                  <TextInput id="resolver" mono value={resolver} onChange={setResolver} placeholder="C…" />
                </Field>
              </Disclosure>
            </div>
          )}

          {step === 2 && (
            <div className="form">
              <div className="grid-2">
                <Field label="Fee per run" error={show(funding.errors, "fee")} hint="Paid to the keeper. It must cover their network fee, so keep it above about 0.01 XLM." htmlFor="fee">
                  <TextInput id="fee" value={fee} onChange={setFee} inputMode="decimal" suffix="XLM" />
                </Field>
                <Field label="Runs to prepay" error={show(funding.errors, "prepaid")} hint="You can add more or withdraw later." htmlFor="prepaid">
                  <TextInput id="prepaid" value={prepaid} onChange={setPrepaid} inputMode="numeric" />
                </Field>
              </div>
              <div className="quick">
                {[10, 24, 100, 365].map((n) => (
                  <button key={n} type="button" className={`chip ${prepaid === String(n) ? "active" : ""}`} onClick={() => setPrepaid(String(n))}>
                    {n} runs
                  </button>
                ))}
              </div>
              <div className="deposit">
                <div>
                  <span className="schedule-label">Deposit</span>
                  <div className="big-figure">
                    {formatAmount(funding.deposit)} <span>XLM</span>
                  </div>
                </div>
                <div>
                  <span className="schedule-label">Covers</span>
                  <div className="big-figure small">
                    {funding.runs > 0 && schedule.interval > 0n ? `about ${formatDuration(schedule.interval * BigInt(funding.runs))}` : "—"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="review">
              <ReviewSection title="Action" onEdit={() => goTo(0)}>
                <dl className="facts">
                  <div>
                    <dt>Contract</dt>
                    <dd className="mono wrap">{params.target}</dd>
                  </div>
                  <div>
                    <dt>Call</dt>
                    <dd className="mono">
                      {params.function}({params.args.length} {params.args.length === 1 ? "argument" : "arguments"})
                    </dd>
                  </div>
                </dl>
              </ReviewSection>
              <ReviewSection title="Schedule" onEdit={() => goTo(1)}>
                <dl className="facts">
                  <div>
                    <dt>Every</dt>
                    <dd>{formatDuration(params.interval)}</dd>
                  </div>
                  <div>
                    <dt>First run</dt>
                    <dd>{startAt ? formatDateTime(startAt) : "Immediately"}</dd>
                  </div>
                  <div>
                    <dt>Ends</dt>
                    <dd>{endAt ? formatDateTime(endAt) : "No end date"}</dd>
                  </div>
                  <div>
                    <dt>Runs</dt>
                    <dd>{params.max_runs ? `At most ${params.max_runs}` : "No limit"}</dd>
                  </div>
                  <div>
                    <dt>Condition</dt>
                    <dd>{params.resolver ? <span className="mono">{params.resolver.slice(0, 8)}…</span> : "None"}</dd>
                  </div>
                </dl>
              </ReviewSection>
              <ReviewSection title="Funding" onEdit={() => goTo(2)}>
                <dl className="facts">
                  <div>
                    <dt>Fee per run</dt>
                    <dd>{formatAmount(params.fee_per_run)} XLM</dd>
                  </div>
                  <div>
                    <dt>Deposit</dt>
                    <dd>
                      <strong>{formatAmount(funding.deposit)} XLM</strong> for {funding.runs} runs
                    </dd>
                  </div>
                </dl>
              </ReviewSection>
            </div>
          )}

          <footer className="wizard-foot">
            {step > 0 ? (
              <Button variant="ghost" icon="arrowLeft" onClick={() => goTo(step - 1)}>
                Back
              </Button>
            ) : (
              <span />
            )}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={next}>
                Continue <Icon name="arrowRight" size={16} />
              </Button>
            ) : account ? (
              <Button
                variant="primary"
                disabled={!cron || ![0, 1, 2].every(valid)}
                onClick={() => {
                  tx.reset();
                  setNewId(undefined);
                  setSubmitOpen(true);
                }}
              >
                Schedule job
              </Button>
            ) : (
              <Button variant="primary" icon="wallet" onClick={promptConnect}>
                Connect to schedule
              </Button>
            )}
          </footer>
        </section>
      </div>

      <Modal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        locked={tx.phase === "pending"}
        size="sm"
        title={tx.phase === "done" ? "Job scheduled" : "Schedule this job?"}
        description={
          tx.phase === "done"
            ? "Keepers will pick it up at its first run time."
            : `${formatAmount(funding.deposit)} XLM moves from your account into the registry's escrow. Cancel any time for a refund of what's left.`
        }
        footer={
          tx.phase === "done" ? (
            newId !== undefined ? (
              <Link to={{ name: "job", id: newId }} className="btn btn-primary" onClick={() => setSubmitOpen(false)}>
                Open job #{newId.toString()}
              </Link>
            ) : (
              <Button variant="primary" onClick={() => setSubmitOpen(false)}>
                Done
              </Button>
            )
          ) : (
            <>
              <Button variant="ghost" onClick={() => setSubmitOpen(false)} disabled={tx.phase === "pending"}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-autofocus
                disabled={tx.phase === "pending"}
                onClick={() =>
                  tx.run(async () => {
                    const sent = await cron!.createJob(params, funding.deposit);
                    setNewId(sent.result);
                    return sent;
                  })
                }
              >
                {tx.phase === "pending" ? "Confirming…" : `Deposit ${formatAmount(funding.deposit)} XLM`}
              </Button>
            </>
          )
        }
      >
        <TxStatus tx={tx} success={`Job #${newId ?? ""} is live`} />
      </Modal>
    </>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <section className="review-section">
      <header>
        <h3>{title}</h3>
        <button type="button" className="link-btn" onClick={onEdit}>
          Edit
        </button>
      </header>
      {children}
    </section>
  );
}
