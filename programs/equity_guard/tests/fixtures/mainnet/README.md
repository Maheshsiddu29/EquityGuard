# Mainnet mint fixtures

Raw account data (base64) of the verified watchlist mints, captured read-only
from Solana mainnet with `getMultipleAccounts` at commitment `confirmed`,
**slot 446827429** (2026-09-13). Owner of every account:
`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022).

| File | Mint | Multiplier | New multiplier | Effective timestamp |
| --- | --- | --- | --- | --- |
| `UNHx.base64` | `XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe` | 1.0229655423325776 | 1.0273478685368111 | 1789173000 |
| `UNHon.base64` | `kPBGL8vAwKN3UGmr9cjkM2dU79SC3nzTC9yu7F8ondo` | 1.0186608863722362 | same | 1788344044 |
| `KOx.base64` | `XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ` | 1.013779482672994 | 1.0183317967386898 | 1781481300 |
| `KOon.base64` | `e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo` | 1.0196453194004143 | same | 1788344044 |
| `CRMx.base64` | `XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN` | 1.0036630653273484 | 1.0054716788543585 | 1781137800 |
| `CRMon.base64` | `7D7ukbcnUNYt7Et5vtsDZhAy28MKu9pkHka1Hp9ondo` | 1.005894625750097 | same | 1788344044 |

These are frozen test inputs, not live state. Tests that need a different
state mutate a copy of these bytes; the files themselves never change.
