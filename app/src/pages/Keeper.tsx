import { useState } from "react";
import { formatAmount, formatDuration, jobStatus, type Job } from "@sorocron/sdk";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, Empty, Facts, PageHeader, Skeleton, Stat, relative } from "../components/ui";
import { AmountModal, ConfirmModal } from "../modals";
import { Link } from "../router";
import { useNow, useRegistry } from "../state/registry";
import { useWallet } from "../state/wallet";

type Dialog = { kind: "stake" | "unbond" | "withdraw" } | { kind: "execute"; job: Job } | null;

const NODE_SETUP = `git clone https://github.com/sorocon-labs/sorocron
cd sorocron/keeper-bot
npm install
cp .env.example .env   # set STELLAR_SECRET_KEY
npm run keeper`;

export function Keeper() {
  const { cron, config, keeper, jobs, loading } = useRegistry();
  const { account, promptConnect } = useWallet();
  const now = useNow();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState(false);

  const due = jobs.filter((j) => jobStatus(j, now) === "due").sort((a, b) => Number(a.next_run - b.next_run));
  const waiting = due.reduce((sum, j) => sum + j.fee_per_run, 0n);
  const unbondingAt = keeper?.unbonding_at ?? undefined;
  const eligible = !!keeper && unbondingAt === undefined && !!config && keeper.stake >= config.min_stake;

  const status = !account
    ? null
    : keeper === undefined
      ? { tone: "gray" as const, label: "Checking…" }
      : keeper === null
        ? { tone: "gray" as const, label: "Not staked" }
        : unbondingAt !== undefined
          ? { tone: "yellow" as const, label: now >= unbondingAt ? "Ready to withdraw" : "Unbonding" }
          : eligible
            ? { tone: "green" as const, label: "Active" }
            : { tone: "red" as const, label: "Below minimum stake" };

  return (
    <>
      <PageHeader
        title="Keeper"
        description="Stake XLM to execute due jobs and earn their fees. The first keeper to land a run is paid for it."
        actions={
          account ? (
            unbondingAt === undefined ? (
              <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: "stake" })}>
                {keeper ? "Add stake" : "Stake"}
              </Button>
            ) : null
          ) : (
            <Button variant="primary" icon="wallet" onClick={promptConnect}>
              Connect
            </Button>
          )
        }
      />

      <div className="stats-row">
        <Stat icon="clock" label="Jobs due" value={loading ? "—" : due.length} />
        <Stat icon="coin" label="Fees waiting" value={loading ? "—" : `${formatAmount(waiting)} XLM`} />
        <Stat icon="shield" label="Minimum stake" value={config ? `${formatAmount(config.min_stake)} XLM` : "—"} />
        <Stat icon="calendar" label="Unbonding period" value={config ? formatDuration(config.unbonding_period) : "—"} />
      </div>

      <div className="bento">
        <Card title="Execution queue" className="span-2">
          {loading ? (
            <Skeleton rows={3} height={44} />
          ) : due.length === 0 ? (
            <Empty icon="check" title="Nothing due">
              Every job is up to date. Due jobs appear here as their time comes.
            </Empty>
          ) : (
            <ul className="list">
              {due.map((job) => (
                <li key={job.id.toString()} className="list-row static">
                  <Link to={{ name: "job", id: job.id }} className="job-id">
                    #{job.id.toString()}
                  </Link>
                  <span className="mono grow">{job.function}</span>
                  <span className="muted-cell when">due {relative(job.next_run, now)}</span>
                  <span className="mono">{formatAmount(job.fee_per_run)} XLM</span>
                  <Button
                    size="sm"
                    icon="bolt"
                    disabled={!!account && !eligible}
                    onClick={() => (account ? setDialog({ kind: "execute", job }) : promptConnect())}
                  >
                    Execute
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {account && !eligible && due.length > 0 && keeper !== undefined && (
            <p className="note">
              <Icon name="info" size={15} />
              Stake at least {config ? formatAmount(config.min_stake) : "the minimum"} XLM to execute jobs.
            </p>
          )}
        </Card>

        <Card title="Your keeper" className="fill-md" action={status && <Badge tone={status.tone}>{status.label}</Badge>}>
          {!account ? (
            <Empty icon="wallet" title="No wallet connected" action={<Button onClick={promptConnect}>Connect Freighter</Button>} />
          ) : keeper ? (
            <>
              <Facts
                items={[
                  ["Stake", `${formatAmount(keeper.stake)} XLM`],
                  ["Jobs executed", keeper.executions.toString()],
                  ...(unbondingAt !== undefined
                    ? ([["Withdrawable", now >= unbondingAt ? "Now" : relative(unbondingAt, now)]] as [string, string][])
                    : []),
                ]}
              />
              <div className="card-actions">
                {unbondingAt === undefined ? (
                  <Button onClick={() => setDialog({ kind: "unbond" })}>Begin unbonding</Button>
                ) : (
                  <Button variant="primary" disabled={now < unbondingAt} onClick={() => setDialog({ kind: "withdraw" })}>
                    Withdraw stake
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="card-text">Stake at least {config ? formatAmount(config.min_stake) : "the minimum"} XLM to register as a keeper.</p>
          )}
        </Card>

        <Card title="Run a keeper node" className="span-3">
          <div className="node">
            <div>
              <p className="card-text">
                The reference node polls the registry, simulates every due job, and submits the ones that pay more than their network fee.
                It exposes Prometheus metrics and a health endpoint, and ships with a Dockerfile.
              </p>
              <a className="card-link" href="https://github.com/sorocon-labs/sorocron/tree/main/keeper-bot" target="_blank" rel="noreferrer">
                Keeper documentation <Icon name="external" size={13} />
              </a>
            </div>
            <div className="code">
              <button
                type="button"
                className="icon-btn icon-btn-xs code-copy"
                aria-label={copied ? "Copied" : "Copy commands"}
                onClick={() =>
                  void navigator.clipboard?.writeText(NODE_SETUP).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1_400);
                  })
                }
              >
                <Icon name={copied ? "check" : "copy"} size={14} />
              </button>
              <pre>
                <code>{NODE_SETUP}</code>
              </pre>
            </div>
          </div>
        </Card>
      </div>

      {cron && (
        <>
          <AmountModal
            open={dialog?.kind === "stake"}
            onClose={() => setDialog(null)}
            title={keeper ? "Add stake" : "Become a keeper"}
            description={`Stake is locked while you're a keeper. Withdrawing takes a ${config ? formatDuration(config.unbonding_period) : ""} unbonding period.`}
            action="Stake"
            success="Stake added"
            send={(amount) => cron.stake(amount)}
          />
          <ConfirmModal
            open={dialog?.kind === "unbond"}
            onClose={() => setDialog(null)}
            title="Begin unbonding?"
            description={`You stop being able to execute jobs immediately. Your stake can be withdrawn after ${config ? formatDuration(config.unbonding_period) : "the unbonding period"}.`}
            action="Begin unbonding"
            success="Unbonding started"
            send={() => cron.beginUnbonding()}
          />
          <ConfirmModal
            open={dialog?.kind === "withdraw"}
            onClose={() => setDialog(null)}
            title="Withdraw stake?"
            description={`${keeper ? formatAmount(keeper.stake) : ""} XLM returns to your account and you stop being a keeper.`}
            action="Withdraw stake"
            success="Stake withdrawn"
            send={() => cron.withdrawStake()}
          />
          {dialog?.kind === "execute" && (
            <ConfirmModal
              open
              onClose={() => setDialog(null)}
              title={`Execute job #${dialog.job.id}?`}
              description={`Calls ${dialog.job.function}() now and pays you ${formatAmount(dialog.job.fee_per_run)} XLM. If another keeper runs it first, the transaction fails and costs only the network fee.`}
              action="Execute"
              success={`Job #${dialog.job.id} executed`}
              send={() => cron.execute(dialog.job.id)}
            />
          )}
        </>
      )}
    </>
  );
}
