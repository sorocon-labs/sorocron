import { useState } from "react";
import { formatAmount, formatDuration, jobStatus, parseAmount, type Config, type Job, type Keeper, type SoroCron } from "@sorocron/sdk";
import { Stat, relative } from "./ui";
import type { Run } from "./App";

export function KeeperView({
  cron,
  config,
  keeper,
  jobs,
  now,
  account,
  connect,
  run,
}: {
  cron?: SoroCron;
  config?: Config;
  keeper?: Keeper | null;
  jobs: Job[];
  now: bigint;
  account?: string;
  connect: () => void;
  run: Run;
}) {
  const [amount, setAmount] = useState("");
  let parsed: bigint | undefined;
  try {
    parsed = amount ? parseAmount(amount) : undefined;
  } catch {
    parsed = undefined;
  }

  const due = jobs.filter((j) => jobStatus(j, now) === "due");
  const pendingFees = due.reduce((sum, j) => sum + j.fee_per_run, 0n);
  const unbonding = keeper?.unbonding_at ?? undefined;
  const active = !!keeper && unbonding === undefined && !!config && keeper.stake >= config.min_stake;

  return (
    <section className="panel keeper">
      <div className="stats">
        <Stat label="Jobs due now" value={due.length} hint={`${formatAmount(pendingFees)} XLM in fees waiting`} />
        <Stat label="Minimum stake" value={config ? `${formatAmount(config.min_stake)} XLM` : "…"} />
        <Stat label="Unbonding period" value={config ? formatDuration(config.unbonding_period) : "…"} />
      </div>

      {!account ? (
        <div className="callout">
          <div>
            <h3>Earn fees by running jobs</h3>
            <p>
              Keepers stake XLM, watch for due jobs and execute them. Each run pays the job's fee to whichever keeper
              lands it first. Connect a wallet to stake, then run the reference keeper node.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={connect}>
            Connect Freighter
          </button>
        </div>
      ) : (
        <div className="keeper-card">
          <div className="keeper-status">
            <span className={`dot ${active ? "dot-ok" : "dot-off"}`} />
            {keeper === undefined
              ? "Loading…"
              : keeper === null
                ? "Not a keeper yet"
                : unbonding !== undefined
                  ? `Unbonding, withdrawable ${relative(unbonding, now)}`
                  : active
                    ? "Active keeper"
                    : "Stake below the minimum"}
          </div>
          {keeper && (
            <div className="stats">
              <Stat label="Your stake" value={`${formatAmount(keeper.stake)} XLM`} />
              <Stat label="Jobs executed" value={keeper.executions} />
            </div>
          )}
          <div className="actions">
            {unbonding === undefined && (
              <div className="inline-form">
                <input
                  inputMode="decimal"
                  placeholder="Amount in XLM"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label="Stake amount in XLM"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!parsed || parsed <= 0n}
                  onClick={() => run("Staked", () => cron!.stake(parsed!)).then((ok) => ok && setAmount(""))}
                >
                  Stake
                </button>
              </div>
            )}
            {keeper && unbonding === undefined && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (confirm("Start unbonding? You stop being able to execute jobs immediately.")) {
                    void run("Unbonding started", () => cron!.beginUnbonding());
                  }
                }}
              >
                Begin unbonding
              </button>
            )}
            {keeper && unbonding !== undefined && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={now < unbonding}
                onClick={() => run("Stake withdrawn", () => cron!.withdrawStake())}
              >
                Withdraw stake
              </button>
            )}
            {active && due.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  run(`Executed job #${due[0].id}`, () => cron!.execute(due[0].id))
                }
              >
                Execute job #{due[0].id.toString()} now
              </button>
            )}
          </div>
        </div>
      )}

      <div className="howto">
        <h3>Run a keeper node</h3>
        <p>The reference keeper polls the registry and executes due jobs automatically. It ships with Prometheus metrics and a health endpoint.</p>
        <pre>
          <code>{`git clone https://github.com/sorocon-labs/sorocron
cd sorocron/keeper-bot && npm install
cp .env.example .env    # add STELLAR_SECRET_KEY
npm run keeper`}</code>
        </pre>
      </div>
    </section>
  );
}
