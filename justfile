# Common tasks for local development. Install `just`: https://just.systems
#
# Works on Linux, macOS, and Windows (Git Bash) the same way `just` itself
# does: recipes below only use commands already required by CONTRIBUTING.md
# (cargo, npm), no shell-specific syntax. PowerShell is also supported.

# List available recipes.
default:
    @just --list

# Run the contract unit & integration tests.
test:
    cargo test

# Build release WASM contracts (needs stellar-cli 25.2+, see CONTRIBUTING.md).
build:
    stellar contract build

# Format and lint the contracts (matches CI).
lint:
    cargo fmt --all --check
    cargo clippy --all-targets -- -D warnings

# Deploy the contracts to testnet via the keeper-bot deploy script.
deploy-testnet:
    cd keeper-bot && npm install && npm run deploy:testnet

# Run the end-to-end testnet demo (stake, schedule, execute once).
demo:
    cd keeper-bot && npm install && npm run demo

# Run the keeper bot, executing due jobs until stopped.
keeper:
    cd keeper-bot && npm install && npm run keeper

# Run the web dashboard locally at http://localhost:5173.
app:
    npm install && npm run dev
