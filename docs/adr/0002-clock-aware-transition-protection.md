# ADR 0002: Clock-aware transition protection

- Status: accepted (approved with Milestone 2; exercised on devnet in Milestone 3)
- Date: 2026-09-13

## Context

Token-2022 ScaledUiAmount stores `multiplier`, `new_multiplier` and
`new_multiplier_effective_timestamp` (T). The effective multiplier is
`new_multiplier` when `now >= T`, and `multiplier` otherwise. The switch happens
without any write to the mint, so a byte-snapshot comparison cannot detect it.

Real mainnet xStocks mints keep differing `multiplier`/`new_multiplier` values
long after T has passed (e.g. KOx, CRMx), so "a change is scheduled" (bytes
differ) is not the same as "a change is imminent".

## Decision

1. The instruction carries the **activation phase** the client observed
   (`pending` = `now < T`, `activated` = `now >= T`). If a change is scheduled
   and the phase at execution differs, the guard fails
   (`ActivationPhaseChanged`). This makes crossing T impossible, whatever the
   window width or landing latency.
2. The instruction carries a **protection window** `before_secs` / `after_secs`.
   If a change is scheduled and `T - before <= now <= T + after` (inclusive),
   the guard fails (`InsideTransitionWindow`). The window is integrator
   policy, like a slippage tolerance. The program hardcodes no issuer value.
3. When `multiplier` and `new_multiplier` are byte-identical, crossing T is
   economically irrelevant, and both clock checks are skipped.
4. Window arithmetic uses checked `i64` operations; overflow fails closed.
5. Only recent-blockhash transactions are in scope; durable-nonce use is
   unsupported.

## Consequences

- One extra byte of instruction data (34 bytes total).
- Without a phase field, a window would only cover crossings if it were at
  least as long as the worst-case landing delay, which clock drift and slot
  timing make hard to bound in seconds. The phase field removes that
  dependency.
- Issuer reference windows (for example an xStocks-documented interval) must
  be sourced from issuer documentation and applied in the adapter. None is
  asserted here.

## Alternatives considered

- **Window only:** simpler, but correctness depends on the window exceeding
  transaction latency; rejected as the sole mechanism.
- **Expected effective multiplier instead of phase:** equivalent information,
  8 bytes instead of 1, and it duplicates a field already in the snapshot.
- **Hardcoded window constant:** encodes one issuer's policy into a shared
  program; rejected.
