#![no_std]
//! # Composite resolver: ALL / ANY
//!
//! Combines other resolvers into one, so a job can depend on several
//! conditions: for example "price below X **and** inside business hours", or
//! "vault over capacity **or** a day since the last rebalance".
//!
//! - `All` runs when every sub-resolver answers `true` (logical AND).
//! - `Any` runs when at least one does (logical OR).
//!
//! Sub-resolvers are called with the job id the registry passed in, through
//! `try_invoke_contract`, so a broken sub-resolver counts as `false` instead
//! of failing the whole check. Composite resolvers can be nested.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Vec,
};

/// Bound on sub-resolvers, to keep each check within resource limits.
pub const MAX_RESOLVERS: u32 = 8;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    TooManyResolvers = 1,
    NoResolvers = 2,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    All,
    Any,
}

#[contracttype]
enum Key {
    Admin,
    Mode,
    Resolvers,
}

#[contract]
pub struct CompositeResolver;

#[contractimpl]
impl CompositeResolver {
    pub fn __constructor(env: Env, admin: Address, mode: Mode, resolvers: Vec<Address>) {
        env.storage().instance().set(&Key::Admin, &admin);
        if let Err(e) = store(&env, mode, resolvers) {
            soroban_sdk::panic_with_error!(&env, e);
        }
    }

    /// Replaces the mode and sub-resolvers. Admin only.
    pub fn set(env: Env, mode: Mode, resolvers: Vec<Address>) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        store(&env, mode, resolvers)
    }

    pub fn mode(env: Env) -> Mode {
        env.storage().instance().get(&Key::Mode).unwrap()
    }

    pub fn resolvers(env: Env) -> Vec<Address> {
        env.storage().instance().get(&Key::Resolvers).unwrap()
    }

    /// SoroCron resolver: combines the sub-resolvers' answers for `job_id`.
    /// Stops at the first answer that decides the result.
    pub fn should_run(env: Env, job_id: u64) -> bool {
        let fn_name = Symbol::new(&env, "should_run");
        let ask = |resolver: Address| {
            matches!(
                env.try_invoke_contract::<bool, soroban_sdk::Error>(
                    &resolver,
                    &fn_name,
                    vec![&env, job_id.into_val(&env)],
                ),
                Ok(Ok(true))
            )
        };
        let mut resolvers = Self::resolvers(env.clone()).into_iter();
        match Self::mode(env.clone()) {
            Mode::All => resolvers.all(ask),
            Mode::Any => resolvers.any(ask),
        }
    }
}

fn store(env: &Env, mode: Mode, resolvers: Vec<Address>) -> Result<(), Error> {
    if resolvers.is_empty() {
        return Err(Error::NoResolvers);
    }
    if resolvers.len() > MAX_RESOLVERS {
        return Err(Error::TooManyResolvers);
    }
    env.storage().instance().set(&Key::Mode, &mode);
    env.storage().instance().set(&Key::Resolvers, &resolvers);
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, symbol_short};
    use sorocron_testkit::Harness;

    /// Answers whatever it was last told.
    #[contract]
    pub struct Flag;

    #[contractimpl]
    impl Flag {
        pub fn set(env: Env, ready: bool) {
            env.storage()
                .instance()
                .set(&symbol_short!("ready"), &ready);
        }
        pub fn should_run(env: Env, _job_id: u64) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("ready"))
                .unwrap_or(false)
        }
    }

    fn flags(h: &Harness, n: usize) -> std::vec::Vec<FlagClient<'static>> {
        (0..n)
            .map(|_| FlagClient::new(&h.env, &h.env.register(Flag, ())))
            .collect()
    }

    fn composite(h: &Harness, mode: Mode, subs: &[Address]) -> CompositeResolverClient<'static> {
        let mut list = Vec::new(&h.env);
        for a in subs {
            list.push_back(a.clone());
        }
        CompositeResolverClient::new(
            &h.env,
            &h.env
                .register(CompositeResolver, (h.admin.clone(), mode, list)),
        )
    }

    /// Every combination of two flags against the expected truth table.
    #[test]
    fn truth_tables() {
        let h = Harness::new();
        let f = flags(&h, 2);
        let addrs = [f[0].address.clone(), f[1].address.clone()];
        let all = composite(&h, Mode::All, &addrs);
        let any = composite(&h, Mode::Any, &addrs);
        for (a, b) in [(false, false), (false, true), (true, false), (true, true)] {
            f[0].set(&a);
            f[1].set(&b);
            assert_eq!(all.should_run(&0), a && b, "ALL({a}, {b})");
            assert_eq!(any.should_run(&0), a || b, "ANY({a}, {b})");
        }
    }

    #[test]
    fn broken_sub_resolver_counts_as_false() {
        let h = Harness::new();
        let f = flags(&h, 1);
        f[0].set(&true);
        let not_a_resolver = h.probe().address;
        let all = composite(
            &h,
            Mode::All,
            &[f[0].address.clone(), not_a_resolver.clone()],
        );
        let any = composite(&h, Mode::Any, &[f[0].address.clone(), not_a_resolver]);
        assert!(!all.should_run(&0));
        assert!(any.should_run(&0));
    }

    #[test]
    fn composites_nest() {
        let h = Harness::new();
        let f = flags(&h, 3);
        // a AND (b OR c)
        let inner = composite(&h, Mode::Any, &[f[1].address.clone(), f[2].address.clone()]);
        let outer = composite(
            &h,
            Mode::All,
            &[f[0].address.clone(), inner.address.clone()],
        );
        f[0].set(&true);
        assert!(!outer.should_run(&0));
        f[2].set(&true);
        assert!(outer.should_run(&0));
    }

    #[test]
    fn gates_a_registry_job() {
        let h = Harness::new();
        let f = flags(&h, 2);
        let all = composite(&h, Mode::All, &[f[0].address.clone(), f[1].address.clone()]);
        let target = h.probe();
        let mut p = h.params(&target.address, "hit", soroban_sdk::vec![&h.env], 60);
        p.resolver = Some(all.address.clone());
        let job = h.create(&p);

        f[0].set(&true);
        assert!(!h.is_due(job));
        f[1].set(&true);
        h.run(job);
        assert_eq!(target.hits(), 1);
    }

    #[test]
    fn list_size_is_bounded() {
        let h = Harness::new();
        let f = flags(&h, 1);
        let c = composite(&h, Mode::Any, &[f[0].address.clone()]);
        let mut too_many = Vec::new(&h.env);
        for _ in 0..=MAX_RESOLVERS {
            too_many.push_back(f[0].address.clone());
        }
        assert_eq!(
            c.try_set(&Mode::All, &too_many),
            Err(Ok(Error::TooManyResolvers))
        );
        assert_eq!(
            c.try_set(&Mode::All, &Vec::new(&h.env)),
            Err(Ok(Error::NoResolvers))
        );
    }

    extern crate std;
}
