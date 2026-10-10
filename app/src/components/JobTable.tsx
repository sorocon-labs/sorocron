import { describeSchedule, formatAmount, jobStatus, runsRemaining, type Job } from "@sorocron/sdk";
import { Link } from "../router";
import { Icon } from "./Icon";
import { StatusBadge, relative, short, statusLabel } from "./ui";

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Jobs as a list of links laid out like a table. Each link's accessible name
 * carries the whole row, so the column headings are visual only.
 */
export function JobTable({ jobs, now, account }: { jobs: Job[]; now: bigint; account?: string }) {
  return (
    <div className="table" role="list" aria-label="Jobs">
      <div className="table-head" aria-hidden="true">
        <span>Job</span>
        <span>Status</span>
        <span>Schedule</span>
        <span>Next run</span>
        <span className="num">Runs left</span>
        <span className="num">Balance</span>
        <span />
      </div>
      {jobs.map((job) => {
        const status = jobStatus(job, now);
        const live = status === "scheduled" || status === "due";
        const next = live ? relative(job.next_run, now) : "—";
        const name = [
          `Job ${job.id}, ${job.function}`,
          statusLabel(status),
          describeSchedule(job),
          ...(live ? [`${status === "due" ? "due" : "next"} ${next}`] : []),
          `${runsRemaining(job)} runs left`,
          `${formatAmount(job.balance)} XLM`,
          ...(account === job.owner ? ["yours"] : []),
        ].join(", ");
        return (
          <div role="listitem" key={job.id.toString()}>
            <Link to={{ name: "job", id: job.id }} className="table-row job-row" aria-label={name}>
              <span className="c-job">
                <span className="job-id">#{job.id.toString()}</span>
                <span className="job-fn mono">{job.function}</span>
                <span className="job-target mono">{short(job.target, 4, 4)}</span>
                {account === job.owner && <span className="tag">Yours</span>}
              </span>
              <span className="c-status">
                <StatusBadge status={status} />
              </span>
              <span className="c-every muted-cell">
                {describeSchedule(job)}
              </span>
              <span className="c-next muted-cell">
                {next}
              </span>
              <span className="c-runs num">
                {runsRemaining(job).toString()}
              </span>
              <span className="c-balance num mono">
                {formatAmount(job.balance)}
                <span className="unit"> XLM</span>
              </span>
              <span className="c-meta" aria-hidden="true">
                {cap(describeSchedule(job))}
                {live && <> · {status === "due" ? `due ${next}` : `next ${next}`}</>}
              </span>
              <span className="c-arrow row-arrow" aria-hidden="true">
                <Icon name="chevronRight" size={16} />
              </span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
