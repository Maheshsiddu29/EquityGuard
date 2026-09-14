import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  RegistryError,
  UnknownUnderlyingError,
  alternativesFor,
  buildRegistry,
  findRepresentationByMint,
  findRepresentationBySymbol,
  getUnderlying,
  listUnderlyings,
} from "../src/index.ts";

const KOX = "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ";
const KOON = "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo";

test("registry lists KO, UNH and CRM with xStocks and Ondo representations", () => {
  assert.deepEqual(
    listUnderlyings().map((u) => [u.underlying, u.representations.map((r) => `${r.issuer}:${r.symbol}`)]),
    [
      ["KO", ["xStocks:KOx", "Ondo:KOon"]],
      ["UNH", ["xStocks:UNHx", "Ondo:UNHon"]],
      ["CRM", ["xStocks:CRMx", "Ondo:CRMon"]],
    ],
  );
});

test("registry mints match the verified evidence watchlist", () => {
  const watchlist = JSON.parse(
    readFileSync(new URL("../../../scripts/evidence/mints.example.json", import.meta.url), "utf8"),
  ) as { symbol: string; mint: string }[];
  for (const { symbol, mint } of watchlist) {
    assert.equal(findRepresentationBySymbol(symbol)?.mint, mint, symbol);
  }
  assert.equal(listUnderlyings().flatMap((u) => u.representations).length, watchlist.length);
});

test("lookups are deterministic and unknown tickers fail explicitly", () => {
  assert.equal(getUnderlying("KO"), getUnderlying("KO"));
  assert.equal(findRepresentationByMint(KOX)?.symbol, "KOx");
  assert.equal(findRepresentationByMint("11111111111111111111111111111111"), undefined);
  assert.deepEqual(
    alternativesFor(findRepresentationByMint(KOX)!).map((r) => r.mint),
    [KOON],
  );
  assert.throws(() => getUnderlying("AAPL"), UnknownUnderlyingError);
  assert.throws(() => getUnderlying("ko"), UnknownUnderlyingError);
});

test("registry entries are immutable", () => {
  const ko = getUnderlying("KO");
  assert.ok(Object.isFrozen(ko) && Object.isFrozen(ko.representations) && Object.isFrozen(ko.representations[0]));
});

test("registry validation rejects duplicates and invalid addresses", () => {
  const rep = (issuer: "xStocks" | "Ondo", symbol: string, mint: string) => ({ issuer, symbol, mint });
  const cases = [
    [{ underlying: "KO", name: "a", representations: [rep("xStocks", "A", KOX)] }, { underlying: "X", name: "b", representations: [rep("Ondo", "B", KOX)] }],
    [{ underlying: "KO", name: "a", representations: [rep("xStocks", "A", KOX), rep("xStocks", "B", KOON)] }],
    [{ underlying: "KO", name: "a", representations: [rep("xStocks", "A", "not-a-mint")] }],
    [{ underlying: "KO", name: "a", representations: [] }, { underlying: "KO", name: "b", representations: [] }],
    [{ underlying: "KO", name: "a", representations: [rep("xStocks", "A", KOX), rep("Ondo", "A", KOON)] }],
  ];
  for (const entries of cases) {
    assert.throws(() => buildRegistry(entries), RegistryError, JSON.stringify(entries));
  }
});
