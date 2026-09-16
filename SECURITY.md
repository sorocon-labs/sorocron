# Security Policy

SoroCron is pre-audit software under active development. **Do not use it with real funds on mainnet.**

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub: **Security → Report a vulnerability** on this repository. Include:

- the affected contract or component and commit hash
- a description of the issue and its impact
- steps or a test case to reproduce it

What to expect:

- acknowledgement within 72 hours
- an assessment and remediation plan within 7 days for confirmed issues.
- credit in the release notes, if you want it

## Scope

In scope: everything in `contracts/` and `keeper-bot/`.

Out of scope: the testnet deployment's availability (testnet resets periodically), third-party dependencies (report upstream), and issues requiring a compromised admin key.

The design assumptions and known limitations are documented in [docs/security.md](docs/security.md).
