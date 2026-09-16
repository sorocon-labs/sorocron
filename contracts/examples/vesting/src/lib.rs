#![no_std]
//! # SoroCron Token Vesting Example Contract
//!
//! Linear and cliff token vesting contract for Soroban.
//! Beneficiaries receive tokens linearly over time following an optional cliff period.
//! SoroCron keepers can call `release_vested` permissionlessly to ensure beneficiaries
//! automatically receive unlocked tokens on schedule without manual claiming.
//! Implements `should_run(job_id: u64) -> bool` as a SoroCron resolver.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const TOKEN: Symbol = symbol_short!("TOKEN");
const SCHED: Symbol = symbol_short!("SCHED");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VestingError {
    NotAdmin = 1,
    ScheduleExists = 2,
    ScheduleNotFound = 3,
    NothingToRelease = 4,
    AlreadyRevoked = 5,
    NotRevocable = 6,
    InvalidSchedule = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub beneficiary: Address,
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_time: u64,
    pub cliff_duration: u64,
    pub total_duration: u64,
    pub revocable: bool,
    pub revoked: bool,
}

#[contract]
pub struct VestingContract;

#[contractimpl]
impl VestingContract {
    /// Initializes the vesting contract with admin authority and payout token.
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&TOKEN, &token);
        env.storage().instance().extend_ttl(100_000, 500_000);
    }

    /// Creates a new vesting schedule for a beneficiary.
    pub fn create_schedule(
        env: Env,
        beneficiary: Address,
        total_amount: i128,
        start_time: u64,
        cliff_duration: u64,
        total_duration: u64,
        revocable: bool,
    ) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .expect("not initialized");
        admin.require_auth();

        if total_amount <= 0 || total_duration == 0 || cliff_duration > total_duration {
            panic!("invalid vesting parameters");
        }

        let key = (SCHED, beneficiary.clone());
        if env.storage().persistent().has(&key) {
            panic!("schedule already exists for beneficiary");
        }

        let token_addr: Address = env.storage().instance().get(&TOKEN).expect("token not set");
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&admin, env.current_contract_address(), &total_amount);

        let schedule = VestingSchedule {
            beneficiary: beneficiary.clone(),
            total_amount,
            released_amount: 0,
            start_time,
            cliff_duration,
            total_duration,
            revocable,
            revoked: false,
        };

        env.storage().persistent().set(&key, &schedule);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 500_000);
    }

    /// Computes the total vested amount up to current ledger timestamp.
    pub fn vested_amount(env: Env, beneficiary: Address) -> i128 {
        let key = (SCHED, beneficiary.clone());
        let schedule: VestingSchedule = match env.storage().persistent().get(&key) {
            Some(s) => s,
            None => return 0,
        };

        if schedule.revoked {
            return schedule.released_amount;
        }

        let current_time = env.ledger().timestamp();
        if current_time < schedule.start_time + schedule.cliff_duration {
            return 0;
        }

        if current_time >= schedule.start_time + schedule.total_duration {
            return schedule.total_amount;
        }

        let time_elapsed = current_time.saturating_sub(schedule.start_time) as i128;
        let duration = schedule.total_duration as i128;

        (schedule.total_amount * time_elapsed) / duration
    }

    /// Computes the tokens available for immediate withdrawal.
    pub fn releasable_amount(env: Env, beneficiary: Address) -> i128 {
        let key = (SCHED, beneficiary.clone());
        let schedule: VestingSchedule = match env.storage().persistent().get(&key) {
            Some(s) => s,
            None => return 0,
        };

        let vested = Self::vested_amount(env, beneficiary);
        vested.saturating_sub(schedule.released_amount)
    }

    /// Releases available vested tokens to beneficiary. Permissionless (can be called by SoroCron keeper).
    pub fn release_vested(env: Env, beneficiary: Address) -> i128 {
        let key = (SCHED, beneficiary.clone());
        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&key)
            .expect("schedule not found");

        let releasable = Self::releasable_amount(env.clone(), beneficiary.clone());
        if releasable <= 0 {
            panic!("no tokens currently releasable");
        }

        schedule.released_amount += releasable;
        env.storage().persistent().set(&key, &schedule);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 500_000);

        let token_addr: Address = env.storage().instance().get(&TOKEN).expect("token not set");
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &beneficiary, &releasable);

        releasable
    }

    /// SoroCron resolver interface: checks if a given beneficiary has releasable tokens.
    pub fn should_run_for(env: Env, beneficiary: Address) -> bool {
        Self::releasable_amount(env, beneficiary) > 0
    }

    /// Returns schedule details.
    pub fn get_schedule(env: Env, beneficiary: Address) -> VestingSchedule {
        let key = (SCHED, beneficiary);
        env.storage()
            .persistent()
            .get(&key)
            .expect("schedule not found")
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

    fn setup_vesting() -> (
        Env,
        Address,
        Address,
        Address,
        VestingContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = token_id.address();

        let token_client = StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&admin, &1_000_000);

        let contract_id = env.register(VestingContract, (admin.clone(), token_addr.clone()));
        let client = VestingContractClient::new(&env, &contract_id);

        (env, admin, beneficiary, token_addr, client)
    }

    #[test]
    fn test_vesting_cliff_and_linear_release() {
        let (env, _admin, beneficiary, token_addr, client) = setup_vesting();

        // 1000 tokens total: 100s start, 200s cliff, 1000s total duration
        client.create_schedule(&beneficiary, &1000, &100, &200, &1000, &true);

        // Before start
        env.ledger().set_timestamp(50);
        assert_eq!(client.vested_amount(&beneficiary), 0);
        assert_eq!(client.releasable_amount(&beneficiary), 0);
        assert!(!client.should_run_for(&beneficiary));

        // During cliff (timestamp 250 < 100 + 200)
        env.ledger().set_timestamp(250);
        assert_eq!(client.vested_amount(&beneficiary), 0);
        assert!(!client.should_run_for(&beneficiary));

        // After cliff (timestamp 600: elapsed = 500 / 1000 = 50%)
        env.ledger().set_timestamp(600);
        assert_eq!(client.vested_amount(&beneficiary), 500);
        assert_eq!(client.releasable_amount(&beneficiary), 500);
        assert!(client.should_run_for(&beneficiary));

        // Release first tranche
        let released = client.release_vested(&beneficiary);
        assert_eq!(released, 500);
        assert_eq!(client.releasable_amount(&beneficiary), 0);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&beneficiary), 500);

        // At end of vesting schedule (timestamp 1100 >= 100 + 1000)
        env.ledger().set_timestamp(1200);
        assert_eq!(client.vested_amount(&beneficiary), 1000);
        assert_eq!(client.releasable_amount(&beneficiary), 500);

        // Release remainder
        let released_remainder = client.release_vested(&beneficiary);
        assert_eq!(released_remainder, 500);
        assert_eq!(token_client.balance(&beneficiary), 1000);
    }
}
