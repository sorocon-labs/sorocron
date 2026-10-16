//! Missed assigned windows: an attacker must never be able to take another
//! keeper's stake, or blacken its record, by arranging for a job to be
//! impossible to run during that keeper's window and running it right after.
//! Each test plays one way of blocking the window; the victim is the keeper
//! the run is assigned to, and the attacker is another staked keeper who
//! owns the job.

extern crate std;

use crate::test::*;
use crate::{Error, JobParams, JobUpdate, MAX_UNBONDING_EPOCH};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, AuthorizedFunction, Ledger, MockAuth, MockAuthInvoke},
    token::TokenClient,
    vec, Address, Env, IntoVal, Symbol,
};

const GRACE: u64 = 30;

struct Scene {
    s: Setup,
    victim: Address,
    attacker: Address,
}

/// Two staked keepers with assigned windows on; the attacker also owns jobs.
fn scene() -> Scene {
    let s = setup();
    let attacker = Address::generate(&s.env);
    s.sac.mint(&attacker, &INITIAL_BALANCE);
    s.cron.stake(&attacker, &MIN_STAKE);
    s.cron.set_keeper_windows(&GRACE);
    let victim = s.keeper.clone();
    Scene {
        s,
        victim,
        attacker,
    }
}

/// Creates jobs from `p` until one's next run is assigned to the victim, as
/// an attacker can predict from `sha256(job_id, runs)`.
fn job_for_victim(sc: &Scene, p: &JobParams) -> u64 {
    for _ in 0..32 {
        let id = sc.s.cron.create_job(&sc.attacker, p, &1_000);
        if sc.s.cron.assigned_keeper(&id) == Some(sc.victim.clone()) {
            return id;
        }
    }
    panic!("no job assigned to the victim");
}

/// The victim kept its full stake and no miss was recorded against it.
fn assert_untouched(sc: &Scene) {
    let stats = sc.s.cron.keeper_stats(&sc.victim).unwrap();
    assert_eq!(stats.stake, MIN_STAKE, "victim's stake was taken");
    assert_eq!(stats.slashed, 0);
    assert_eq!(
        stats.missed, 0,
        "a miss was recorded for a window the victim couldn't use"
    );
}

#[test]
fn a_resolver_that_says_no_during_the_window_costs_the_victim_nothing() {
    let sc = scene();
    let s = &sc.s;
    let resolver = MockResolverClient::new(&s.env, &s.env.register(MockResolver, ()));
    let mut p = params(s);
    p.resolver = Some(resolver.address.clone());
    let id = job_for_victim(&sc, &p);

    // During its window the victim can't run the job...
    assert_eq!(
        s.cron.try_execute(&sc.victim, &id),
        Err(Ok(Error::ResolverRejected))
    );
    // ...then the resolver flips as the window closes and the attacker runs it.
    advance(&s.env, GRACE);
    resolver.set_ready(&true);
    s.cron.execute(&sc.attacker, &id);
    assert_untouched(&sc);
}

#[test]
fn pausing_the_job_through_the_window_costs_the_victim_nothing() {
    let sc = scene();
    let s = &sc.s;
    let id = job_for_victim(&sc, &params(s));

    s.cron.set_job_active(&id, &false);
    assert_eq!(
        s.cron.try_execute(&sc.victim, &id),
        Err(Ok(Error::JobPaused))
    );
    advance(&s.env, GRACE);
    s.cron.set_job_active(&id, &true);
    s.cron.execute(&sc.attacker, &id);
    assert_untouched(&sc);
}

#[test]
fn draining_the_balance_through_the_window_costs_the_victim_nothing() {
    let sc = scene();
    let s = &sc.s;
    let id = job_for_victim(&sc, &params(s));

    s.cron.withdraw_job_balance(&id, &1_000);
    assert_eq!(
        s.cron.try_execute(&sc.victim, &id),
        Err(Ok(Error::InsufficientJobBalance))
    );
    advance(&s.env, GRACE);
    s.cron.fund_job(&sc.attacker, &id, &1_000);
    s.cron.execute(&sc.attacker, &id);
    assert_untouched(&sc);
}

#[test]
fn adding_the_victim_to_the_allowlist_after_the_window_costs_it_nothing() {
    let sc = scene();
    let s = &sc.s;
    let mut p = params(s);
    p.keepers = Some(vec![&s.env, sc.attacker.clone()]);
    let id = s.cron.create_job(&sc.attacker, &p, &1_000);
    advance(&s.env, GRACE);

    // Only now does the victim join the allowlist, in whichever order makes
    // this run its assignment.
    let update = |keepers: soroban_sdk::Vec<Address>| {
        let mut u: JobUpdate = update_from(s, id);
        u.keepers = Some(keepers);
        s.cron.update_job(&id, &u);
    };
    update(vec![&s.env, sc.victim.clone(), sc.attacker.clone()]);
    if s.cron.assigned_keeper(&id) != Some(sc.victim.clone()) {
        update(vec![&s.env, sc.attacker.clone(), sc.victim.clone()]);
    }
    assert_eq!(s.cron.assigned_keeper(&id), Some(sc.victim.clone()));

    // Running it straight away must not count against the victim.
    let _ = s.cron.try_execute(&sc.attacker, &id);
    assert_untouched(&sc);
}

#[test]
fn an_admin_pause_through_the_window_costs_the_victim_nothing() {
    let sc = scene();
    let s = &sc.s;
    let id = job_for_victim(&sc, &params(s));

    s.cron.set_paused(&true);
    advance(&s.env, GRACE);
    s.cron.set_paused(&false);
    s.cron.execute(&sc.attacker, &id);
    assert_untouched(&sc);
}

#[test]
fn an_honest_miss_is_recorded_but_never_takes_stake() {
    let sc = scene();
    let s = &sc.s;
    let id = job_for_victim(&sc, &params(s));

    // Nothing stood in the victim's way; it just didn't run the job.
    advance(&s.env, GRACE);
    let attacker_before = s.token.balance(&sc.attacker);
    s.cron.execute(&sc.attacker, &id);

    let stats = s.cron.keeper_stats(&sc.victim).unwrap();
    assert_eq!(
        stats.stake, MIN_STAKE,
        "missing a window must not take stake"
    );
    assert_eq!(stats.missed, 1);
    assert_eq!(stats.recent_miss_bps, 1_250);
    // The keeper that ran it earned the run's fee and nothing more.
    assert_eq!(s.token.balance(&sc.attacker), attacker_before + FEE);
}

// ---------------------------------------------------------------------------
// A job's target asking for the keeper's own authorization
// ---------------------------------------------------------------------------

/// A job target that tries to spend whoever it names from a token.
#[contract]
pub struct Thief;

#[contractimpl]
impl Thief {
    pub fn steal(env: Env, token: Address, from: Address, to: Address, amount: i128) {
        TokenClient::new(&env, &token).transfer(&from, &to, &amount);
    }
}

/// The registry can't stop a target from calling `require_auth` on the
/// executing keeper: whether that succeeds depends on what the keeper signs.
/// A keeper that signs only the registry call is safe; one that signs
/// everything its simulation recorded hands its funds over. The keeper
/// clients therefore refuse any authorization beyond the registry call.
#[test]
fn a_target_can_only_spend_a_keeper_that_authorizes_more_than_the_registry_call() {
    let s = setup();
    let thief = s.env.register(Thief, ());
    let attacker = Address::generate(&s.env);
    let mut p = params(&s);
    p.target = thief.clone();
    p.function = Symbol::new(&s.env, "steal");
    p.args = (
        s.token.address.clone(),
        s.keeper.clone(),
        attacker.clone(),
        500_000i128,
    )
        .into_val(&s.env);
    let id = s.cron.create_job(&s.owner, &p, &1_000);

    // Authorizing exactly the registry call: the theft fails inside the
    // target, and the run is charged and recorded as a failure.
    s.env.mock_auths(&[MockAuth {
        address: &s.keeper,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name: "execute",
            args: (s.keeper.clone(), id).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    let keeper_before = s.token.balance(&s.keeper);
    s.cron.execute(&s.keeper, &id);
    assert_eq!(s.token.balance(&attacker), 0);
    assert_eq!(s.token.balance(&s.keeper), keeper_before + FEE);
    assert_eq!(s.cron.get_job(&id).unwrap().failures, 1);

    // Authorizing whatever the call asks for, as a keeper that signs its
    // simulation's auth entries without reading them would: the transfer
    // sits under the keeper's authorization and goes through.
    s.env.mock_all_auths();
    advance(&s.env, INTERVAL);
    s.cron.execute(&s.keeper, &id);
    // (Read the authorizations before any other call replaces them.)
    let (_, tree) = s
        .env
        .auths()
        .into_iter()
        .find(|(who, _)| *who == s.keeper)
        .expect("the keeper authorized the call");
    assert!(matches!(tree.function, AuthorizedFunction::Contract(_)));
    assert_eq!(
        tree.sub_invocations.len(),
        1,
        "the keeper's authorization covers the target's transfer"
    );
    assert_eq!(s.token.balance(&attacker), 500_000);
}

// ---------------------------------------------------------------------------
// Admin limits that protect keepers' stake
// ---------------------------------------------------------------------------

#[test]
fn the_admin_cant_set_an_unbonding_epoch_that_freezes_stake() {
    let s = setup();
    assert_eq!(
        s.cron.try_set_unbonding_epoch(&u64::MAX),
        Err(Ok(Error::InvalidSetting))
    );
    assert_eq!(
        s.cron.try_set_unbonding_epoch(&(MAX_UNBONDING_EPOCH + 1)),
        Err(Ok(Error::InvalidSetting))
    );
    s.cron.set_unbonding_epoch(&MAX_UNBONDING_EPOCH);

    // Even at the cap a keeper gets its stake back within a bounded time.
    let at = s.cron.begin_unbonding(&s.keeper);
    assert!(at <= START + MAX_UNBONDING_EPOCH + UNBONDING);
    s.env.ledger().set_timestamp(at);
    assert_eq!(s.cron.withdraw_stake(&s.keeper), MIN_STAKE);
}
