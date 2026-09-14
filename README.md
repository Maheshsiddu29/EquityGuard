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

Milestone 3: EquityGuard executes on Solana devnet and atomically prevents later
instructions from settling when protected ScaledUiAmount state is stale or
transitioning. Devnet program:
[`EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT`](https://explorer.solana.com/address/EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT?cluster=devnet).
The evidence uses devnet **test mints** and a system transfer as the downstream
instruction ([docs/devnet.md](docs/devnet.md)).

Not yet demonstrated: Jupiter composition, protection of live xStocks trades on
mainnet, Ondo support, and cross-issuer routing.

| Component | Status |
| --- | --- |
| `programs/equity_guard` — `assert_safe_execution` | deployed on devnet; host, LiteSVM and real devnet transactions |
| Token-2022 ScaledUiAmount decoding | implemented in Rust and TypeScript; cross-checked on golden vectors and real mainnet mint bytes |
| `packages/guard-client` | TypeScript instruction builder (chain-clock snapshot, ABI v1) |
| `scripts/devnet/` | devnet test mints EQ-A/EQ-B, scenario runner, evidence |
| `scripts/evidence/capture-equity-mints.mjs` | raw mainnet mint recorder, verified watchlist |
| Mainnet watcher / xStocks adapter | planned |
| Jupiter composition | planned |
| Rerouting, demo UI | later |

## Repository layout

```
AGENTS.md                 rules for coding agents (read first)
programs/equity_guard/    on-chain guard program (native Rust)
packages/guard-client/    TypeScript instruction builder used by clients
scripts/devnet/           devnet test mints, scenarios, deployment record
scripts/evidence/         raw mainnet evidence capture
evidence/                 capture instructions; generated data is gitignored
docs/                     architecture, invariants, threat model, demo boundary, ADRs
```

## Development

Requirements: Rust (pinned by `rust-toolchain.toml`), Node.js ≥ 22.18, and the
Agave CLI (validated with 4.2.2) for `cargo build-sbf`.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build-sbf --manifest-path programs/equity_guard/Cargo.toml -- --locked
cargo test --workspace --locked        # unit, golden, deployment-ID, LiteSVM (needs the .so)
npm ci && npm run typecheck && npm test
```

Devnet deployment and scenarios are manual; see [docs/devnet.md](docs/devnet.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Invariants](docs/invariants.md)
- [Threat model](docs/threat-model.md)
- [Demo boundary: live mainnet vs devnet execution](docs/demo-boundary.md)
- [Devnet runbook and evidence](docs/devnet.md)
- [ADR 0001: minimal execution guard](docs/adr/0001-minimal-execution-guard.md)
- [ADR 0002: clock-aware transition protection](docs/adr/0002-clock-aware-transition-protection.md)
- [Evidence capture](evidence/README.md)
