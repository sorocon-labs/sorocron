//! Targets and resolvers that call back into the registry mid-run.
//!
//! A job's target and resolver are arbitrary contracts, so one could try to
//! run its own job again, cancel or drain it, or change it while the
//! registry is in the middle of executing it. Soroban rejects contract
//! re-entry, so each callback fails. These tests check what the registry
//! does with that failure: a target's failed callback is recorded as a
//! failed, paid run, and a resolver's makes the run not happen at all. In
//! both cases every balance still adds up.
//!
//! The harness mocks every authorization, so nothing here is stopped by a
//! missing signature: only re-entry protection is being tested.

use soroban_sdk::{vec, Address, IntoVal, Symbol, Val, Vec};
use sorocron_registry::{Error, JobUpdate};
use sorocron_testkit::{Harness, Schedule, FEE};

/// Registry functions a callback can try, with their arguments.
fn callbacks(h: &Harness, job: u64) -> std::vec::Vec<(&'static str, Vec<Val>)> {
    let e = &h.env;
    let update = JobUpdate {
        function: Symbol::new(e, "changed"),
        args: Vec::new(e),
        interval: 60,
        schedule: Schedule::Interval,
        fee_per_run: FEE,
        max_fee_per_run: 0,
        max_runs: 0,
        end_at: 0,
        resolver: None,
        keepers: None,
        after: None,
    };
    std::vec![
        ("execute", (h.keeper.clone(), job).into_val(e)),
        (
            "execute_batch",
            (h.keeper.clone(), vec![e, job]).into_val(e)
        ),
        ("cancel_job", (job,).into_val(e)),
        ("fund_job", (h.owner.clone(), job, 5 * FEE).into_val(e)),
        ("withdraw_job_balance", (job, 5 * FEE).into_val(e)),
        ("update_job", (job, update).into_val(e)),
    ]
}

/// With one token for fees and stake, the registry holds exactly the live
/// job balances plus the keepers' stakes.
fn assert_books_balance(h: &Harness, keepers: &[&Address]) {
    let jobs: i128 = h.cron.get_jobs(&0, &50).iter().map(|j| j.balance).sum();
    let stakes: i128 = keepers
        .iter()
        .filter_map(|k| h.cron.get_keeper(k))
        .map(|k| k.stake)
        .sum();
    assert_eq!(h.token.balance(&h.cron.address), jobs + stakes);
}

#[test]
fn target_callbacks_fail_as_a_paid_failed_run() {
    for single in [true, false] {
        let h = Harness::new();
        let target = h.reentrant();
        let job = h.schedule(&target.address, "run", Vec::new(&h.env), 60);

        // Control: calling any other contract works, so the failures below
        // come from calling back into the registry.
        let other = h.probe();
        target.arm(
            &other.address,
            &Symbol::new(&h.env, "hit"),
            &Vec::new(&h.env),
        );
        h.run(job);
        assert_eq!((h.job(job).failures, other.hits()), (0, 1));
        h.advance(60);

        for (function, args) in callbacks(&h, job) {
            target.arm(&h.cron.address, &Symbol::new(&h.env, function), &args);
            let before = h.job(job);
            let keeper_before = h.token.balance(&h.keeper);

            if single {
                h.run(job);
            } else {
                let ran = h.cron.execute_batch(&h.keeper, &vec![&h.env, job]);
                assert_eq!(ran, vec![&h.env, true], "{function}");
            }

            let after = h.job(job);
            assert_eq!(after.runs, before.runs + 1, "{function}: one run, not two");
            assert_eq!(after.failures, before.failures + 1, "{function}");
            assert_eq!(
                after.balance,
                before.balance - FEE,
                "{function}: only the fee left"
            );
            assert_eq!(after.function, before.function, "{function}: not updated");
            assert_eq!(
                h.token.balance(&h.keeper),
                keeper_before + FEE,
                "{function}"
            );
            assert_books_balance(&h, &[&h.keeper]);

            // Clear the failure count so the job doesn't pause itself.
            h.cron.set_job_active(&job, &true);
            h.advance(60);
        }
    }
}

#[test]
fn resolver_callbacks_stop_the_run() {
    let h = Harness::new();
    let resolver = h.reentrant();
    let probe = h.probe();
    let mut params = h.params(&probe.address, "hit", Vec::new(&h.env), 60);
    params.resolver = Some(resolver.address.clone());
    let job = h.create(&params);

    // Control: a resolver calling any other contract lets the run happen.
    let other = h.probe();
    resolver.arm(
        &other.address,
        &Symbol::new(&h.env, "hit"),
        &Vec::new(&h.env),
    );
    h.run(job);
    assert_eq!((h.job(job).runs, probe.hits()), (1, 1));
    h.advance(60);

    for (function, args) in callbacks(&h, job) {
        resolver.arm(&h.cron.address, &Symbol::new(&h.env, function), &args);
        let before = h.job(job);

        assert!(!h.is_due(job), "{function}");
        assert_eq!(
            h.cron.try_execute(&h.keeper, &job),
            Err(Ok(Error::ResolverRejected)),
            "{function}"
        );
        let after = h.job(job);
        assert_eq!(after.runs, before.runs, "{function}");
        assert_eq!(after.balance, before.balance, "{function}");
        assert_eq!(after.function, before.function, "{function}");
        assert_eq!(probe.hits(), 1, "{function}: the target never ran");
        assert_books_balance(&h, &[&h.keeper]);
    }
}
