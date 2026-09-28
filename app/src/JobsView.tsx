import { useMemo, useState } from "react";
import {
  formatAmount,
  formatDuration,
  jobStatus,
  parseAmount,
  runsRemaining,
  type Job,
  type SoroCron,
} from "@sorocron/sdk";
import { Addr, Empty, StatusPill, relative } from "./ui";
import type { Run } from "./App";

type Filter = "all" | "mine" | "due" | "attention";

export function JobsView({
  jobs,
  now,
  account,
  cron,
  run,
  loading,
}: {
  jobs: Job[];
  now: bigint;
  account?: string;
  cron?: SoroCron;
  run: Run;
  loading: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<bigint>();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs
      .filter((job) => {
        const status = jobStatus(job, now);
        if (filter === "mine" && job.owner !== account) return false;
        if (filter === "due" && status !== "due") return false;
        if (filter === "attention" && !["underfunded", "expired", "paused"].includes(status)) return false;
        if (!q) return true;
        return (
          job.id.toString() === q ||
          job.function.toLowerCase().includes(q) ||
          job.target.toLowerCase().includes(q) ||
          job.owner.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.id - a.id));
  }, [jobs, now, filter, query, account]);

  const filters: [Filter, string][] = [
    ["all", "All jobs"],
    ["mine", "My jobs"],
    ["due", "Due now"],
    ["attention", "Needs attention"],
  ];

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="segmented" role="tablist">
          {filters.map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? "active" : ""}
              disabled={value === "mine" && !account}
              title={value === "mine" && !account ? "Connect Freighter to see your jobs" : undefined}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search id, function, target or owner"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && jobs.length === 0 ? (
        <div className="skeleton-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Empty title={filter === "mine" ? "You have no jobs yet" : "No jobs match"}>
          {filter === "mine" ? "Schedule one from the Schedule tab." : "Try a different filter or search."}
        </Empty>
      ) : (
        <div className="jobs" role="table">
          <div className="jobs-head" role="row">
            <span>Job</span>
            <span>Status</span>
            <span>Every</span>
            <span>Next run</span>
            <span>Runs left</span>
            <span className="num">Balance</span>
          </div>
          {visible.map((job) => (
            <JobRow
              key={job.id.toString()}
              job={job}
              now={now}
              open={open === job.id}
              toggle={() => setOpen(open === job.id ? undefined : job.id)}
              isOwner={account === job.owner}
              cron={cron}
              run={run}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function JobRow({
  job,
  now,
  open,
  toggle,
  isOwner,
  cron,
  run,
}: {
  job: Job;
  now: bigint;
  open: boolean;
  toggle: () => void;
  isOwner: boolean;
  cron?: SoroCron;
  run: Run;
}) {
  const status = jobStatus(job, now);
  const left = runsRemaining(job);
  return (
    <div className={`job ${open ? "open" : ""}`} role="row">
      <button type="button" className="job-main" onClick={toggle} aria-expanded={open}>
        <span className="job-name">
          <span className="job-id">#{job.id.toString()}</span>
          <span className="mono">{job.function}()</span>
          {isOwner && <span className="tag">yours</span>}
        </span>
        <span>
          <StatusPill status={status} />
        </span>
        <span>{formatDuration(job.interval)}</span>
        <span>{status === "scheduled" || status === "due" ? relative(job.next_run, now) : "—"}</span>
        <span>{left.toString()}</span>
        <span className="num mono">{formatAmount(job.balance)}</span>
      </button>
      {open && <JobDetail job={job} isOwner={isOwner} cron={cron} run={run} now={now} />}
    </div>
  );
}

function JobDetail({ job, isOwner, cron, run, now }: { job: Job; isOwner: boolean; cron?: SoroCron; run: Run; now: bigint }) {
  const [amount, setAmount] = useState("");
  let parsed: bigint | undefined;
  try {
    parsed = amount ? parseAmount(amount) : undefined;
  } catch {
    parsed = undefined;
  }
  const canFund = !!cron?.publicKey && parsed !== undefined && parsed > 0n;

  return (
    <div className="job-detail">
      <dl className="facts">
        <div>
          <dt>Target</dt>
          <dd>
            <Addr value={job.target} />
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>
            <Addr value={job.owner} />
          </dd>
        </div>
        <div>
          <dt>Arguments</dt>
          <dd className="mono">{job.args.length ? job.args.map(formatArg).join(", ") : "none"}</dd>
        </div>
        <div>
          <dt>Fee per run</dt>
          <dd className="mono">{formatAmount(job.fee_per_run)} XLM</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>
            {job.runs}
            {job.max_runs ? ` of ${job.max_runs}` : " (no limit)"}
          </dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>{job.end_at ? relative(job.end_at, now) : "never"}</dd>
        </div>
        <div>
          <dt>Resolver</dt>
          <dd>{job.resolver ? <Addr value={job.resolver} /> : "none, runs on schedule"}</dd>
        </div>
      </dl>

      <div className="actions">
        <div className="inline-form">
          <input
            inputMode="decimal"
            placeholder="Amount in XLM"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount in XLM"
          />
          <button
            type="button"
            className="btn"
            disabled={!canFund}
            title={cron?.publicKey ? undefined : "Connect Freighter to fund"}
            onClick={() => run(`Funded job #${job.id}`, () => cron!.fundJob(job.id, parsed!)).then((ok) => ok && setAmount(""))}
          >
            Fund
          </button>
          {isOwner && (
            <button
              type="button"
              className="btn"
              disabled={!canFund || parsed! > job.balance}
              onClick={() =>
                run(`Withdrew from job #${job.id}`, () => cron!.withdrawJobBalance(job.id, parsed!)).then(
                  (ok) => ok && setAmount(""),
                )
              }
            >
              Withdraw
            </button>
          )}
        </div>
        {isOwner && (
          <div className="owner-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                run(job.active ? `Paused job #${job.id}` : `Resumed job #${job.id}`, () =>
                  cron!.setJobActive(job.id, !job.active),
                )
              }
            >
              {job.active ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                if (confirm(`Cancel job #${job.id} and refund ${formatAmount(job.balance)} XLM to you?`)) {
                  void run(`Cancelled job #${job.id}`, () => cron!.cancelJob(job.id));
                }
              }}
            >
              Cancel & refund
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.length > 20 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
  if (value instanceof Uint8Array) return `0x${[...value].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}
