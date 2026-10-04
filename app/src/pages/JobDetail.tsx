import { useState } from "react";
import { formatAmount, formatDuration, jobStatus, runsRemaining, type Job } from "@sorocron/sdk";
import { Icon } from "../components/Icon";
import { Address, Badge, Button, Card, Empty, Facts, Meter, PageHeader, Skeleton, StatusBadge, relative } from "../components/ui";
import { AmountModal, ConfirmModal } from "../modals";
import { Link, navigate } from "../router";
import { useNow, useRegistry } from "../state/registry";
import { useWallet } from "../state/wallet";

type Dialog = "fund" | "withdraw" | "pause" | "cancel" | null;

export function JobDetail({ id }: { id: bigint }) {
  const { jobs, loading, cron } = useRegistry();
  const { account, promptConnect } = useWallet();
  const now = useNow();
  const [dialog, setDialog] = useState<Dialog>(null);
  const job = jobs.find((j) => j.id === id);

  const crumbs = (
    <span className="crumbs">
      <Link to={{ name: "jobs" }}>Jobs</Link>
      <Icon name="chevronRight" size={13} />
      <span>#{id.toString()}</span>
    </span>
  );

  if (!job) {
    return (
      <>
        <PageHeader eyebrow={crumbs} title={`Job #${id}`} />
        {loading ? (
          <Skeleton rows={3} height={120} />
        ) : (
          <section className="card">
            <Empty
              icon="search"
              title="This job doesn't exist"
              action={
                <Button onClick={() => navigate({ name: "jobs" })} icon="arrowLeft">
                  Back to jobs
                </Button>
              }
            >
              It may have been cancelled, or the id is wrong.
            </Empty>
          </section>
        )}
      </>
    );
  }

  const status = jobStatus(job, now);
  const isOwner = account === job.owner;
  const left = runsRemaining(job);
  const requireWallet = (d: Dialog) => (account ? setDialog(d) : promptConnect());

  return (
    <>
      <PageHeader
        eyebrow={crumbs}
        title={`Job #${job.id}`}
        description={
          <span className="title-meta">
            <StatusBadge status={status} />
            <span className="mono">{job.function}()</span>
            <span>on</span>
            <Address value={job.target} />
          </span>
        }
        actions={
          <>
            <Button variant="primary" icon="coin" onClick={() => requireWallet("fund")}>
              Fund
            </Button>
            {isOwner && (
              <>
                <Button icon="arrowLeft" onClick={() => setDialog("withdraw")} disabled={job.balance === 0n}>
                  Withdraw
                </Button>
                <Button icon={job.active ? "pause" : "play"} onClick={() => setDialog("pause")}>
                  {job.active ? "Pause" : "Resume"}
                </Button>
                <Button variant="danger" icon="trash" onClick={() => setDialog("cancel")}>
                  Cancel
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="bento">
        <ScheduleCard job={job} now={now} />

        <Card title="Funding">
          <div className="big-figure">
            {formatAmount(job.balance)} <span>XLM</span>
          </div>
          <Meter value={Number(left)} max={Math.max(Number(left), 10)} label="Runs funded" />
          <Facts
            items={[
              ["Fee per run", `${formatAmount(job.fee_per_run)} XLM`],
              ["Runs funded", left.toString()],
              ["Lasts about", left > 0n ? formatDuration(job.interval * left) : "—"],
            ]}
          />
        </Card>

        <Card title="Conditions">
          <Facts
            items={[
              ["Owner", <Address key="o" value={job.owner} />],
              ["Runs", job.max_runs ? `${job.runs} of ${job.max_runs}` : `${job.runs}, no limit`],
              ["Ends", job.end_at ? relative(job.end_at, now) : "Never"],
              ["Resolver", job.resolver ? <Address key="r" value={job.resolver} /> : "None"],
              ["State", job.active ? <Badge key="s" tone="green">Active</Badge> : <Badge key="s" tone="gray">Paused by owner</Badge>],
            ]}
          />
        </Card>
        <Card title="Call" className="span-2">
          <Facts
            items={[
              ["Contract", <Address key="t" value={job.target} />],
              ["Function", <span key="f" className="mono">{job.function}</span>],
            ]}
          />
          <div className="args">
            <div className="args-label">Arguments</div>
            {job.args.length === 0 ? (
              <p className="muted-cell">None</p>
            ) : (
              <ol>
                {job.args.map((arg, i) => (
                  <li key={i}>
                    <span className="arg-index">{i}</span>
                    <ArgValue value={arg} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>

      </div>

      {cron && (
        <>
          <AmountModal
            open={dialog === "fund"}
            onClose={() => setDialog(null)}
            title={`Fund job #${job.id}`}
            description={`Each run costs ${formatAmount(job.fee_per_run)} XLM. Anyone can fund any job.`}
            action="Add funds"
            success="Funds added"
            send={(amount) => cron.fundJob(job.id, amount)}
          />
          <AmountModal
            open={dialog === "withdraw"}
            onClose={() => setDialog(null)}
            title="Withdraw funds"
            description="Move part of this job's balance back to your account. The job keeps running while funds last."
            action="Withdraw"
            success="Funds withdrawn"
            max={job.balance}
            maxLabel="Job balance"
            send={(amount) => cron.withdrawJobBalance(job.id, amount)}
          />
          <ConfirmModal
            open={dialog === "pause"}
            onClose={() => setDialog(null)}
            title={job.active ? "Pause this job?" : "Resume this job?"}
            description={
              job.active
                ? "Keepers won't run it until you resume. The balance and schedule are kept."
                : "Keepers will run it again from its next scheduled time."
            }
            action={job.active ? "Pause job" : "Resume job"}
            success={job.active ? "Job paused" : "Job resumed"}
            send={() => cron.setJobActive(job.id, !job.active)}
          />
          <ConfirmModal
            open={dialog === "cancel"}
            onClose={() => setDialog(null)}
            danger
            title="Cancel this job?"
            description="The job is deleted and its remaining balance is refunded to you. This can't be undone."
            action={`Cancel and refund ${formatAmount(job.balance)} XLM`}
            success="Job cancelled and refunded"
            send={async () => {
              const sent = await cron.cancelJob(job.id);
              setTimeout(() => navigate({ name: "my-jobs" }), 1_500);
              return sent;
            }}
          />
        </>
      )}
    </>
  );
}

function ScheduleCard({ job, now }: { job: Job; now: bigint }) {
  const status = jobStatus(job, now);
  const live = status === "due" || status === "scheduled";
  // The next few eligible times, assuming a keeper runs each on time.
  const upcoming = live
    ? Array.from({ length: 3 }, (_, i) => {
        const first = job.next_run > now ? job.next_run : now;
        return first + job.interval * BigInt(i);
      }).filter((t) => !job.end_at || t < job.end_at)
    : [];

  return (
    <Card title="Schedule" className="span-2">
      <div className="schedule">
        <div>
          <div className="schedule-label">{status === "due" ? "Due" : "Next run"}</div>
          <div className="big-figure">{live ? relative(job.next_run, now) : "Not running"}</div>
          <div className="muted-cell">
            {live ? new Date(Number(job.next_run) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : explain(status)}
          </div>
        </div>
        <div>
          <div className="schedule-label">Every</div>
          <div className="big-figure">{formatDuration(job.interval)}</div>
          <div className="muted-cell">{job.runs === 1 ? "1 run" : `${job.runs} runs`} so far</div>
        </div>
      </div>
      {upcoming.length > 0 && (
        <ol className="timeline" aria-label="Upcoming runs">
          {upcoming.map((t, i) => (
            <li key={t.toString()}>
              <span className="dot" />
              <span>{new Date(Number(t) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
              <span className="muted-cell">{i === 0 && status === "due" ? "waiting for a keeper" : relative(t, now)}</span>
            </li>
          ))}
        </ol>
      )}
      {status === "due" && job.next_run + job.interval < now && (
        <p className="note">
          <Icon name="info" size={15} />
          <span>
            This job has been due for {formatDuration(now - job.next_run)} and no keeper has run it yet. You can run it yourself from the{" "}
            <Link to={{ name: "keeper" }}>keeper console</Link>.
          </span>
        </p>
      )}
    </Card>
  );
}

function explain(status: string): string {
  switch (status) {
    case "paused":
      return "Paused by its owner";
    case "underfunded":
      return "Balance can't cover another run";
    case "expired":
      return "Past its end time";
    case "completed":
      return "Used all of its runs";
    default:
      return "";
  }
}

function ArgValue({ value }: { value: unknown }) {
  if (typeof value === "string" && /^[GC][A-Z2-7]{55}$/.test(value)) return <Address value={value} />;
  if (typeof value === "bigint" || typeof value === "number") {
    return (
      <span className="mono">
        {value.toString()}
        <span className="arg-type">integer</span>
      </span>
    );
  }
  if (value instanceof Uint8Array) {
    return <span className="mono">0x{[...value].map((b) => b.toString(16).padStart(2, "0")).join("")}</span>;
  }
  if (typeof value === "string" || typeof value === "boolean") return <span className="mono">{String(value)}</span>;
  return <span className="mono">{JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}</span>;
}

