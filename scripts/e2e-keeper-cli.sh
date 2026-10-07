#!/usr/bin/env bash
# Takes a second keeper through its whole stake lifecycle with the CLI (#76):
# register with `keeper topup`, top up to a target, unbond, then withdraw.
#
#   scripts/e2e-keeper-cli.sh
#
# Needs a local network (stellar/quickstart on :8000) with SoroCron deployed by
# `npm run deploy` with STELLAR_NETWORK=local and a short
# UNBONDING_PERIOD_SECONDS, as the end-to-end CI job does. The deployment's
# own keeper is left alone, so this can run before or after the keeper checks.
set -euo pipefail
cd "$(dirname "$0")/.."

export STELLAR_NETWORK="${STELLAR_NETWORK:-local}"
friendbot="${FRIENDBOT_URL:-http://localhost:8000/friendbot}"

cli() { npm run -s cli -w sorocron-keeper-bot -- "$@"; }

# expect <pattern> <command...>: the command succeeds and prints the pattern.
expect() {
  local pattern=$1 out
  shift
  echo "\$ sorocron ${*:2}"
  out=$("$@" 2>&1) || { echo "$out"; echo "::error::'${*:2}' failed"; exit 1; }
  echo "$out"
  grep -Eq "$pattern" <<<"$out" || { echo "::error::'${*:2}' didn't print /$pattern/"; exit 1; }
}

# expect_fail <pattern> <command...>: the command fails and prints the pattern.
expect_fail() {
  local pattern=$1 out
  shift
  echo "\$ sorocron ${*:2}"
  if out=$("$@" 2>&1); then echo "$out"; echo "::error::'${*:2}' should have failed"; exit 1; fi
  echo "$out"
  grep -Eq "$pattern" <<<"$out" || { echo "::error::'${*:2}' failed without /$pattern/"; exit 1; }
}

# A fresh account; the exported key takes precedence over keeper-bot/.env.
read -r STELLAR_SECRET_KEY address < <(node --input-type=module -e \
  'import { Keypair } from "@stellar/stellar-sdk"; const k = Keypair.random(); console.log(k.secret(), k.publicKey());')
export STELLAR_SECRET_KEY
curl -sf "$friendbot?addr=$address" >/dev/null
echo "Second keeper: $address"

# The local deployment's minimum stake is 1 XLM.
expect "is not a keeper" cli keeper status
expect "Would stake 1 XLM to bring 0 XLM up to 1 XLM" cli keeper topup --dry-run
expect "is not a keeper" cli keeper status
expect "Topped up 1 XLM\. Total stake: 1 XLM" cli keeper topup
expect "Nothing to do" cli keeper topup
expect "Topped up 2 XLM\. Total stake: 3 XLM" cli keeper topup --to 3
expect_fail "needs 7 XLM, more than --max 1 XLM" cli keeper topup --to 10 --max 1
expect "Total stake: 4 XLM" cli keeper stake 1
expect "^Status +active" cli keeper status
expect "^Stake +4 XLM" cli keeper status

expect "Unbonding\. Withdrawable at" cli keeper unbond
expect "^Status +unbonding" cli keeper status
expect_fail "while unbonding" cli keeper topup
expect_fail "KeeperUnbonding" cli keeper stake 1

# Withdraw as soon as the unbonding period is over.
echo "\$ sorocron keeper withdraw (until unbonding ends)"
for _ in $(seq 1 24); do
  if out=$(cli keeper withdraw 2>&1); then break; fi
  grep -q "UnbondingNotFinished" <<<"$out" || { echo "$out"; echo "::error::withdraw failed"; exit 1; }
  sleep 5
done
echo "$out"
grep -Eq "Withdrew 4 XLM" <<<"$out" || { echo "::error::Unbonding didn't finish within two minutes"; exit 1; }
expect "is not a keeper" cli keeper status

echo "Keeper stake lifecycle OK"
