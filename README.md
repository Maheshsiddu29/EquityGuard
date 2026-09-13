# EquityGuard

**Corporate-action-aware execution infrastructure for tokenized equities on
Solana.**

_Slippage protection, but for corporate actions._

## Why

Tokenized equities change economic state through dividends, splits, reverse
splits, mergers, issuer pauses, and Token-2022 `ScaledUiAmount` multiplier
changes, including scheduled multiplier activations.

A backend can inspect that state before building a transaction, but the state
can change between quote/check time, wallet signing, and transaction landing.
EquityGuard puts the check inside the transaction:

```
transaction
 ├─ EquityGuard.assert_safe_execution(expected = S)   ← reads mint at execution time
 └─ execution instruction(s), e.g. Jupiter swap        ← settle only if the guard passed
```

If the protected state has moved from `S` to `S'`, the guard fails and Solana's
transaction atomicity guarantees the downstream instructions do not settle.

Integrators are venues, wallets, aggregators, trading apps, agents and DeFi
protocols. EquityGuard is not primarily a retail product.

## Status

Milestone 1: repository foundation. The guard program is a fail-closed skeleton;
guard business logic has not been implemented yet.

| Component | Status |
| --- | --- |
| `programs/equity_guard` | skeleton, rejects all instructions |
| `scripts/evidence/capture-equity-mints.mjs` | raw mainnet mint recorder |
| Token-2022 ScaledUiAmount decoding | planned |
| Devnet test mints | planned |
| Mainnet watcher / xStocks adapter | planned |
| Jupiter composition | planned |
| Rerouting, demo UI | later |

## Repository layout

```
AGENTS.md                 rules for coding agents (read first)
programs/equity_guard/    on-chain guard program (native Rust)
scripts/evidence/         raw mainnet evidence capture
evidence/                 capture instructions; generated data is gitignored
docs/                     architecture, invariants, threat model, demo boundary, ADRs
```

## Development

Requirements: Rust (pinned by `rust-toolchain.toml`), Node.js ≥ 22.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
node --check scripts/evidence/capture-equity-mints.mjs
node --test scripts/evidence/
```

Building the on-chain SBF artifact additionally requires the Solana/Agave CLI
(`cargo build-sbf`). See `docs/architecture.md`.

## Documentation

- [Architecture](docs/architecture.md)
- [Invariants](docs/invariants.md)
- [Threat model](docs/threat-model.md)
- [Demo boundary: live mainnet vs devnet execution](docs/demo-boundary.md)
- [ADR 0001: minimal execution guard](docs/adr/0001-minimal-execution-guard.md)
- [Evidence capture](evidence/README.md)
