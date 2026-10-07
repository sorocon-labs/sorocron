//! SoroCron keeper in Rust: an alternative to the TypeScript keeper for
//! operators who prefer Rust services. Configured with the same environment
//! variables.
//!
//!   cargo run --release              run until Ctrl+C
//!   cargo run --release -- --once    one pass
//!   cargo run --release -- --dry-run simulate only, never send
//!
//! Each tick it reads `job_count`, checks `is_due` for every job, and for each
//! due job simulates `execute`, assembles the transaction from the
//! simulation, signs it and sends it. Keeping a local index from events and
//! batching, as the TypeScript keeper does, are natural next steps.

mod config;
mod registry;
mod tx;

use std::time::Instant;

use config::Config;
use registry::{Outcome, Registry};

fn log(message: impl AsRef<str>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("[{now}] {}", message.as_ref());
}

#[derive(Default, Debug, PartialEq)]
struct TickSummary {
    checked: u64,
    due: u64,
    executed: u64,
    skipped: u64,
}

async fn tick(registry: &Registry) -> Result<TickSummary, tx::Error> {
    let mut summary = TickSummary::default();
    let count = registry.job_count().await?;
    for job_id in 0..count {
        summary.checked += 1;
        if !registry.is_due(job_id).await? {
            continue;
        }
        summary.due += 1;
        match registry.execute(job_id).await {
            Ok(Outcome::Executed(hash)) => {
                summary.executed += 1;
                log(format!("job {job_id}: executed {hash}"));
            }
            Ok(Outcome::Simulated) => {
                summary.executed += 1;
                log(format!("job {job_id}: would execute (dry run)"));
            }
            Ok(Outcome::Skipped(reason)) => {
                summary.skipped += 1;
                log(format!("job {job_id}: skipped ({reason})"));
            }
            // Another keeper may have run it first; that's expected.
            Err(err) => {
                summary.skipped += 1;
                log(format!("job {job_id}: send failed ({err})"));
            }
        }
    }
    Ok(summary)
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let config = match Config::from_env(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let (once, interval, network, dry_run) = (
        config.once,
        config.poll_interval,
        config.network.clone(),
        config.dry_run,
    );
    let registry = match Registry::new(config) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    log(format!(
        "keeper {} on {network}{}",
        registry.keeper_address(),
        if dry_run {
            " (dry run: nothing is sent)"
        } else {
            ""
        }
    ));

    loop {
        let started = Instant::now();
        match tick(&registry).await {
            Ok(s) => log(format!(
                "tick: {} jobs, {} due, {} executed, {} skipped in {:.1}s",
                s.checked,
                s.due,
                s.executed,
                s.skipped,
                started.elapsed().as_secs_f64()
            )),
            Err(e) => log(format!("tick failed: {e}")),
        }
        if once {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = tokio::signal::ctrl_c() => {
                log("shutting down");
                break;
            }
        }
    }
}
