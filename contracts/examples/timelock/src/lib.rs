#![no_std]
//! # DAO timelock auto-executor
//!
//! Governance queues calls with an ETA; once the delay passes, anyone may
//! execute them. In practice passed proposals sit unexecuted until someone
//! remembers. Schedule this instead:
//!
//! ```text
//! target:   <timelock>, function: execute_ready, args: []
//! resolver: <timelock>          (true only when something is ready)
//! interval: 3600
//! ```
//!
//! Each run executes every queued call whose ETA has passed (up to
//! `MAX_PER_RUN`). A call that fails stays queued and is retried until its
//! grace period ends, then expires, so a broken proposal can't block the
//! queue forever. The timelock is the invoker of the calls it executes, so it
//! acts with its own authority: give it the permissions the DAO grants
//! proposals, nothing more.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Val,
    Vec,
};

/// Calls executed per `execute_ready`, to stay within transaction limits.
pub const MAX_PER_RUN: u32 = 10;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    EtaTooSoon = 1,
    UnknownCall = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Call {
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    /// Earliest execution time.
    pub eta: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallExecuted {
    #[topic]
    pub id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallExpired {
    #[topic]
    pub id: u64,
}

#[contracttype]
enum Key {
    Admin,
    /// Minimum seconds between queueing and the ETA.
    Delay,
    /// Seconds after the ETA during which a call may still execute.
    Grace,
    NextId,
    /// Ids of queued calls, oldest first.
    Queue,
    Call(u64),
}

#[contract]
pub struct Timelock;

#[contractimpl]
impl Timelock {
    pub fn __constructor(env: Env, admin: Address, delay: u64, grace: u64) {
        let s = env.storage().instance();
        s.set(&Key::Admin, &admin);
        s.set(&Key::Delay, &delay);
        s.set(&Key::Grace, &grace);
        s.set(&Key::NextId, &0u64);
        s.set(&Key::Queue, &Vec::<u64>::new(&env));
    }

    /// Queues `target.function(args)` to run at or after `eta`, which must
    /// be at least the timelock delay from now. Admin (governance) only.
    pub fn queue(
        env: Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        eta: u64,
    ) -> Result<u64, Error> {
        admin(&env).require_auth();
        let delay: u64 = env.storage().instance().get(&Key::Delay).unwrap();
        if eta < env.ledger().timestamp().saturating_add(delay) {
            return Err(Error::EtaTooSoon);
        }
        let id: u64 = env.storage().instance().get(&Key::NextId).unwrap();
        env.storage().instance().set(&Key::NextId, &(id + 1));
        env.storage().persistent().set(
            &Key::Call(id),
            &Call {
                target,
                function,
                args,
                eta,
            },
        );
        let mut queue = queue(&env);
        queue.push_back(id);
        env.storage().instance().set(&Key::Queue, &queue);
        Ok(id)
    }

    /// Removes a queued call. Admin only.
    pub fn cancel(env: Env, id: u64) -> Result<(), Error> {
        admin(&env).require_auth();
        remove(&env, id).ok_or(Error::UnknownCall)
    }

    /// Executes every queued call whose ETA has passed, expires those past
    /// their grace period, and returns how many executed. Anyone may call it.
    pub fn execute_ready(env: Env) -> u32 {
        let now = env.ledger().timestamp();
        let grace: u64 = env.storage().instance().get(&Key::Grace).unwrap();
        let mut executed = 0;
        for id in queue(&env).iter() {
            if executed >= MAX_PER_RUN {
                break;
            }
            let Some(call) = env.storage().persistent().get::<_, Call>(&Key::Call(id)) else {
                continue;
            };
            if now < call.eta {
                continue;
            }
            if now >= call.eta.saturating_add(grace) {
                remove(&env, id);
                CallExpired { id }.publish(&env);
                continue;
            }
            if env
                .try_invoke_contract::<Val, soroban_sdk::Error>(
                    &call.target,
                    &call.function,
                    call.args,
                )
                .is_ok()
            {
                remove(&env, id);
                CallExecuted { id }.publish(&env);
                executed += 1;
            }
        }
        executed
    }

    pub fn get_call(env: Env, id: u64) -> Option<Call> {
        env.storage().persistent().get(&Key::Call(id))
    }

    /// Ids still queued.
    pub fn queued(env: Env) -> Vec<u64> {
        queue(&env)
    }

    /// SoroCron resolver: `true` when at least one call is ready to run or
    /// to expire, so keepers don't pay for empty runs.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let now = env.ledger().timestamp();
        queue(&env).iter().any(|id| {
            env.storage()
                .persistent()
                .get::<_, Call>(&Key::Call(id))
                .is_some_and(|c| now >= c.eta)
        })
    }
}

fn admin(env: &Env) -> Address {
    env.storage().instance().get(&Key::Admin).unwrap()
}

fn queue(env: &Env) -> Vec<u64> {
    env.storage().instance().extend_ttl(17_280, 30 * 17_280);
    env.storage().instance().get(&Key::Queue).unwrap()
}

fn remove(env: &Env, id: u64) -> Option<()> {
    let mut q = queue(env);
    let index = q.first_index_of(id)?;
    q.remove(index);
    env.storage().instance().set(&Key::Queue, &q);
    env.storage().persistent().remove(&Key::Call(id));
    Some(())
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::vec;
    use sorocron_testkit::Harness;

    const DELAY: u64 = 2 * 86_400;
    const GRACE: u64 = 14 * 86_400;

    fn timelock(h: &Harness) -> TimelockClient<'static> {
        TimelockClient::new(
            &h.env,
            &h.env.register(Timelock, (h.admin.clone(), DELAY, GRACE)),
        )
    }

    #[test]
    fn keeper_executes_a_queued_call_after_its_eta() {
        let h = Harness::new();
        let tl = timelock(&h);
        let treasury_action = h.probe();
        let eta = h.env.ledger().timestamp() + DELAY;
        let id = tl.queue(
            &treasury_action.address,
            &Symbol::new(&h.env, "hit"),
            &vec![&h.env],
            &eta,
        );

        let mut p = h.params(&tl.address, "execute_ready", vec![&h.env], 3_600);
        p.resolver = Some(tl.address.clone());
        let job = h.create(&p);

        assert!(!h.is_due(job), "nothing ready before the ETA");
        h.advance(DELAY);
        assert!(h.is_due(job));
        h.run(job);

        assert_eq!(treasury_action.hits(), 1);
        assert_eq!(tl.get_call(&id), None);
        h.advance(3_600);
        assert!(!h.is_due(job), "queue is empty again");
    }

    #[test]
    fn eta_must_respect_the_delay() {
        let h = Harness::new();
        let tl = timelock(&h);
        let target = h.probe().address;
        let soon = h.env.ledger().timestamp() + DELAY - 1;
        assert_eq!(
            tl.try_queue(&target, &Symbol::new(&h.env, "hit"), &vec![&h.env], &soon),
            Err(Ok(Error::EtaTooSoon))
        );
    }

    #[test]
    fn failing_calls_retry_then_expire_after_grace() {
        let h = Harness::new();
        let tl = timelock(&h);
        let eta = h.env.ledger().timestamp() + DELAY;
        // `nope` doesn't exist on the probe, so this call always fails.
        let broken = tl.queue(
            &h.probe().address,
            &Symbol::new(&h.env, "nope"),
            &vec![&h.env],
            &eta,
        );
        let good_target = h.probe();
        let good = tl.queue(
            &good_target.address,
            &Symbol::new(&h.env, "hit"),
            &vec![&h.env],
            &eta,
        );

        h.advance(DELAY);
        assert_eq!(tl.execute_ready(), 1);
        assert_eq!(tl.queued(), vec![&h.env, broken]);
        assert!(tl.get_call(&good).is_none());

        h.advance(GRACE);
        assert_eq!(tl.execute_ready(), 0);
        assert_eq!(tl.queued().len(), 0, "broken call expired");
        assert!(!tl.should_run(&0));
    }

    #[test]
    fn admin_can_cancel() {
        let h = Harness::new();
        let tl = timelock(&h);
        let eta = h.env.ledger().timestamp() + DELAY;
        let id = tl.queue(
            &h.probe().address,
            &Symbol::new(&h.env, "hit"),
            &vec![&h.env],
            &eta,
        );
        tl.cancel(&id);
        assert_eq!(tl.try_cancel(&id), Err(Ok(Error::UnknownCall)));
        h.advance(DELAY);
        assert!(!tl.should_run(&0));
    }
}
