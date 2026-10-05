import { formatAmount, formatDuration, jobStatus, runsRemaining, type Job } from "@sorocron/sdk";
import { Link } from "../router";
import { Icon } from "./Icon";
import { StatusBadge, relative, short } from "./ui";

export function JobTable({ jobs, now, account }: { jobs: Job[]; now: bigint; account?: string }) {
  return (
    <div className="table" role="table" aria-label="Jobs">
      <div className="table-head" role="row">
        <span role="columnheader">Job</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Every</span>
        <span role="columnheader">Next run</span>
        <span role="columnheader" className="num">
          Runs left
        </span>
        <span role="columnheader" className="num">
          Balance
        </span>
        <span aria-hidden="true" />
      </div>
      {jobs.map((job) => {
        const status = jobStatus(job, now);
        const live = status === "scheduled" || status === "due";
        const next = live ? relative(job.next_run, now) : "—";
        return (
          <Link key={job.id.toString()} to={{ name: "job", id: job.id }} className="table-row job-row" aria-label={`Job ${job.id}, ${job.function}`}>
            <span className="c-job" role="cell">
              <span className="job-id">#{job.id.toString()}</span>
              <span className="job-fn mono">{job.function}</span>
              <span className="job-target mono">{short(job.target, 4, 4)}</span>
              {account === job.owner && <span className="tag">Yours</span>}
            </span>
            <span className="c-status" role="cell">
              <StatusBadge status={status} />
            </span>
            <span className="c-every muted-cell" role="cell">
              {formatDuration(job.interval)}
            </span>
            <span className="c-next muted-cell" role="cell">
              {next}
            </span>
            <span className="c-runs num" role="cell">
              {runsRemaining(job).toString()}
            </span>
            <span className="c-balance num mono" role="cell">
              {formatAmount(job.balance)}
              <span className="unit"> XLM</span>
            </span>
            <span className="c-meta" aria-hidden="true">
              Every {formatDuration(job.interval)}
              {live && <> · {status === "due" ? `due ${next}` : `next ${next}`}</>}
            </span>
            <span className="c-arrow row-arrow" aria-hidden="true">
              <Icon name="chevronRight" size={16} />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
