#![no_std]
//! # DCA vault (dollar-cost averaging through Soroswap)
//!
//! An owner deposits a sell token; a SoroCron job calls `swap_tranche()` on
//! a schedule, and each call swaps a fixed amount into the buy token through
//! a [Soroswap](https://soroswap.finance)-compatible router and sends the
//! proceeds to the owner.
//!
//! The vault defends itself, so the job can be open to any keeper:
//!
//! - **Early or repeated calls fail.** A tranche can run once per interval,
//!   counted from the previous tranche; `max_swaps` caps the total.
//! - **No bad fills.** Every swap passes `amount_out_min` computed from the
//!   owner's `min_price`, so a keeper that manipulates the pool first only
//!   makes its own transaction fail.
//! - **Only the tranche leaves.** The vault authorizes the router to move
//!   exactly `amount_per_swap` of the sell token, nothing else.
//!
//! Use the vault as its own resolver (`should_run`) so keepers don't waste
//! runs before a tranche is due.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error, token,
    vec, Address, Env, IntoVal, Symbol, Vec,
};

/// `min_price` scale: buy-token units per sell-token unit, times 10^7.
pub const PRICE_SCALE: i128 = 10_000_000;

/// The Soroswap router functions the vault uses.
#[allow(dead_code)]
#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DcaError {
    InvalidParameters = 1,
    PlanNotActive = 2,
    NotDueYet = 3,
    MaxSwapsReached = 4,
    InsufficientBalance = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DcaPlan {
    pub owner: Address,
    pub router: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub amount_per_swap: i128,
    pub interval: u64,
    pub max_swaps: u32,
    /// Minimum buy-token units per sell-token unit, scaled by `PRICE_SCALE`.
    pub min_price: i128,
    pub executed_swaps: u32,
    /// Earliest time the next tranche may run.
    pub next_swap_at: u64,
    pub active: bool,
}

#[contracttype]
enum Key {
    Plan,
}

#[contract]
pub struct DcaVault;

#[contractimpl]
impl DcaVault {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        owner: Address,
        router: Address,
        sell_token: Address,
        buy_token: Address,
        amount_per_swap: i128,
        interval: u64,
        max_swaps: u32,
        min_price: i128,
    ) {
        if amount_per_swap <= 0
            || interval == 0
            || max_swaps == 0
            || min_price < 0
            || sell_token == buy_token
        {
            panic_with_error!(&env, DcaError::InvalidParameters);
        }
        let plan = DcaPlan {
            owner,
            router,
            sell_token,
            buy_token,
            amount_per_swap,
            interval,
            max_swaps,
            min_price,
            executed_swaps: 0,
            next_swap_at: env.ledger().timestamp(),
            active: true,
        };
        save(&env, &plan);
    }

    /// Adds sell tokens to the vault.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), DcaError> {
        from.require_auth();
        if amount <= 0 {
            return Err(DcaError::InvalidParameters);
        }
        let plan = load(&env);
        token::Client::new(&env, &plan.sell_token).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        Ok(())
    }

    /// Swaps one tranche and sends the proceeds to the owner. Anyone may
    /// call it (that's the keeper's job); it fails unless a tranche is due.
    /// Returns the amount of buy token the owner received.
    pub fn swap_tranche(env: Env) -> Result<i128, DcaError> {
        let mut plan = load(&env);
        ensure_due(&env, &plan)?;
        let vault = env.current_contract_address();
        let sell = token::Client::new(&env, &plan.sell_token);
        if sell.balance(&vault) < plan.amount_per_swap {
            return Err(DcaError::InsufficientBalance);
        }

        // Effects first: even if the swap could re-enter, the tranche is spent.
        plan.executed_swaps += 1;
        plan.next_swap_at = env.ledger().timestamp() + plan.interval;
        plan.active = plan.executed_swaps < plan.max_swaps;
        save(&env, &plan);

        let router = RouterClient::new(&env, &plan.router);
        let pair = router.router_pair_for(&plan.sell_token, &plan.buy_token);
        // The router pulls the input from the vault, so authorize exactly
        // that transfer and nothing more.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: plan.sell_token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (vault.clone(), pair, plan.amount_per_swap).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        let min_out = plan.amount_per_swap * plan.min_price / PRICE_SCALE;
        let amounts = router.swap_exact_tokens_for_tokens(
            &plan.amount_per_swap,
            &min_out,
            &vec![&env, plan.sell_token.clone(), plan.buy_token.clone()],
            &vault,
            &env.ledger().timestamp(),
        );
        let received = amounts.last().unwrap_or(0);
        token::Client::new(&env, &plan.buy_token).transfer(&vault, &plan.owner, &received);
        Ok(received)
    }

    /// SoroCron resolver: `true` when a tranche is due and funded.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let plan = load(&env);
        ensure_due(&env, &plan).is_ok()
            && token::Client::new(&env, &plan.sell_token).balance(&env.current_contract_address())
                >= plan.amount_per_swap
    }

    /// Stops the plan and refunds the unspent sell token. Owner only.
    pub fn cancel(env: Env) -> i128 {
        let mut plan = load(&env);
        plan.owner.require_auth();
        plan.active = false;
        save(&env, &plan);
        let sell = token::Client::new(&env, &plan.sell_token);
        let balance = sell.balance(&env.current_contract_address());
        if balance > 0 {
            sell.transfer(&env.current_contract_address(), &plan.owner, &balance);
        }
        balance
    }

    pub fn get_plan(env: Env) -> DcaPlan {
        load(&env)
    }
}

fn ensure_due(env: &Env, plan: &DcaPlan) -> Result<(), DcaError> {
    if plan.executed_swaps >= plan.max_swaps {
        return Err(DcaError::MaxSwapsReached);
    }
    if !plan.active {
        return Err(DcaError::PlanNotActive);
    }
    if env.ledger().timestamp() < plan.next_swap_at {
        return Err(DcaError::NotDueYet);
    }
    Ok(())
}

fn load(env: &Env) -> DcaPlan {
    env.storage().instance().extend_ttl(17_280, 30 * 17_280);
    env.storage().instance().get(&Key::Plan).unwrap()
}

fn save(env: &Env, plan: &DcaPlan) {
    env.storage().instance().set(&Key::Plan, plan);
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::token::{StellarAssetClient, TokenClient};
    use sorocron_testkit::{Harness, MockRouterClient, RATE_SCALE};

    const TRANCHE: i128 = 100_000;
    const DAY: u64 = 86_400;

    struct Dca {
        vault: DcaVaultClient<'static>,
        router: MockRouterClient<'static>,
        usdc: TokenClient<'static>,
        xlm: TokenClient<'static>,
        investor: Address,
    }

    /// Sell USDC for XLM: the router pays 8 XLM per USDC, the owner accepts
    /// no less than 7.5.
    fn setup(h: &Harness, max_swaps: u32) -> Dca {
        let (usdc, usdc_admin): (TokenClient, StellarAssetClient) = h.new_token();
        let (xlm, xlm_admin) = h.new_token();
        let router = h.router(8 * RATE_SCALE, &xlm_admin, 1_000_000_000);
        let investor = h.funded_account();
        usdc_admin.mint(&investor, &1_000_000);

        let vault = DcaVaultClient::new(
            &h.env,
            &h.env.register(
                DcaVault,
                (
                    investor.clone(),
                    router.address.clone(),
                    usdc.address.clone(),
                    xlm.address.clone(),
                    TRANCHE,
                    DAY,
                    max_swaps,
                    75 * RATE_SCALE / 10,
                ),
            ),
        );
        vault.deposit(&investor, &(TRANCHE * 5));
        Dca {
            vault,
            router,
            usdc,
            xlm,
            investor,
        }
    }

    #[test]
    fn keeper_swaps_one_tranche_per_interval_through_the_router() {
        let h = Harness::new();
        let d = setup(&h, 3);
        let mut p = h.params(&d.vault.address, "swap_tranche", vec![&h.env], DAY);
        p.resolver = Some(d.vault.address.clone());
        let job = h.create(&p);

        // Only the keeper's signature is mocked: the vault's authorization of
        // the router's transfer is real.
        h.run_strict(job);
        assert_eq!(d.xlm.balance(&d.investor), 8 * TRANCHE);
        assert_eq!(d.usdc.balance(&d.vault.address), 4 * TRANCHE);

        h.advance(DAY);
        h.run_strict(job);
        h.advance(DAY);
        h.run_strict(job);
        assert_eq!(d.xlm.balance(&d.investor), 24 * TRANCHE);

        // max_swaps reached: the resolver keeps the job from running again.
        h.advance(DAY);
        assert!(!h.is_due(job));
        assert!(!d.vault.get_plan().active);
    }

    #[test]
    fn cannot_be_drained_by_early_or_repeated_calls() {
        let h = Harness::new();
        let d = setup(&h, 10);
        d.vault.swap_tranche();
        assert_eq!(d.vault.try_swap_tranche(), Err(Ok(DcaError::NotDueYet)));
        h.advance(DAY - 1);
        assert_eq!(d.vault.try_swap_tranche(), Err(Ok(DcaError::NotDueYet)));
        h.advance(1);
        d.vault.swap_tranche();
        assert_eq!(d.usdc.balance(&d.vault.address), 3 * TRANCHE);
    }

    #[test]
    fn rejects_a_price_below_the_owners_minimum() {
        let h = Harness::new();
        let d = setup(&h, 10);
        // Pool moved (or was manipulated) to 7 XLM per USDC.
        d.router.set_rate(&(7 * RATE_SCALE));
        assert!(d.vault.try_swap_tranche().is_err());
        assert_eq!(d.usdc.balance(&d.vault.address), 5 * TRANCHE);
        assert_eq!(d.vault.get_plan().executed_swaps, 0);
    }

    #[test]
    fn cancel_refunds_unspent_funds() {
        let h = Harness::new();
        let d = setup(&h, 10);
        d.vault.swap_tranche();
        let before = d.usdc.balance(&d.investor);
        assert_eq!(d.vault.cancel(), 4 * TRANCHE);
        assert_eq!(d.usdc.balance(&d.investor), before + 4 * TRANCHE);
        h.advance(DAY);
        assert_eq!(d.vault.try_swap_tranche(), Err(Ok(DcaError::PlanNotActive)));
        assert!(!d.vault.should_run(&0));
    }

    #[test]
    fn unfunded_vault_is_not_due() {
        let h = Harness::new();
        let d = setup(&h, 10);
        d.vault.cancel();
        let fresh = DcaVaultClient::new(
            &h.env,
            &h.env.register(
                DcaVault,
                (
                    d.investor.clone(),
                    d.router.address.clone(),
                    d.usdc.address.clone(),
                    d.xlm.address.clone(),
                    TRANCHE,
                    DAY,
                    10u32,
                    0i128,
                ),
            ),
        );
        assert!(!fresh.should_run(&0));
        assert_eq!(
            fresh.try_swap_tranche(),
            Err(Ok(DcaError::InsufficientBalance))
        );
    }
}
