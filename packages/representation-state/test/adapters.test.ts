import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RegistryError,
  RepresentationState,
  StateSource,
  TransitionPolicyError,
  classifyChainEvidence,
  findRepresentationBySymbol,
  observeMintAccount,
  resolveOndoState,
  resolveXStocksState,
  type ApiObservation,
  type ApiStatus,
  type ChainEvidence,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withPaused, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOON = findRepresentationBySymbol("KOon")!;
/** KOx's real scheduled activation timestamp at capture. */
const KOX_T = 1_781_481_300n;

function observe(symbol: string, data: Uint8Array, chainUnixTimestamp: bigint | null, owner = TOKEN_2022): ChainEvidence {
  const mint = findRepresentationBySymbol(symbol)!.mint;
  return observeMintAccount({ mint, owner, data, slot: 1n, blockTime: 2n, observedAt: "2026-09-14T00:00:00Z", chainUnixTimestamp });
}

function api(status: ApiStatus): ApiObservation {
  return { issuer: "Ondo", symbol: "KOon", observedAt: "2026-09-14T00:00:00Z", status, detail: null, calibration: "UNCALIBRATED" };
}

test("xStocks: no pending economic change is SAFE regardless of chain time", () => {
  const equal = withScaledUi(mainnetMint("KOx"), { multiplier: 1.25, newMultiplier: 1.25 });
  for (const time of [KOX_T, null]) {
    const resolved = resolveXStocksState(KOX, observe("KOx", equal, time), TEST_POLICY);
    assert.equal(resolved.state, RepresentationState.SAFE);
    assert.equal(resolved.stateSource, StateSource.CHAIN);
  }
});

test("xStocks: transition interval boundaries are inclusive", () => {
  const data = mainnetMint("KOx");
  const table: [string, bigint, RepresentationState, "pending" | "activated"][] = [
    ["before window", KOX_T - 901n, RepresentationState.SAFE, "pending"],
    ["lower bound", KOX_T - 900n, RepresentationState.TRANSITION, "pending"],
    ["at activation", KOX_T, RepresentationState.TRANSITION, "activated"],
    ["upper bound", KOX_T + 900n, RepresentationState.TRANSITION, "activated"],
    ["after activation and window", KOX_T + 901n, RepresentationState.SAFE, "activated"],
  ];
  for (const [label, time, state, phase] of table) {
    const resolved = resolveXStocksState(KOX, observe("KOx", data, time), TEST_POLICY);
    assert.equal(resolved.state, state, label);
    const obs = resolved.chainObservation;
    assert.ok(obs?.kind === "decoded");
    assert.equal(obs.phase, phase === "pending" ? 0 : 1, label);
  }
});

test("xStocks: after activation the observation reports the activated phase, invalidating pending-phase assumptions", () => {
  const resolved = resolveXStocksState(KOX, observe("KOx", mainnetMint("KOx"), KOX_T + 86_400n), TEST_POLICY);
  assert.equal(resolved.state, RepresentationState.SAFE);
  assert.match(resolved.reason, /activated/);
  assert.ok(resolved.chainObservation?.kind === "decoded" && resolved.chainObservation.phase === 1);
});

test("xStocks: UNKNOWN for malformed, missing extension, invalid multiplier, wrong owner, unavailable chain time", () => {
  const data = mainnetMint("KOx");
  const cases: [string, ChainEvidence][] = [
    ["malformed", observe("KOx", data.slice(0, 120), KOX_T)],
    ["missing ScaledUiAmount", observe("KOx", data.slice(0, 82), KOX_T)],
    ["invalid multiplier", observe("KOx", withScaledUi(data, { multiplier: -1 }), KOX_T)],
    ["wrong owner", observe("KOx", data, KOX_T, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")],
    ["chain time unavailable", observe("KOx", data, null)],
  ];
  for (const [label, evidence] of cases) {
    const resolved = resolveXStocksState(KOX, evidence, TEST_POLICY);
    assert.equal(resolved.state, RepresentationState.UNKNOWN, label);
    assert.equal(resolved.stateSource, StateSource.CHAIN, label);
  }
});

test("xStocks: PAUSED only from a real Pausable flag", () => {
  assert.equal(resolveXStocksState(KOX, observe("KOx", withPaused(mainnetMint("KOx"), true), KOX_T), TEST_POLICY).state, RepresentationState.PAUSED);
  assert.notEqual(resolveXStocksState(KOX, observe("KOx", mainnetMint("KOx"), KOX_T + 10_000n), TEST_POLICY).state, RepresentationState.PAUSED);
});

test("adapters reject mismatched issuers, mints and invalid policies", () => {
  const koxEvidence = observe("KOx", mainnetMint("KOx"), KOX_T);
  assert.throws(() => resolveXStocksState(KOON, koxEvidence, TEST_POLICY), RegistryError);
  assert.throws(() => resolveOndoState(KOX, { chain: null, api: null }, TEST_POLICY), RegistryError);
  assert.throws(() => resolveOndoState(KOON, { chain: koxEvidence, api: null }, TEST_POLICY), RegistryError);
  assert.throws(() => classifyChainEvidence(koxEvidence, { ...TEST_POLICY, beforeSecs: -1n }), TransitionPolicyError);
});

test("Ondo: stateSource is chain, api, both-agree or conflict, and conflict is preserved", () => {
  const koonSafe = observe("KOon", mainnetMint("KOon"), 1_789_400_000n);
  const koonPaused = observe("KOon", withPaused(mainnetMint("KOon"), true), 1_789_400_000n);

  const chainOnly = resolveOndoState(KOON, { chain: koonSafe, api: null }, TEST_POLICY);
  assert.deepEqual([chainOnly.state, chainOnly.stateSource], [RepresentationState.SAFE, StateSource.CHAIN]);

  const apiOnly = resolveOndoState(KOON, { chain: null, api: api("paused") }, TEST_POLICY);
  assert.deepEqual([apiOnly.state, apiOnly.stateSource], [RepresentationState.PAUSED, StateSource.API]);

  const agree = resolveOndoState(KOON, { chain: koonSafe, api: api("active") }, TEST_POLICY);
  assert.deepEqual([agree.state, agree.stateSource], [RepresentationState.SAFE, StateSource.BOTH_AGREE]);

  // API reports a pause the mint does not (yet) show: kept as a conflict, not reconciled.
  const conflict = resolveOndoState(KOON, { chain: koonSafe, api: api("paused") }, TEST_POLICY);
  assert.equal(conflict.stateSource, StateSource.CONFLICT);
  assert.equal(conflict.state, null);
  assert.equal(conflict.chainState, RepresentationState.SAFE);
  assert.equal(conflict.apiState, RepresentationState.PAUSED);
  assert.ok(conflict.chainObservation && conflict.apiObservation);

  const reverseConflict = resolveOndoState(KOON, { chain: koonPaused, api: api("active") }, TEST_POLICY);
  assert.deepEqual([reverseConflict.chainState, reverseConflict.apiState], [RepresentationState.PAUSED, RepresentationState.SAFE]);

  const none = resolveOndoState(KOON, { chain: null, api: null }, TEST_POLICY);
  assert.deepEqual([none.state, none.stateSource], [RepresentationState.UNKNOWN, null]);

  const unknownApi = resolveOndoState(KOON, { chain: koonSafe, api: api("unknown") }, TEST_POLICY);
  assert.equal(unknownApi.stateSource, StateSource.CONFLICT, "UNKNOWN API vs SAFE chain is disagreement, kept distinct");
});
