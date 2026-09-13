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

Milestone 2: the guard is implemented, and LiteSVM tests show it atomically
prevents a downstream instruction from settling when a ScaledUiAmount mint's
protected state is unsafe. It is not yet deployed, and Jupiter composition is
not yet demonstrated.

| Component | Status |
| --- | --- |
| `programs/equity_guard` — `assert_safe_execution` | implemented; host and LiteSVM tests |
| Token-2022 ScaledUiAmount decoding | implemented; tested against real mainnet mint bytes |
| `scripts/evidence/capture-equity-mints.mjs` | raw mainnet mint recorder, verified watchlist |
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

Requirements: Rust (pinned by `rust-toolchain.toml`), Node.js ≥ 22, and the
Agave CLI (validated with 4.2.2) for `cargo build-sbf`.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --lib --locked                      # host unit tests
cargo build-sbf --manifest-path programs/equity_guard/Cargo.toml
cargo test --locked -p equity_guard --test litesvm_atomicity  # needs the .so
node --check scripts/evidence/capture-equity-mints.mjs
node --test 'scripts/evidence/*.test.mjs'
```

## Documentation

- [Architecture](docs/architecture.md)
- [Invariants](docs/invariants.md)
- [Threat model](docs/threat-model.md)
- [Demo boundary: live mainnet vs devnet execution](docs/demo-boundary.md)
- [ADR 0001: minimal execution guard](docs/adr/0001-minimal-execution-guard.md)
- [ADR 0002: clock-aware transition protection](docs/adr/0002-clock-aware-transition-protection.md)
- [Evidence capture](evidence/README.md)
