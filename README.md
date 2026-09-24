# StateGuard

**StateGuard is an economic-intent protection layer for tokenized assets.**

A transaction authorized under one tokenized-stock economic state must not silently execute under another.

A trade can be prepared under one economic state and land after that state has changed. StateGuard binds the expected state to the transaction and checks it atomically before the protected action executes.

Integrators are venues, wallets, aggregators, trading applications, agents, and DeFi protocols. StateGuard is not primarily a retail product.

Underlying protocol: EquityGuard Protocol

```
ONE SOLANA TRANSACTION
     │
     ├── instruction 0: EquityGuard Protocol assert_safe_execution
     │     ├─ reads mint state directly from chain account
     │     ├─ checks clock phase & expected multiplier bytes
     │     └─ validates downstream instruction commitment
     │
     └── next instruction: Protected Action / Jupiter Swap
           └─ executes ONLY if instruction 0 succeeds
```

---

## Status & Proof Stack

StateGuard has four distinct proof layers:

### 1. Real Mainnet Data
- **19,986** real tokenized-stock state observations captured read-only from Solana mainnet.
- **294,527** authorization-to-execution pairs evaluated.
- **7,029** economically stale pairs detected and **all 7,029** blocked by the guard model.
- **0** unexpected ALLOWs, **0** unexpected BLOCKs.
- *No StateGuard transaction was sent on mainnet. The EquityGuard Protocol has no mainnet deployment.*

### 2. Guard-Model Replay
- Demonstrates **SAFE / BLOCK / REFRESH** state evaluations using real captured mainnet state.
- Illustrates zero-window protection boundaries around corporate-action transitions.
- *Evaluated by the guard model; not an executed transaction crossing the event.*

### 3. Local Execution Replay
- Ran on local `solana-test-validator` loaded with real **Jupiter v6** and **Orca Whirlpool** program binaries and mainnet-derived state.
- Executed valid guarded KOx trade (USDC → KOx).
- Stale-state expectation and mutated swap route were rejected at instruction 0 before Jupiter ran.
- *NOT mainnet execution. NOT devnet Jupiter. NOT a real purchase.*

### 4. Live Devnet Wallet Proof
- Signed by real **Phantom browser wallet** (`2jMicXzM68ecXLvWDikT92cLaKMQA8mePrQ9T6hPp6b5`), distinct from the deployment authority keypair (`JArGaWxrddR7J1XYjsoEU5XCuHffra3gASBjfVK4BuNT`).
- Program deployed on devnet: [`EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT`](https://explorer.solana.com/address/EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT?cluster=devnet) (SBF SHA-256 `d7d59ccd…a41e4e46`).
- Fresh Token-2022 demo mint (`GtSMAJiKyu1cEoD8UshqFGGAK78nHYCb2gYJzKbHB8Ar`).
- **SAFE:** [`3uExQAQZ…vGDNH`](https://explorer.solana.com/tx/3uExQAQZvMaTfcQzomSX5b1vumZhqfYJHEKMhh49BEynBicbH8qcKe999LbYndmAYNwWxEQoJirDy2kA34vGDNH?cluster=devnet) · Slot 500612756 · Source -0.10 · Destination +0.10 (Confirmed on-chain).
- **BLOCK:** [`bTX3qQEy…tpvw`](https://explorer.solana.com/tx/bTX3qQEytQQvryTKRD3UZcmAHWkZmFp5ToaDy29LMxGZff81TkTX4GkYi22ZA3DMn7aSGHAfHhGCeYiAUi7tpvw?cluster=devnet) · Refused at Instruction 0 with `0x9` (`MultiplierChanged`) · 0 tokens transferred (No tokens transferred; a network fee may still have been charged).
- **REFRESH:** [`4TZnvpKk…AqhVy`](https://explorer.solana.com/tx/4TZnvpKkdNkba69o74R1BBWrGgGvPX7jjRYEkM8n7AT9ZrbHjzfrftQMoqWorxRi9FMoVXJ7mvgdH8DiTV7AqhVy?cluster=devnet) · Slot 500612820 · Source -0.10 · Destination +0.10 (Confirmed on-chain).
- *Fresh devnet demo token — not a security. No Jupiter execution on devnet.*

---

## Real Mainnet Observations

We observed real tokenized-stock state transitions on Solana mainnet across xStocks (xStocks KOx, UNHx, CRMx) and Ondo (Ondo KOon, UNHon, CRMon):

- **KOx (xStocks):** Showed a scheduled economic-state activation. The new multiplier was stored in advance (`pending`), and became active when the Solana Clock passed the effective timestamp `T` (2026-09-15 00:30:00 UTC).
- **KOon (Ondo):** Showed an immediate-style state update written already active around the same corporate-action period.
- **Timestamp Divergence:** Their stored effective timestamps differed by **25 min 56 sec**.
- **Clock-Driven Activation:** The account bytes carrying `multiplier`, `newMultiplier`, and `T` were unchanged across the adjacent KOx activation observations. The effective phase changed because the Solana Clock crossed `T`. *Watching only for account-byte changes is insufficient for a Clock-driven activation.*

---

## Integrating with Jupiter

Applications that build Jupiter Swap V2 swaps add the EquityGuard Protocol using the integration surface:

```ts
import { protectJupiterSwap } from "@equityguard/jupiter/protect";

const guarded = await protectJupiterSwap({
  build,                                                 // your Jupiter /build response
  userPublicKey: wallet.publicKey,
  rpc,                                                   // any Solana RPC, read-only
  protectionWindow: { beforeSecs: 900, afterSecs: 300 }, // your policy, not ours
});

if (guarded.status === "PROTECTED") await wallet.signAndSendTransaction(guarded.transaction);
```

### Typed Integration Outcomes

| `status` | Meaning |
| --- | --- |
| `PROTECTED` | Supported protected route, built against a guard deployment that can execute on this cluster; sign and send `transaction` |
| `NOT_APPLICABLE` | The asset was read and is positively outside the EquityGuard Protocol's protected universe; continue your existing path |
| `UNSUPPORTED_PROTECTED_ASSET` | A known tokenized equity whose protection semantics cannot be established; fail closed |
| `UNSUPPORTED_PROTECTED_ROUTE` | Protected asset on a route the EquityGuard Protocol cannot represent; fail closed |
| `ERROR` | Malformed input, unreadable state, state that moved, or no usable guard deployment; fail closed |

- **`unsupported` is never `unprotected`.** No refusal carries a transaction; sending the plain Jupiter transaction instead would defeat the product.
- **`NOT_APPLICABLE` never means "the state could not be decoded".** Unknown protection semantics never become permission.
- **Deployment Verification:** Resolves cluster from RPC genesis hash and verifies the 63,840-byte reviewed ELF binary (SHA-256 `d7d59ccd…a41e4e46`).

---

## Why Solana

The EquityGuard Protocol relies fundamentally on Solana-native primitives:
- **Token-2022 Extensions:** `ScaledUiAmount` multiplier state stored directly on token mint accounts.
- **Solana Clock:** Enables deterministic, on-chain evaluation of scheduled economic-state activations.
- **Instructions Sysvar:** Enables instruction 0 to introspect the transaction and cryptographically bind the guard to the exact downstream swap.
- **Atomic Instruction Ordering:** Guarantees that if instruction 0 fails, all downstream state changes in the same transaction roll back automatically.

---

## Validation Metrics

Verified empirical metrics from the release candidate:

| Metric | Value | Context |
| --- | --- | --- |
| Mainnet Observations | **19,986** | 6 representations, 3,331 polls (2026-09-13 to 2026-09-15) |
| Authorization Pairs | **294,527** | Authorization-to-execution comparisons evaluated |
| Economically Stale Pairs | **7,029** | All 7,029 stale pairs blocked (0 unexpected ALLOWs / BLOCKs) |
| Differential Cases | **1,000,000** | 1,000,000 seeded TypeScript/Rust differential cases · 0 disagreements |
| Guard Transaction Size | **675–918 B** | +176 B vs unguarded Jupiter build; 314 B minimum headroom |
| Compute Units | **10.7k–15.5k CU** | Guard CU overhead for Jupiter adapter kinds 2 & 3 |

---

## Known Limitations

This release is a **hackathon release candidate / reviewed prototype**:

1. **No Mainnet Deployment:** The EquityGuard Protocol is deployed on Solana devnet only (`EbzHfaoS…NnhT`). No mainnet deployment exists.
2. **Strict Supported Jupiter Subset:** Supports only Jupiter v6 `route_v2`, `ExactIn`, canonical USDC ↔ protected mint, BUY and SELL, guard at instruction 0. Any route-shape drift fails closed.
3. **Uncalibrated Protection Windows:** Pre/post transition windows are policy inputs configured by the integrator; they are uncalibrated demo values.
4. **Scalar State Model:** Protects Token-2022 `ScaledUiAmount` scalar multiplier state. Structural corporate actions (mergers, spinoffs, redemptions) are not represented by the current scalar model.
5. **No External Security Audit:** The codebase has undergone internal security reviews, but no external security audit has been performed.
6. **Upgrade-Authority TOCTOU (R-01):** The reviewed devnet program keeps an upgrade authority (`JArGaWxr…BuNT`), so an upgrade between build-time verification and transaction landing is not prevented.
7. **Unpublished Packages:** Workspace packages (`@equityguard/guard-client`, `@equityguard/jupiter`, `@equityguard/representation-state`) are private 0.1.0 packages and not yet published.

---

## Repository Layout

```
programs/equity_guard/           on-chain guard program (native Rust)
packages/guard-client/           TypeScript instruction builder used by clients
packages/jupiter/                Jupiter /build client and guarded transaction composition
packages/representation-state/   representation registry, state, normalization, decisions
scripts/observation/             read-only capture decoding and event detection
scripts/devnet/                  devnet test mints, scenarios, deployment record
scripts/evidence/                raw mainnet evidence capture (output is local, gitignored)
apps/reference/                  reference integration UI over recorded evidence
apps/devnet-wallet-demo/         live Phantom browser wallet proof on devnet
apps/example-jupiter-protected/  minimal before/after Jupiter integration example
```

---

## Development & Verification

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build-sbf --manifest-path programs/equity_guard/Cargo.toml -- --locked
cargo test --workspace --locked        # unit, golden, deployment-ID, LiteSVM
npm ci && npm run typecheck && npm test # 542 JS unit tests
npm run app:build                       # reference app static build
npm run wallet-demo:build               # devnet wallet demo static build
```
