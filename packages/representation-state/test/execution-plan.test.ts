/**
 * Quote-to-execution binding: the plan an executor consumes is the exact
 * quote, route, notional and economic state the decision engine used.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Decision,
  ExecutionEligibility,
  ExecutionPlanError,
  QuoteIdentityError,
  assertPlanFresh,
  canonicalKey,
  compareQuotes,
  consumeExecutionPlan,
  createExecutionPlan,
  decideExecution,
  grantConsent,
  economicStateOf,
  findRepresentationBySymbol,
  observeMintAccount,
  planDigestOf,
  quoteIdentityOf,
  quoteKey,
  quoteMismatches,
  resolveOndoState,
  resolveXStocksState,
  routeIdentity,
  verifyExecutionPlan,
  type ExecutionPlan,
  type NormalizedQuote,
  type QuoteMismatchCode,
  type ResolvedRepresentationState,
  type RouteObservation,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOON = findRepresentationBySymbol("KOon")!;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const T = 1_789_432_200n;
const INPUT_RAW = 5_000_000n;
const KOX_SCHEDULED = withScaledUi(mainnetMint("KOx"), { multiplier: 1.0183317967386898, newMultiplier: 1.0225601246249238, effectiveTimestamp: T });
const KOON_SAFE = withScaledUi(mainnetMint("KOon"), { multiplier: 1.0238905041551842, newMultiplier: 1.0238905041551842, effectiveTimestamp: T - 1556n });
const TRANSITION_TIME = T - 14n;

const observe = (mint: string, data: Uint8Array, time: bigint) => observeMintAccount({ mint, owner: TOKEN_2022, data, slot: 7n, blockTime: null, observedAt: null, chainUnixTimestamp: time });
const kox = (time: bigint) => resolveXStocksState(KOX, observe(KOX.mint, KOX_SCHEDULED, time), TEST_POLICY);
const koon = (time: bigint, data = KOON_SAFE) => resolveOndoState(KOON, { chain: observe(KOON.mint, data, time), api: null }, TEST_POLICY);

const whirlpool = (mint: string) => routeIdentity("TEST_ROUTE", [{ venue: "Whirlpool", poolId: "BG7f49R2sb2UBCMu3AHuDmgDRyzqVgeMpDEk9S9gvQhy", inputMint: USDC, outputMint: mint, percent: 100 }]);

function quote(r: ResolvedRepresentationState, outputRaw: bigint): NormalizedQuote {
  const state = economicStateOf(r.chainObservation);
  assert.ok(state);
  return { underlying: r.underlying, issuer: r.issuer, inputMint: USDC, mint: r.mint, inputRaw: INPUT_RAW, outputRaw, minOutputRaw: outputRaw - 1_000n, route: whirlpool(r.mint), quotedAt: "2026-09-15T04:22:16.045Z", contextSlot: 447157559n, state };
}
const route = (q: NormalizedQuote): RouteObservation => ({ mint: q.mint, status: "AVAILABLE", quote: q, source: "test", detail: null });

const POLICY = { maxAdditionalCostBps: 25n };
const SLOT = 100n;
/** KOon raw output about 10 bps below the KOx quote in share-equivalents. */
const KOON_OUT = 54_153_839n;

/** KOx in transition, KOon SAFE and quoted: the consented reroute is EXECUTABLE. */
function reroute(consent = true, alternativeRouteQuote?: NormalizedQuote) {
  const preferred = kox(TRANSITION_TIME);
  const alternative = koon(TRANSITION_TIME);
  const preferredQuote = quote(preferred, 5_450_395n);
  const alternativeQuote = quote(alternative, KOON_OUT);
  const comparison = compareQuotes(preferredQuote, alternativeQuote);
  const base = { preferred, alternative, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison, currentSlot: SLOT, routes: { preferred: route(preferredQuote), alternative: route(alternativeRouteQuote ?? alternativeQuote) } };
  const withoutConsent = decideExecution({ ...base, consent: null });
  if (!consent) return { preferred, alternative, preferredQuote, alternativeQuote, comparison, decision: withoutConsent };
  // The user accepts exactly this disclosure.
  const record = grantConsent({ decision: withoutConsent.stateDecision, comparison, reroutePolicy: POLICY, currentSlot: SLOT, maxAdditionalCostBps: 25n, validForSlots: 10n });
  return { preferred, alternative, preferredQuote, alternativeQuote, comparison, decision: decideExecution({ ...base, consent: record }) };
}

const codes = (expected: NormalizedQuote, actual: NormalizedQuote): QuoteMismatchCode[] => quoteMismatches(expected, actual).map((m) => m.code);

/** A stand-in downstream binding; the on-chain commitment is exercised in Rust/LiteSVM. */
const TEST_DOWNSTREAM = { adapterKind: "TOKEN_2022_TRANSFER_CHECKED" as const, commitmentHex: "a".repeat(64) };

test("1. an identical quote identity is accepted, including a structurally cloned copy", () => {
  const { alternativeQuote, comparison, decision } = reroute();
  assert.deepEqual(codes(alternativeQuote, structuredClone(alternativeQuote)), []);
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  assert.doesNotThrow(() => verifyExecutionPlan(plan, { quote: structuredClone(alternativeQuote), comparison: structuredClone(comparison) }));
  // The issuer label is not part of the identity.
  assert.deepEqual(codes(alternativeQuote, { ...alternativeQuote, issuer: "xStocks" }), []);
});

test("2-8. each substituted field is rejected with a precise code", () => {
  const { alternative, alternativeQuote: q, comparison, decision } = reroute();
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  const phaseChanged = { ...q, state: { ...q.state, phase: q.state.phase === 0 ? 1 : 0 } } as NormalizedQuote;
  const cases: [string, NormalizedQuote, QuoteMismatchCode[]][] = [
    ["2. outputRaw", { ...q, outputRaw: q.outputRaw + 1n }, ["OUTPUT_AMOUNT_CHANGED"]],
    ["3. inputRaw", { ...q, inputRaw: q.inputRaw + 1n }, ["INPUT_AMOUNT_CHANGED"]],
    ["4. route plan (same venue, split)", { ...q, route: routeIdentity("TEST_ROUTE", [{ ...q.route.legs[0]!, percent: 60 }, { ...q.route.legs[0]!, percent: 40 }]) }, ["VENUE_CHANGED", "ROUTE_CHANGED"]],
    ["4. provider route id", { ...q, route: { ...q.route, routeId: "provider:other" } }, ["ROUTE_CHANGED"]],
    ["5. venue", { ...q, route: routeIdentity("TEST_ROUTE", [{ ...q.route.legs[0]!, venue: "FluxBeam", poolId: "FLUXpool" }]) }, ["VENUE_CHANGED", "ROUTE_CHANGED"]],
    ["6. mint", { ...q, mint: KOX.mint }, ["OUTPUT_MINT_CHANGED"]],
    ["6. input mint", { ...q, inputMint: "So11111111111111111111111111111111111111112" }, ["INPUT_MINT_CHANGED"]],
    ["7. economic state", { ...q, state: economicStateOf(koon(TRANSITION_TIME, withScaledUi(KOON_SAFE, { multiplier: 1.03, newMultiplier: 1.03 })).chainObservation)! }, ["ECONOMIC_STATE_CHANGED"]],
    ["7. decimals", { ...q, state: { ...q.state, decimals: q.state.decimals + 1 } }, ["ECONOMIC_STATE_CHANGED"]],
    ["8. phase only", phaseChanged, ["PHASE_CHANGED"]],
    ["min output", { ...q, minOutputRaw: 0n }, ["MIN_OUTPUT_CHANGED"]],
    ["quote context", { ...q, quotedAt: "2026-09-15T04:23:00.000Z", contextSlot: 447157600n }, ["QUOTE_CONTEXT_CHANGED"]],
  ];
  for (const [label, substituted, expected] of cases) {
    assert.deepEqual(codes(q, substituted), expected, label);
    assert.throws(
      () => verifyExecutionPlan(plan, { quote: substituted, comparison }),
      (e) => e instanceof ExecutionPlanError && e.code === "QUOTE_SUBSTITUTED" && e.mismatches.map((m) => m.code).join() === expected.join(),
      label,
    );
  }
  assert.equal(alternative.symbol, "KOon");
});

test("8. a comparison whose quote state went stale by phase is not executable", () => {
  // Quotes built while KOx was pending just before T; at T the phase changed with identical bytes.
  const before = kox(T - 1n);
  const at = kox(T);
  const alternative = koon(T - 1n);
  const comparison = compareQuotes(quote(before, 5_450_395n), quote(alternative, KOON_OUT));
  const decision = decideExecution({ preferred: at, alternative, reroutePolicy: POLICY, consent: null, currentSlot: SLOT, inputRaw: INPUT_RAW, comparison, routes: { preferred: null, alternative: route(comparison.alternativeQuote as NormalizedQuote) } });
  assert.equal(decision.executionEligibility, ExecutionEligibility.STALE_COMPARISON);
  assert.throws(() => createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }), (e) => e instanceof ExecutionPlanError && e.code === "NOT_EXECUTABLE");
});

test("9. an execution plan is only created from an EXECUTABLE decision", () => {
  const consentOff = reroute(false).decision;
  assert.equal(consentOff.executionEligibility, ExecutionEligibility.CONSENT_REQUIRED);
  assert.throws(() => createExecutionPlan(consentOff, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }), (e) => e instanceof ExecutionPlanError && e.code === "NOT_EXECUTABLE");
  const forged = { ...reroute().decision, executableQuote: null };
  assert.throws(() => createExecutionPlan(forged, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }), (e) => e instanceof ExecutionPlanError && e.code === "NOT_EXECUTABLE");
});

test("10. a MAINNET_OBSERVATION environment can never produce a submit-capable plan", () => {
  const { decision } = reroute();
  assert.equal(decision.executionEligibility, ExecutionEligibility.EXECUTABLE);
  assert.throws(() => createExecutionPlan(decision, "MAINNET_OBSERVATION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }), (e) => e instanceof ExecutionPlanError && e.code === "OBSERVATION_ONLY_ENVIRONMENT");
});

test("11. the plan pins exactly the decision's quote, route, state and notional, and cannot be altered", () => {
  const { alternativeQuote, comparison, decision } = reroute();
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  assert.deepEqual(
    [plan.selectedRepresentation.mint, plan.inputRaw, plan.expectedOutputRaw, plan.minOutputRaw, plan.route, plan.economicState, plan.decision, plan.executionEligibility],
    [KOON.mint, INPUT_RAW, KOON_OUT, KOON_OUT - 1_000n, alternativeQuote.route, alternativeQuote.state, Decision.USE_ALTERNATIVE, "EXECUTABLE"],
  );
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.quote) && Object.isFrozen(plan.route.legs));
  assert.throws(() => {
    (plan as { expectedOutputRaw: bigint }).expectedOutputRaw = 1n;
  }, TypeError);
  const tampered = [
    { ...plan, expectedOutputRaw: 1n },
    { ...plan, economicState: { ...plan.economicState, decimals: plan.economicState.decimals + 1 } },
    { ...plan, route: whirlpool(KOX.mint) },
    { ...plan, selectedRepresentation: { ...plan.selectedRepresentation, mint: KOX.mint } },
    { ...plan, disclosure: { ...plan.disclosure!, additionalCostBps: 0n } },
  ];
  for (const t of tampered) {
    assert.throws(() => verifyExecutionPlan(t, { quote: alternativeQuote, comparison }), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_NOT_ISSUED");
  }
  // Mutating the caller's objects after planning does not change the plan.
  (alternativeQuote.route.legs[0] as { percent: number }).percent = 50;
  assert.equal(plan.route.legs[0]?.percent, 100);
});

test("12. a substituted route quote is not executable and cannot produce a plan", () => {
  const { alternativeQuote } = reroute();
  const substitute = { ...alternativeQuote, outputRaw: 5_500_000n, route: routeIdentity("TEST_ROUTE", [{ ...alternativeQuote.route.legs[0]!, venue: "Other", poolId: "OtherPool" }]) };
  const { decision } = reroute(true, substitute);
  assert.deepEqual([decision.stateDecision.decision, decision.executionEligibility], [Decision.USE_ALTERNATIVE, ExecutionEligibility.QUOTE_MISMATCH]);
  assert.deepEqual(decision.quoteMismatches.map((m) => m.code), ["OUTPUT_AMOUNT_CHANGED", "VENUE_CHANGED", "ROUTE_CHANGED"]);
  assert.throws(() => createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }), (e) => e instanceof ExecutionPlanError && e.code === "NOT_EXECUTABLE");
});

test("13. consent stays bound to the same disclosure and comparison", () => {
  const off = reroute(false);
  const on = reroute(true);
  assert.deepEqual(off.decision.stateDecision.disclosure, on.decision.stateDecision.disclosure);
  const plan = createExecutionPlan(on.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  assert.equal(plan.comparisonKey, on.comparison.comparisonKey);
  assert.equal(plan.disclosure?.comparisonKey, on.comparison.comparisonKey);
  // Another comparison (different alternative output) is not the one consent was given to.
  const other = compareQuotes(on.preferredQuote, { ...on.alternativeQuote, outputRaw: KOON_OUT - 3_000n });
  assert.throws(() => verifyExecutionPlan(plan, { quote: on.alternativeQuote, comparison: other }), (e) => e instanceof ExecutionPlanError && e.code === "COMPARISON_NOT_FOR_PLAN");
  assert.throws(() => verifyExecutionPlan(plan, { quote: on.alternativeQuote, comparison: null }), (e) => e instanceof ExecutionPlanError && e.code === "COMPARISON_NOT_FOR_PLAN");
  // The comparison key is a pure function of the two exact quotes.
  assert.equal(compareQuotes(on.preferredQuote, on.alternativeQuote).comparisonKey, on.comparison.comparisonKey);
  // A decision whose disclosure describes another comparison cannot be planned.
  const mismatched = { ...on.decision, stateDecision: { ...on.decision.stateDecision, disclosure: { ...on.decision.stateDecision.disclosure!, comparisonKey: other.comparisonKey } } };
  assert.throws(() => createExecutionPlan(mismatched, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }), (e) => e instanceof ExecutionPlanError && e.code === "DISCLOSURE_NOT_FOR_COMPARISON");
});

test("a SAFE preferred plan has no comparison and binds the preferred route quote", () => {
  const preferred = koon(TRANSITION_TIME);
  const q = quote(preferred, 5_000_000n);
  const decision = decideExecution({ preferred, alternative: null, reroutePolicy: POLICY, consent: null, currentSlot: SLOT, inputRaw: INPUT_RAW, comparison: null, routes: { preferred: route(q), alternative: null } });
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  assert.deepEqual([plan.decision, plan.comparisonKey, plan.disclosure, plan.expectedOutputRaw], [Decision.USE_PREFERRED, null, null, 5_000_000n]);
  assert.doesNotThrow(() => verifyExecutionPlan(plan, { quote: q, comparison: null }));
  assert.throws(() => verifyExecutionPlan(plan, { quote: { ...q, outputRaw: 1n }, comparison: null }), (e) => e instanceof ExecutionPlanError && e.code === "QUOTE_SUBSTITUTED");
});

test("M01: only createExecutionPlan issues plans; forged, copied and deserialized plans are refused", () => {
  const { alternativeQuote, comparison, decision } = reroute();
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  const presented = { quote: alternativeQuote, comparison };
  const { planDigest: _digest, ...content } = plan;
  const forgedContent = { ...content, expectedOutputRaw: 999_999_999n, quote: { ...content.quote, outputRaw: 999_999_999n } };
  const bigintJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));
  const forgeries: [string, unknown][] = [
    ["self-consistent forgery with a recomputed digest", { ...forgedContent, quoteKey: quoteKey(forgedContent.quote), planDigest: planDigestOf({ ...forgedContent, quoteKey: quoteKey(forgedContent.quote) }) }],
    ["structurally identical copy", { ...plan }],
    ["structured clone", structuredClone(plan)],
    ["JSON round trip", bigintJson(plan)],
  ];
  for (const [label, forged] of forgeries) {
    assert.throws(() => verifyExecutionPlan(forged as ExecutionPlan, presented), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_NOT_ISSUED", label);
    assert.throws(() => consumeExecutionPlan(forged as ExecutionPlan, presented), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_NOT_ISSUED", label);
  }
  assert.doesNotThrow(() => verifyExecutionPlan(plan, presented));
});

test("M01: nested plan content is frozen", () => {
  const { decision } = reroute();
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  const mutations: [string, () => void][] = [
    ["quote.outputRaw", () => ((plan.quote as { outputRaw: bigint }).outputRaw = 1n)],
    ["economicState.multiplierHex", () => ((plan.economicState as { multiplierHex: string }).multiplierHex = "000000000000f03f")],
    ["route.legs[0].venue", () => ((plan.route.legs[0] as { venue: string }).venue = "Other")],
    ["route.legs push", () => (plan.route.legs as unknown as unknown[]).push({})],
    ["disclosure.additionalCostBps", () => ((plan.disclosure as { additionalCostBps: bigint }).additionalCostBps = 0n)],
    ["selectedRepresentation.mint", () => ((plan.selectedRepresentation as { mint: string }).mint = KOX.mint)],
  ];
  for (const [label, mutate] of mutations) assert.throws(mutate, TypeError, label);
});

test("M03 / planDigest: plans are single-use, expire at a slot, and carry a SHA-256 commitment", () => {
  const { alternativeQuote, comparison, decision } = reroute();
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM });
  const presented = { quote: alternativeQuote, comparison };
  const { planDigest, ...content } = plan;
  assert.match(planDigest, /^[0-9a-f]{64}$/);
  assert.equal(planDigest, planDigestOf(content));
  assert.deepEqual([plan.createdAtSlot, plan.expiresAtSlot], [SLOT, SLOT + 100n]);
  assert.doesNotThrow(() => assertPlanFresh(plan, SLOT + 100n));
  assert.throws(() => assertPlanFresh(plan, SLOT + 101n), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_EXPIRED");
  consumeExecutionPlan(plan, presented);
  assert.throws(() => consumeExecutionPlan(plan, presented), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_CONSUMED");
  assert.throws(() => verifyExecutionPlan(plan, presented), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_CONSUMED");
  // Freshness must be explicit.
  for (const freshness of [undefined, { validForSlots: 0n }, { validForSlots: 100 }]) {
    const { decision: d } = reroute();
    assert.throws(() => createExecutionPlan(d, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness, downstream: TEST_DOWNSTREAM } as never), (e) => e instanceof ExecutionPlanError && e.code === "INVALID_FRESHNESS");
  }
  // Same content, same digest: two USE_PREFERRED plans from one decision at one slot.
  const preferred = koon(TRANSITION_TIME);
  const q = quote(preferred, 5_000_000n);
  const direct = decideExecution({ preferred, alternative: null, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: null, routes: { preferred: route(q), alternative: null }, consent: null, currentSlot: SLOT });
  const options = { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM };
  assert.equal(createExecutionPlan(direct, "DEVNET_EXECUTION", options).planDigest, createExecutionPlan(direct, "DEVNET_EXECUTION", options).planDigest);
});

test("L01: canonical encoding distinguishes runtime types and rejects ambiguous values", () => {
  const distinct = [5n, "5n", 5, "5", null, true, "true", [5n], ["5n"], { a: null }, {}];
  assert.equal(new Set(distinct.map((v) => canonicalKey(v))).size, distinct.length);
  for (const bad of [undefined, { a: undefined }, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1.5, 2 ** 53, new Uint8Array(1), new Date(0)]) {
    assert.throws(() => canonicalKey(bad), QuoteIdentityError, String(bad));
  }
  assert.equal(canonicalKey({ b: 1, a: 2 }), canonicalKey({ a: 2, b: 1 }));
  assert.notEqual(canonicalKey([1, 2]), canonicalKey([2, 1]));
  // Raw amounts must be bigints: a string or Number amount never matches and is rejected outright.
  const { alternativeQuote } = reroute();
  for (const outputRaw of ["54153839n", 54_153_839, "54153839"]) {
    const bad = { ...alternativeQuote, outputRaw } as unknown as NormalizedQuote;
    assert.throws(() => quoteMismatches(alternativeQuote, bad), QuoteIdentityError, String(outputRaw));
    assert.throws(() => quoteIdentityOf(bad), QuoteIdentityError, String(outputRaw));
  }
  const missingMin = { ...alternativeQuote } as Record<string, unknown>;
  delete missingMin.minOutputRaw;
  assert.throws(() => quoteMismatches(alternativeQuote, missingMin as unknown as NormalizedQuote), QuoteIdentityError);
});
