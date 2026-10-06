//! Measures what each SoroCron call costs, using the built WASM so VM
//! instantiation and real storage sizes are included.
//!
//!   stellar contract build
//!   cargo run -p sorocron-bench --release
//!
//! Prints a Markdown table (docs/costs.md is generated from it). Fees use the
//! mainnet fee schedule snapshot built into soroban-sdk; see its
//! `CostEstimate::fee` docs.

mod registry {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/sorocron_registry.wasm"
    );
}
mod executor {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/sorocron_executor.wasm"
    );
}
mod counter {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/sorocron_example_counter.wasm"
    );
}

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Env, IntoVal, Symbol, Val, Vec,
};

const START: u64 = 1_700_000_000;
const INTERVAL: u64 = 60;
const FEE: i128 = 1_000_000;

struct Row {
    call: String,
    instructions: i64,
    mem: i64,
    read_entries: u32,
    write_entries: u32,
    write_bytes: u32,
    fee: i64,
}

fn measure(env: &Env, call: &str, rows: &mut std::vec::Vec<Row>) {
    let r = env.cost_estimate().resources();
    let fee = env.cost_estimate().fee();
    rows.push(Row {
        call: call.into(),
        instructions: r.instructions,
        mem: r.mem_bytes,
        read_entries: r.memory_read_entries + r.disk_read_entries,
        write_entries: r.write_entries,
        write_bytes: r.write_bytes,
        fee: fee.total,
    });
}

fn params(env: &Env, target: &Address) -> registry::JobParams {
    let args: Vec<Val> = vec![env, 1u32.into_val(env)];
    registry::JobParams {
        target: target.clone(),
        function: Symbol::new(env, "increment"),
        args,
        interval: INTERVAL,
        schedule: registry::Schedule::Interval,
        start_at: 0,
        fee_per_run: FEE,
        max_fee_per_run: 0,
        max_runs: 0,
        end_at: 0,
        resolver: None,
        keepers: None,
    }
}

fn main() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &token);
    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    sac.mint(&owner, &1_000_000_000_000);
    sac.mint(&keeper, &1_000_000_000_000);

    let cron_id = env.register(
        registry::WASM,
        (
            admin.clone(),
            token.clone(),
            token.clone(),
            10_000_000_i128,
            3_600_u64,
        ),
    );
    let cron = registry::Client::new(&env, &cron_id);
    let executor_id = env.register(executor::WASM, (cron_id.clone(),));
    cron.set_executor(&executor_id);
    let target = env.register(counter::WASM, ());

    let mut rows = std::vec::Vec::new();

    cron.stake(&keeper, &10_000_000);
    measure(&env, "stake", &mut rows);

    let id = cron.create_job(&owner, &params(&env, &target), &(FEE * 100));
    measure(&env, "create_job", &mut rows);

    cron.fund_job(&owner, &id, &FEE);
    measure(&env, "fund_job", &mut rows);

    cron.is_due(&id);
    measure(&env, "is_due (simulation)", &mut rows);

    cron.execute(&keeper, &id);
    measure(&env, "execute (first run)", &mut rows);

    env.ledger().set_timestamp(START + INTERVAL);
    cron.execute(&keeper, &id);
    measure(&env, "execute (steady state)", &mut rows);

    // A job carrying 1 KB of arguments: since v4 a run rewrites only the
    // small state entry, so this costs about the same to execute.
    let mut big = params(&env, &target);
    for _ in 0..4 {
        big.args.push_back(soroban_sdk::Bytes::from_array(&env, &[7u8; 256]).into_val(&env));
    }
    let big_id = cron.create_job(&owner, &big, &(FEE * 100));
    measure(&env, "create_job (1 KB of args)", &mut rows);
    cron.execute(&keeper, &big_id);
    measure(&env, "execute (1 KB of args)", &mut rows);

    let mut batch = Vec::new(&env);
    for _ in 0..5 {
        batch.push_back(cron.create_job(&owner, &params(&env, &target), &(FEE * 100)));
    }
    cron.execute_batch(&keeper, &batch);
    measure(&env, "execute_batch (5 jobs)", &mut rows);

    cron.cancel_job(&id);
    measure(&env, "cancel_job", &mut rows);

    println!("| Call | CPU instructions | Memory (bytes) | Entries read | Entries written | Bytes written | Est. fee (stroops) |");
    println!("|---|---:|---:|---:|---:|---:|---:|");
    for r in rows {
        println!(
            "| `{}` | {} | {} | {} | {} | {} | {} |",
            r.call, r.instructions, r.mem, r.read_entries, r.write_entries, r.write_bytes, r.fee
        );
    }
}
