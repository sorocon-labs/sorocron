import { useMemo, useState } from "react";
import { formatAmount, jobStatus, type Job } from "@sorocron/sdk";
import { Icon } from "../components/Icon";
import { JobTable } from "../components/JobTable";
import { Button, Empty, PageHeader, Segmented, Skeleton, Stat } from "../components/ui";
import { navigate } from "../router";
import { useNow, useRegistry } from "../state/registry";
import { useWallet } from "../state/wallet";

type Filter = "all" | "due" | "scheduled" | "attention" | "inactive";

const MATCH: Record<Filter, (status: string) => boolean> = {
  all: () => true,
  due: (s) => s === "due",
  scheduled: (s) => s === "scheduled",
  attention: (s) => s === "underfunded" || s === "expired",
  inactive: (s) => s === "paused" || s === "completed",
};

function useFiltered(jobs: Job[], now: bigint, filter: Filter, query: string) {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs
      .filter((job) => MATCH[filter](jobStatus(job, now)))
      .filter(
        (job) =>
          !q ||
          job.id.toString() === q.replace(/^#/, "") ||
          job.function.toLowerCase().includes(q) ||
          job.target.toLowerCase().includes(q) ||
          job.owner.toLowerCase().includes(q),
      )
      .sort((a, b) => Number(b.id - a.id));
  }, [jobs, now, filter, query]);
}

function JobBrowser({ jobs, loading, emptyAction }: { jobs: Job[]; loading: boolean; emptyAction?: React.ReactNode }) {
  const { account } = useWallet();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const visible = useFiltered(jobs, now, filter, query);
  const count = (f: Filter) => jobs.filter((j) => MATCH[f](jobStatus(j, now))).length;

  return (
    <section className="card card-flush">
      <div className="toolbar">
        <Segmented
          label="Filter jobs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: jobs.length },
            { value: "due", label: "Due", count: count("due") },
            { value: "scheduled", label: "Scheduled", count: count("scheduled") },
            { value: "attention", label: "Attention", count: count("attention") },
            { value: "inactive", label: "Inactive", count: count("inactive") },
          ]}
        />
        <div className="search">
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder="Search id, function or address"
            aria-label="Search jobs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
      {loading && jobs.length === 0 ? (
        <div className="pad">
          <Skeleton rows={4} />
        </div>
      ) : visible.length === 0 ? (
        jobs.length === 0 ? (
          <Empty title="No jobs yet" action={emptyAction}>
            Scheduled jobs will show up here.
          </Empty>
        ) : (
          <Empty icon="search" title="No jobs match">
            Try another filter or search term.
          </Empty>
        )
      ) : (
        <JobTable jobs={visible} now={now} account={account} />
      )}
    </section>
  );
}

export function Jobs() {
  const { jobs, loading } = useRegistry();
  return (
    <>
      <PageHeader
        hideActionsOnMobile
        title="Jobs"
        description="Every live job on the registry. Select one to see its schedule, funding and call."
        actions={
          <Button variant="primary" icon="plus" onClick={() => navigate({ name: "new" })}>
            New job
          </Button>
        }
      />
      <JobBrowser jobs={jobs} loading={loading} />
    </>
  );
}

export function MyJobs() {
  const { jobs, loading } = useRegistry();
  const { account, promptConnect } = useWallet();
  const now = useNow();
  const mine = jobs.filter((j) => j.owner === account);
  const escrow = mine.reduce((sum, j) => sum + j.balance, 0n);
  const attention = mine.filter((j) => MATCH.attention(jobStatus(j, now))).length;
  const newJob = (
    <Button variant="primary" icon="plus" onClick={() => navigate({ name: "new" })}>
      New job
    </Button>
  );

  return (
    <>
      <PageHeader hideActionsOnMobile title="My jobs" description="Jobs owned by your connected account." actions={account && newJob} />
      {!account ? (
        <section className="card">
          <Empty
            icon="wallet"
            title="Connect a wallet to see your jobs"
            action={
              <Button variant="primary" onClick={promptConnect}>
                Connect Freighter
              </Button>
            }
          >
            Jobs are tied to the account that created them.
          </Empty>
        </section>
      ) : (
        <>
          <div className="stats-row three">
            <Stat label="Your jobs" value={mine.length} />
            <Stat label="Escrowed" value={`${formatAmount(escrow)} XLM`} />
            <Stat label="Need attention" value={attention} hint="Out of funds or expired" />
          </div>
          <JobBrowser jobs={mine} loading={loading} emptyAction={newJob} />
        </>
      )}
    </>
  );
}
