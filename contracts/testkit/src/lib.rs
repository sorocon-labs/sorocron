//! Test harness for contracts automated by SoroCron.
//!
//! One call gives you a registry wired to its executor, a fee token, a
//! funded job owner and a staked keeper, so an example's integration test
//! can focus on its own contract:
//!
//! ```ignore
//! let h = Harness::new();
//! let job = h.schedule(&my_contract, "release", vec![&h.env], 60);
//! h.run(job);              // a keeper executes the job now
//! h.advance(60);
//! h.run(job);
//! ```
//!
//! The harness mocks all auths for setup convenience; tests that need to
//! prove a contract authorizes something itself should clear mocks with
//! `env.set_auths(&[])` around that call.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol, Val, Vec,
};
use sorocron_executor::Executor;
pub use sorocron_registry::{Job, JobParams, Schedule, SoroCron, SoroCronClient};

pub const START: u64 = 1_700_000_000;
pub const FEE: i128 = 1_000;
pub const MIN_STAKE: i128 = 100_000;
const FUNDS: i128 = 1_000_000_000;

pub struct Harness {
    pub env: Env,
    pub cron: SoroCronClient<'static>,
    /// Fee and stake token (a Stellar Asset Contract).
    pub token: TokenClient<'static>,
    pub sac: StellarAssetClient<'static>,
    pub admin: Address,
    pub owner: Address,
    pub keeper: Address,
}

impl Harness {
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(START);

        let admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let sac = StellarAssetClient::new(&env, &token);
        let cron_id = env.register(
            SoroCron,
            (
                admin.clone(),
                token.clone(),
                token.clone(),
                MIN_STAKE,
                3_600u64,
            ),
        );
        let cron = SoroCronClient::new(&env, &cron_id);
        cron.set_executor(&env.register(Executor, (cron_id.clone(),)));

        let owner = Address::generate(&env);
        let keeper = Address::generate(&env);
        sac.mint(&owner, &FUNDS);
        sac.mint(&keeper, &FUNDS);
        cron.stake(&keeper, &MIN_STAKE);

        Harness {
            cron,
            token: TokenClient::new(&env, &token),
            sac,
            admin,
            owner,
            keeper,
            env,
        }
    }

    /// Job parameters for `target.function(args)` every `interval` seconds,
    /// starting now, with the harness fee. Adjust fields before scheduling.
    pub fn params(
        &self,
        target: &Address,
        function: &str,
        args: Vec<Val>,
        interval: u64,
    ) -> JobParams {
        JobParams {
            target: target.clone(),
            function: Symbol::new(&self.env, function),
            args,
            interval,
            schedule: Schedule::Interval,
            start_at: 0,
            fee_per_run: FEE,
            max_fee_per_run: 0,
            max_runs: 0,
            end_at: 0,
            resolver: None,
            keepers: None,
            after: None,
        }
    }

    /// Creates a job funded for 100 runs and returns its id.
    pub fn schedule(&self, target: &Address, function: &str, args: Vec<Val>, interval: u64) -> u64 {
        self.create(&self.params(target, function, args, interval))
    }

    /// Creates a job from custom parameters, funded for 100 runs.
    pub fn create(&self, params: &JobParams) -> u64 {
        self.cron
            .create_job(&self.owner, params, &(params.fee_per_run * 100))
    }

    /// The keeper executes the job now. Panics with the registry error if
    /// the job can't run (not due, resolver said no, ...).
    pub fn run(&self, job_id: u64) {
        self.cron.execute(&self.keeper, &job_id);
    }

    /// Like `run`, but only the keeper's own signature is mocked. Everything
    /// the job does must be authorized for real, so this proves a contract
    /// grants its own sub-call authorizations (for example to a DEX router).
    pub fn run_strict(&self, job_id: u64) {
        self.env.mock_auths(&[MockAuth {
            address: &self.keeper,
            invoke: &MockAuthInvoke {
                contract: &self.cron.address,
                fn_name: "execute",
                args: (self.keeper.clone(), job_id).into_val(&self.env),
                sub_invokes: &[],
            },
        }]);
        self.cron.execute(&self.keeper, &job_id);
        self.env.mock_all_auths();
    }

    /// Whether the keeper could execute the job now.
    pub fn is_due(&self, job_id: u64) -> bool {
        self.cron.is_due(&job_id)
    }

    pub fn job(&self, job_id: u64) -> Job {
        self.cron.get_job(&job_id).expect("job exists")
    }

    pub fn advance(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(now + seconds);
    }

    /// A new address funded with the fee token.
    pub fn funded_account(&self) -> Address {
        let who = Address::generate(&self.env);
        self.sac.mint(&who, &FUNDS);
        who
    }

    /// A second Stellar Asset Contract token, e.g. for swap examples.
    pub fn new_token(&self) -> (TokenClient<'static>, StellarAssetClient<'static>) {
        let id = self
            .env
            .register_stellar_asset_contract_v2(self.admin.clone())
            .address();
        (
            TokenClient::new(&self.env, &id),
            StellarAssetClient::new(&self.env, &id),
        )
    }
}

/// A trivial job target: `hit()` counts how many times it was called.
#[contract]
pub struct Probe;

#[contractimpl]
impl Probe {
    pub fn hit(env: Env) -> u32 {
        let hits = Self::hits(env.clone()) + 1;
        env.storage().instance().set(&symbol_short!("hits"), &hits);
        hits
    }

    pub fn hits(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("hits"))
            .unwrap_or(0)
    }
}

impl Harness {
    /// Registers a `Probe` and returns its client.
    pub fn probe(&self) -> ProbeClient<'static> {
        ProbeClient::new(&self.env, &self.env.register(Probe, ()))
    }
}

/// Soroswap-compatible router stand-in with one fixed exchange rate and its
/// own liquidity. Like Soroswap, it pulls the input from `to` (which must
/// authorize that transfer) and sends the output back to `to`. The "pair"
/// it reports is itself.
#[contract]
pub struct MockRouter;

/// Fixed-point scale for `MockRouter` rates: `out = in * rate / RATE_SCALE`.
pub const RATE_SCALE: i128 = 10_000_000;

#[contractimpl]
impl MockRouter {
    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&symbol_short!("rate"), &rate);
    }

    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn router_get_amounts_out(env: Env, amount_in: i128, _path: Vec<Address>) -> Vec<i128> {
        let rate: i128 = env
            .storage()
            .instance()
            .get(&symbol_short!("rate"))
            .unwrap_or(RATE_SCALE);
        vec![&env, amount_in, amount_in * rate / RATE_SCALE]
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        if env.ledger().timestamp() > deadline {
            panic!("expired");
        }
        let out = Self::router_get_amounts_out(env.clone(), amount_in, path.clone())
            .get(1)
            .unwrap();
        if out < amount_out_min {
            panic!("insufficient output amount");
        }
        let me = env.current_contract_address();
        TokenClient::new(&env, &path.get(0).unwrap()).transfer(&to, &me, &amount_in);
        TokenClient::new(&env, &path.get(path.len() - 1).unwrap()).transfer(&me, &to, &out);
        vec![&env, amount_in, out]
    }
}

impl Harness {
    /// A `MockRouter` at `rate` (scaled by `RATE_SCALE`) holding `liquidity`
    /// of `buy`.
    pub fn router(
        &self,
        rate: i128,
        buy: &StellarAssetClient,
        liquidity: i128,
    ) -> MockRouterClient<'static> {
        let router = MockRouterClient::new(&self.env, &self.env.register(MockRouter, ()));
        router.set_rate(&rate);
        buy.mint(&router.address, &liquidity);
        router
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}
