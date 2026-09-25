# StateGuard

**Transactions bound to the state you authorized.**

StateGuard protects tokenized-asset transactions when the asset's economic state changes between authorization and execution.

A transaction can be valid when a user signs it and still become stale before it lands. A stock split, reverse split, rebase, or similar update can change the state the user originally saw.

StateGuard binds the expected economic state to the protected transaction and checks that state again before the downstream action runs.

If the state still matches, execution continues.

If the state changed, StateGuard stops the transaction before the protected action executes. The user can review the new state and authorize again.

StateGuard is designed for wallets, trading applications, aggregators, agents, venues, and DeFi protocols.

**Underlying protocol:** EquityGuard Protocol

```text
ONE SOLANA TRANSACTION
     │
     ├── instruction 0: EquityGuard Protocol assert_safe_execution
     │     ├─ reads the token state from chain
     │     ├─ checks the expected multiplier and activation phase
     │     └─ checks the protected downstream instruction
     │
     └── next instruction: protected action
           └─ executes only if instruction 0 succeeds
```

---

## What StateGuard protects

The problem is not an invalid signature.

The problem is that a valid authorization can become economically stale.

Example:

```text
User sees multiplier: 1.00x
        ↓
User authorizes the action
        ↓
Corporate action activates
        ↓
Current multiplier: 0.50x
        ↓
Old authorization reaches execution
        ↓
StateGuard detects the mismatch
        ↓
BLOCKED
```

The user then sees the updated state and decides whether to authorize again.

---

## Public demo

The public demo has two modes.

### Recorded proof

The recorded proof uses captured tokenized-stock state and the local execution replay.

It shows:

- real tokenized-stock observations from Solana mainnet;
- stale and refreshed authorization decisions;
- a protected Jupiter transaction composition;
- local Jupiter v6 and Orca Whirlpool execution using mainnet-derived state.

This is not a mainnet StateGuard transaction.

### Live Devnet

The Live Devnet demo uses a real Phantom wallet and the deployed EquityGuard Protocol program on Solana Devnet.

Program:

`EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT`

Reviewed SBF SHA-256:

`d7d59ccd9e96bb3eb3e16893aca638d8e5fdbfaf5032b4b39737ef16a41e4e46`

The demo creates a fresh Token-2022 asset for the session and schedules a simulated corporate action.

The flow is:

```text
Prepare demo asset
        ↓
Authorize the current state
        ↓
Corporate action activates
        ↓
StateGuard rejects the stale authorization
        ↓
ActivationPhaseChanged
        ↓
Downstream action blocked
        ↓
0 token movement
        ↓
Review updated state
        ↓
Authorize again
        ↓
StateGuard PASSED
        ↓
Token-2022 TransferChecked executes
```

The demo assets are not real securities, have no market value, and are not affiliated with the companies used in the scenario names.

The Live Devnet demo does not execute Jupiter or Whirlpool. Those are demonstrated separately in the recorded/local proof.

---

## Why the demo waits

The Devnet demo compresses a corporate-action lifecycle into a short window so the state change can be seen during a live walkthrough.

The current demo schedules the corporate action about 35 seconds after setup starts.

That 35-second delay is **only for the demo**. It is not a StateGuard protocol rule.

The Authorize button opens close to the activation point so the signed Solana transaction is not held for too long. When Authorize becomes available, approve it promptly.

The important rule is not the timer:

> **The state at execution must still match the state that was authorized.**

---

## How this would work on mainnet

There would be no artificial 35-second countdown.

A normal execution would look like this:

```text
Read current economic state
        ↓
Build authorization for that state
        ↓
User signs
        ↓
Submit normally
        ↓
StateGuard checks the state again on-chain
        ↓
same state? ── yes ──> protected action executes
     │
     no
     ↓
reject stale authorization
```

If a split or another economic-state change happens between signing and execution, StateGuard rejects the old authorization.

If nothing changed, the transaction continues normally.

The current EquityGuard Protocol deployment is on Devnet only. There is no mainnet deployment in this release.

---

## Status & proof stack

StateGuard has four proof layers.

### 1. Real mainnet data

- **19,986** tokenized-stock state observations captured read-only from Solana mainnet.
- **294,527** authorization-to-execution pairs evaluated.
- **7,029** economically stale pairs detected.
- All **7,029** stale pairs were blocked by the guard model.
- **0** unexpected ALLOWs and **0** unexpected BLOCKs.

No StateGuard transaction was sent on mainnet.

### 2. Guard-model replay

The guard model replays captured state and evaluates:

- SAFE
- BLOCK
- REFRESH

It also checks protection boundaries around corporate-action transitions.

This is model evaluation, not an executed transaction crossing the event.

### 3. Local execution replay

The local execution replay uses `solana-test-validator` with real Jupiter v6 and Orca Whirlpool program binaries plus mainnet-derived state.

It demonstrates:

- a valid guarded KOx trade;
- stale-state rejection before Jupiter executes;
- route-commitment rejection before the downstream swap executes.

This is local execution, not mainnet execution and not Devnet Jupiter.

### 4. Live Devnet wallet proof

The public Live Devnet flow uses:

- a real Phantom browser wallet;
- the deployed EquityGuard Protocol program;
- a fresh per-session Token-2022 demo mint;
- a scheduled economic-state change;
- stale authorization rejection;
- zero downstream movement;
- fresh authorization;
- successful `TransferChecked` execution.

The UI exposes Solana Explorer links for the live transactions.

---

## Real mainnet observations

We observed real tokenized-stock state transitions on Solana mainnet across xStocks and Ondo representations.

Examples include KOx, UNHx, CRMx, KOon, UNHon, and CRMon.

Important observations:

- **KOx:** a future multiplier and activation timestamp were stored in advance.
- When the Solana Clock crossed the effective timestamp, the economic phase changed.
- The relevant account bytes did not need to change at that exact moment.
- Watching only for account-byte changes is therefore not enough for a clock-driven activation.

---

## Integrating with Jupiter

Applications that build Jupiter Swap V2 swaps can add the EquityGuard Protocol before signing.

```ts
import { protectJupiterSwap } from "@equityguard/jupiter/protect";

const guarded = await protectJupiterSwap({
  build,
  userPublicKey: wallet.publicKey,
  rpc,
  protectionWindow: { beforeSecs: 900, afterSecs: 300 },
});

if (guarded.status === "PROTECTED") {
  await wallet.signAndSendTransaction(guarded.transaction);
}
```

### Integration outcomes

| `status` | Meaning |
| --- | --- |
| `PROTECTED` | The route is supported and the guarded transaction can be signed and sent |
| `NOT_APPLICABLE` | The asset is outside the protected tokenized-equity set |
| `UNSUPPORTED_PROTECTED_ASSET` | The asset should be protected, but its state cannot be safely established |
| `UNSUPPORTED_PROTECTED_ROUTE` | The asset is protected, but the route cannot be represented safely |
| `ERROR` | Input, state, or deployment verification failed |

StateGuard fails closed for protected assets.

A failure to understand the protected state is never treated as permission to send an unprotected transaction.

---

## Why Solana

The protocol uses Solana-native features directly:

- **Token-2022 `ScaledUiAmount`:** stores multiplier state on the token mint.
- **Solana Clock:** provides the on-chain time used for scheduled state activation.
- **Instructions Sysvar:** lets the guard inspect and bind the protected downstream instruction.
- **Atomic instruction ordering:** if the guard fails, later instructions in the same transaction do not execute.

---

## Validation

Release-candidate validation includes:

| Metric | Value | Context |
| --- | --- | --- |
| Mainnet observations | **19,986** | 6 representations, 3,331 polls |
| Authorization pairs | **294,527** | authorization-to-execution comparisons |
| Economically stale pairs | **7,029** | all blocked by the guard model |
| Differential cases | **1,000,000** | seeded TypeScript/Rust cases, 0 disagreements |
| Guard transaction size | **675–918 B** | +176 B vs unguarded Jupiter build |
| Compute units | **10.7k–15.5k CU** | guard overhead for Jupiter adapter kinds 2 and 3 |

The repository CI also checks Rust, SBF, TypeScript, the standalone web application, linting, tests, and the production web build.

---

## Future work

### Agent and automated execution

StateGuard can also protect automated and agent-driven trading.

For longer-lived workflows, the clean design is to separate:

```text
state-bound user authorization
        from
short-lived Solana transaction
```

A user could authorize an action against a specific economic state.

Later, when an agent is ready to execute, it can build a fresh Solana transaction. StateGuard would still check that the current economic state matches what the user authorized.

If the state changed, the agent would not silently continue. It would need fresh authorization.

This avoids forcing a user or agent to hold one short-lived Solana transaction for a long period.

### Broader state models

The current release protects scalar multiplier changes such as stock splits and reverse splits.

Future versions can extend the same idea to more complex events such as mergers, spinoffs, redemptions, and other changes that affect what the user is actually authorizing.

---

## Known limitations

This is a **hackathon release candidate / reviewed prototype**.

1. **No mainnet deployment.** The EquityGuard Protocol is deployed on Solana Devnet only.
2. **Live Devnet uses `TransferChecked`.** Jupiter and Whirlpool are shown in the recorded/local proof, not in the public Devnet execution path.
3. **Strict Jupiter support.** The current adapter supports a limited Jupiter v6 route shape and fails closed when the protected route cannot be represented safely.
4. **Protection windows are policy inputs.** They are configured by the integrator and are not calibrated production defaults.
5. **Scalar state model.** The current model protects Token-2022 `ScaledUiAmount` multiplier state.
6. **No external security audit.** The codebase has undergone internal review, but not an independent external audit.
7. **Upgradeable Devnet program.** The reviewed Devnet deployment still has an upgrade authority.
8. **Unpublished packages.** The workspace packages are not published packages yet.

---

## Repository layout

```text
programs/equity_guard/           on-chain guard program
packages/guard-client/           TypeScript instruction builder
packages/jupiter/                Jupiter transaction composition
packages/representation-state/   representation registry and state logic
scripts/observation/             read-only state capture and event detection
scripts/devnet/                  Devnet scenarios and deployment records
scripts/evidence/                evidence capture tools
apps/reference/                  recorded-evidence reference application
apps/devnet-wallet-demo/         Phantom/Devnet proof harness
apps/web/                        public StateGuard site and demo
apps/example-jupiter-protected/  minimal Jupiter integration example
```

---

## Development and verification

Root checks:

```sh
npm ci
npm run typecheck
npm test
```

Web checks:

```sh
cd apps/web
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Rust and SBF checks are run in CI, including formatting, clippy, tests, deployment checks, dependency audit, and the SBF build.
