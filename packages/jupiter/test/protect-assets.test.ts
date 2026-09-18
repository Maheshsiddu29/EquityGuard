/**
 * Asset classification at the integration surface.
 *
 * The distinction this file exists to defend: "EquityGuard does not apply to
 * this asset" and "EquityGuard cannot establish this asset's protection
 * semantics" are different answers. The first permits the caller's ordinary
 * path; the second must never do so.
 *
 * Before this behaviour existed, a known tokenized equity that stopped
 * presenting a ScaledUiAmount extension was reported NOT_APPLICABLE, and an
 * integrator following the documented contract would have traded it
 * unprotected. Each case below pins the refusal instead.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { address } from "@solana/kit";
import { KNOWN_PROTECTED_ASSETS, findKnownProtectedAsset } from "@equityguard/guard-client";

import { explainEquityGuardError, protectJupiterSwap, supportsJupiterSwap, type ProtectJupiterSwapResult } from "../src/protect.ts";
import {
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  distinctAddress,
  fakeRpc,
  legacyMint,
  mainnetMint,
  mutatedMint,
  plainToken2022Mint,
  recordedKoxBuyBuild,
  token2022Account,
  withMints,
  type FakeAccount,
} from "./protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const KOON_MINT = address("e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo");

/** A BUY of `mint` with USDC, over the recorded mainnet route. */
function buyOf(mint: string) {
  return withMints(recordedKoxBuyBuild(), { outputMint: mint });
}

function protect(build: Parameters<typeof protectJupiterSwap>[0]["build"], accounts: Readonly<Record<string, FakeAccount>>): Promise<ProtectJupiterSwapResult> {
  const { rpc } = fakeRpc({ accounts, unixTimestamp: SETTLED_TIMESTAMP });
  return protectJupiterSwap({ build, userPublicKey: TAKER, rpc, protectionWindow: WINDOW });
}

function assertNoTransaction(result: ProtectJupiterSwapResult): void {
  assert.notEqual(result.status, "PROTECTED");
  assert.ok(!("transaction" in result) && !("transactionBase64" in result) && !("instructions" in result), "a refusal must carry no transaction");
}

test("a known tokenized equity with no supported state model fails closed", async () => {
  for (const asset of KNOWN_PROTECTED_ASSETS) {
    const result = await protect(buyOf(asset.mint), { [asset.mint]: plainToken2022Mint() });
    assert.equal(result.status, "UNSUPPORTED_PROTECTED_ASSET", asset.symbol);
    if (result.status !== "UNSUPPORTED_PROTECTED_ASSET") continue;
    assert.equal(result.code, "NO_SUPPORTED_STATE_ADAPTER", asset.symbol);
    assert.equal(result.protectedMint, asset.mint);
    assert.equal(result.knownAsset.symbol, asset.symbol);
    assert.equal(result.knownAsset.issuer, asset.issuer);
    assertNoTransaction(result);
    assert.match(explainEquityGuardError(result), /must not be sent in its place/);
    assert.match(explainEquityGuardError(result), new RegExp(`${asset.symbol} is a known ${asset.issuer} representation`));
  }
});

test("the very same account bytes at an unlisted mint are NOT_APPLICABLE", async () => {
  // This is the whole distinction: identical bytes, different asset universe.
  const unlisted = distinctAddress(81);
  const result = await protect(buyOf(unlisted), { [unlisted]: plainToken2022Mint() });
  assert.equal(result.status, "NOT_APPLICABLE");
  assert.equal(result.status === "NOT_APPLICABLE" && result.reason, "NO_PROTECTED_STATE_MODEL");
  assert.match(explainEquityGuardError(result), /Continue with your existing Jupiter flow/);
});

test("a known equity whose mint is no longer Token-2022 fails closed", async () => {
  const result = await protect(buyOf(KOX_MINT), { [KOX_MINT]: legacyMint() });
  assert.equal(result.status, "UNSUPPORTED_PROTECTED_ASSET");
  assert.equal(result.status === "UNSUPPORTED_PROTECTED_ASSET" && result.code, "NO_SUPPORTED_STATE_ADAPTER");
  assertNoTransaction(result);
});

test("a known equity with malformed state is an ERROR, never NOT_APPLICABLE", async () => {
  const cases: [string, Uint8Array, string][] = [
    ["uninitialized", mutatedMint("KOx", (d) => void (d[45] = 0)), "MALFORMED_TOKEN_STATE"],
    ["truncated", mutatedMint("KOx", (d) => d.slice(0, 200)), "MALFORMED_TOKEN_STATE"],
    ["subnormal multiplier", mutatedMint("KOx", (d) => void Buffer.alloc(8).copy(d, 275 + 4 + 32)), "MALFORMED_TOKEN_STATE"],
  ];
  for (const [label, data, code] of cases) {
    const result = await protect(buyOf(KOX_MINT), { [KOX_MINT]: token2022Account(data) });
    assert.equal(result.status, "ERROR", label);
    assert.equal(result.status === "ERROR" && result.code, code, label);
    assert.equal(result.status === "ERROR" && result.protectedMint, KOX_MINT, label);
    assertNoTransaction(result);
  }
});

test("a known equity with a duplicate or unknown extension fails closed", async () => {
  const appendTlv = (type: number, length: number) =>
    mutatedMint("KOx", (data) => {
      const extra = new Uint8Array(data.length + 4 + length);
      extra.set(data);
      const view = new DataView(extra.buffer);
      view.setUint16(data.length, type, true);
      view.setUint16(data.length + 2, length, true);
      return extra;
    });
  for (const [label, data, code] of [
    ["duplicate ScaledUiAmount", appendTlv(25, 56), "MALFORMED_TOKEN_STATE"],
    ["unknown extension type", appendTlv(99, 0), "MALFORMED_TOKEN_STATE"],
    ["forbidden extension combination", appendTlv(10, 52), "UNSUPPORTED_TOKEN_STATE"],
  ] as const) {
    const result = await protect(buyOf(KOX_MINT), { [KOX_MINT]: token2022Account(data) });
    assert.equal(result.status, "ERROR", label);
    assert.equal(result.status === "ERROR" && result.code, code, label);
    assertNoTransaction(result);
  }
});

test("a known equity whose account cannot be read is an ERROR that names it", async () => {
  const result = await protect(buyOf(KOX_MINT), {});
  assert.equal(result.status, "ERROR");
  assert.equal(result.status === "ERROR" && result.code, "MINT_STATE_UNAVAILABLE");
  assert.equal(result.status === "ERROR" && result.protectedMint, KOX_MINT, "a known equity is named even when unreadable");
  assert.match(result.status === "ERROR" ? result.message : "", /known tokenized equity/);
  assertNoTransaction(result);
});

test("an unlisted mint that cannot be read is an ERROR too, without naming it protected", async () => {
  const unlisted = distinctAddress(82);
  const result = await protect(buyOf(unlisted), {});
  assert.equal(result.status, "ERROR");
  assert.equal(result.status === "ERROR" && result.code, "MINT_STATE_UNAVAILABLE");
  assert.equal(result.status === "ERROR" && result.protectedMint, null);
  assertNoTransaction(result);
});

test("Ondo representations are treated as supported assets, on the repository's evidence", async () => {
  // docs/m10a-corporate-action-validation.md: KOon and UNHon update immediately
  // (multiplier and new multiplier equal, no pending phase), which the guard's
  // stored-state identity check covers. They are NOT classified unsupported.
  const koon = findKnownProtectedAsset(KOON_MINT);
  assert.equal(koon?.issuer, "Ondo");

  const support = await supportsJupiterSwap({
    build: buyOf(KOON_MINT),
    rpc: fakeRpc({ accounts: { [KOON_MINT]: token2022Account(mainnetMint("KOon")) }, unixTimestamp: SETTLED_TIMESTAMP }).rpc,
  });
  assert.equal(support.supported, true);
  assert.equal(support.supported === true && support.level, "STRUCTURALLY_SUPPORTED");
  assert.equal(support.supported === true && support.knownAsset?.symbol, "KOon");

  // Classification passes; the refusal comes from the route, because the
  // recorded route_v2's destination account and setup were built for KOx. No
  // Jupiter route to an Ondo mint exists (docs/m9d-a-jupiter-trade-binding.md),
  // so a PROTECTED Ondo build cannot be exercised from recorded evidence.
  const result = await protect(buyOf(KOON_MINT), { [KOON_MINT]: token2022Account(mainnetMint("KOon")) });
  assert.equal(result.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.guardError, "InvalidAtaSetup");
  assertNoTransaction(result);
});

test("supportsJupiterSwap refuses a known equity with no adapter instead of claiming support", async () => {
  const support = await supportsJupiterSwap({
    build: buyOf(KOX_MINT),
    rpc: fakeRpc({ accounts: { [KOX_MINT]: plainToken2022Mint() }, unixTimestamp: SETTLED_TIMESTAMP }).rpc,
  });
  assert.equal(support.supported, false);
  assert.equal(support.supported === false && support.status, "UNSUPPORTED_PROTECTED_ASSET");
  assert.equal(support.supported === false && support.code, "NO_SUPPORTED_STATE_ADAPTER");
  assert.equal(support.supported === false && support.protectedMint, KOX_MINT);
});

test("a supported protected asset still composes normally", async () => {
  const result = await protect(recordedKoxBuyBuild(), { [KOX_MINT]: token2022Account(mainnetMint("KOx")) });
  assert.equal(result.status, "PROTECTED");
  assert.equal(result.status === "PROTECTED" && result.knownAsset?.symbol, "KOx");
  assert.equal(result.status === "PROTECTED" && result.knownAsset?.issuer, "xStocks");
});
