#![no_std]
//! # Subscriptions with SEP-41 allowances
//!
//! A merchant deploys this contract with a price and a billing period.
//! Subscribers keep their funds: they approve an allowance for this contract
//! on the token (`approve(subscriber, <this contract>, amount, expiration)`)
//! and subscribe. A SoroCron job then calls `charge(subscriber)` each period,
//! which pulls one payment with `transfer_from`.
//!
//! ```text
//! target:   <subscription>, function: charge, args: [subscriber]
//! resolver: <subscription>   (after bind_job(subscriber, job_id))
//! interval: <period>
//! ```
//!
//! Guarantees:
//! - **At most one charge per billing period.** Periods are counted from the
//!   subscription's start, so a late keeper can't double-bill; a period
//!   nobody charged in is simply not billed.
//! - **Never above the allowance.** The subscriber controls the ceiling and
//!   can stop payments at any time by lowering it or calling `cancel`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidPlan = 1,
    NotSubscribed = 2,
    AlreadyCharged = 3,
    InsufficientAllowance = 4,
    AlreadySubscribed = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub merchant: Address,
    pub token: Address,
    pub price: i128,
    pub period: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub start: u64,
    /// Index of the last period charged (`period 0` starts at `start`).
    pub last_charged: Option<u64>,
    pub payments: u32,
}

#[contracttype]
enum Key {
    Plan,
    Sub(Address),
    Job(u64),
}

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    pub fn __constructor(env: Env, merchant: Address, token: Address, price: i128, period: u64) {
        if price <= 0 || period == 0 {
            panic_with_error!(&env, Error::InvalidPlan);
        }
        env.storage().instance().set(
            &Key::Plan,
            &Plan {
                merchant,
                token,
                price,
                period,
            },
        );
    }

    pub fn plan(env: Env) -> Plan {
        env.storage().instance().get(&Key::Plan).unwrap()
    }

    /// Starts a subscription; the first period begins now. Payments need an
    /// allowance for this contract on the plan's token.
    pub fn subscribe(env: Env, subscriber: Address) -> Result<(), Error> {
        subscriber.require_auth();
        let key = Key::Sub(subscriber);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadySubscribed);
        }
        let sub = Subscription {
            start: env.ledger().timestamp(),
            last_charged: None,
            payments: 0,
        };
        env.storage().persistent().set(&key, &sub);
        Ok(())
    }

    /// Records which SoroCron job bills this subscriber, so the contract can
    /// act as that job's resolver.
    pub fn bind_job(env: Env, subscriber: Address, job_id: u64) {
        subscriber.require_auth();
        env.storage()
            .persistent()
            .set(&Key::Job(job_id), &subscriber);
    }

    /// Pulls one period's payment from the subscriber to the merchant.
    /// Anyone may call it; it succeeds at most once per period and never
    /// beyond the subscriber's allowance. Returns the number of payments so far.
    pub fn charge(env: Env, subscriber: Address) -> Result<u32, Error> {
        let plan = Self::plan(env.clone());
        let key = Key::Sub(subscriber.clone());
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotSubscribed)?;
        let period = current_period(&env, &plan, &sub);
        if sub.last_charged.is_some_and(|p| p >= period) {
            return Err(Error::AlreadyCharged);
        }
        let token = token::Client::new(&env, &plan.token);
        let me = env.current_contract_address();
        if token.allowance(&subscriber, &me) < plan.price {
            return Err(Error::InsufficientAllowance);
        }

        sub.last_charged = Some(period);
        sub.payments += 1;
        env.storage().persistent().set(&key, &sub);
        token.transfer_from(&me, &subscriber, &plan.merchant, &plan.price);
        Ok(sub.payments)
    }

    /// Ends the subscription. Subscriber only.
    pub fn cancel(env: Env, subscriber: Address) {
        subscriber.require_auth();
        env.storage().persistent().remove(&Key::Sub(subscriber));
    }

    pub fn subscription(env: Env, subscriber: Address) -> Option<Subscription> {
        env.storage().persistent().get(&Key::Sub(subscriber))
    }

    /// Whether `charge(subscriber)` would succeed now.
    pub fn is_billable(env: Env, subscriber: Address) -> bool {
        let plan = Self::plan(env.clone());
        let Some(sub): Option<Subscription> = env
            .storage()
            .persistent()
            .get(&Key::Sub(subscriber.clone()))
        else {
            return false;
        };
        let period = current_period(&env, &plan, &sub);
        sub.last_charged.is_none_or(|p| p < period)
            && token::Client::new(&env, &plan.token)
                .allowance(&subscriber, &env.current_contract_address())
                >= plan.price
    }

    /// SoroCron resolver for jobs bound with `bind_job`.
    pub fn should_run(env: Env, job_id: u64) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Address>(&Key::Job(job_id))
        {
            Some(subscriber) => Self::is_billable(env, subscriber),
            None => false,
        }
    }
}

fn current_period(env: &Env, plan: &Plan, sub: &Subscription) -> u64 {
    env.ledger().timestamp().saturating_sub(sub.start) / plan.period
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{token::TokenClient, vec, IntoVal};
    use sorocron_testkit::Harness;

    const PRICE: i128 = 5_000_000;
    const MONTH: u64 = 30 * 86_400;

    fn setup(h: &Harness) -> (SubscriptionContractClient<'static>, Address, Address) {
        let merchant = soroban_sdk::Address::generate(&h.env);
        let subs = SubscriptionContractClient::new(
            &h.env,
            &h.env.register(
                SubscriptionContract,
                (merchant.clone(), h.token.address.clone(), PRICE, MONTH),
            ),
        );
        let subscriber = h.funded_account();
        subs.subscribe(&subscriber);
        (subs, merchant, subscriber)
    }

    fn approve(h: &Harness, subscriber: &Address, spender: &Address, amount: i128) {
        TokenClient::new(&h.env, &h.token.address)
            .approve(subscriber, spender, &amount, &1_000_000);
    }

    #[test]
    fn keeper_bills_once_per_period_through_the_registry() {
        let h = Harness::new();
        let (subs, merchant, subscriber) = setup(&h);
        approve(&h, &subscriber, &subs.address, PRICE * 12);

        let mut p = h.params(
            &subs.address,
            "charge",
            vec![&h.env, subscriber.into_val(&h.env)],
            MONTH,
        );
        p.resolver = Some(subs.address.clone());
        let job = h.create(&p);
        subs.bind_job(&subscriber, &job);

        h.run(job);
        assert_eq!(h.token.balance(&merchant), PRICE);
        h.advance(MONTH);
        h.run(job);
        assert_eq!(h.token.balance(&merchant), 2 * PRICE);
        assert_eq!(subs.subscription(&subscriber).unwrap().payments, 2);
        assert!(!h.is_due(job), "next period hasn't started");
    }

    #[test]
    fn cannot_charge_twice_in_one_period() {
        let h = Harness::new();
        let (subs, _, subscriber) = setup(&h);
        approve(&h, &subscriber, &subs.address, PRICE * 12);
        subs.charge(&subscriber);
        h.advance(MONTH - 1);
        assert_eq!(subs.try_charge(&subscriber), Err(Ok(Error::AlreadyCharged)));
        h.advance(1);
        subs.charge(&subscriber);
    }

    #[test]
    fn missed_periods_are_not_billed_retroactively() {
        let h = Harness::new();
        let (subs, merchant, subscriber) = setup(&h);
        approve(&h, &subscriber, &subs.address, PRICE * 12);
        subs.charge(&subscriber);
        // Keepers offline for three months: one charge, not three.
        h.advance(3 * MONTH + 10);
        subs.charge(&subscriber);
        assert_eq!(subs.try_charge(&subscriber), Err(Ok(Error::AlreadyCharged)));
        assert_eq!(h.token.balance(&merchant), 2 * PRICE);
    }

    #[test]
    fn never_charges_above_the_allowance() {
        let h = Harness::new();
        let (subs, merchant, subscriber) = setup(&h);
        approve(&h, &subscriber, &subs.address, PRICE + PRICE / 2);
        subs.charge(&subscriber);
        h.advance(MONTH);
        assert!(!subs.is_billable(&subscriber));
        assert_eq!(
            subs.try_charge(&subscriber),
            Err(Ok(Error::InsufficientAllowance))
        );
        assert_eq!(h.token.balance(&merchant), PRICE);
    }

    #[test]
    fn cancelled_or_unknown_subscribers_are_not_billed() {
        let h = Harness::new();
        let (subs, _, subscriber) = setup(&h);
        approve(&h, &subscriber, &subs.address, PRICE * 12);
        subs.cancel(&subscriber);
        assert_eq!(subs.try_charge(&subscriber), Err(Ok(Error::NotSubscribed)));
        assert!(!subs.should_run(&0));
    }

    use soroban_sdk::testutils::Address as _;
}
