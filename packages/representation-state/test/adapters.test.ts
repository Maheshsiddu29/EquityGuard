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

test("Ondo reconciliation matrix (fixture-only, no live API)", () => {
  const time = 1_789_400_000n;
  const chainSafe = observe("KOon", mainnetMint("KOon"), time);
  const chainPaused = observe("KOon", withPaused(mainnetMint("KOon"), true), time);
  // A KOon copy with a scheduled change whose activation is at the observed chain time.
  const chainTransition = observe("KOon", withScaledUi(mainnetMint("KOon"), { newMultiplier: 1.03, effectiveTimestamp: time }), time);
  const matrix: [string, ChainEvidence | null, ApiStatus | null, RepresentationState | null, StateSource | null][] = [
    ["chain SAFE + api SAFE", chainSafe, "active", RepresentationState.SAFE, StateSource.BOTH_AGREE],
    ["chain PAUSED + api PAUSED", chainPaused, "paused", RepresentationState.PAUSED, StateSource.BOTH_AGREE],
    ["chain SAFE + api PAUSED", chainSafe, "paused", null, StateSource.CONFLICT],
    ["chain TRANSITION + api SAFE", chainTransition, "active", null, StateSource.CONFLICT],
    ["API only", null, "paused", RepresentationState.PAUSED, StateSource.API],
    ["chain only", chainTransition, null, RepresentationState.TRANSITION, StateSource.CHAIN],
  ];
  for (const [label, chain, status, state, source] of matrix) {
    const resolved = resolveOndoState(KOON, { chain, api: status ? api(status) : null }, TEST_POLICY);
    assert.deepEqual([resolved.state, resolved.stateSource], [state, source], label);
    if (source === StateSource.CONFLICT) assert.ok(resolved.chainState !== null && resolved.apiState !== null, label);
  }
});

test("an immediate update is SAFE as soon as it is observed: no cooldown at any chain time", () => {
  const t = 1_789_430_644n;
  const immediate = withScaledUi(mainnetMint("KOon"), { multiplier: 1.0238905041551842, newMultiplier: 1.0238905041551842, effectiveTimestamp: t });
  for (const offset of [0n, 1n, 12n, 60n, 300n, 301n, 86_400n]) {
    const resolved = resolveOndoState(KOON, { chain: observe("KOon", immediate, t + offset), api: null }, TEST_POLICY);
    assert.deepEqual([resolved.state, resolved.reason], [RepresentationState.SAFE, "no scheduled multiplier change"], `T+${offset}`);
  }
  // The same state is SAFE under any window configuration: windows apply to scheduled changes only.
  const wide = { ...TEST_POLICY, beforeSecs: 86_400n, afterSecs: 86_400n };
  assert.equal(classifyChainEvidence(observe("KOon", immediate, t + 12n), wide).state, RepresentationState.SAFE);
  assert.throws(() => classifyChainEvidence(observe("KOon", immediate, t), { ...TEST_POLICY, afterSecs: -1n }), TransitionPolicyError);
});

test("a scheduled pending change still resolves TRANSITION inside the window", () => {
  const t = 1_789_432_200n;
  const pending = withScaledUi(mainnetMint("KOx"), { multiplier: 1.0183317967386898, newMultiplier: 1.0225601246249238, effectiveTimestamp: t });
  const table: [bigint, RepresentationState][] = [
    [t - 901n, RepresentationState.SAFE],
    [t - 14n, RepresentationState.TRANSITION],
    [t + 17n, RepresentationState.TRANSITION],
    [t + 901n, RepresentationState.SAFE],
  ];
  for (const [time, state] of table) {
    assert.equal(resolveXStocksState(KOX, observe("KOx", pending, time), TEST_POLICY).state, state, String(time - t));
  }
});
