# Evidence

Raw mainnet account captures of tokenized-equity mints.

## Why raw state is captured

- **Ground truth independent of our parsers.** Bytes are stored undecoded, so a
  later decoding bug cannot corrupt the evidence. Decoders (ScaledUiAmount,
  issuer adapters) can be re-run and regression-tested against real history.
- **Observing real transitions.** A multiplier change, a newly scheduled pending
  multiplier, or an activation timestamp passing is visible as a byte change
  between slots.
- **Honest documentation.** Claims about real mainnet behaviour in docs and the
  demo can be traced to a slot and raw bytes.

**Raw data is evidence, not application state.** Nothing in the application
reads these files at runtime, and they must never be rendered in the LIVE
MAINNET pane as if current (see `docs/demo-boundary.md`).

## Output format

JSON Lines, one record per mint per poll, appended to
`evidence/mint-captures.jsonl` by default:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | record shape version (currently `1`) |
| `capturedAt` | string | ISO-8601 wallclock when the RPC response was received |
| `wallclockMs` | number | same, Unix milliseconds |
| `slot` | number | RPC context slot for the account read |
| `blockTime` | number \| null | Unix seconds for `slot`; `null` if the RPC could not supply it |
| `commitment` | string | commitment used for the read (`confirmed`) |
| `symbol` | string | configured label, e.g. `UNHx` |
| `issuer` | string | configured issuer label, e.g. `xstocks`, `ondo` |
| `mint` | string | mint address |
| `exists` | boolean | whether the account existed at `slot` |
| `owner` | string \| null | owning program (Token-2022 is `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |
| `lamports` | number \| null | account balance |
| `dataBase64` | string \| null | raw account data, base64 |

All mints in one poll share one `slot`, because they are read with a single
`getMultipleAccounts` call.

## How to run

Requires Node.js ≥ 22. No npm install needed.

1. Create a mint list from the template, filling in **verified** mint addresses
   (from issuer documentation or the existing recorder's configuration):

   ```sh
   cp scripts/evidence/mints.example.json scripts/evidence/mints.json
   ```

2. Run against a mainnet RPC endpoint. The URL is read from the environment
   and never logged, since provider URLs often embed API keys. The public
   endpoint `https://api.mainnet-beta.solana.com` works for low-frequency
   polling but is rate limited.

   ```sh
   export EQUITYGUARD_MAINNET_RPC_URL=...
   # single snapshot
   node scripts/evidence/capture-equity-mints.mjs --mints scripts/evidence/mints.json --once
   # continuous, every 30 seconds (default)
   node scripts/evidence/capture-equity-mints.mjs --mints scripts/evidence/mints.json
   ```

   Options: `--out <path>` (default `evidence/mint-captures.jsonl`),
   `--interval-seconds <n>` (default `30`), `--once`.

Failed polls are logged to stderr and retried at the next interval; `--once`
exits non-zero on failure.

## Git policy

`evidence/*.jsonl` and `evidence/*.log` are gitignored. Never commit generated
captures. Archive them outside the repository if they need to be shared.

## Relationship to the external recorder

A throwaway recorder already running outside this repository captures the same
fields for UNHx, UNHon, KOx, KOon, CRMx and CRMon. This script is its clean,
tested replacement; the running recorder is intentionally left untouched.
