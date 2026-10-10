//! Tests for the v5 registry features. Each section names the issue whose
//! acceptance criteria it covers.

extern crate std;

use crate::test::*;
use crate::{events, Error, PendingUpgrade};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Event as _, IntoVal, Val, Vec,
};

/// Only `who` signs, and only for `fn_name(args)` on the registry.
fn sign_as(s: &Setup, who: &Address, fn_name: &'static str, args: Vec<Val>) {
    s.env.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: &s.cron.address,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

// ---------------------------------------------------------------------------
// #109 Upgrade timelock
// ---------------------------------------------------------------------------

fn hash(s: &Setup, byte: u8) -> BytesN<32> {
    BytesN::from_array(&s.env, &[byte; 32])
}

#[test]
fn upgrade_delay_defaults_to_the_unbonding_period() {
    let s = setup();
    assert_eq!(s.cron.upgrade_delay(), UNBONDING);
    assert_eq!(s.cron.pending_upgrade(), None);
}

#[test]
fn proposed_upgrade_waits_for_the_delay() {
    let s = setup();
    let h = hash(&s, 7);
    let available_at = s.cron.propose_upgrade(&h);
    assert_eq!(available_at, START + UNBONDING);
    assert_eq!(
        last_event(&s),
        events::UpgradeProposed {
            wasm_hash: h.clone(),
            available_at,
        }
        .to_xdr(&s.env, &s.cron.address)
    );
    assert_eq!(
        s.cron.pending_upgrade(),
        Some(PendingUpgrade {
            wasm_hash: h,
            proposed_at: START,
            available_at,
        })
    );

    assert_eq!(s.cron.try_apply_upgrade(), Err(Ok(Error::UpgradeNotReady)));
    advance(&s.env, UNBONDING - 1);
    assert_eq!(s.cron.try_apply_upgrade(), Err(Ok(Error::UpgradeNotReady)));
}

#[test]
fn proposing_again_restarts_the_delay() {
    let s = setup();
    s.cron.propose_upgrade(&hash(&s, 1));
    advance(&s.env, UNBONDING - 10);

    let available_at = s.cron.propose_upgrade(&hash(&s, 2));
    assert_eq!(available_at, START + UNBONDING - 10 + UNBONDING);
    assert_eq!(s.cron.pending_upgrade().unwrap().wasm_hash, hash(&s, 2));

    advance(&s.env, 10);
    assert_eq!(s.cron.try_apply_upgrade(), Err(Ok(Error::UpgradeNotReady)));
}

#[test]
fn cancelled_upgrade_cant_be_applied() {
    let s = setup();
    let h = hash(&s, 3);
    s.cron.propose_upgrade(&h);
    s.cron.cancel_upgrade();
    assert_eq!(
        last_event(&s),
        events::UpgradeCancelled { wasm_hash: h }.to_xdr(&s.env, &s.cron.address)
    );
    assert_eq!(s.cron.pending_upgrade(), None);

    advance(&s.env, UNBONDING);
    assert_eq!(s.cron.try_apply_upgrade(), Err(Ok(Error::NoPendingUpgrade)));
    assert_eq!(
        s.cron.try_cancel_upgrade(),
        Err(Ok(Error::NoPendingUpgrade))
    );
}

#[test]
fn upgrade_delay_never_undercuts_unbonding() {
    let s = setup();
    assert_eq!(
        s.cron.try_set_upgrade_delay(&(UNBONDING - 1)),
        Err(Ok(Error::InvalidSetting))
    );

    s.cron.set_upgrade_delay(&(2 * UNBONDING));
    assert_eq!(
        last_event(&s),
        events::UpgradeDelaySet {
            upgrade_delay: 2 * UNBONDING,
        }
        .to_xdr(&s.env, &s.cron.address)
    );
    assert_eq!(s.cron.upgrade_delay(), 2 * UNBONDING);
    assert_eq!(s.cron.propose_upgrade(&hash(&s, 4)), START + 2 * UNBONDING);

    // Longer unbonding epochs raise the floor above the stored delay, so a
    // keeper unbonding at the worst moment can still leave in time.
    s.cron.set_unbonding_epoch(&(5 * UNBONDING));
    assert_eq!(s.cron.upgrade_delay(), 6 * UNBONDING);
}

#[test]
fn settings_changed_after_a_proposal_can_only_delay_it() {
    let s = setup();
    s.cron.propose_upgrade(&hash(&s, 6));

    // A keeper unbonding now could need a whole epoch longer to leave, so the
    // pending upgrade waits for that too.
    s.cron.set_unbonding_epoch(&(5 * UNBONDING));
    assert_eq!(
        s.cron.pending_upgrade().unwrap().available_at,
        START + 6 * UNBONDING
    );

    // Shortening the epoch again doesn't bring it back: keepers who started
    // unbonding meanwhile still need the longer time.
    s.cron.set_unbonding_epoch(&0);
    advance(&s.env, UNBONDING);
    assert_eq!(
        s.cron.pending_upgrade().unwrap().available_at,
        START + 6 * UNBONDING
    );
    assert_eq!(s.cron.try_apply_upgrade(), Err(Ok(Error::UpgradeNotReady)));

    // A longer delay pushes it back the same way.
    s.cron.set_upgrade_delay(&(10 * UNBONDING));
    assert_eq!(
        s.cron.pending_upgrade().unwrap().available_at,
        START + 10 * UNBONDING
    );
}

#[test]
fn only_the_admin_can_propose_apply_or_cancel_upgrades() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let h = hash(&s, 5);

    sign_as(
        &s,
        &stranger,
        "propose_upgrade",
        (h.clone(),).into_val(&s.env),
    );
    assert!(s.cron.try_propose_upgrade(&h).is_err());
    sign_as(
        &s,
        &stranger,
        "set_upgrade_delay",
        (UNBONDING * 2,).into_val(&s.env),
    );
    assert!(s.cron.try_set_upgrade_delay(&(UNBONDING * 2)).is_err());

    s.env.mock_all_auths();
    s.cron.propose_upgrade(&h);
    advance(&s.env, UNBONDING);

    sign_as(&s, &stranger, "apply_upgrade", vec![&s.env]);
    assert!(s.cron.try_apply_upgrade().is_err());
    sign_as(&s, &stranger, "cancel_upgrade", vec![&s.env]);
    assert!(s.cron.try_cancel_upgrade().is_err());
    assert_eq!(s.cron.pending_upgrade().unwrap().wasm_hash, h);
}

// ---------------------------------------------------------------------------
// #110 Transfer job ownership
// ---------------------------------------------------------------------------

#[test]
fn job_moves_to_its_new_owner_with_its_history() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    s.cron.execute(&s.keeper, &id);
    let before = s.cron.get_job(&id).unwrap();
    let new_owner = Address::generate(&s.env);

    s.cron.propose_job_owner(&id, &new_owner);
    assert_eq!(
        last_event(&s),
        events::JobOwnerProposed {
            job_id: id,
            owner: s.owner.clone(),
            proposed: new_owner.clone(),
        }
        .to_xdr(&s.env, &s.cron.address)
    );
    assert_eq!(s.cron.pending_job_owner(&id), Some(new_owner.clone()));
    // Nothing changes until the new owner accepts.
    assert_eq!(s.cron.get_job(&id).unwrap().owner, s.owner);

    sign_as(&s, &new_owner, "accept_job_owner", (id,).into_val(&s.env));
    s.cron.accept_job_owner(&id);
    assert_eq!(
        last_event(&s),
        events::JobOwnerChanged {
            job_id: id,
            previous: s.owner.clone(),
            new_owner: new_owner.clone(),
        }
        .to_xdr(&s.env, &s.cron.address)
    );

    let after = s.cron.get_job(&id).unwrap();
    assert_eq!(after.owner, new_owner);
    assert_eq!(after.id, before.id);
    assert_eq!(after.balance, before.balance);
    assert_eq!(after.runs, before.runs);
    assert_eq!(after.next_run, before.next_run);
    assert_eq!(s.cron.pending_job_owner(&id), None);
    assert_eq!(s.cron.jobs_by_owner(&s.owner), vec![&s.env]);
    assert_eq!(s.cron.jobs_by_owner(&new_owner), vec![&s.env, id]);

    // The refund on cancel now goes to the new owner.
    sign_as(&s, &new_owner, "cancel_job", (id,).into_val(&s.env));
    s.cron.cancel_job(&id);
    assert_eq!(s.token.balance(&new_owner), before.balance);
}

#[test]
fn old_owner_loses_control_after_the_handover() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let new_owner = Address::generate(&s.env);
    s.cron.propose_job_owner(&id, &new_owner);
    s.cron.accept_job_owner(&id);

    sign_as(
        &s,
        &s.owner,
        "withdraw_job_balance",
        (id, 100i128).into_val(&s.env),
    );
    assert!(s.cron.try_withdraw_job_balance(&id, &100).is_err());
    sign_as(
        &s,
        &s.owner,
        "propose_job_owner",
        (id, s.owner.clone()).into_val(&s.env),
    );
    assert!(s.cron.try_propose_job_owner(&id, &s.owner).is_err());
}

#[test]
fn only_the_proposed_owner_can_accept() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let proposed = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    s.cron.propose_job_owner(&id, &proposed);

    sign_as(&s, &stranger, "accept_job_owner", (id,).into_val(&s.env));
    assert!(s.cron.try_accept_job_owner(&id).is_err());
    assert_eq!(s.cron.get_job(&id).unwrap().owner, s.owner);
}

#[test]
fn only_the_owner_can_propose() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let stranger = Address::generate(&s.env);

    sign_as(
        &s,
        &stranger,
        "propose_job_owner",
        (id, stranger.clone()).into_val(&s.env),
    );
    assert!(s.cron.try_propose_job_owner(&id, &stranger).is_err());
    assert_eq!(s.cron.pending_job_owner(&id), None);
}

#[test]
fn proposing_again_replaces_and_proposing_yourself_withdraws() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);

    s.cron.propose_job_owner(&id, &first);
    s.cron.propose_job_owner(&id, &second);
    assert_eq!(s.cron.pending_job_owner(&id), Some(second.clone()));
    sign_as(&s, &first, "accept_job_owner", (id,).into_val(&s.env));
    assert!(s.cron.try_accept_job_owner(&id).is_err());

    s.env.mock_all_auths();
    s.cron.propose_job_owner(&id, &s.owner);
    assert_eq!(s.cron.pending_job_owner(&id), None);
    assert_eq!(
        s.cron.try_accept_job_owner(&id),
        Err(Ok(Error::NoPendingOwner))
    );
}

#[test]
fn cancelling_a_job_clears_its_pending_owner() {
    let s = setup();
    let id = s.cron.create_job(&s.owner, &params(&s), &1_000);
    let proposed = Address::generate(&s.env);
    s.cron.propose_job_owner(&id, &proposed);

    s.cron.cancel_job(&id);
    assert_eq!(s.cron.pending_job_owner(&id), None);
    assert_eq!(
        s.cron.try_accept_job_owner(&id),
        Err(Ok(Error::JobNotFound))
    );
    assert_eq!(
        s.cron.try_propose_job_owner(&id, &proposed),
        Err(Ok(Error::JobNotFound))
    );
}
