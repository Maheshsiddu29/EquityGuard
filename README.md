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

EquityGuard executes on Solana devnet and atomically prevents later
instructions from settling when protected ScaledUiAmount state is stale or
transitioning. Devnet program:
[`EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT`](https://explorer.solana.com/address/EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT?cluster=devnet).
The evidence uses devnet **test mints** (EQ-A, EQ-B; not issuer assets) and a
system transfer as the downstream instruction. Each transaction below was sent
as `[assert_safe_execution, system transfer]`:

| # | Scenario | Result | Devnet transaction |
| --- | --- | --- | --- |
| 1 | Safe: fresh snapshot (EQ-B) | succeeds; transfer settles | [`5RNgyfWj…TVuERX`](https://explorer.solana.com/tx/5RNgyfWjDmQYLwQtZr8jsHKLfqth1UewmNjrSsjuhZB4m3sxgf9kKBjvzfG3zugW1sdSCwspAwrXVdied3TVuERX?cluster=devnet) |
| 2 | Stale snapshot after multiplier changed (EQ-A) | fails `MultiplierChanged`; transfer does not settle | [`3NMHpzCc…6bKngJ`](https://explorer.solana.com/tx/3NMHpzCc1X5pFrebj5PR8aJiEV2q35xcGncqtaiGpRJqfNYhrpoJLEMq3nYVXi3XizttoBwG6X2VNJnwxE6bKngJ?cluster=devnet) |
| 3 | Fresh snapshot recovery (EQ-A) | succeeds; transfer settles | [`46WaWA5q…BviaJDJ`](https://explorer.solana.com/tx/46WaWA5qC42p4vwhg1qYNzFpMqsPu1J3UYDTy1PaX6MckwwB5jTzzmzzW4mfZhjkrUQSSWgCoXfNcD99QBviaJDJ?cluster=devnet) |
| 4 | Pending phase, before transition window (EQ-A) | succeeds; transfer settles | [`2NSvgdfc…iYd7Mbz`](https://explorer.solana.com/tx/2NSvgdfcDoiB28wjyY5aRm95orn3zuR5npu4x53RU6zRCPbN9Zs1Uh94Bi38yYnDSVPkeLcqwu51qBqANiYd7Mbz?cluster=devnet) |
| 5 | Same payload, same mint bytes, clock inside transition window | fails `InsideTransitionWindow`; transfer does not settle | [`2LYSTjXg…v9bMsHm8`](https://explorer.solana.com/tx/2LYSTjXgzrMgCDapr7LQEuc2j5hpkxHq2BWHT82nzX4LbfzF3SjgunyaySf8y7A6GwWKDAtRdrqkCgpMv9bMsHm8?cluster=devnet) |
| 6 | Same payload after the window (activation passed) | fails `ActivationPhaseChanged`; transfer does not settle | [`2z7xv8VJ…PGrPX6`](https://explorer.solana.com/tx/2z7xv8VJnXu75cK512qSLVQMc6DYMxVugqLD5bvubeSTNknUgeo7z9C1K2QiDAdajKKPS42E95hcrAJQZkPGrPX6?cluster=devnet) |
| 7 | Fresh activated snapshot (EQ-A) | succeeds; transfer settles | [`hySXRPu5…J3HA5`](https://explorer.solana.com/tx/hySXRPu5ennbRT2fyZsKWoZX1aR8Xue9BdYxpdMSWAYuhE5kgeNPqmqK6iB2pHHJGdBPwiBjroyTMPGWKYJ3HA5?cluster=devnet) |

EquityGuard has been composed into a real Jupiter Swap V2 mainnet transaction
build for a real xStock. The composition was build-only: a USDC → KOx `/build`
route, with a guard instruction encoded from KOx's live mainnet ScaledUiAmount
state, compiled into one v0 transaction using Jupiter's lookup table. The
original (ABI v1) guarded transaction was 577 bytes; with the ABI v2 Jupiter
adapter (below), fresh KOx BUY and UNHx BUY/SELL builds (2026-09-17) compile to
675 bytes against the 1232-byte limit. Nothing was signed or submitted, and
EquityGuard is not deployed on mainnet, so the guard has not executed alongside
a Jupiter swap.

**Deployed on devnet (upgrade
[`5Vb8aaU4…vQ1jXmb`](https://explorer.solana.com/tx/5Vb8aaU47wz2bK8iA5yvAyYFEGQbWPy5vzVTo46kZi6VJb22gman2KaRyEBLpcgkkiQSvJSYkg6nSHZZvvQ1jXmb?cluster=devnet),
SBF SHA-256 `d7d59ccd…a41e4e46`, verified against the ProgramData bytes):**
ABI v2 adapter kinds 2 and 3 guard a whole Jupiter `route_v2` transaction
(`guard, price, limit, [destination ATA], route_v2`). Adapter kinds 2 and 3
support only USDC ↔ protected-equity `route_v2` trades. The program checks
the transaction grammar and the trade's semantics itself; the suffix
commitment is not treated as semantic validation.

Jupiter's program is not executable on devnet, so any transaction invoking it
is rejected at load time, before the guard runs. Devnet therefore shows the
kind 2/3 rejections that precede the trade-program check (e.g.
`GuardNotFirst`
[`3jLywJan…E471aKBL`](https://explorer.solana.com/tx/3jLywJan1CiSARDrHi6WKaRrBxDEi1Sadhnms9XTg57HFhbinKY2qfx8CTgG2qKAQ145C8uCBecF3xqdE471aKBL?cluster=devnet),
which also rolls back a token transfer placed before the guard). It cannot
show a guarded Jupiter trade.

### Claim boundary

Proven:

- real mainnet KOx (`XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ`) Token-2022
  ScaledUiAmount state, read at one slot together with the chain Clock;
- a real Jupiter Swap V2 `/build` route for USDC → KOx (single Orca Whirlpool
  hop, recorded 2026-09-14);
- real v0 composition of that route with an EquityGuard instruction encoded
  from the KOx state, using Jupiter's address lookup table: 577 bytes guarded
  vs 507 bytes baseline (+70 bytes, +1 static account, +1 instruction); no
  `maxAccounts` reduction was needed;
- guard execution and atomic rollback on **devnet** (table above), re-run
  against the upgraded binary with adapter kind 1;
- adapter kind 2/3 grammar rejections on **devnet** that precede the
  trade-program check, matching the client model.

Not proven:

- EquityGuard execution on mainnet (the program is deployed on devnet only);
- guard + Jupiter atomicity on mainnet;
- a guarded Jupiter trade on any cluster, and the kind 2/3 checks after the
  trade-program check on a live cluster: these are verified only in LiteSVM,
  where a stand-in occupies the Jupiter address and no trade executes;
- protection of live xStocks trades, or any real purchase;
- automatic cross-issuer rerouting (the decision engine decides; nothing
  executes the alternative), live protection in a UI (the reference app
  renders recorded evidence only), or calibrated issuer transition policies.

### Off-chain representation state

Implemented without any execution path:

- a canonical registry of KO, UNH and CRM representations (xStocks KOx, UNHx,
  CRMx; Ondo KOon, UNHon, CRMon). These are representations associated with
  the same underlying equity, not fungible or legally identical instruments;
- state resolution to SAFE, TRANSITION, PAUSED or UNKNOWN, with state source
  `chain`, `api`, `both-agree` or `conflict`. xStocks is chain-primary. Ondo
  chain and API evidence are observed independently, and disagreement is kept
  as a conflict. There is no live Ondo API client yet, and issuer transition
  policies are uncalibrated;
- read-only capture decoding and change detection that only analyse copies
  of captures and never write to the input;
- exact share-equivalent normalization (`outAmountRaw × multiplier /
  10^decimals` in bigint rationals) with a switching cost that is never
  understated;
- a pure decision engine returning `USE_PREFERRED`, `REQUIRES_CONSENT`,
  `USE_ALTERNATIVE`, `NO_SAFE_ROUTE` or `UNKNOWN_STATE`, with a disclosure
  for any cross-issuer outcome.

| Component | Status |
| --- | --- |
| `programs/equity_guard` — `assert_safe_execution` | ABI v2 deployed on devnet with adapter kinds 1 (committed Token-2022 `TransferChecked`) and 2/3 (USDC ↔ protected-equity Jupiter `route_v2`; positive path LiteSVM-only, since devnet has no Jupiter) |
| Token-2022 ScaledUiAmount decoding | implemented in Rust and TypeScript; cross-checked on golden vectors and real mainnet mint bytes |
| `packages/guard-client` | TypeScript builders for ABI v2 guards: kind 1 `TransferChecked`, kinds 2/3 Jupiter `route_v2` (grammar mirror, suffix commitment) |
| `scripts/devnet/` | devnet test mints EQ-A/EQ-B, scenario runner, evidence |
| `packages/jupiter` | Jupiter Swap V2 `/build` client and guard-first v0 composition for adapter kinds 2/3 (build-only; unsupported builds are refused) |
| `scripts/evidence/capture-equity-mints.mjs` | raw mainnet mint recorder, verified watchlist |
| `packages/representation-state` | registry, issuer state adapters, capture decoding, normalization, decision engine (no execution) |
| `scripts/observation/` | read-only decoding and event detection over capture copies |
| `apps/reference` | reference integration UI over recorded evidence (no signing, no network) |
| Executed rerouting | later |

## Integrating with Jupiter

Applications that already build Jupiter Swap V2 swaps add EquityGuard with one
import, one call, and a decision on the typed result:

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

The SDK derives the protected mint, adapter kind, economic state, activation
phase, guard deployment and downstream commitment itself: an integrator never
encodes multiplier bytes, phases, timestamps or `route_v2` account grammar.

Every other status is a refusal, and `NOT_APPLICABLE` is the only one that
means "carry on as before":

| `status` | Meaning |
| --- | --- |
| `PROTECTED` | Supported protected route, built against a guard deployment that can execute on this cluster; sign and send `transaction` |
| `NOT_APPLICABLE` | The asset was read and is positively outside EquityGuard's protected universe; continue your existing path |
| `UNSUPPORTED_PROTECTED_ASSET` | A known tokenized equity whose protection semantics cannot be established; fail closed |
| `UNSUPPORTED_PROTECTED_ROUTE` | Protected asset on a route EquityGuard cannot represent; fail closed |
| `ERROR` | Malformed input, unreadable state, state that moved, or no usable guard deployment; fail closed |

**`unsupported` is never `unprotected`.** No refusal carries a transaction, and
sending the plain Jupiter transaction instead would defeat the product.

**`NOT_APPLICABLE` never means "the state could not be decoded".** EquityGuard
protects one economic-state model — a Token-2022 ScaledUiAmount multiplier with
its scheduled activation — and a mint that presents it is protected on its own
merits. A small registry of the six mainnet representations this repository
holds decoded evidence for (xStocks KOx, UNHx, CRMx; Ondo KOon, UNHon, CRMon)
exists for the opposite case: if one of those stops presenting a supported
state model, or cannot be read, it fails closed instead of being mistaken for
an ordinary token. Unknown protection semantics never become permission.

**`PROTECTED` is bound to a real deployment.** EquityGuard resolves the cluster
from the RPC's genesis hash and reads the program account back: the guard
program must exist and be executable there. There is one deployment, on devnet
(`EbzHfaoS…VeEtNnhT`). **No mainnet deployment is claimed or implied**: a
mainnet or unknown-cluster build with no explicit `programAddress` fails closed
with `GUARD_DEPLOYMENT_UNAVAILABLE` or `UNSUPPORTED_CLUSTER` rather than
silently reusing the devnet address. Supplying `programAddress` yourself is
honoured on any cluster — trusting that deployment is your decision — but it is
still read back and must be an executable program.

`supportsJupiterSwap({ build, rpc })` answers the cheaper question: which side
is protected and which adapter would cover it. It proves structure only. It
does not read the Clock, evaluate the protection window, resolve a deployment,
validate the route grammar or build anything, so a `STRUCTURALLY_SUPPORTED`
answer can still end as a refusal from `protectJupiterSwap` — the only function
whose result may be signed.

Supported today: Jupiter v6 `route_v2`, `ExactIn`, canonical USDC against one
protected Token-2022 mint, BUY and SELL, guard at instruction 0, optional
destination-ATA setup. Everything else is refused with a typed reason. Guarded
KOx and UNHx builds compile to 675 bytes (+176 B over unguarded, 557 B of
headroom); the guard costs 4,658 compute units to pass.

The package is build-only: it returns unsigned bytes and cannot sign, submit,
hold a key or read configuration. Jupiter exists only on mainnet and the guard
only on devnet, so a guarded mainnet swap is buildable but not submittable
today.

Guide: [`docs/m10-jupiter-integration.md`](docs/m10-jupiter-integration.md).
Worked before/after example:
[`apps/example-jupiter-protected/`](apps/example-jupiter-protected/).

## Reference app

`apps/reference` shows how a wallet, trading app or agent platform could
surface EquityGuard. Its main flow uses the two real KOx observations either
side of the Sep 15 2026 dividend activation (00:29:46Z and 00:30:16Z block
time): a trade prepared under the pending state (**ALLOW**), the same
authorization checked after activation
(**BLOCK: ECONOMIC_STATE_CHANGED**, `ActivationPhaseChanged`), and a refreshed
trade (**ALLOW**). These checks use a zero protection window to isolate the
activation; with the 15 min / 5 min demo window, both moments are already
blocked as `InsideTransitionWindow`.

The Sep 17 local-validator replay (guarded trade executed; outdated-phase and
altered-swap transactions rejected before Jupiter ran) is shown as a separate
test. It ran two days after the activation and did not cross it. A secondary
issuer-switch case (**REQUIRES_CONSENT: REPRESENTATION_CHANGE**) is
illustrative: its KOon quote is made up, because Jupiter returned no KOon
route.

```sh
npm run app:build          # derive state, compile, write apps/reference/dist
npm run app:serve          # http://127.0.0.1:4173/  (?state=stale, ?demo, #advanced)
```

Decisions are computed at build time by the existing code:
`checkGuardOffline` over the curated mainnet KOx/KOon bytes, and the
representation decision engine for the illustrative case. The replay results
come from `apps/reference/data/local-replay-2026-09-17.json`, an excerpt that
records the SHA-256 of its source record. The browser only renders. It has no
network, wallet or signing code, and the tests pin that.

Boundary: the page shows recorded evidence, not live state. It does not
show mainnet EquityGuard execution, a real purchase, a guarded Jupiter trade
on devnet, a trade that crossed the Sep 15 event, or a real cross-issuer
reroute. The 15 min / 5 min window is an uncalibrated demo policy.

## Repository layout

```
programs/equity_guard/    on-chain guard program (native Rust)
packages/guard-client/    TypeScript instruction builder used by clients
packages/jupiter/         Jupiter /build client and guarded transaction composition
packages/representation-state/  representation registry, state, normalization, decisions
scripts/observation/      read-only capture decoding and event detection
scripts/devnet/           devnet test mints, scenarios, deployment record
scripts/evidence/         raw mainnet evidence capture (output is local, gitignored)
apps/reference/           reference integration UI over recorded evidence
apps/example-jupiter-protected/  minimal before/after Jupiter integration example
```

## Development

Requirements: Rust (pinned by `rust-toolchain.toml`), Node.js ≥ 22.18, and the
Agave CLI (validated with 4.2.2) for `cargo build-sbf`.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build-sbf --manifest-path programs/equity_guard/Cargo.toml -- --locked
cargo test --workspace --locked        # unit, golden, deployment-ID, LiteSVM (needs the .so)
npm ci && npm run typecheck && npm test   # offline; includes the recorded Jupiter fixture
```

The Jupiter tests compose recorded mainnet `/build` responses offline; the
2026-09-14 ABI v1 composition remains as historical sizing evidence. CI is
credential-free and never calls Jupiter.

Capture analysis reads only a copy of a capture file. The tools require
`--input`, open it read-only, refuse files modified in the last 90 seconds or
listed in `EQUITYGUARD_PROTECTED_CAPTURE_PATHS`, and write only to stdout or a
new file:

```sh
npm run observation:snapshot -- --input <backup.jsonl>          # sealed read-only copy + SHA-256 manifest
npm run observation:extract -- --input <snapshot> --start <ISO-Z> --end <ISO-Z> [--symbols KOx,KOon] --output <new.jsonl>
npm run observation:timeline -- --input <snapshot> [--symbols KOx,KOon] [--verbose]
npm run observation:decode -- --input <copy.jsonl> [--output <new.jsonl>]
npm run observation:events -- --input <copy.jsonl> [--output <new.jsonl>]
```

The timeline compresses unchanged periods, reports state changes (including
phase changes with identical bytes), decode errors and capture gaps, and ends
with evidence-quality metrics (coverage at the 30-second cadence, largest gaps,
GOOD/DEGRADED/INSUFFICIENT). Window extraction copies lines byte-for-byte.
Snapshots and extracts live in the gitignored `tmp/`.

Devnet deployment is manual and performed by the owner; scenarios run with an
explicitly devnet-targeted wallet. `EQUITYGUARD_DEVNET_WALLET` is required (there
is no default wallet), and nothing is signed unless the RPC reports the exact
devnet genesis hash, checked at connect and again before every signature:

```sh
export EQUITYGUARD_DEVNET_WALLET=<path to a devnet-only keypair file>
npm run devnet -- scenario safe --label EQ-B
npm run devnet -- scenario stale --label EQ-A
npm run devnet -- scenario transition --label EQ-A
```

The scenario runner and the devnet demo build ABI v2 guards and refuse to run
while `scripts/devnet/devnet.json` records the deployed program as ABI v1.

The devnet program ID, deployment signature and test mint addresses are
recorded in `scripts/devnet/devnet.json`. The on-chain ABI is documented in
`programs/equity_guard/src/instruction.rs`, and error codes in
`programs/equity_guard/src/error.rs`.
