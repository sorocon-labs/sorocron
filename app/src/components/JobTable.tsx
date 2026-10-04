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
        return (
          <Link key={job.id.toString()} to={{ name: "job", id: job.id }} className="table-row" aria-label={`Job ${job.id}, ${job.function}`}>
            <span className="cell-job" role="cell">
              <span className="job-id">#{job.id.toString()}</span>
              <span className="job-fn mono">{job.function}</span>
              <span className="job-target mono">{short(job.target, 4, 4)}</span>
              {account === job.owner && <span className="tag">Yours</span>}
            </span>
            <span role="cell">
              <StatusBadge status={status} />
            </span>
            <span role="cell" className="muted-cell">
              {formatDuration(job.interval)}
            </span>
            <span role="cell" className="muted-cell">
              {live ? relative(job.next_run, now) : "—"}
            </span>
            <span role="cell" className="num">
              {runsRemaining(job).toString()}
            </span>
            <span role="cell" className="num mono">
              {formatAmount(job.balance)}
            </span>
            <span className="row-arrow" aria-hidden="true">
              <Icon name="chevronRight" size={16} />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
