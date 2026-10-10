//! Configuration from the environment, matching the TypeScript keeper's
//! variables so one `.env` serves both.

use std::{env, fs, path::PathBuf, time::Duration};

use ed25519_dalek::SigningKey;
use stellar_strkey::{ed25519, Contract, Strkey};

pub const TESTNET_PASSPHRASE: &str = "Test SDF Network ; September 2015";
pub const MAINNET_PASSPHRASE: &str = "Public Global Stellar Network ; September 2015";
pub const LOCAL_PASSPHRASE: &str = "Standalone Network ; February 2017";

#[derive(Debug, Clone)]
pub struct Config {
    pub network: String,
    pub rpc_url: String,
    pub passphrase: String,
    /// Registry contract id (32 bytes).
    pub registry: [u8; 32],
    pub keeper: SigningKey,
    pub poll_interval: Duration,
    /// Inclusion fee bid in stroops, on top of the simulated resource fee.
    pub inclusion_fee: u32,
    pub once: bool,
    /// Simulate everything but never send.
    pub dry_run: bool,
    /// Jobs per `execute_batch` (1-20).
    pub batch_size: usize,
    /// Skip batches whose XLM fees minus network cost are below this, in stroops.
    pub min_profit: i128,
    /// Serve `/metrics` and `/healthz` on this port; 0 turns the server off.
    pub metrics_port: u16,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

/// Network passphrase and default RPC URL for a network name.
pub fn network_defaults(network: &str) -> Result<(&'static str, &'static str), ConfigError> {
    match network {
        "testnet" => Ok((TESTNET_PASSPHRASE, "https://soroban-testnet.stellar.org")),
        "mainnet" => Ok((MAINNET_PASSPHRASE, "")),
        "local" => Ok((LOCAL_PASSPHRASE, "http://localhost:8000/rpc")),
        other => err(format!(
            "STELLAR_NETWORK must be testnet, mainnet or local (got {other})"
        )),
    }
}

pub fn parse_contract(id: &str) -> Result<[u8; 32], ConfigError> {
    match Strkey::from_string(id.trim()) {
        Ok(Strkey::Contract(Contract(bytes))) => Ok(bytes),
        _ => err(format!("{id} is not a contract address (C...)")),
    }
}

pub fn parse_secret(secret: &str) -> Result<SigningKey, ConfigError> {
    match ed25519::PrivateKey::from_string(secret.trim()) {
        Ok(ed25519::PrivateKey(bytes)) => Ok(SigningKey::from_bytes(&bytes)),
        Err(_) => err("STELLAR_SECRET_KEY must be a secret key (S...)"),
    }
}

/// `G...` address of a signing key.
pub fn address(key: &SigningKey) -> String {
    ed25519::PublicKey(key.verifying_key().to_bytes())
        .to_string()
        .as_str()
        .to_owned()
}

/// Reads `deployments/<network>.json` from the repository, searching up from
/// the working directory so the keeper runs from `keeper-rs/` or the root.
fn registry_from_deployments(network: &str) -> Option<String> {
    let mut dir = env::current_dir().ok()?;
    loop {
        let candidate: PathBuf = dir.join("deployments").join(format!("{network}.json"));
        if let Ok(text) = fs::read_to_string(&candidate) {
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            return json.get("registry")?.as_str().map(str::to_owned);
        }
        if !dir.pop() {
            return None;
        }
    }
}

impl Config {
    pub fn from_env(args: &[String]) -> Result<Self, ConfigError> {
        let network = env::var("STELLAR_NETWORK").unwrap_or_else(|_| "testnet".into());
        let (passphrase, default_rpc) = network_defaults(&network)?;
        let rpc_url = env::var("STELLAR_RPC_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_rpc.to_owned());
        if rpc_url.is_empty() {
            return err("Set STELLAR_RPC_URL for mainnet");
        }
        let registry = match env::var("SOROCRON_CONTRACT_ID")
            .ok()
            .filter(|s| !s.is_empty())
        {
            Some(id) => id,
            None => registry_from_deployments(&network).ok_or_else(|| {
                ConfigError("Set SOROCRON_CONTRACT_ID or add deployments/<network>.json".into())
            })?,
        };
        let dry_run = args.iter().any(|a| a == "--dry-run");
        let keeper = match env::var("STELLAR_SECRET_KEY")
            .ok()
            .filter(|s| !s.is_empty())
        {
            Some(secret) => parse_secret(&secret)?,
            // A dry run only simulates, so any key works for reading.
            None if dry_run => SigningKey::from_bytes(&[7u8; 32]),
            None => return err("Set STELLAR_SECRET_KEY (or pass --dry-run to only simulate)"),
        };
        let poll_ms: u64 = env::var("POLL_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000);
        let inclusion_fee: u32 = env::var("INCLUSION_FEE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1_000);
        let number = |name: &str, default: i128| -> Result<i128, ConfigError> {
            match env::var(name).ok().filter(|v| !v.is_empty()) {
                None => Ok(default),
                Some(v) => v
                    .parse()
                    .map_err(|_| ConfigError(format!("{name} must be a number (got {v})"))),
            }
        };
        Ok(Config {
            network,
            rpc_url,
            passphrase: passphrase.to_owned(),
            registry: parse_contract(&registry)?,
            keeper,
            poll_interval: Duration::from_millis(poll_ms),
            inclusion_fee,
            once: args.iter().any(|a| a == "--once"),
            dry_run,
            batch_size: number("BATCH_SIZE", 10)?.clamp(1, 20) as usize,
            min_profit: number("MIN_PROFIT_STROOPS", 0)?,
            metrics_port: u16::try_from(number("METRICS_PORT", 0)?)
                .map_err(|_| ConfigError("METRICS_PORT must be a port number".into()))?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_strkeys_both_ways() {
        let key = SigningKey::from_bytes(&[1u8; 32]);
        let private = ed25519::PrivateKey([1u8; 32]);
        let secret = private.as_unredacted().to_string();
        assert_eq!(
            parse_secret(secret.as_str()).unwrap().to_bytes(),
            key.to_bytes()
        );
        assert!(address(&key).starts_with('G'));
        assert!(parse_secret(&address(&key)).is_err());

        let contract = Contract([9u8; 32]).to_string();
        assert_eq!(parse_contract(contract.as_str()).unwrap(), [9u8; 32]);
        assert!(parse_contract(&address(&key)).is_err());
    }

    #[test]
    fn knows_each_network() {
        assert_eq!(network_defaults("testnet").unwrap().0, TESTNET_PASSPHRASE);
        assert_eq!(
            network_defaults("local").unwrap().1,
            "http://localhost:8000/rpc"
        );
        assert!(network_defaults("moon").is_err());
    }
}
