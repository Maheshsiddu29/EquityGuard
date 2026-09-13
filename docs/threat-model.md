# Threat model

Scope: the execution-time guard and the client flow that composes it. Updated
as components land.

## Assets protected

The user's expectation that a trade executes against the corporate-action
state (multiplier, pending multiplier, activation time, issuer status) they
were quoted against.

## Actors

- **User / integrator** builds and signs the transaction.
- **Issuer** (xStocks, Ondo) controls mint authorities and can update
  multipliers, schedule activations, or pause.
- **Validators / MEV searchers** control inclusion timing and ordering.
- **RPC provider** supplies check-time state; may be stale or wrong.
- **AMM / liquidity venues** price the trade.

## Threats and mitigations

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | State changes between quote and landing (multiplier update, new pending multiplier, timestamp change) | Guard compares expected vs actual at execution; atomic failure |
| T2 | Scheduled activation passes while tx is in flight (mint bytes unchanged) | Guard reads `Clock` at execution; rejects inside the inclusive protection window and whenever the activation phase differs from the one the client observed |
| T3 | Stale or malicious RPC gives wrong check-time state | Guard reads the real account at execution; a wrong expectation fails rather than silently passing |
| T4 | Attacker passes a fake mint account with matching bytes | Guard requires the account owner to be the Token-2022 program; composer binds the guard's mint to the mint used by the swap |
| T5 | Guard placed after, or omitted from, the swap | Composer responsibility; tests assert instruction ordering. Guard does not introspect the transaction in MVP (documented limitation) |
| T6 | Malformed instruction data or unexpected extensions | Fail closed with explicit errors |
| T7 | Float representation ambiguity (`-0.0`, NaN, rounding) | Byte-level comparison on-chain; multipliers that are not positive and normal are rejected both in the mint and in the expected state; tolerance policy only in display code |
| T8 | Issuer pause not reflected on-chain in the same form across issuers | Per-issuer adapters; Ondo compares API vs on-chain and fails closed on mismatch |
| T9 | Silent cross-issuer reroute exposes user to different issuer risk | Explicit consent + disclosure required (I-7) |
| T10 | Demo presents simulated data as live | Hard separation of LIVE MAINNET and DEVNET panes (I-6) |
| T11 | Client sets a zero or tiny protection window | The phase check still rejects any crossing of activation; the window only adds a refusal margin, and choosing it is integrator policy |
| T12 | Long-lived (durable-nonce) transaction executes much later against state that changed and changed back | Unsupported in MVP; recent-blockhash lifetime bounds exposure. Not analysed beyond that |

## Known limitations

- The guard does not verify that the swap instructions actually trade the
  guarded mint. Binding is enforced by the composer and its tests.
- A transaction that lands before the issuer's update lands executes against
  the old state. That is correct behaviour: the state the user agreed to was
  still true at execution.
- The guard does not inspect the Pausable extension. Token-2022 itself blocks
  transfers of a paused mint, so a downstream swap fails regardless, but the
  guard does not report a pause as its own error.
- The guard does not require the mint to be read-only at the transaction
  level, so it can compose with transactions where another instruction write-locks it.
- Extension types newer than `spl-token-2022-interface` 3.1.1 make decoding
  fail closed until the dependency is updated.
- Issuer off-chain corporate-action announcements not yet reflected on-chain are
  not visible to the guard. Adapters may block at check time (`TRANSITION`,
  `UNKNOWN`).

## Out of scope: market risk

EquityGuard protects the **discrete corporate-action state transition**. It does
not guarantee that an AMM pool has repriced to fair value after a transition.
After the issuer-recommended or state-derived protection interval:

- normal execution-price controls apply;
- Jupiter min-out / slippage applies;
- price impact is ordinary market risk.

Pool-staleness and fair-value detection are roadmap items.
