import { formatAmount, formatDuration, jobStatus } from "@sorocron/sdk";
import { Icon } from "../components/Icon";
import { Address, Badge, Button, Card, Empty, Facts, PageHeader, Skeleton, Stat, StatusBadge, relative } from "../components/ui";
import { Link, navigate } from "../router";
import { useNow, useRegistry } from "../state/registry";
import { useWallet } from "../state/wallet";

export function Overview() {
  const { jobs, config, version, loading, cron } = useRegistry();
  const { account, promptConnect } = useWallet();
  const now = useNow();

  const statuses = jobs.map((j) => jobStatus(j, now));
  const due = statuses.filter((s) => s === "due").length;
  const attention = statuses.filter((s) => s === "underfunded" || s === "expired").length;
  const escrow = jobs.reduce((sum, j) => sum + j.balance, 0n);
  const upcoming = jobs
    .filter((j) => ["due", "scheduled"].includes(jobStatus(j, now)))
    .sort((a, b) => Number(a.next_run - b.next_run))
    .slice(0, 5);

  return (
    <>
      <PageHeader
        eyebrow="Stellar testnet"
        title="Overview"
        description="Scheduled contract calls on Soroban, executed by staked keepers and paid per run."
        actions={
          <Button variant="primary" icon="plus" onClick={() => navigate({ name: "new" })}>
            New job
          </Button>
        }
      />

      <div className="stats-row reveal-group">
        <Stat icon="jobs" label="Live jobs" value={loading ? "—" : jobs.length} />
        <Stat icon="clock" label="Due now" value={loading ? "—" : due} hint={due ? "Waiting for a keeper" : "All caught up"} />
        <Stat icon="coin" label="Escrowed" value={loading ? "—" : `${formatAmount(escrow)}`} hint="XLM held for future runs" />
        <Stat icon="alert" label="Need attention" value={loading ? "—" : attention} hint="Out of funds or expired" />
      </div>

      <div className="bento">
        <Card
          className="span-2"
          title="Next up"
          action={
            <Link to={{ name: "jobs" }} className="card-link">
              All jobs <Icon name="arrowRight" size={14} />
            </Link>
          }
        >
          {loading ? (
            <Skeleton rows={4} height={40} />
          ) : upcoming.length === 0 ? (
            <Empty icon="clock" title="Nothing scheduled">
              Jobs that are due or scheduled appear here.
            </Empty>
          ) : (
            <ul className="list">
              {upcoming.map((job) => (
                <li key={job.id.toString()}>
                  <Link to={{ name: "job", id: job.id }} className="list-row">
                    <span className="job-id">#{job.id.toString()}</span>
                    <span className="mono grow">{job.function}</span>
                    <span className="muted-cell">every {formatDuration(job.interval)}</span>
                    <StatusBadge status={jobStatus(job, now)} />
                    <span className="muted-cell when">{relative(job.next_run, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Registry">
          {config ? (
            <Facts
              items={[
                ["Status", config.paused ? <Badge tone="red">Paused</Badge> : <Badge tone="green">Running</Badge>],
                ["Interface", `v${version ?? "…"}`],
                ["Minimum stake", `${formatAmount(config.min_stake)} XLM`],
                ["Unbonding", formatDuration(config.unbonding_period)],
                ["Contract", cron ? <Address value={cron.contractId} /> : "…"],
              ]}
            />
          ) : (
            <Skeleton rows={4} height={24} />
          )}
        </Card>

        <Card title="Earn as a keeper">
          <p className="card-text">
            Stake XLM, run the open-source keeper node, and collect the fee for every job you execute.
          </p>
          <Button onClick={() => navigate({ name: "keeper" })} icon="keeper">
            Keeper console
          </Button>
        </Card>
        <Card title="Get started" className="span-2">
          <ol className="howto">
            <li>
              <span className="howto-n">1</span>
              <div>
                <strong>Connect Freighter</strong>
                <p>Switch it to Testnet and fund the account with Friendbot.</p>
              </div>
              {account ? (
                <Badge tone="green">Connected</Badge>
              ) : (
                <Button size="sm" onClick={promptConnect}>
                  Connect
                </Button>
              )}
            </li>
            <li>
              <span className="howto-n">2</span>
              <div>
                <strong>Schedule a call</strong>
                <p>Pick a contract and function, how often, and a fee per run.</p>
              </div>
              <Button size="sm" onClick={() => navigate({ name: "new" })}>
                New job
              </Button>
            </li>
            <li>
              <span className="howto-n">3</span>
              <div>
                <strong>Keep it funded</strong>
                <p>Top up from the job page. Cancel any time for a refund of what's left.</p>
              </div>
              <Button size="sm" onClick={() => navigate({ name: "my-jobs" })}>
                My jobs
              </Button>
            </li>
          </ol>
        </Card>

      </div>
    </>
  );
}
