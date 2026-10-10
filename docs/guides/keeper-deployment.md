# Running a keeper in production

A keeper earns the fee of every job it executes. This guide covers running
one 24/7: choosing how to deploy it, handling its keys, sizing its accounts,
and knowing when it needs attention. For what the keeper does each tick, see
[keeper-bot/README.md](../../keeper-bot/README.md).

## Before you start

1. **A staked keeper account.** Any Stellar account with at least the
   registry's minimum stake:
   ```bash
   npm run cli -- registry            # shows the minimum stake
   npm run cli -- keeper stake 100
   npm run cli -- keeper status
   ```
2. **XLM for network fees.** Each transaction costs about 0.2 XLM in
   resource fees plus your inclusion fee bid (see [costs](../costs.md)). Keep
   enough for a few days of runs and set `MIN_BALANCE_XLM` to warn you.
3. **An RPC endpoint.** The public testnet RPC is fine for testnet. On
   mainnet there is no public default: use a provider or run
   [stellar-rpc](https://github.com/stellar/stellar-rpc) yourself.

## Configuration

All settings are environment variables; [`.env.example`](../../keeper-bot/.env.example)
documents each one. The important ones:

| Variable | Purpose |
|---|---|
| `STELLAR_SECRET_KEY` | The staked keeper. Receives fees and signs executions. **Secret.** |
| `CHANNEL_SECRET_KEYS` | Optional extra accounts that pay for and sequence transactions, so batches go out in parallel. **Secret.** |
| `STELLAR_NETWORK`, `STELLAR_RPC_URL` | `testnet`, `mainnet` or `local`, and the RPC to use |
| `STELLAR_RPC_URLS` | Several RPC endpoints, most preferred first; the keeper fails over between them |
| `SOROCRON_CONTRACT_ID` | Registry address; defaults to `deployments/<network>.json` |
| `BATCH_SIZE` | Jobs per transaction, up to 20 |
| `FEE_PERCENTILE`, `MAX_INCLUSION_FEE` | Inclusion fee bidding |
| `MIN_PROFIT_STROOPS` | Don't send batches that earn less than they cost |
| `METRICS_PORT` | Prometheus `/metrics` and `/healthz` |
| `LOG_FORMAT=json` | Structured logs for your log pipeline |
| `ALERT_WEBHOOK_URL`, `ALERT_FORMAT` | Discord, Slack or JSON alerts |
| `TOPUP_STAKE_TO_XLM` | Stake back up to this amount after slashing |

## Key handling

The keeper key controls the stake; a leaked key can be unbonded and drained
after the unbonding period.

- **Never bake keys into images or commit them.** Inject them at runtime
  from a secret store (Kubernetes Secrets backed by External Secrets or
  Sealed Secrets, Vault, AWS/GCP secret managers, systemd credentials).
- **Use channel accounts for throughput, not the keeper key.** Channel
  accounts hold only fee money; if one leaks you lose a few XLM, not stake.
- **One process per key.** Two keepers sharing a key race each other's
  sequence numbers. Scale out with different keys, or with more channels.
- **Rotate by staking a new key first,** then `keeper unbond` the old one and
  `keeper withdraw` once unbonding finishes. Slashing (if the registry has
  assigned windows on) only applies while a key is in the rotation, so
  unbond before shutting a keeper down for good.

## Option 1: Docker

```bash
cp keeper-bot/.env.example keeper-bot/.env      # fill it in
docker compose -f keeper-bot/docker-compose.yml up -d --build
docker compose -f keeper-bot/docker-compose.yml logs -f
```

The image runs as a non-root user, exposes metrics on 9464 and uses
`/healthz` as its Docker `HEALTHCHECK`, so `docker ps` shows unhealthy when
ticks stop succeeding. `restart: unless-stopped` brings it back after crashes
and reboots.

## Option 2: systemd

[`deploy/systemd/sorocron-keeper.service`](../../deploy/systemd/sorocron-keeper.service)
runs the built keeper as an unprivileged, sandboxed service:

```bash
sudo useradd --system --home /opt/sorocron --shell /usr/sbin/nologin sorocron
sudo git clone https://github.com/sorocon-labs/sorocron /opt/sorocron
cd /opt/sorocron && sudo npm ci && sudo npm run build -w @sorocron/sdk && sudo npm run build -w sorocron-keeper-bot
sudo install -d -m 700 -o sorocron /etc/sorocron
sudo install -m 600 -o sorocron keeper-bot/.env /etc/sorocron/keeper.env
sudo cp deploy/systemd/sorocron-keeper.service /etc/systemd/system/
sudo systemctl enable --now sorocron-keeper
journalctl -u sorocron-keeper -f
```

## Option 3: Kubernetes

Plain manifests are in [`deploy/kubernetes/keeper.yaml`](../../deploy/kubernetes/keeper.yaml),
and a Helm chart in [`deploy/helm/sorocron-keeper`](../../deploy/helm/sorocron-keeper):

```bash
kubectl create secret generic sorocron-keeper \
  --from-literal=STELLAR_SECRET_KEY=S... \
  --from-literal=CHANNEL_SECRET_KEYS=S...,S... \
  --from-literal=ALERT_WEBHOOK_URL=https://hooks.example/...

helm install keeper deploy/helm/sorocron-keeper \
  --set network=mainnet --set rpcUrl=https://your-rpc \
  --set metrics.serviceMonitor=true
```

Both run one replica (see "One process per key"), drop all Linux
capabilities, mount the root filesystem read-only, and use `/healthz` as
liveness and readiness probes. Images are published to
`ghcr.io/sorocon-labs/sorocron-keeper` by the release workflow; you can also
build your own with `docker build -f keeper-bot/Dockerfile .`.

## Monitoring

Scrape `/metrics` with Prometheus (the Kubernetes manifests carry the usual
`prometheus.io/*` annotations, and the Helm chart can create a
ServiceMonitor). The metric list and ready-made Grafana queries are in the
[keeper README](../../keeper-bot/README.md#metrics). Alert on at least:

| Condition | Query | Why |
|---|---|---|
| Keeper stalled | `time() - sorocron_keeper_last_tick_timestamp_seconds > 60` | RPC down, crashed, out of XLM |
| Sends failing | failed share of `sorocron_keeper_jobs_total` above 20% for 15 minutes | Fee bids too low, competition, RPC trouble |
| Low balance | `min(sorocron_keeper_balance_stroops) / 1e7 < 5` | Runs will start failing |
| Fee bid maxed | `sorocron_keeper_inclusion_fee_stroops >= MAX_INCLUSION_FEE` | Congestion beyond your ceiling |

The webhook alerts (`ALERT_WEBHOOK_URL`) cover the same failures without a
Prometheus stack, and add stake alerts: `low_stake` when one slash would
disqualify the keeper, `keeper_ineligible` when it already has.

## Running several keepers

- Give each its own key and stake. With assigned windows enabled, more
  staked keepers means each gets a share of reserved runs.
- Point them at different RPC providers so one outage doesn't stop them all.
- Running the Rust keeper ([`keeper-rs`](../../keeper-rs)) alongside the
  TypeScript one diversifies implementations too.

## Upgrading

Pull the new version, rebuild and restart; the keeper has no local state
beyond its in-memory index, which it rebuilds on start. If the registry was
upgraded to a new interface `version()`, upgrade the keeper first: the CLI's
`registry` command shows the version the keeper is talking to.
