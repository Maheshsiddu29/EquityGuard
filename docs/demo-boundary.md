# Demo boundary: live mainnet vs devnet execution

The demo has two deliberately separate environments. The seam is disclosed on
screen, not hidden.

## Why

The developers do not rely on holding restricted tokenized securities, and real
corporate actions cannot be triggered on demand. Real state is therefore
observed read-only on mainnet, while execution behaviour is proven on devnet
with mints we control that use the same Token-2022 mechanics.

## LIVE MAINNET pane — read only

May show only real, current data:

- real xStocks / Ondo mints
- real Token-2022 account state
- real current multiplier, pending multiplier, activation timestamp
- real issuer status
- real Jupiter quotes/liquidity where available

Must never show simulated, replayed, cached-as-live, or engineered data. If a
value is unavailable it is shown as unavailable, not substituted.

## DEVNET EXECUTION pane

- controlled Token-2022 test mints with ScaledUiAmount: EQ-A and EQ-B,
  both labelled as representing the fictional stock `DEMO`
- engineered pending transitions and activations
- the real deployed EquityGuard program
  (`EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT` on devnet)
- actually signed transactions
- actual atomic success/failure outcomes, linked to explorer

Test assets carry no xStocks, Ondo or other issuer branding, and every listing
shows the disclosure "DEVNET TEST ASSET … Not an xStocks, Ondo or any issuer
asset; no real-world value" (enforced by `scripts/devnet/devnet-state.ts`).
Evidence records name their cluster, so a local-validator rehearsal can never
appear as a devnet result. See [devnet.md](devnet.md).

## Required disclosure

The UI states, in substance:

> LIVE MAINNET shows real read-only state of real tokenized equities.
> DEVNET EXECUTION uses test mints we control, with the same Token-2022
> ScaledUiAmount mechanics, to demonstrate the guard succeeding and failing on
> real transactions. No real corporate action is simulated on mainnet.

## Evidence

Raw mainnet account captures (see `evidence/README.md`) are evidence of real
state history. They may be cited in documentation but are never rendered in the
LIVE MAINNET pane as if current.

## Optional mainnet composition proof

If a non-restricted, Jupiter-routable Token-2022 ScaledUiAmount mint is found, a
tiny mainnet transaction may demonstrate the guard composing with a real
Jupiter swap. It must not be described as a corporate action unless the asset
genuinely underwent one. It is not a dependency of MVP completion.
