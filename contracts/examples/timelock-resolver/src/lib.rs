#![no_std]
//! # Timelock governance resolver
//!
//! For governors that keep proposals in their own contract and expose an
//! `execute(proposal)` function: register each passed proposal here with its
//! ETA and execution window, bind the SoroCron job that calls
//! `execute(proposal)`, and use this contract as that job's resolver. The job
//! is then due exactly while the proposal is executable, from its ETA until
//! the window closes, and never before or after.
//!
//! ```text
//! target:   <governor>, function: execute, args: [proposal_hash]
//! resolver: <timelock-resolver>    (after bind(job_id, proposal_hash))
//! ```
//!
//! The governor (admin) marks a proposal executed when it runs, which closes
//! the job's window for good.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    UnknownProposal = 1,
    AlreadyRegistered = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub queued_at: u64,
    pub eta: u64,
    /// Seconds after `eta` during which the proposal may execute.
    pub window: u64,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalState {
    Unknown,
    /// Queued, timelock not over yet.
    Queued,
    /// Inside the execution window.
    Ready,
    /// The window closed without execution.
    Expired,
    Executed,
}

#[contracttype]
enum Key {
    Admin,
    Proposal(BytesN<32>),
    Job(u64),
}

#[contract]
pub struct TimelockResolver;

#[contractimpl]
impl TimelockResolver {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&Key::Admin, &admin);
    }

    /// Registers a queued proposal. Admin (the governor) only.
    pub fn register(env: Env, proposal: BytesN<32>, eta: u64, window: u64) -> Result<(), Error> {
        admin(&env).require_auth();
        let key = Key::Proposal(proposal);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }
        let record = Proposal {
            queued_at: env.ledger().timestamp(),
            eta,
            window,
            executed: false,
        };
        env.storage().persistent().set(&key, &record);
        Ok(())
    }

    /// Ties a SoroCron job to the proposal it executes. Admin only.
    pub fn bind(env: Env, job_id: u64, proposal: BytesN<32>) -> Result<(), Error> {
        admin(&env).require_auth();
        if !env
            .storage()
            .persistent()
            .has(&Key::Proposal(proposal.clone()))
        {
            return Err(Error::UnknownProposal);
        }
        env.storage().persistent().set(&Key::Job(job_id), &proposal);
        Ok(())
    }

    /// Records that the proposal ran. Admin only.
    pub fn mark_executed(env: Env, proposal: BytesN<32>) -> Result<(), Error> {
        admin(&env).require_auth();
        let key = Key::Proposal(proposal);
        let mut record: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::UnknownProposal)?;
        record.executed = true;
        env.storage().persistent().set(&key, &record);
        Ok(())
    }

    pub fn state(env: Env, proposal: BytesN<32>) -> ProposalState {
        let Some(p) = env
            .storage()
            .persistent()
            .get::<_, Proposal>(&Key::Proposal(proposal))
        else {
            return ProposalState::Unknown;
        };
        let now = env.ledger().timestamp();
        if p.executed {
            ProposalState::Executed
        } else if now < p.eta {
            ProposalState::Queued
        } else if now < p.eta.saturating_add(p.window) {
            ProposalState::Ready
        } else {
            ProposalState::Expired
        }
    }

    /// SoroCron resolver: `true` only while the bound proposal is `Ready`.
    pub fn should_run(env: Env, job_id: u64) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&Key::Job(job_id))
        {
            Some(proposal) => Self::state(env, proposal) == ProposalState::Ready,
            None => false,
        }
    }
}

fn admin(env: &Env) -> Address {
    env.storage().instance().get(&Key::Admin).unwrap()
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::vec;
    use sorocron_testkit::Harness;

    const DAY: u64 = 86_400;

    fn setup(h: &Harness) -> (TimelockResolverClient<'static>, BytesN<32>, u64) {
        let resolver = TimelockResolverClient::new(
            &h.env,
            &h.env.register(TimelockResolver, (h.admin.clone(),)),
        );
        let proposal = BytesN::from_array(&h.env, &[9; 32]);
        let eta = h.env.ledger().timestamp() + 2 * DAY;
        resolver.register(&proposal, &eta, &(3 * DAY));
        (resolver, proposal, eta)
    }

    #[test]
    fn walks_through_queued_ready_and_expired() {
        let h = Harness::new();
        let (r, proposal, eta) = setup(&h);
        assert_eq!(r.state(&proposal), ProposalState::Queued);
        h.env.ledger().set_timestamp(eta);
        assert_eq!(r.state(&proposal), ProposalState::Ready);
        h.env.ledger().set_timestamp(eta + 3 * DAY - 1);
        assert_eq!(r.state(&proposal), ProposalState::Ready);
        h.env.ledger().set_timestamp(eta + 3 * DAY);
        assert_eq!(r.state(&proposal), ProposalState::Expired);
        assert_eq!(
            r.state(&BytesN::from_array(&h.env, &[1; 32])),
            ProposalState::Unknown
        );
    }

    #[test]
    fn job_is_due_only_inside_the_window() {
        let h = Harness::new();
        let (r, proposal, eta) = setup(&h);
        let governor = h.probe();
        let mut p = h.params(&governor.address, "hit", vec![&h.env], 3_600);
        p.resolver = Some(r.address.clone());
        let job = h.create(&p);
        r.bind(&job, &proposal);

        assert!(!h.is_due(job));
        h.env.ledger().set_timestamp(eta);
        assert!(h.is_due(job));
        h.run(job);
        r.mark_executed(&proposal);
        assert_eq!(r.state(&proposal), ProposalState::Executed);
        h.advance(3_600);
        assert!(!h.is_due(job), "executed proposals never run again");
        assert_eq!(governor.hits(), 1);
    }

    #[test]
    fn registration_rules() {
        let h = Harness::new();
        let (r, proposal, eta) = setup(&h);
        assert_eq!(
            r.try_register(&proposal, &eta, &DAY),
            Err(Ok(Error::AlreadyRegistered))
        );
        let unknown = BytesN::from_array(&h.env, &[2; 32]);
        assert_eq!(r.try_bind(&0, &unknown), Err(Ok(Error::UnknownProposal)));
        assert!(!r.should_run(&123));
    }

    use soroban_sdk::testutils::Ledger;
}
