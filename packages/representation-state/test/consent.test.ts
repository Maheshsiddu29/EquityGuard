/**
 * EG-SEC-H02: consent is an opaque, single-use, expiring record for ONE exact
 * disclosure, and the one-sided reroute cost limit is a hard bound consent cannot lift.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConsentError,
  Decision,
  ExecutionEligibility,
  ExecutionPlanError,
  compareQuotes,
  createExecutionPlan,
  decideExecution,
  economicStateOf,
  findRepresentationBySymbol,
  grantConsent,
  observeMintAccount,
  resolveOndoState,
  resolveXStocksState,
  routeIdentity,
  type ConsentRecord,
  type NormalizedQuote,
  type QuoteComparison,
  type ResolvedRepresentationState,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOON = findRepresentationBySymbol("KOon")!;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const T = 1_789_432_200n;
const NOW = T - 14n;
const INPUT_RAW = 5_000_000n;
const SLOT = 1_000n;
const POLICY = { maxAdditionalCostBps: 25n };
const KOX_OUT = 5_450_395n;
/** About 10 bps below KOX_OUT in share-equivalents (KOx 8 decimals, KOon 9). */
const KOON_OUT = 54_153_839n;

const observe = (mint: string, data: Uint8Array) => observeMintAccount({ mint, owner: TOKEN_2022, data, slot: SLOT, blockTime: null, observedAt: null, chainUnixTimestamp: NOW });
const KOX_DATA = withScaledUi(mainnetMint("KOx"), { multiplier: 1.0183317967386898, newMultiplier: 1.0225601246249238, effectiveTimestamp: T });
const KOON_DATA = withScaledUi(mainnetMint("KOon"), { multiplier: 1.0238905041551842, newMultiplier: 1.0238905041551842, effectiveTimestamp: T - 1556n });
const kox = resolveXStocksState(KOX, observe(KOX.mint, KOX_DATA), TEST_POLICY);
const koon = (data = KOON_DATA) => resolveOndoState(KOON, { chain: observe(KOON.mint, data), api: null }, TEST_POLICY);

const route = (mint: string, venue = "Whirlpool") => routeIdentity("TEST_ROUTE", [{ venue, poolId: `${venue}Pool`, inputMint: USDC, outputMint: mint, percent: 100 }]);
function quote(r: ResolvedRepresentationState, outputRaw: bigint, overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return { underlying: r.underlying, issuer: r.issuer, inputMint: USDC, mint: r.mint, inputRaw: INPUT_RAW, outputRaw, minOutputRaw: null, route: route(r.mint), quotedAt: null, contextSlot: SLOT, state: economicStateOf(r.chainObservation)!, ...overrides };
}

interface Trade {
  alternative: ResolvedRepresentationState;
  comparison: QuoteComparison;
  alternativeQuote: NormalizedQuote;
  inputRaw: bigint;
}
function trade(overrides: { koxOut?: bigint; koonOut?: bigint; alternative?: ResolvedRepresentationState; altQuote?: Partial<NormalizedQuote>; inputRaw?: bigint; policy?: { maxAdditionalCostBps: bigint } } = {}): Trade {
  const alternative = overrides.alternative ?? koon();
  const inputRaw = overrides.inputRaw ?? INPUT_RAW;
  const alternativeQuote = quote(alternative, overrides.koonOut ?? KOON_OUT, { inputRaw, ...overrides.altQuote });
  const comparison = compareQuotes(quote(kox, overrides.koxOut ?? KOX_OUT, { inputRaw }), alternativeQuote);
  return { alternative, comparison, alternativeQuote, inputRaw };
}
function evaluate(t: Trade, consent: ConsentRecord | null, currentSlot = SLOT, policy = POLICY) {
  return decideExecution({
    preferred: kox,
    alternative: t.alternative,
    reroutePolicy: policy,
    inputRaw: t.inputRaw,
    comparison: t.comparison,
    routes: { preferred: null, alternative: { mint: t.alternative.mint, status: "AVAILABLE", quote: t.alternativeQuote, source: "test", detail: null } },
    consent,
    currentSlot,
  });
}
function consentFor(t: Trade, maxAdditionalCostBps = 20n, validForSlots = 10n): ConsentRecord {
  const off = evaluate(t, null);
  assert.equal(off.stateDecision.decision, Decision.REQUIRES_CONSENT);
  return grantConsent({ decision: off.stateDecision, comparison: t.comparison, reroutePolicy: POLICY, currentSlot: SLOT, maxAdditionalCostBps, validForSlots });
}
const issues = (d: ReturnType<typeof evaluate>): string[] => d.consentIssues.map((i) => i.code);

test("exact consent to the shown disclosure authorizes the reroute", () => {
  const t = trade();
  const consent = consentFor(t);
  assert.equal(consent.additionalCostBps, t.comparison.additionalCostBps);
  assert.ok(consent.additionalCostBps > 0n && consent.additionalCostBps <= 20n);
  assert.ok(Object.isFrozen(consent));
  assert.match(consent.consentId, /^[0-9a-f]{64}$/);
  const d = evaluate(t, consent);
  assert.deepEqual([d.stateDecision.decision, d.stateDecision.reasonCode, d.executionEligibility], [Decision.USE_ALTERNATIVE, "CONSENT_GIVEN", ExecutionEligibility.EXECUTABLE]);
  assert.equal(d.consent, consent);
});

test("a boolean, a copied record or a deserialized record is not consent", () => {
  const t = trade();
  const real = consentFor(t);
  const fakes: unknown[] = [true, { allowCrossIssuerReroute: true }, { ...real }, JSON.parse(JSON.stringify(real, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))];
  for (const fake of fakes) {
    const d = evaluate(t, fake as ConsentRecord);
    assert.deepEqual([d.stateDecision.decision, d.executionEligibility, issues(d)], [Decision.REQUIRES_CONSENT, ExecutionEligibility.CONSENT_INVALID, ["NOT_ISSUED"]]);
  }
  // A stray legacy flag on the input is ignored: still only REQUIRES_CONSENT.
  const legacy = decideExecution({ ...({ policy: { allowCrossIssuerReroute: true } } as object), preferred: kox, alternative: t.alternative, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: t.comparison, routes: { preferred: null, alternative: null }, consent: null, currentSlot: SLOT } as Parameters<typeof decideExecution>[0]);
  assert.deepEqual([legacy.stateDecision.decision, legacy.executionEligibility], [Decision.REQUIRES_CONSENT, ExecutionEligibility.CONSENT_REQUIRED]);
});

test("consent for comparison A never authorizes comparison B (amount, route, state, output)", () => {
  const consent = consentFor(trade());
  const cases: [string, Trade, string[]][] = [
    ["another output amount", trade({ koonOut: KOON_OUT - 1_000n }), ["COMPARISON_MISMATCH", "DISCLOSURE_MISMATCH", "QUOTE_MISMATCH"]],
    ["another input amount", trade({ inputRaw: INPUT_RAW * 2n, koxOut: KOX_OUT * 2n, koonOut: KOON_OUT * 2n }), ["COMPARISON_MISMATCH", "DISCLOSURE_MISMATCH", "TRADE_MISMATCH", "QUOTE_MISMATCH"]],
    ["another route", trade({ altQuote: { route: route(KOON.mint, "FluxBeam") } }), ["COMPARISON_MISMATCH", "DISCLOSURE_MISMATCH", "QUOTE_MISMATCH"]],
    ["another economic state", trade({ alternative: koon(withScaledUi(KOON_DATA, { multiplier: 1.0238905041551844, newMultiplier: 1.0238905041551844 })) }), ["COMPARISON_MISMATCH", "DISCLOSURE_MISMATCH", "QUOTE_MISMATCH"]],
  ];
  for (const [label, other, expected] of cases) {
    const d = evaluate(other, consent);
    assert.equal(d.executionEligibility, ExecutionEligibility.CONSENT_INVALID, label);
    for (const code of expected) assert.ok(issues(d).includes(code), `${label}: ${code} in ${issues(d).join(",")}`);
  }
});

test("the hard cost limit is enforced before consent: 10,000 bps, zero output and above-policy cost are never offered", () => {
  const cases: [string, Trade][] = [
    ["alternative delivers 1 raw unit (10,000 bps)", trade({ koonOut: 1n })],
    ["alternative delivers nothing", trade({ koonOut: 0n })],
    ["cost above the 5 bps policy", trade({ policy: { maxAdditionalCostBps: 5n } })],
  ];
  for (const [label, t] of cases) {
    const policy = label.includes("5 bps") ? { maxAdditionalCostBps: 5n } : POLICY;
    const d = evaluate(t, null, SLOT, policy);
    assert.deepEqual([d.stateDecision.decision, d.stateDecision.reasonCode, d.executionEligibility], [Decision.NO_ACCEPTABLE_ROUTE, "ALTERNATIVE_OUTSIDE_TOLERANCE", ExecutionEligibility.ALTERNATIVE_OUTSIDE_TOLERANCE], label);
    assert.throws(() => grantConsent({ decision: d.stateDecision, comparison: t.comparison, reroutePolicy: policy, currentSlot: SLOT, maxAdditionalCostBps: 10_000n, validForSlots: 10n }), (e) => e instanceof ConsentError && e.issues[0]?.code === "NOT_A_CONSENT_DECISION", label);
  }
});

test("consent cannot accept a cost above the user's own maximum", () => {
  const t = trade();
  assert.throws(() => consentFor(t, t.comparison.additionalCostBps - 1n), (e) => e instanceof ConsentError && e.issues.some((i) => i.code === "COST_ABOVE_ACCEPTED_MAX"));
});

test("consent expires at its slot", () => {
  const t = trade();
  const consent = consentFor(t, 20n, 10n);
  assert.equal(evaluate(t, consent, SLOT + 10n).executionEligibility, ExecutionEligibility.EXECUTABLE);
  const late = evaluate(t, consent, SLOT + 11n);
  assert.deepEqual([late.executionEligibility, issues(late)], [ExecutionEligibility.CONSENT_INVALID, ["EXPIRED"]]);
  // Planning after expiry is refused even for a decision evaluated in time.
  const inTime = evaluate(t, consent, SLOT + 5n);
  assert.throws(() => createExecutionPlan(inTime, "DEVNET_EXECUTION", { currentSlot: SLOT + 11n, freshness: { validForSlots: 100n } }), (e) => e instanceof ExecutionPlanError && e.code === "CONSENT_REJECTED" && /EXPIRED/.test(e.message));
});

test("consent is single-use: one plan, then it is consumed", () => {
  const t = trade();
  const consent = consentFor(t);
  const decision = evaluate(t, consent);
  const plan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n } });
  assert.equal(plan.consentId, consent.consentId);
  assert.throws(() => createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n } }), (e) => e instanceof ExecutionPlanError && e.code === "CONSENT_REJECTED" && /CONSUMED/.test(e.message));
  const again = evaluate(t, consent);
  assert.deepEqual([again.executionEligibility, issues(again)], [ExecutionEligibility.CONSENT_INVALID, ["CONSUMED"]]);
  // A fresh grant for the same disclosure is a new, distinct consent.
  assert.notEqual(consentFor(t).consentId, consent.consentId);
});
