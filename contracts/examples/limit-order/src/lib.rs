#![no_std]
//! # Limit order
//!
//! Sell `amount_in` of one token for at least `min_amount_out` of another,
//! filled through a Soroswap-compatible router as soon as the market allows.
//! The order is its own resolver: `should_run` asks the router for a quote,
//! so keepers only run `fill()` once the price is good enough. The swap
//! itself passes `min_amount_out` to the router, so even a manipulated quote
//! can't fill the order below the limit. Walkthrough:
//! [docs/tutorials/limit-order.md](../../../docs/tutorials/limit-order.md).

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error, token,
    vec, Address, Env, IntoVal, Symbol, Vec,
};

#[allow(dead_code)]
#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
    fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128>;
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
pub enum Error {
    InvalidOrder = 1,
    NotFunded = 2,
    Closed = 3,
    Expired = 4,
    PriceNotReached = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub owner: Address,
    pub router: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub amount_in: i128,
    pub min_amount_out: i128,
    /// Unix time after which the order can't fill. `0` means never.
    pub expires_at: u64,
    pub funded: bool,
    pub open: bool,
    /// Amount received when filled.
    pub filled_out: i128,
}

#[contracttype]
enum Key {
    Order,
}

#[contract]
pub struct LimitOrder;

#[contractimpl]
impl LimitOrder {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        owner: Address,
        router: Address,
        sell_token: Address,
        buy_token: Address,
        amount_in: i128,
        min_amount_out: i128,
        expires_at: u64,
    ) {
        if amount_in <= 0 || min_amount_out <= 0 || sell_token == buy_token {
            panic_with_error!(&env, Error::InvalidOrder);
        }
        save(
            &env,
            &Order {
                owner,
                router,
                sell_token,
                buy_token,
                amount_in,
                min_amount_out,
                expires_at,
                funded: false,
                open: true,
                filled_out: 0,
            },
        );
    }

    /// Moves `amount_in` of the sell token from the owner into the order.
    pub fn fund(env: Env) -> Result<(), Error> {
        let mut order = load(&env);
        order.owner.require_auth();
        if !order.open || order.funded {
            return Err(Error::Closed);
        }
        token::Client::new(&env, &order.sell_token).transfer(
            &order.owner,
            env.current_contract_address(),
            &order.amount_in,
        );
        order.funded = true;
        save(&env, &order);
        Ok(())
    }

    /// What the router would pay for the order right now.
    pub fn quote(env: Env) -> i128 {
        let order = load(&env);
        RouterClient::new(&env, &order.router)
            .try_router_get_amounts_out(&order.amount_in, &path(&env, &order))
            .ok()
            .and_then(|r| r.ok())
            .and_then(|amounts| amounts.last())
            .unwrap_or(0)
    }

    /// Fills the order if the market pays at least the limit. Anyone may
    /// call it. Sends the proceeds to the owner and returns the amount.
    pub fn fill(env: Env) -> Result<i128, Error> {
        let mut order = load(&env);
        ensure_fillable(&env, &order)?;
        if Self::quote(env.clone()) < order.min_amount_out {
            return Err(Error::PriceNotReached);
        }
        order.open = false;
        save(&env, &order);

        let me = env.current_contract_address();
        let router = RouterClient::new(&env, &order.router);
        let pair = router.router_pair_for(&order.sell_token, &order.buy_token);
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: order.sell_token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (me.clone(), pair, order.amount_in).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        let amounts = router.swap_exact_tokens_for_tokens(
            &order.amount_in,
            &order.min_amount_out,
            &path(&env, &order),
            &me,
            &env.ledger().timestamp(),
        );
        let out = amounts.last().unwrap_or(0);
        token::Client::new(&env, &order.buy_token).transfer(&me, &order.owner, &out);
        order.filled_out = out;
        save(&env, &order);
        Ok(out)
    }

    /// Cancels an open order and returns the funds. Owner only.
    pub fn cancel(env: Env) -> Result<i128, Error> {
        let mut order = load(&env);
        order.owner.require_auth();
        if !order.open {
            return Err(Error::Closed);
        }
        order.open = false;
        save(&env, &order);
        if order.funded {
            token::Client::new(&env, &order.sell_token).transfer(
                &env.current_contract_address(),
                &order.owner,
                &order.amount_in,
            );
            return Ok(order.amount_in);
        }
        Ok(0)
    }

    pub fn order(env: Env) -> Order {
        load(&env)
    }

    /// SoroCron resolver: `true` once the order can fill at its limit.
    pub fn should_run(env: Env, _job_id: u64) -> bool {
        let order = load(&env);
        ensure_fillable(&env, &order).is_ok() && Self::quote(env) >= order.min_amount_out
    }
}

fn ensure_fillable(env: &Env, order: &Order) -> Result<(), Error> {
    if !order.open {
        return Err(Error::Closed);
    }
    if !order.funded {
        return Err(Error::NotFunded);
    }
    if order.expires_at != 0 && env.ledger().timestamp() >= order.expires_at {
        return Err(Error::Expired);
    }
    Ok(())
}

fn path(env: &Env, order: &Order) -> Vec<Address> {
    vec![env, order.sell_token.clone(), order.buy_token.clone()]
}

fn load(env: &Env) -> Order {
    env.storage().instance().extend_ttl(17_280, 30 * 17_280);
    env.storage().instance().get(&Key::Order).unwrap()
}

fn save(env: &Env, order: &Order) {
    env.storage().instance().set(&Key::Order, order);
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::token::TokenClient;
    use sorocron_testkit::{Harness, MockRouterClient, RATE_SCALE};

    /// One whole token, with 7 decimals.
    const UNIT: i128 = 10_000_000;
    const AMOUNT: i128 = 1_000 * UNIT; // 1,000 USDC
    const LIMIT: i128 = 8_500 * UNIT; // at least 8,500 XLM: 8.5 XLM per USDC

    struct Setup {
        order: LimitOrderClient<'static>,
        router: MockRouterClient<'static>,
        xlm: TokenClient<'static>,
        trader: Address,
    }

    fn setup(h: &Harness, expires_at: u64) -> Setup {
        let (usdc, usdc_admin) = h.new_token();
        let (xlm, xlm_admin) = h.new_token();
        let router = h.router(8 * RATE_SCALE, &xlm_admin, 1_000_000 * UNIT);
        let trader = h.funded_account();
        usdc_admin.mint(&trader, &AMOUNT);
        let order = LimitOrderClient::new(
            &h.env,
            &h.env.register(
                LimitOrder,
                (
                    trader.clone(),
                    router.address.clone(),
                    usdc.address.clone(),
                    xlm.address.clone(),
                    AMOUNT,
                    LIMIT,
                    expires_at,
                ),
            ),
        );
        order.fund();
        Setup {
            order,
            router,
            xlm,
            trader,
        }
    }

    #[test]
    fn keeper_fills_once_the_market_reaches_the_limit() {
        let h = Harness::new();
        let s = setup(&h, 0);
        let mut p = h.params(&s.order.address, "fill", soroban_sdk::vec![&h.env], 60);
        p.resolver = Some(s.order.address.clone());
        p.max_runs = 1;
        let job = h.create(&p);

        assert!(!h.is_due(job), "8.0 XLM per USDC is below the limit");
        s.router.set_rate(&(9 * RATE_SCALE));
        assert!(h.is_due(job));
        h.run_strict(job);

        assert_eq!(s.xlm.balance(&s.trader), 9_000 * UNIT);
        assert!(!s.order.order().open);
        assert_eq!(s.order.order().filled_out, 9_000 * UNIT);
    }

    #[test]
    fn never_fills_below_the_limit() {
        let h = Harness::new();
        let s = setup(&h, 0);
        assert_eq!(s.order.try_fill(), Err(Ok(Error::PriceNotReached)));
        assert!(s.order.order().open);
    }

    #[test]
    fn expiry_and_cancel() {
        let h = Harness::new();
        let expiry = h.env.ledger().timestamp() + 3_600;
        let s = setup(&h, expiry);
        s.router.set_rate(&(9 * RATE_SCALE));
        h.advance(3_600);
        assert_eq!(s.order.try_fill(), Err(Ok(Error::Expired)));
        assert!(!s.order.should_run(&0));
        assert_eq!(s.order.cancel(), AMOUNT);
        assert_eq!(s.order.try_cancel(), Err(Ok(Error::Closed)));
    }
}
