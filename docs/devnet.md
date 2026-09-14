# Devnet runbook and evidence

EquityGuard runs on **Solana devnet** against **test mints we control**. This
page covers how the deployment and evidence were produced, and how to
reproduce them. Nothing here involves mainnet, real issuer assets, or Jupiter.

## Deployment

| Item | Value |
| --- | --- |
| Cluster | devnet (genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) |
| Program ID | [`EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT`](https://explorer.solana.com/address/EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT?cluster=devnet) |
| ProgramData | `4Zc4TAEYNSXCGUkpD7y7CcEWDS8a9aQBDfYHFu55dPE3` |
| Loader | BPF Upgradeable Loader |
| Deploy signature | [`4rc3JcJ7…tGBWRa`](https://explorer.solana.com/tx/4rc3JcJ7NHg3HmjNsfzmnTDcEXxR7k3gYvgFazJFfZ4chbwBaSU9nxp7P9yepJtxaEPtiGUXgQLHpoAezwtGBWRa?cluster=devnet) (finalized) |
| Last deployed slot | 498049186 |
| Upgrade authority | `JArGaWxrddR7J1XYjsoEU5XCuHffra3gASBjfVK4BuNT` (dedicated EquityGuard devnet wallet, held by the project owner) |
| Binary | 29,744 bytes, SHA-256 `dd1ff50d6646e23ee5f3bb64d3bee0aac73d8549eb775285083febdb5731ca63` (on-chain dump matches the local build) |
| Toolchain | Agave 4.2.2, `cargo-build-sbf` 4.1.0, platform-tools v1.54, SBPF v0 (default) |

Public metadata is committed in `scripts/devnet/devnet.json`. Keypairs are
never committed:

- **Program keypair:** `~/.config/solana/equityguard/equity_guard-devnet-program-keypair.json`,
  outside the repository. It fixes the program address; the upgrade authority
  controls upgrades.
- **Devnet wallet:** `~/.config/solana/equityguard-devnet.json`, owner-held and
  devnet only.

## Test assets

> **DEVNET TEST ASSETS.** Created by EquityGuard tooling. Not xStocks, Ondo or
> any issuer asset. No real-world value. Both represent the same *fictional*
> stock, `DEMO`, so that Milestone 4 can show a choice between two
> representations.

| Label | Mint | Decimals | Extension | State after the runs below |
| --- | --- | --- | --- | --- |
| EQ-A | [`5ikX5JLtRXxqARxsCfLyJ1gkz43bcYFCXnhPyfpmJeRt`](https://explorer.solana.com/address/5ikX5JLtRXxqARxsCfLyJ1gkz43bcYFCXnhPyfpmJeRt?cluster=devnet) | 6 | ScaledUiAmount only | multiplier 1.25, new 1.5, T = 1789358117 (activated) |
| EQ-B | [`AwQ8Cx4D4a1fBEcNThsG4kCskmgLNKMnvkf57iQG7wZn`](https://explorer.solana.com/address/AwQ8Cx4D4a1fBEcNThsG4kCskmgLNKMnvkf57iQG7wZn?cluster=devnet) | 6 | ScaledUiAmount only | multiplier 1.0, no scheduled change (safe) |

The wallet is both mint authority and multiplier authority. Each mint holds a
1,000-token balance in the wallet's associated token account, for later
milestones. The tooling refuses ScaledUiAmount + InterestBearingConfig with
`InvalidTestMintExtensionsError` before building any transaction.

## Evidence (devnet, 2026-09-14)

Every guarded transaction is `[assert_safe_execution (EQ-A or EQ-B), system
transfer of 1,000,000 lamports to a fresh address]`. Failed transactions were
sent with preflight disabled so they landed on-chain; each status below was
confirmed independently with `solana confirm -v <sig> -u devnet`. The protection
window was 20 s before and 20 s after T. That is demo policy, not an issuer
value.

| # | Step | Mint | Asserted snapshot | Slot | Block time | Result | Recipient lamports | Signature |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | safe / fresh snapshot | EQ-B | m = n = 1.0, T = 0, activated | 498051702 | 1789358025 | ✅ success (`EquityGuard: safe`) | 0 → 1,000,000 | [`5RNgyfWj…TVuERX`](https://explorer.solana.com/tx/5RNgyfWjDmQYLwQtZr8jsHKLfqth1UewmNjrSsjuhZB4m3sxgf9kKBjvzfG3zugW1sdSCwspAwrXVdied3TVuERX?cluster=devnet) |
| 2 | stale / snapshot S before immediate update to 1.25 | EQ-A | m = n = 1.0, T = 0 | 498051742 | 1789358031 | ❌ `MultiplierChanged` (9) | 0 → 0 | [`3NMHpzCc…6bKngJ`](https://explorer.solana.com/tx/3NMHpzCc1X5pFrebj5PR8aJiEV2q35xcGncqtaiGpRJqfNYhrpoJLEMq3nYVXi3XizttoBwG6X2VNJnwxE6bKngJ?cluster=devnet) |
| 3 | stale / fresh snapshot S′ | EQ-A | m = n = 1.25, T = 0 | 498051752 | 1789358033 | ✅ success | 0 → 1,000,000 | [`46WaWA5q…BviaJDJ`](https://explorer.solana.com/tx/46WaWA5qC42p4vwhg1qYNzFpMqsPu1J3UYDTy1PaX6MckwwB5jTzzmzzW4mfZhjkrUQSSWgCoXfNcD99QBviaJDJ?cluster=devnet) |
| 4 | transition / pending, before window | EQ-A | m = 1.25, n = 1.5, T = 1789358117, **pending** | 498051820 | 1789358045 | ✅ success | 0 → 1,000,000 | [`2NSvgdfc…iYd7Mbz`](https://explorer.solana.com/tx/2NSvgdfcDoiB28wjyY5aRm95orn3zuR5npu4x53RU6zRCPbN9Zs1Uh94Bi38yYnDSVPkeLcqwu51qBqANiYd7Mbz?cluster=devnet) |
| 5 | transition / **same payload**, inside window | EQ-A | identical to #4 | 498052160 | 1789358101 | ❌ `InsideTransitionWindow` (13) | 0 → 0 | [`2LYSTjXg…v9bMsHm8`](https://explorer.solana.com/tx/2LYSTjXgzrMgCDapr7LQEuc2j5hpkxHq2BWHT82nzX4LbfzF3SjgunyaySf8y7A6GwWKDAtRdrqkCgpMv9bMsHm8?cluster=devnet) |
| 6 | transition / **same payload**, after window | EQ-A | identical to #4 | 498052435 | 1789358146 | ❌ `ActivationPhaseChanged` (12) | 0 → 0 | [`2z7xv8VJ…PGrPX6`](https://explorer.solana.com/tx/2z7xv8VJnXu75cK512qSLVQMc6DYMxVugqLD5bvubeSTNknUgeo7z9C1K2QiDAdajKKPS42E95hcrAJQZkPGrPX6?cluster=devnet) |
| 7 | transition / fresh snapshot, activated | EQ-A | m = 1.25, n = 1.5, T = 1789358117, **activated** | 498052452 | 1789358149 | ✅ success | 0 → 1,000,000 | [`hySXRPu5…J3HA5`](https://explorer.solana.com/tx/hySXRPu5ennbRT2fyZsKWoZX1aR8Xue9BdYxpdMSWAYuhE5kgeNPqmqK6iB2pHHJGdBPwiBjroyTMPGWKYJ3HA5?cluster=devnet) |

What the transition steps show:

- Steps 4–6 sent the **byte-identical** 34-byte instruction
  `01 000000000000f43f 000000000000f83f 2570a76a00000000 00 14000000 14000000`,
  built once from the pending snapshot at slot 498051815. Before steps 5 and
  6, the runner re-read the mint and confirmed the protected bytes were
  unchanged. Only chain time moved.
- Window: [T − 20, T + 20] = [1789358097, 1789358137], inclusive. Step 5
  landed at block time 1789358101, inside the window and before T. Step 6
  landed at 1789358146, after the window closed.
- Step 6 is the post-activation check: once the window ended, a payload built
  while `multiplier` was effective did not become valid again. The program
  rejected it because `new_multiplier` is now effective.
- Step 7 recovers with a fresh snapshot read from chain state, phase activated.
- Guard compute: 1,772–2,033 CU per invocation.

The full per-step records (logs, balances, chain time before send) are in the
gitignored `evidence/devnet/devnet-2026-09-14T0353*.json` files, in the format
described below.

## Prerequisites

- Rust toolchain from `rust-toolchain.toml`; Agave CLI 4.2.2 on `PATH`
  (`$HOME/.local/share/solana/install/active_release/bin`).
- Node.js ≥ 22.18, then `npm ci`.
- A funded **devnet** wallet file. Every command below passes `-u devnet` or
  `EQUITYGUARD_DEVNET_*` explicitly; global Solana CLI config is never changed.

```sh
export EQUITYGUARD_DEVNET_WALLET=~/.config/solana/equityguard-devnet.json
export EQUITYGUARD_DEVNET_RPC_URL=https://api.devnet.solana.com   # default
```

## Build and verify

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build-sbf --manifest-path programs/equity_guard/Cargo.toml -- --locked
cargo test --workspace --locked          # includes LiteSVM; needs the .so
npm run typecheck && npm test
```

## Deploy (owner, manual)

```sh
solana program deploy target/deploy/equity_guard.so \
  --program-id ~/.config/solana/equityguard/equity_guard-devnet-program-keypair.json \
  -u devnet -k "$EQUITYGUARD_DEVNET_WALLET"
```

Verify the deployment:

```sh
solana program show EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT -u devnet -k "$EQUITYGUARD_DEVNET_WALLET"
solana program dump EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT /tmp/eg.so -u devnet -k "$EQUITYGUARD_DEVNET_WALLET"
shasum -a 256 target/deploy/equity_guard.so /tmp/eg.so   # must match
```

Record the program ID, deploy signature and upgrade authority in
`scripts/devnet/devnet.json`. `cargo test --test deployment` checks that the
ID matches `declare_id!`. CI never deploys and holds no credentials.

## Create test mints

```sh
npm run devnet -- create-mints
```

This creates EQ-A and EQ-B, funds the test balances, and writes the addresses
to `devnet.json`. It refuses to run if assets are already listed.

## Schedule a transition

```sh
npm run devnet -- schedule --label EQ-A --multiplier 1.75 --in-seconds 300
npm run devnet -- snapshot --label EQ-A
```

`--in-seconds` is added to the chain Clock's `unix_timestamp`, not to the local
clock. For the Milestone 4 "EQ-A transitioning, EQ-B safe" fixture, schedule
EQ-A shortly before the demo and leave EQ-B untouched.

## Run the scenarios

```sh
npm run devnet -- scenario safe --label EQ-B
npm run devnet -- scenario stale --label EQ-A
npm run devnet -- scenario transition --label EQ-A [--lead-seconds 75] [--before 20] [--after 20]
```

Each step prints expected versus observed results and exits non-zero on any
mismatch. A failure step only counts as matched if the downstream recipient's
balance is also unchanged.

## Chain time vs local time

The program compares against `Clock::unix_timestamp` at execution. The client
reads the Clock sysvar in the same `getMultipleAccounts` call as the mint, and
derives the expected phase and every wait from it. Local wallclock appears in
output as `localWallclockForReferenceOnly` and is never used for decisions.
Devnet chain time and wallclock can differ by seconds.

## Evidence format (schema v1)

One JSON file per guarded transaction at
`evidence/devnet/<cluster>-<run>-<scenario>-<step>.json` (gitignored). Fields:
`schemaVersion`, `scenario`, `step`, `cluster` (`devnet` or `localnet`),
`programId`, `mint`, `assetLabel`, `transactionSignature`, `explorerUrl` (devnet
only), `slot`, `blockTime`, `guardSnapshot` (context slot, chain time,
multiplier hex, new multiplier hex, effective timestamp, phase, window),
`instructionDataHex`, `chainUnixTimestampBeforeSend`, `expectedResult`,
`observedResult`, `customError` (`code`, `name`), `matchedExpectation`,
`downstream` (recipient, lamports, balance before/after), `logs`, and
`localWallclockForReferenceOnly`. Integers are strings so they stay exact.

## Rehearse locally

To rehearse without devnet SOL, use a local validator that mirrors devnet's
SBPF gate. Recent validators disable SBPF v0 deployment (SIMD-0500) by
default; devnet has not activated that gate.

```sh
solana-test-validator --reset --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g
export EQUITYGUARD_DEVNET_RPC_URL=http://127.0.0.1:8899
export EQUITYGUARD_DEVNET_STATE=/tmp/eg-local-state.json      # keep devnet.json untouched
export EQUITYGUARD_EVIDENCE_DIR=/tmp/eg-local-evidence
```

Only loopback URLs bypass the devnet genesis check. Records made this way say
`"cluster": "localnet"` and have no explorer links.

## Cleanup and regeneration

- To regenerate test mints, remove the `assets` entries from `devnet.json`,
  then run `create-mints`. The old mints stay on devnet and are simply no
  longer referenced.
- Evidence files can be deleted at any time; they are not application state.
- An upgrade redeploys to the same program ID with the upgrade authority.
  After upgrading, update the deploy signature and hash above.
