#![no_std]
//! # SoroCron DCA (Dollar-Cost Averaging) Example Contract
//!
//! Automated Dollar-Cost Averaging order contract for Soroban.
//! A user deposits tokens and schedules recurring swaps over time. SoroCron keepers
//! trigger `execute_swap` permissionlessly whenever the configured interval has elapsed.
//! Implements `should_run(job_id: u64) -> bool` so it can also act as its own resolver.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

const PLAN: Symbol = symbol_short!("PLAN");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum DcaError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    PlanNotActive = 3,
    IntervalNotElapsed = 4,
    MaxSwapsReached = 5,
    InsufficientContractBalance = 6,
    InvalidParameters = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DcaPlan {
    pub owner: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub amount_per_swap: i128,
    pub interval_seconds: u64,
    pub max_swaps: u32,
    pub executed_swaps: u32,
    pub last_swap_timestamp: u64,
    pub active: bool,
}

#[contract]
pub struct DcaContract;

#[contractimpl]
impl DcaContract {
    /// Initializes the DCA contract with swap parameters.
    pub fn __constructor(
        env: Env,
        owner: Address,
        sell_token: Address,
        buy_token: Address,
        amount_per_swap: i128,
        interval_seconds: u64,
        max_swaps: u32,
    ) {
        if amount_per_swap <= 0 || interval_seconds == 0 || max_swaps == 0 {
            panic!("invalid DCA parameters");
        }

        let plan = DcaPlan {
            owner,
            sell_token,
            buy_token,
            amount_per_swap,
            interval_seconds,
            max_swaps,
            executed_swaps: 0,
            last_swap_timestamp: 0,
            active: true,
        };

        env.storage().instance().set(&PLAN, &plan);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Deposits sell tokens into the DCA escrow.
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let plan: DcaPlan = env
            .storage()
            .instance()
            .get(&PLAN)
            .expect("plan not initialized");
        let token_client = token::Client::new(&env, &plan.sell_token);
        token_client.transfer(&from, &env.current_contract_address(), &amount);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Executes the next DCA swap slice. Permissionless: can be called by SoroCron keeper.
    pub fn execute_swap(env: Env) -> u32 {
        let mut plan: DcaPlan = env
            .storage()
            .instance()
            .get(&PLAN)
            .expect("plan not initialized");

        if !plan.active {
            panic!("plan is inactive");
        }
        if plan.executed_swaps >= plan.max_swaps {
            panic!("max swaps already reached");
        }

        let current_time = env.ledger().timestamp();
        if plan.last_swap_timestamp > 0
            && current_time < plan.last_swap_timestamp + plan.interval_seconds
        {
            panic!("interval has not elapsed yet");
        }

        let token_client = token::Client::new(&env, &plan.sell_token);
        let balance = token_client.balance(&env.current_contract_address());
        if balance < plan.amount_per_swap {
            panic!("insufficient balance in DCA escrow");
        }

        // In production this routes through a DEX router; for this example contract,
        // it transfers to the owner (simulating completed swap settlement).
        token_client.transfer(
            &env.current_contract_address(),
            &plan.owner,
            &plan.amount_per_swap,
        );

        plan.executed_swaps += 1;
        plan.last_swap_timestamp = current_time;

        if plan.executed_swaps >= plan.max_swaps {
            plan.active = false;
        }

        let executed = plan.executed_swaps;
        env.storage().instance().set(&PLAN, &plan);
        env.storage().instance().extend_ttl(100_000, 500_000);
        executed
    }

    /// SoroCron resolver interface: returns true if the DCA job is ready for execution.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let plan: DcaPlan = match env.storage().instance().get(&PLAN) {
            Some(p) => p,
            None => return false,
        };

        if !plan.active || plan.executed_swaps >= plan.max_swaps {
            return false;
        }

        let current_time = env.ledger().timestamp();
        if plan.last_swap_timestamp == 0 {
            return true;
        }

        current_time >= plan.last_swap_timestamp + plan.interval_seconds
    }

    /// Cancels the plan and returns any unspent sell tokens to the owner.
    pub fn cancel(env: Env) {
        let mut plan: DcaPlan = env
            .storage()
            .instance()
            .get(&PLAN)
            .expect("plan not initialized");
        plan.owner.require_auth();

        plan.active = false;
        let token_client = token::Client::new(&env, &plan.sell_token);
        let balance = token_client.balance(&env.current_contract_address());
        if balance > 0 {
            token_client.transfer(&env.current_contract_address(), &plan.owner, &balance);
        }

        env.storage().instance().set(&PLAN, &plan);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Returns the current state of the DCA plan.
    pub fn get_plan(env: Env) -> DcaPlan {
        env.storage()
            .instance()
            .get(&PLAN)
            .expect("plan not initialized")
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

    fn setup_test() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        DcaContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let sell_token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let buy_token_id = env.register_stellar_asset_contract_v2(token_admin.clone());

        let sell_token = sell_token_id.address();
        let buy_token = buy_token_id.address();

        let sell_client = StellarAssetClient::new(&env, &sell_token);
        sell_client.mint(&owner, &10_000);

        let dca_id = env.register(
            DcaContract,
            (
                owner.clone(),
                sell_token.clone(),
                buy_token.clone(),
                100i128,
                3600u64,
                5u32,
            ),
        );
        let client = DcaContractClient::new(&env, &dca_id);

        (env, owner, token_admin, sell_token, buy_token, client)
    }

    #[test]
    fn test_initialization_and_deposit() {
        let (env, owner, _token_admin, sell_token, _buy_token, client) = setup_test();

        let plan = client.get_plan();
        assert_eq!(plan.amount_per_swap, 100);
        assert_eq!(plan.interval_seconds, 3600);
        assert_eq!(plan.max_swaps, 5);
        assert_eq!(plan.executed_swaps, 0);
        assert!(plan.active);

        // Deposit funds into DCA contract
        client.deposit(&owner, &500);
        let token_client = token::Client::new(&env, &sell_token);
        assert_eq!(token_client.balance(&client.address), 500);
    }

    #[test]
    fn test_execute_swap_and_resolver() {
        let (env, owner, _token_admin, sell_token, _buy_token, client) = setup_test();
        client.deposit(&owner, &500);

        env.ledger().set_timestamp(1000);

        // Resolver should say ready for first swap
        assert!(client.should_run(&1));

        // Execute first swap
        let count = client.execute_swap();
        assert_eq!(count, 1);
        assert_eq!(client.get_plan().executed_swaps, 1);

        // Immediately after, resolver should return false (interval not elapsed)
        assert!(!client.should_run(&1));

        // Advance time past interval (1000 + 3600 = 4600)
        env.ledger().set_timestamp(4600);
        assert!(client.should_run(&1));

        // Execute second swap
        let count2 = client.execute_swap();
        assert_eq!(count2, 2);

        let token_client = token::Client::new(&env, &sell_token);
        assert_eq!(token_client.balance(&client.address), 300);
    }

    #[test]
    fn test_completion_and_cancellation() {
        let (env, owner, _token_admin, sell_token, _buy_token, client) = setup_test();
        client.deposit(&owner, &500);

        let mut time = 1000u64;
        for i in 1..=5 {
            env.ledger().set_timestamp(time);
            assert!(client.should_run(&1));
            assert_eq!(client.execute_swap(), i);
            time += 3600;
        }

        // Plan is now finished
        let plan = client.get_plan();
        assert_eq!(plan.executed_swaps, 5);
        assert!(!plan.active);
        assert!(!client.should_run(&1));

        let token_client = token::Client::new(&env, &sell_token);
        assert_eq!(token_client.balance(&client.address), 0);
    }

    #[test]
    fn test_cancel_refunds_unspent_funds() {
        let (env, owner, _token_admin, sell_token, _buy_token, client) = setup_test();
        client.deposit(&owner, &500);

        env.ledger().set_timestamp(1000);
        client.execute_swap(); // spent 100, 400 remaining

        client.cancel();
        let plan = client.get_plan();
        assert!(!plan.active);

        let token_client = token::Client::new(&env, &sell_token);
        assert_eq!(token_client.balance(&client.address), 0);
        assert_eq!(token_client.balance(&owner), 10_000);
    }
}
