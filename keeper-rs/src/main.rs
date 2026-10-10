//! SoroCron keeper in Rust: an alternative to the TypeScript keeper for
//! operators who prefer Rust services. Configured with the same environment
//! variables.
//!
//!   cargo run --release              run until Ctrl+C
//!   cargo run --release -- --once    one pass
//!   cargo run --release -- --dry-run simulate only, never send
//!
//! Each tick it reads `job_count` and checks `is_due` for every job, then
//! runs the due jobs in `execute_batch` transactions of up to `BATCH_SIZE`.
//! Each batch is simulated first and only sent when something in it runs
//! and, for jobs paid in XLM, the fees cover the network cost. With
//! `METRICS_PORT` set it serves Prometheus metrics on `/metrics` and a
//! liveness probe on `/healthz`, with the TypeScript keeper's metric names.

mod config;
mod metrics;
mod registry;
mod tx;

use std::sync::Arc;
use std::time::{Duration, Instant};

use config::Config;
use metrics::Metrics;
use registry::{batches, BatchOutcome, Registry};

fn log(message: impl AsRef<str>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("[{now}] {}", message.as_ref());
}

/// What one tick did. Every due job lands in exactly one outcome.
#[derive(Default, Debug, PartialEq)]
struct TickSummary {
    checked: u64,
    due: u64,
    batches: u64,
    executed: u64,
    skipped: u64,
    unprofitable: u64,
    failed: u64,
    /// Fees earned by executed jobs, in stroops.
    earned: i128,
}

async fn tick(
    registry: &Registry,
    batch_size: usize,
    fee_is_native: bool,
) -> Result<TickSummary, tx::Error> {
    let mut summary = TickSummary::default();
    let count = registry.job_count().await?;
    let mut due = Vec::new();
    for job_id in 0..count {
        summary.checked += 1;
        if registry.is_due(job_id).await? {
            due.push(job_id);
        }
    }
    summary.due = due.len() as u64;

    for batch in batches(&due, batch_size) {
        let label = format!("jobs {}", join(&batch));
        let size = batch.len() as u64;
        match registry.execute_batch(&batch, fee_is_native).await {
            Ok(BatchOutcome::Executed { ran, earned, hash }) => {
                summary.batches += 1;
                summary.executed += ran.len() as u64;
                summary.skipped += size - ran.len() as u64;
                summary.earned += earned;
                log(format!("executed {} {hash}", join(&ran)));
            }
            Ok(BatchOutcome::Simulated(ran)) => {
                summary.executed += ran.len() as u64;
                summary.skipped += size - ran.len() as u64;
                log(format!("would execute {} (dry run)", join(&ran)));
            }
            Ok(BatchOutcome::Skipped(reason)) => {
                summary.skipped += size;
                log(format!("{label}: skipped ({reason})"));
            }
            Ok(BatchOutcome::Unprofitable { ran, earned, cost }) => {
                summary.unprofitable += ran.len() as u64;
                summary.skipped += size - ran.len() as u64;
                log(format!(
                    "{label}: unprofitable (earns {earned}, costs ~{cost} stroops)"
                ));
            }
            // Another keeper may have run them first; that's expected.
            Err(err) => {
                summary.failed += size;
                log(format!("{label}: send failed ({err})"));
            }
        }
    }
    Ok(summary)
}

fn join(ids: &[u64]) -> String {
    ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",")
}

fn record(metrics: &Metrics, s: &TickSummary, duration: Duration, inclusion_fee: u32) {
    metrics.inc(
        "sorocron_keeper_ticks_total",
        "Completed polling passes",
        &[],
        1.0,
    );
    metrics.set(
        "sorocron_keeper_tick_duration_seconds",
        "Duration of the last tick",
        duration.as_secs_f64(),
    );
    metrics.set(
        "sorocron_keeper_last_tick_timestamp_seconds",
        "Unix time of the last completed tick",
        metrics::now_ms() as f64 / 1000.0,
    );
    metrics.set(
        "sorocron_keeper_jobs_due",
        "Jobs that looked due in the last tick",
        s.due as f64,
    );
    metrics.inc(
        "sorocron_keeper_batches_total",
        "execute_batch transactions sent",
        &[],
        s.batches as f64,
    );
    let help = "Due jobs by outcome";
    for (outcome, n) in [
        ("executed", s.executed),
        ("skipped", s.skipped),
        ("unprofitable", s.unprofitable),
        ("failed", s.failed),
    ] {
        metrics.inc(
            "sorocron_keeper_jobs_total",
            help,
            &[("outcome", outcome)],
            n as f64,
        );
    }
    metrics.inc(
        "sorocron_keeper_fees_earned_stroops_total",
        "Fees earned from executed jobs",
        &[],
        s.earned as f64,
    );
    metrics.set(
        "sorocron_keeper_inclusion_fee_stroops",
        "Current inclusion fee bid",
        inclusion_fee as f64,
    );
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
    let (batch_size, metrics_port, inclusion_fee) =
        (config.batch_size, config.metrics_port, config.inclusion_fee);
    let registry = match Registry::new(config) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let metrics = Arc::new(Metrics::default());
    if metrics_port != 0 {
        let stale_after = Duration::max(3 * interval, Duration::from_secs(60));
        match tokio::net::TcpListener::bind(("0.0.0.0", metrics_port)).await {
            Ok(listener) => {
                tokio::spawn(metrics::serve(listener, metrics.clone(), stale_after));
            }
            Err(e) => {
                eprintln!("can't serve metrics on port {metrics_port}: {e}");
                std::process::exit(1);
            }
        }
    }

    let fee_is_native = match registry.fee_is_native().await {
        Ok(native) => native,
        Err(e) => {
            eprintln!("can't read the registry config: {e}");
            std::process::exit(1);
        }
    };
    log(format!(
        "keeper {} on {network}, batches of {batch_size}{}{}",
        registry.keeper_address(),
        if metrics_port != 0 {
            format!(", metrics on :{metrics_port}")
        } else {
            String::new()
        },
        if dry_run {
            " (dry run: nothing is sent)"
        } else {
            ""
        }
    ));

    loop {
        let started = Instant::now();
        match tick(&registry, batch_size, fee_is_native).await {
            Ok(s) => {
                record(&metrics, &s, started.elapsed(), inclusion_fee);
                metrics.record_success(metrics::now_ms());
                log(format!(
                    "tick: {} jobs, {} due, {} executed, {} skipped, {} unprofitable, {} failed in {:.1}s",
                    s.checked,
                    s.due,
                    s.executed,
                    s.skipped,
                    s.unprofitable,
                    s.failed,
                    started.elapsed().as_secs_f64()
                ));
            }
            Err(e) => {
                metrics.inc(
                    "sorocron_keeper_tick_errors_total",
                    "Ticks that threw before finishing",
                    &[],
                    1.0,
                );
                log(format!("tick failed: {e}"));
            }
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
