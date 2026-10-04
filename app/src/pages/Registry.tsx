import { ERRORS, formatAmount, formatDuration } from "@sorocron/sdk";
import { Icon, type IconName } from "../components/Icon";
import { Address, Badge, Card, Facts, PageHeader, Skeleton } from "../components/ui";
import { NETWORK, useRegistry } from "../state/registry";

const CONTRACTS: [string, string | undefined, string][] = [
  ["Registry", NETWORK.contracts.registry, "Jobs, escrow, keeper stakes and admin"],
  ["Executor", NETWORK.contracts.executor, "Makes every target call; holds no funds"],
  ["TTL Guardian", NETWORK.contracts.ttlGuardian, "Extends contract TTLs on schedule"],
  ["Fee token", NETWORK.contracts.feeToken, "Native XLM (Stellar Asset Contract)"],
  ["Example counter", NETWORK.contracts.counter, "Demo job target"],
  ["Example resolver", NETWORK.contracts.flagResolver, "Demo should_run condition"],
];

const LINKS: [IconName, string, string, string][] = [
  ["book", "Architecture", "How scheduling, resolvers and the TTL Guardian work", "docs/architecture.md"],
  ["shield", "Security model", "Why targets are called through a fund-less executor", "docs/security.md"],
  ["code", "TypeScript SDK", "Typed client used by this app", "packages/sdk"],
  ["keeper", "Keeper node", "Run your own keeper", "keeper-bot"],
];

export function Registry() {
  const { config, version, cron } = useRegistry();
  const repo = "https://github.com/sorocon-labs/sorocron";

  return (
    <>
      <PageHeader title="Registry" description="Configuration, deployed contracts and reference for the SoroCron registry on testnet." />

      <div className="bento">
        <Card title="Configuration" className="span-2">
          {config ? (
            <Facts
              items={[
                ["Status", config.paused ? <Badge tone="red">Paused</Badge> : <Badge tone="green">Running</Badge>],
                ["Interface version", `v${version ?? "…"}`],
                ["Admin", <Address key="a" value={config.admin} />],
                ["Minimum keeper stake", `${formatAmount(config.min_stake)} XLM`],
                ["Unbonding period", formatDuration(config.unbonding_period)],
                ["Minimum interval", config.min_interval > 0n ? formatDuration(config.min_interval) : "None"],
                ["Maximum arguments", config.max_args > 0 ? config.max_args.toString() : "No limit"],
                ["Executor", config.executor ? <Address key="e" value={config.executor} /> : "Not connected"],
              ]}
            />
          ) : (
            <Skeleton rows={5} height={24} />
          )}
        </Card>

        <Card title="Network" className="fill-md">
          <Facts
            items={[
              ["Network", "Stellar testnet"],
              ["RPC", <span key="r" className="mono wrap">{NETWORK.rpcUrl.replace("https://", "")}</span>],
              ["Connected to", cron ? <Address key="c" value={cron.contractId} /> : "…"],
            ]}
          />
          <p className="note">
            <Icon name="info" size={15} />
            Testnet is reset periodically; addresses are kept current in the repository.
          </p>
        </Card>

        <Card title="Contracts" className="span-3">
          <div className="table compact" role="table" aria-label="Contracts">
            {CONTRACTS.filter(([, addr]) => addr).map(([name, addr, purpose]) => (
              <div key={name} className="table-row static three" role="row">
                <span role="cell">
                  <strong>{name}</strong>
                </span>
                <span role="cell" className="muted-cell">
                  {purpose}
                </span>
                <span role="cell">
                  <Address value={addr!} />
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Error codes" className="span-2">
          <div className="errors-table">
            {Object.entries(ERRORS).map(([code, [name, message]]) => (
              <div key={code} className="error-row">
                <span className="mono code-n">{code}</span>
                <span className="mono">{name}</span>
                <span className="muted-cell">{message}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Learn more" className="fill-md">
          <ul className="links">
            {LINKS.map(([icon, title, body, path]) => (
              <li key={title}>
                <a href={`${repo}/${path.includes(".") ? "blob" : "tree"}/main/${path}`} target="_blank" rel="noreferrer">
                  <span className="choice-icon">
                    <Icon name={icon} size={16} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{body}</small>
                  </span>
                  <Icon name="external" size={14} />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
