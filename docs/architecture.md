# Architecture

This document describes what exists and what is planned. It is updated in the
same change as the code it describes.

## Components

```
                    ┌─────────────────────────── client / integrator ───────────────────────────┐
                    │                                                                            │
 mainnet RPC ──▶ watcher + issuer adapters ──▶ normalized state ──▶ tx composer ──▶ wallet sign  │
 (read only)        (xStocks first, Ondo later)  SAFE/TRANSITION/     (guard ix +                 │
                                                  PAUSED/UNKNOWN       Jupiter ixs)               │
                    └────────────────────────────────────────────────────────┬───────────────────┘
                                                                             ▼
                                                              Solana transaction (atomic)
                                                              1. equity_guard::assert_safe_execution
                                                              2. swap / execution instructions
```

| Component | Location | Status |
| --- | --- | --- |
| Guard program | `programs/equity_guard` | skeleton (fail-closed, no instructions) |
| Raw evidence capture | `scripts/evidence/capture-equity-mints.mjs` | implemented |
| ScaledUiAmount decoding | inside the program crate; extracted to `crates/equity-state` only if off-chain Rust needs it | planned |
| Devnet test-mint tooling | `scripts/devnet/` | planned |
| Mainnet watcher + xStocks adapter | `packages/watcher/` | planned |
| Jupiter composition | TBD with watcher/client code | planned |
| Rerouting | later | planned, gated on base guard |
| Demo UI | `apps/web/` | later |

Directories are created only when they contain real code.

## Guard program

Native Solana Rust program (no Anchor). Rationale in
[ADR 0001](adr/0001-minimal-execution-guard.md).

Planned single instruction, `assert_safe_execution(expected)`:

- **Accounts:** the Token-2022 mint (read-only). Nothing else. The clock is read
  with the `Clock` sysvar getter syscall, not an account.
- **Data:** a fixed-layout expected-state snapshot. Candidate fields, finalized
  in Milestone 2:
  - current multiplier (IEEE-754 `f64` bytes as stored in the extension)
  - pending/new multiplier (bytes)
  - new-multiplier effective timestamp (`i64`)
  - safety window (seconds) around activation, if the demo requires it
- **Checks:**
  1. mint owner is the Token-2022 program;
  2. mint parses with extensions; ScaledUiAmount extension present;
  3. stored multiplier bytes / timestamp equal expected (byte equality, never
     float equality);
  4. clock is not inside the protected activation window;
  5. anything else → error (fail closed).
- **Effects:** none. The guard writes no state and moves no funds.

Multipliers are compared as their stored byte representation. Two different
NaN encodings or `0.0`/`-0.0` are therefore treated as different, which is the
conservative choice.

## Normalized state model (off-chain)

| State | Meaning | Execution |
| --- | --- | --- |
| `SAFE` | no pending transition near execution time, issuer active | allowed with guard |
| `TRANSITION` | pending multiplier/corporate action inside the protection window | blocked |
| `PAUSED` | issuer pause / trading halt | blocked |
| `UNKNOWN` | state cannot be established or sources disagree | blocked (fail closed) |

Issuer-native raw details are stored alongside, never folded into the enum.

## ScaledUiAmount display rules

Raw token amount ≠ displayed/economic amount. UI conversion uses floating-point
multiplication. Display and valuation code must use an explicit rounding and
tolerance policy and must not assume `ui → raw → ui` round-trips exactly.

## Market-risk boundary

EquityGuard protects the discrete state transition, not post-transition fair
value. See [threat model](threat-model.md#out-of-scope-market-risk).

## Tooling

- Rust toolchain pinned in `rust-toolchain.toml`; edition 2021 for
  compatibility with Solana platform-tools.
- Host `cargo test` runs unit tests. On-chain integration tests (planned:
  LiteSVM against the built `.so`) require `cargo build-sbf` from the Agave CLI.
- Evidence script uses Node.js ≥ 22 built-ins only (global `fetch`,
  `node:test`); no npm dependencies.
