#![no_std]
//! # SoroCron Recurring Subscription Example Contract
//!
//! Prepaid pull-payment subscription contract for Soroban.
//! Users deposit funds into escrow and subscribe to a recurring plan at fixed intervals (e.g. 30 days).
//! SoroCron keepers can call `charge` permissionlessly whenever an active subscription
//! is due, automatically transferring the subscription fee from escrow to the merchant.
//! Implements `should_run_for` as a SoroCron resolver.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

const MERCHANT: Symbol = symbol_short!("MERCH");
const TOKEN: Symbol = symbol_short!("TOKEN");
const SUB: Symbol = symbol_short!("SUB");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SubscriptionError {
    NotActive = 1,
    IntervalNotElapsed = 2,
    InvalidRate = 3,
    SubscriptionNotFound = 4,
    InsufficientBalance = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub subscriber: Address,
    pub prepaid_balance: i128,
    pub rate: i128,
    pub interval_seconds: u64,
    pub last_billed_timestamp: u64,
    pub total_payments: u32,
    pub active: bool,
}

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// Initializes the subscription contract with merchant receiver address and token.
    pub fn __constructor(env: Env, merchant: Address, token: Address) {
        env.storage().instance().set(&MERCHANT, &merchant);
        env.storage().instance().set(&TOKEN, &token);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Subscribes to the recurring plan and deposits initial prepaid balance.
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        initial_deposit: i128,
        rate: i128,
        interval_seconds: u64,
    ) {
        subscriber.require_auth();
        if rate <= 0 || interval_seconds == 0 {
            panic!("rate and interval must be positive");
        }
        if initial_deposit < rate {
            panic!("initial deposit must at least cover one billing cycle");
        }

        let token_addr: Address = env.storage().instance().get(&TOKEN).expect("token not set");
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(
            &subscriber,
            &env.current_contract_address(),
            &initial_deposit,
        );

        let key = (SUB, subscriber.clone());
        let sub = Subscription {
            subscriber: subscriber.clone(),
            prepaid_balance: initial_deposit,
            rate,
            interval_seconds,
            last_billed_timestamp: 0,
            total_payments: 0,
            active: true,
        };

        env.storage().persistent().set(&key, &sub);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 500_000);
    }

    /// Tops up prepaid subscription balance.
    pub fn deposit(env: Env, subscriber: Address, amount: i128) {
        subscriber.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let token_addr: Address = env.storage().instance().get(&TOKEN).expect("token not set");
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&subscriber, &env.current_contract_address(), &amount);

        let key = (SUB, subscriber.clone());
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .expect("subscription not found");
        sub.prepaid_balance += amount;
        env.storage().persistent().set(&key, &sub);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 500_000);
    }

    /// Charges the subscriber if due. Permissionless: can be called by SoroCron keeper.
    pub fn charge(env: Env, subscriber: Address) -> u32 {
        let key = (SUB, subscriber.clone());
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .expect("subscription not found");

        if !sub.active {
            panic!("subscription is inactive");
        }
        if sub.prepaid_balance < sub.rate {
            panic!("insufficient prepaid balance");
        }

        let current_time = env.ledger().timestamp();
        if sub.last_billed_timestamp > 0
            && current_time < sub.last_billed_timestamp + sub.interval_seconds
        {
            panic!("billing interval has not elapsed");
        }

        let merchant: Address = env
            .storage()
            .instance()
            .get(&MERCHANT)
            .expect("merchant not set");
        let token_addr: Address = env.storage().instance().get(&TOKEN).expect("token not set");

        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &merchant, &sub.rate);

        sub.prepaid_balance -= sub.rate;
        sub.last_billed_timestamp = current_time;
        sub.total_payments += 1;

        env.storage().persistent().set(&key, &sub);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 500_000);

        sub.total_payments
    }

    /// Resolver check for whether a subscriber is due for charging and has sufficient balance.
    pub fn should_run_for(env: Env, subscriber: Address) -> bool {
        let key = (SUB, subscriber);
        let sub: Subscription = match env.storage().persistent().get(&key) {
            Some(s) => s,
            None => return false,
        };

        if !sub.active || sub.prepaid_balance < sub.rate {
            return false;
        }

        let current_time = env.ledger().timestamp();
        if sub.last_billed_timestamp == 0 {
            return true;
        }

        current_time >= sub.last_billed_timestamp + sub.interval_seconds
    }

    /// Cancels active subscription and refunds remaining prepaid balance.
    pub fn cancel(env: Env, subscriber: Address) {
        subscriber.require_auth();
        let key = (SUB, subscriber.clone());
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .expect("subscription not found");

        sub.active = false;
        let refund = sub.prepaid_balance;
        sub.prepaid_balance = 0;

        env.storage().persistent().set(&key, &sub);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 500_000);

        if refund > 0 {
            let token_addr: Address = env.storage().instance().get(&TOKEN).expect("token not set");
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&env.current_contract_address(), &subscriber, &refund);
        }
    }

    /// Fetches subscription record.
    pub fn get_subscription(env: Env, subscriber: Address) -> Subscription {
        let key = (SUB, subscriber);
        env.storage()
            .persistent()
            .get(&key)
            .expect("subscription not found")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, Env,
    };

    fn setup_subscription() -> (
        Env,
        Address,
        Address,
        Address,
        SubscriptionContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let merchant = Address::generate(&env);
        let subscriber = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_id.address();

        let token_client = StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&subscriber, &100_000);

        let contract_id =
            env.register(SubscriptionContract, (merchant.clone(), token_addr.clone()));
        let client = SubscriptionContractClient::new(&env, &contract_id);

        (env, merchant, subscriber, token_addr, client)
    }

    #[test]
    fn test_subscription_lifecycle() {
        let (env, merchant, subscriber, token_addr, client) = setup_subscription();

        // 100 tokens deposit, 50 tokens rate every 86400 seconds (1 day)
        client.subscribe(&subscriber, &100, &50, &86400);

        let sub = client.get_subscription(&subscriber);
        assert_eq!(sub.rate, 50);
        assert_eq!(sub.prepaid_balance, 100);
        assert_eq!(sub.interval_seconds, 86400);
        assert_eq!(sub.total_payments, 0);
        assert!(sub.active);

        // Initial check: should be ready
        env.ledger().set_timestamp(1000);
        assert!(client.should_run_for(&subscriber));

        // First charge
        assert_eq!(client.charge(&subscriber), 1);
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&merchant), 50);
        assert_eq!(client.get_subscription(&subscriber).prepaid_balance, 50);

        // Not ready immediately after
        assert!(!client.should_run_for(&subscriber));

        // Ready after 1 day
        env.ledger().set_timestamp(1000 + 86400);
        assert!(client.should_run_for(&subscriber));
        assert_eq!(client.charge(&subscriber), 2);
        assert_eq!(token_client.balance(&merchant), 100);
        assert_eq!(client.get_subscription(&subscriber).prepaid_balance, 0);

        // After balance runs out, should_run_for is false
        env.ledger().set_timestamp(1000 + 86400 * 2);
        assert!(!client.should_run_for(&subscriber));

        // Top up deposit
        client.deposit(&subscriber, &150);
        assert_eq!(client.get_subscription(&subscriber).prepaid_balance, 150);
        assert!(client.should_run_for(&subscriber));

        // Cancellation refunds balance
        let balance_before = token_client.balance(&subscriber);
        client.cancel(&subscriber);
        let balance_after = token_client.balance(&subscriber);
        assert_eq!(balance_after - balance_before, 150);
        assert!(!client.should_run_for(&subscriber));
    }
}
