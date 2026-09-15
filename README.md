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
guarded transaction is 577 bytes against the 1232-byte limit, 70 bytes more
than the unguarded one. Nothing was signed or submitted, and EquityGuard is not
deployed on mainnet, so the guard has not executed alongside a Jupiter swap.

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
- guard execution and atomic rollback on **devnet** (table above).

Not proven:

- EquityGuard execution on mainnet (the program is deployed on devnet only);
- guard + Jupiter atomicity on mainnet;
- protection of live xStocks trades, or any real purchase;
- automatic cross-issuer rerouting (the decision engine decides; nothing
  executes the alternative), a UI, or calibrated issuer transition policies.

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
| `programs/equity_guard` — `assert_safe_execution` | deployed on devnet; host, LiteSVM and real devnet transactions |
| Token-2022 ScaledUiAmount decoding | implemented in Rust and TypeScript; cross-checked on golden vectors and real mainnet mint bytes |
| `packages/guard-client` | TypeScript instruction builder (chain-clock snapshot, ABI v1) |
| `scripts/devnet/` | devnet test mints EQ-A/EQ-B, scenario runner, evidence |
| `packages/jupiter` | Jupiter Swap V2 `/build` client and guarded v0 composition (build-only) |
| `scripts/jupiter/compose-mainnet.ts` | live build-only composition for a real xStock; needs `JUPITER_API_KEY` |
| `scripts/evidence/capture-equity-mints.mjs` | raw mainnet mint recorder, verified watchlist |
| `packages/representation-state` | registry, issuer state adapters, capture decoding, normalization, decision engine (no execution) |
| `scripts/observation/` | read-only decoding and event detection over capture copies |
| Rerouting, demo UI | later |

## Repository layout

```
programs/equity_guard/    on-chain guard program (native Rust)
packages/guard-client/    TypeScript instruction builder used by clients
packages/jupiter/         Jupiter /build client and guarded transaction composition
packages/representation-state/  representation registry, state, normalization, decisions
scripts/jupiter/          live build-only mainnet composition (no submission)
scripts/observation/      read-only capture decoding and event detection
scripts/devnet/           devnet test mints, scenarios, deployment record
scripts/evidence/         raw mainnet evidence capture (output is local, gitignored)
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

The live composition run reads secrets from a gitignored `.env`
(`JUPITER_API_KEY`, `EQUITYGUARD_MAINNET_RPC_URL`) and never signs or submits:

```sh
node --env-file=.env scripts/jupiter/compose-mainnet.ts
```

CI is credential-free and never calls Jupiter.

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

The devnet program ID, deployment signature and test mint addresses are
recorded in `scripts/devnet/devnet.json`. The on-chain ABI is documented in
`programs/equity_guard/src/instruction.rs`, and error codes in
`programs/equity_guard/src/error.rs`.
