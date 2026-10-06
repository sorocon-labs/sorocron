//! Fee accounting invariant under random operation sequences (#5).
//!
//! When the fee and stake token are the same, the registry's token balance
//! must always equal the sum of live job balances plus the stakes of
//! registered keepers: every token that enters is escrowed for exactly one
//! of them, and every token that leaves (fees, protocol fees, refunds,
//! withdrawals, slashing rewards) is debited from exactly one of them.
//!
//! Each case builds a registry with protocol fees, assigned windows and
//! slashing all switched on, then applies a random sequence of creates,
//! funding, withdrawals, cancellations, executions (single and batched,
//! including failing targets), staking, unbonding, withdrawals and clock
//! jumps. After every step the invariant is checked, and no call may fail
//! with anything other than a registry error.
//!
//! CI runs 1,000 cases (`PROPTEST_CASES=1000`); locally the default is 48.

extern crate std;

use std::vec;

use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec as svec, Address, Env, IntoVal, Symbol, Val, Vec,
};
use sorocron_executor::Executor;

use crate::test::MockTarget;
use crate::{JobParams, Schedule, SoroCron, SoroCronClient};

const OWNERS: usize = 3;
const KEEPERS: usize = 3;
const START: u64 = 1_700_000_000;
const MIN_STAKE: i128 = 1_000;

#[derive(Clone, Debug)]
enum Op {
    Create {
        owner: usize,
        fee: i128,
        runs: i128,
        failing: bool,
        ramp: bool,
    },
    Fund {
        job: usize,
        amount: i128,
    },
    Withdraw {
        job: usize,
        amount: i128,
    },
    Cancel {
        job: usize,
    },
    Pause {
        job: usize,
        active: bool,
    },
    Execute {
        keeper: usize,
        job: usize,
    },
    Batch {
        keeper: usize,
        jobs: std::vec::Vec<usize>,
    },
    Stake {
        keeper: usize,
        amount: i128,
    },
    Unbond {
        keeper: usize,
    },
    WithdrawStake {
        keeper: usize,
    },
    SettleAll,
    Advance {
        seconds: u64,
    },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..OWNERS, 1i128..=500, 1i128..=20, any::<bool>(), any::<bool>())
            .prop_map(|(owner, fee, runs, failing, ramp)| Op::Create { owner, fee, runs, failing, ramp }),
        2 => (0usize..12, 1i128..=5_000).prop_map(|(job, amount)| Op::Fund { job, amount }),
        1 => (0usize..12, 1i128..=5_000).prop_map(|(job, amount)| Op::Withdraw { job, amount }),
        1 => (0usize..12).prop_map(|job| Op::Cancel { job }),
        1 => (0usize..12, any::<bool>()).prop_map(|(job, active)| Op::Pause { job, active }),
        5 => (0..KEEPERS, 0usize..12).prop_map(|(keeper, job)| Op::Execute { keeper, job }),
        2 => (0..KEEPERS, prop::collection::vec(0usize..12, 1..6)).prop_map(|(keeper, jobs)| Op::Batch { keeper, jobs }),
        2 => (0..KEEPERS, 1i128..=3_000).prop_map(|(keeper, amount)| Op::Stake { keeper, amount }),
        1 => (0..KEEPERS).prop_map(|keeper| Op::Unbond { keeper }),
        1 => (0..KEEPERS).prop_map(|keeper| Op::WithdrawStake { keeper }),
        1 => Just(Op::SettleAll),
        3 => prop_oneof![1u64..=90, 1_000u64..=5_000].prop_map(|seconds| Op::Advance { seconds }),
    ]
}

struct World {
    env: Env,
    cron: SoroCronClient<'static>,
    token: TokenClient<'static>,
    target: Address,
    owners: std::vec::Vec<Address>,
    keepers: std::vec::Vec<Address>,
}

fn world(protocol_bps: u32, grace: u64, slash_bps: u32) -> World {
    // Thousands of throwaway environments: skip writing a JSON snapshot for each.
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &token_id);
    let cron_id = env.register(
        SoroCron,
        (
            admin.clone(),
            token_id.clone(),
            token_id.clone(),
            MIN_STAKE,
            3_600u64,
        ),
    );
    let cron = SoroCronClient::new(&env, &cron_id);
    cron.set_executor(&env.register(Executor, (cron_id.clone(),)));
    let treasury = Address::generate(&env);
    cron.set_protocol_fee(&protocol_bps, &Some(treasury));
    cron.set_keeper_windows(&grace, &slash_bps);
    cron.set_unbonding_epoch(&1_800);

    let owners: std::vec::Vec<Address> = (0..OWNERS).map(|_| Address::generate(&env)).collect();
    let keepers: std::vec::Vec<Address> = (0..KEEPERS).map(|_| Address::generate(&env)).collect();
    for who in owners.iter().chain(keepers.iter()) {
        sac.mint(who, &1_000_000_000);
    }
    let target = env.register(MockTarget, ());

    World {
        cron,
        token: TokenClient::new(&env, &token_id),
        target,
        owners,
        keepers,
        env,
    }
}

/// Registry balance == live job balances + registered keepers' stakes.
fn check_invariant(w: &World) -> Result<(), TestCaseError> {
    let mut escrowed: i128 = 0;
    for id in 0..w.cron.job_count() {
        if let Some(job) = w.cron.get_job(&id) {
            prop_assert!(job.balance >= 0, "job {} balance went negative", id);
            escrowed += job.balance;
        }
    }
    for keeper in &w.keepers {
        if let Some(info) = w.cron.get_keeper(keeper) {
            prop_assert!(info.stake >= 0, "keeper stake went negative");
            escrowed += info.stake;
        }
    }
    let held = w.token.balance(&w.cron.address);
    prop_assert_eq!(
        held,
        escrowed,
        "registry holds {} but owes {}",
        held,
        escrowed
    );
    Ok(())
}

/// Registry errors are expected outcomes; anything else (a host error, a
/// token transfer failing, an arithmetic panic) is a bug.
macro_rules! allowed {
    ($call:expr) => {{
        match $call {
            Ok(_) | Err(Ok(_)) => {}
            Err(Err(e)) => prop_assert!(false, "call failed outside the registry: {:?}", e),
        }
    }};
}

fn job_id(w: &World, pick: usize) -> u64 {
    let count = w.cron.job_count();
    if count == 0 {
        0
    } else {
        pick as u64 % count
    }
}

fn apply(w: &World, op: &Op) -> Result<(), TestCaseError> {
    let env = &w.env;
    match op {
        Op::Create {
            owner,
            fee,
            runs,
            failing,
            ramp,
        } => {
            let (target, function, args): (Address, Symbol, Vec<Val>) = if *failing {
                (w.target.clone(), Symbol::new(env, "fail"), Vec::new(env))
            } else {
                (
                    w.target.clone(),
                    Symbol::new(env, "bump"),
                    svec![env, 1u32.into_val(env)],
                )
            };
            let params = JobParams {
                target,
                function,
                args,
                interval: 60,
                schedule: Schedule::Interval,
                start_at: 0,
                fee_per_run: *fee,
                max_fee_per_run: if *ramp { fee * 3 } else { 0 },
                max_runs: 0,
                end_at: 0,
                resolver: None,
                keepers: None,
            };
            allowed!(w
                .cron
                .try_create_job(&w.owners[*owner], &params, &(fee * runs)));
        }
        Op::Fund { job, amount } => {
            allowed!(w.cron.try_fund_job(&w.owners[0], &job_id(w, *job), amount));
        }
        Op::Withdraw { job, amount } => {
            allowed!(w.cron.try_withdraw_job_balance(&job_id(w, *job), amount));
        }
        Op::Cancel { job } => {
            allowed!(w.cron.try_cancel_job(&job_id(w, *job)));
        }
        Op::Pause { job, active } => {
            allowed!(w.cron.try_set_job_active(&job_id(w, *job), active));
        }
        Op::Execute { keeper, job } => {
            allowed!(w.cron.try_execute(&w.keepers[*keeper], &job_id(w, *job)));
        }
        Op::Batch { keeper, jobs } => {
            let mut ids = Vec::new(env);
            for j in jobs {
                ids.push_back(job_id(w, *j));
            }
            allowed!(w.cron.try_execute_batch(&w.keepers[*keeper], &ids));
        }
        Op::Stake { keeper, amount } => {
            allowed!(w.cron.try_stake(&w.keepers[*keeper], amount));
        }
        Op::Unbond { keeper } => {
            allowed!(w.cron.try_begin_unbonding(&w.keepers[*keeper]));
        }
        Op::WithdrawStake { keeper } => {
            allowed!(w.cron.try_withdraw_stake(&w.keepers[*keeper]));
        }
        Op::SettleAll => {
            let mut all = Vec::new(env);
            for k in &w.keepers {
                all.push_back(k.clone());
            }
            allowed!(w.cron.try_withdraw_stakes(&all));
        }
        Op::Advance { seconds } => {
            let now = env.ledger().timestamp();
            env.ledger().set_timestamp(now + seconds);
        }
    }
    Ok(())
}

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(48)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases()))]

    #[test]
    fn escrow_always_matches_job_balances_plus_stakes(
        protocol_bps in prop_oneof![Just(0u32), 1u32..=1_000],
        grace in prop_oneof![Just(0u64), 10u64..=60],
        slash_bps in 0u32..=1_000,
        ops in prop::collection::vec(op(), 1..40),
    ) {
        let w = world(protocol_bps, grace, slash_bps);
        // Start with every keeper staked so executions can happen.
        for k in &w.keepers {
            w.cron.stake(k, &MIN_STAKE);
        }
        check_invariant(&w)?;
        for op in &ops {
            apply(&w, op)?;
            check_invariant(&w)?;
        }
    }
}
