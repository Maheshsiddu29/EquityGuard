# Invariants

## I-1 Core execution invariant

> A transaction constructed against economic state **S** must not execute
> successfully if the relevant protected economic state has changed to **S'**
> before execution.

Mechanism:

```
quote/check time:   read mint state S and activation phase P = phase(S, now_check)
transaction:        [ equity_guard::assert_safe_execution(expected = S, P, window), execution ixs... ]
execution time:     guard reads actual state A and Clock
                    A == S (protected fields, by bytes)
                    and, if a multiplier change is scheduled:
                        now outside [T - before, T + after] and phase(A, now) == P  → Ok
                    otherwise                                                        → Err
atomicity:          Err ⇒ no instruction in the transaction settles
```

"Economic state" includes the clock: Token-2022 switches from `multiplier` to
`new_multiplier` at `now >= T` without changing the account, so S is the stored
fields **plus** which of them is effective. See
[architecture](architecture.md#byte-state-vs-clock-state).

The guard must precede the execution instructions it protects. Ordering is the
composer's responsibility; the guard itself does not introspect the transaction
in the MVP.

## I-2 Fail closed

If the guard cannot establish that execution is safe — wrong account owner,
unparseable mint, missing ScaledUiAmount extension, malformed instruction data,
unsupported extension set — it returns an error. There is no "proceed anyway"
path.

Off-chain, `UNKNOWN` blocks execution.

## I-3 No floating-point equality in safety decisions

Protected multiplier values are compared by stored byte representation.
Float arithmetic is permitted only in display/valuation code, which must use an
explicit rounding/tolerance policy and never assume exact `ui → raw → ui`
round-trips.

## I-4 Guard has no side effects

The guard is read-only: it writes no accounts and transfers nothing. Adding it
to a transaction cannot change the outcome of a transaction that would
otherwise succeed with unchanged state, other than compute and size cost.

## I-5 Minimal overhead

The guard adds one instruction, one read-only account (the mint, usually already
present in the swap), and 34 bytes of instruction data. A `[guard, system
transfer]` transaction measures 2,800 compute units in LiteSVM, and the test
suite enforces a ceiling of 20,000.

## I-6 Honest environments

Data shown as LIVE MAINNET is real and read-only. Engineered transitions exist
only on devnet. See [demo-boundary.md](demo-boundary.md).

## I-7 No silent rerouting

Execution is never moved to a different issuer's representation without
explicit user policy and disclosure of issuers, reason, and cost/quote
difference.

## Test obligations

Each invariant maps to tests as components land (tracked in `AGENTS.md` §4).

| Invariant | Tests |
| --- | --- |
| I-1 | `guard.rs` (stored-field changes, window boundaries, phase crossing); `tests/litesvm_atomicity.rs` cases A–C on the compiled program |
| I-2 | `state.rs` (owner, truncation, malformed TLV, missing extension, extension combination, invalid multipliers); `instruction.rs` (version, length, expected state); LiteSVM case B |
| I-3 | `state.rs` byte identity; `guard.rs` identical UI amount but changed state, non-exact UI round-trip |
| I-4, I-5 | LiteSVM: mint bytes unchanged, compute ceiling |
