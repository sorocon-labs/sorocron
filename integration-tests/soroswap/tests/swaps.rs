//! Current example WASM against the real router from a frozen mainnet capture.

use kanatoko::{
    mainnet,
    soroban_sdk::{testutils::Ledger as _, vec, Address, Vec},
    AutoRunner, ScenarioFork,
};

mod dca {
    #![allow(clippy::too_many_arguments)]
    use kanatoko::soroban_sdk;
    soroban_sdk::contractimport!(file = "wasm/sorocron_example_dca.wasm");
}

mod limit_order {
    #![allow(clippy::too_many_arguments)]
    use kanatoko::soroban_sdk;
    soroban_sdk::contractimport!(file = "wasm/sorocron_example_limit_order.wasm");
}

const ROUTER: &str = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const XLM: &str = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const TEN_USDC: i128 = 100_000_000;
const DAY: u64 = 86_400;

fn runner(name: &str) -> AutoRunner {
    let path = format!("{}/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let runner = mainnet().cache(path);
    match std::env::var("KANATOKO_CAPTURE_RPC") {
        Ok(rpc) => runner.rpc_url(rpc).rpc_rate_limit(4).refresh(),
        Err(_) => runner.offline(),
    }
}

fn user(fork: &ScenarioFork<'_>, label: &str) -> Address {
    let user = fork.local_account(label);
    fork.fund_local_account(&user, 100_000_000);
    let token = fork.contract(USDC);
    fork.invoke::<()>(&token, "trust", (user.clone(),));
    fork.invoke::<()>(&token, "set_authorized", (user.clone(), true));
    fork.invoke::<()>(&token, "mint", (user.clone(), 10 * TEN_USDC));
    user
}

#[test]
fn dca_swaps_and_advances_its_schedule() {
    runner("dca")
        .run(|fork| {
            fork.mock_all_auths();
            let owner = user(fork, "dca-owner");
            let address = fork.deploy(
                dca::WASM,
                (
                    owner.clone(),
                    fork.contract(ROUTER),
                    fork.contract(USDC),
                    fork.contract(XLM),
                    TEN_USDC,
                    DAY,
                    10_u32,
                    0_i128,
                ),
            );
            let vault = dca::Client::new(fork.env(), &address);
            vault.deposit(&owner, &(5 * TEN_USDC));
            assert!(vault.swap_tranche() > 0);
            assert_eq!(vault.get_plan().executed_swaps, 1);
            assert_eq!(vault.try_swap_tranche(), Err(Ok(dca::DcaError::NotDueYet)));
            fork.env()
                .ledger()
                .set_timestamp(fork.env().ledger().timestamp() + DAY);
            assert!(vault.swap_tranche() > 0);
            assert_eq!(vault.get_plan().executed_swaps, 2);
        })
        .unwrap();
}

#[test]
fn limit_order_fills_once_through_the_real_router() {
    runner("limit-order")
        .run(|fork| {
            fork.mock_all_auths();
            let owner = user(fork, "limit-order-owner");
            let address = fork.deploy(
                limit_order::WASM,
                (
                    owner.clone(),
                    fork.contract(ROUTER),
                    fork.contract(USDC),
                    fork.contract(XLM),
                    TEN_USDC,
                    1_i128,
                    0_u64,
                ),
            );
            let order = limit_order::Client::new(fork.env(), &address);
            order.fund();
            let out = order.fill();
            assert!(out > 0);
            assert!(!order.order().open);
            assert_eq!(order.order().filled_out, out);
            assert_eq!(order.try_fill(), Err(Ok(limit_order::Error::Closed)));
        })
        .unwrap();
}

#[test]
fn router_rejects_equal_deadline_and_accepts_the_next_second() {
    runner("router-control")
        .run(|fork| {
            fork.mock_all_auths();
            let owner = user(fork, "swap-user");
            let router = fork.contract(ROUTER);
            let path = vec![fork.env(), fork.contract(USDC), fork.contract(XLM)];
            let now = fork.env().ledger().timestamp();
            let result = fork.try_invoke::<Vec<i128>>(
                &router,
                "swap_exact_tokens_for_tokens",
                (TEN_USDC, 0_i128, path.clone(), owner.clone(), now),
            );
            assert_eq!(
                result.unwrap_err().error,
                Some(kanatoko::soroban_env_host::xdr::ScError::Contract(503))
            );
            let amounts: Vec<i128> = fork.invoke(
                &router,
                "swap_exact_tokens_for_tokens",
                (TEN_USDC, 0_i128, path, owner, now + 1),
            );
            assert_eq!(amounts.get_unchecked(0), TEN_USDC);
            assert!(amounts.get_unchecked(1) > 0);
        })
        .unwrap();
}
