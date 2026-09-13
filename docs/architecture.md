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
| Guard program (`assert_safe_execution`) | `programs/equity_guard` | implemented; host + LiteSVM tested; not yet deployed |
| ScaledUiAmount decoding | `programs/equity_guard/src/state.rs`; extract to `crates/equity-state` only if off-chain Rust needs it | implemented |
| Raw evidence capture | `scripts/evidence/capture-equity-mints.mjs` | implemented |
| Devnet test-mint tooling | `scripts/devnet/` | planned |
| Mainnet watcher + xStocks adapter | `packages/watcher/` | planned |
| Jupiter composition | TBD with watcher/client code | planned |
| Rerouting | later | planned, gated on base guard |
| Demo UI | `apps/web/` | later |

Directories are created only when they contain real code.

## Guard program

Native Solana Rust program (no Anchor). Rationale in
[ADR 0001](adr/0001-minimal-execution-guard.md); clock semantics in
[ADR 0002](adr/0002-clock-aware-transition-protection.md).

| Module | Responsibility |
| --- | --- |
| `state.rs` | Token-2022 mint → `ProtectedState`; activation phase semantics |
| `instruction.rs` | ABI v1 encode/decode |
| `guard.rs` | pure decision: `(request, actual state, unix_timestamp) → Ok / error` |
| `processor.rs` | accounts, Clock syscall, logging |
| `error.rs` | stable error codes |

### Instruction: `assert_safe_execution` (ABI v1)

Accounts: exactly one — `[0]` the Token-2022 mint, passed read-only. Any other
count fails with `InvalidAccountCount`. The Clock is read with the sysvar
syscall, not passed as an account. The program does not reject a mint that is
writable at the transaction level, so it composes with transactions where
another instruction write-locks the mint.

Data: exactly 34 bytes, little-endian, trailing bytes rejected.

| Offset | Size | Field | Encoding |
| --- | --- | --- | --- |
| 0 | 1 | version | `1` |
| 1 | 8 | expected `multiplier` | stored `f64` bytes |
| 9 | 8 | expected `new_multiplier` | stored `f64` bytes |
| 17 | 8 | expected `new_multiplier_effective_timestamp` | `i64` |
| 25 | 1 | expected activation phase | `0` pending, `1` activated |
| 26 | 4 | `protection_before_secs` | `u32` |
| 30 | 4 | `protection_after_secs` | `u32` |

Empty data or another version → `UnsupportedInstruction`. Version 1 with the
wrong length → `InvalidInstructionLength`. A non-positive-normal expected
multiplier or unknown phase → `InvalidExpectedState`.

### Protected state

From the mint's `ScaledUiAmountConfig`:

- `multiplier` — stored 8 bytes
- `new_multiplier` — stored 8 bytes
- `new_multiplier_effective_timestamp` — `i64`

The multiplier `authority` is not protected: it carries no economic state, and
any change it makes lands in the fields above.

Decoding fails closed unless the account is owned by Token-2022, is an
initialized mint, its entire TLV extension area parses, it has ScaledUiAmount,
its extension set passes Token-2022's combination rules (so no
InterestBearingConfig), and both stored multipliers are positive and normal.
`-0.0`, `+0.0`, every NaN, infinities, negatives and subnormals are rejected.
Extension types unknown to `spl-token-2022-interface` 3.1.1 also fail closed.

### Byte state vs clock state

Token-2022's effective multiplier is

```
now <  new_multiplier_effective_timestamp  →  multiplier
now >= new_multiplier_effective_timestamp  →  new_multiplier
```

The account bytes do not change at activation. A mint can be **byte-identical**
immediately before and after `T` while its economic multiplier has changed.
Byte equality is therefore necessary but not sufficient, so the guard performs
two checks.

**A. Stored state** (always): each protected field must equal the expected
value by bytes, else `MultiplierChanged`, `NewMultiplierChanged`, or
`EffectiveTimestampChanged`.

**B. Clock** (only when `multiplier` and `new_multiplier` bytes differ, i.e.
crossing `T` changes the effective multiplier). With `now =
Clock::unix_timestamp`:

1. If `T - protection_before_secs <= now <= T + protection_after_secs` (both
   bounds **inclusive**) → `InsideTransitionWindow`. Bound overflow →
   `ArithmeticOverflow`.
2. If the phase at `now` differs from the expected phase →
   `ActivationPhaseChanged`.

The phase check makes the crossing guarantee independent of the window width:
a transaction built at `now < T` can never execute at `now >= T`, or the reverse.
The window is integrator policy (like a slippage tolerance), used to refuse
execution close to activation. The program hardcodes no window; issuer
reference values will live in issuer adapters.

When the multipliers are byte-identical, crossing `T` has no economic effect,
and the clock check is skipped.

### Transaction lifetime

The MVP assumes ordinary recent-blockhash transactions, whose lifetime is
bounded (about 150 slots). EquityGuard is **not** designed for durable-nonce
transactions that stay valid across a long corporate-action window. The phase
check still rejects such a transaction if it crosses activation, but the
threat model for long-lived signed transactions (e.g. a later issuer update
that happens to restore the expected bytes) has not been analysed, and they are
unsupported.

### Error codes

`ProgramError::Custom(code)`; codes are stable.

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `UnsupportedInstruction` | empty data or unknown version |
| 1 | `InvalidInstructionLength` | wrong data length for version |
| 2 | `InvalidExpectedState` | invalid expected multiplier or phase |
| 3 | `InvalidAccountCount` | not exactly one account |
| 4 | `InvalidMintOwner` | mint not owned by Token-2022 |
| 5 | `InvalidMintData` | not a valid initialized mint / malformed TLV |
| 6 | `MissingScaledUiAmount` | no ScaledUiAmount extension |
| 7 | `InvalidExtensionCombination` | forbidden extension set |
| 8 | `InvalidMultiplier` | stored multiplier not positive and normal |
| 9 | `MultiplierChanged` | stored `multiplier` differs |
| 10 | `NewMultiplierChanged` | stored `new_multiplier` differs |
| 11 | `EffectiveTimestampChanged` | stored timestamp differs |
| 12 | `ActivationPhaseChanged` | clock crossed activation vs. expectation |
| 13 | `InsideTransitionWindow` | execution inside protection window |
| 14 | `ArithmeticOverflow` | window bounds overflow |
| 15 | `ClockUnavailable` | Clock sysvar unreadable |

Failures log `EquityGuard rejected: <Name>`; success logs `EquityGuard: safe`.

### Effects and cost

None: the guard writes no accounts, performs no CPI, and moves no funds. In
LiteSVM, a `[guard, system transfer]` transaction consumes 2,800 compute units
in total. The program binary is about 30 KB.

### Proof of atomicity

`programs/equity_guard/tests/litesvm_atomicity.rs` loads the compiled `.so`
and sends `[assert_safe_execution, system transfer]` against the real UNHx mint
bytes captured from mainnet:

- safe state → transfer settles;
- changed multiplier, new multiplier, timestamp, wrong owner, extra account
  → the transaction fails with the specific error, and the transfer does not
  settle;
- identical mint bytes with the Clock moved → passes before the window, fails
  at the inclusive lower bound and at `T`, and fails after the window with
  `ActivationPhaseChanged`.

This proves execution-time protection composes atomically with a downstream
instruction. It does **not** yet prove composition with Jupiter.

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
- Validated with Agave CLI 4.2.2 (`cargo-build-sbf` 4.1.0, platform-tools
  v1.54, whose bundled rustc is 1.89.0). Host builds use the pinned 1.94.0.
- Solana crate versions are constrained to the set LiteSVM 0.16 resolves
  against (see workspace `Cargo.toml`).
- `cargo test --workspace --lib` runs host unit tests. LiteSVM tests need the
  compiled program: run `cargo build-sbf` first.
- Evidence script uses Node.js ≥ 22 built-ins only (global `fetch`,
  `node:test`); no npm dependencies.
