/**
 * One-sided reroute cost policy: `additionalCostBps <= maxAdditionalCostBps`.
 * A worse alternative is limited; a better one always passes the economic
 * bound but still requires exact consent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import {
  Decision,
  ExecutionEligibility,
  RepresentationState,
  StateSource,
  compareQuotes,
  decideExecution,
  findRepresentationBySymbol,
  grantConsent,
  type ChainObservation,
  type ConsentRecord,
  type EconomicState,
  type NormalizedQuote,
  type ResolvedRepresentationState,
} from "../src/index.ts";
import { TEST_POLICY, TEST_QUOTE_CONTEXT } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOON = findRepresentationBySymbol("KOon")!;
const POLICY = { maxAdditionalCostBps: 25n };
const SLOT = 500n;
const INPUT_RAW = 5_000_000n;
/** Preferred output; both sides use 6 decimals and multiplier 1, so bps are exact raw ratios. */
const P = 1_000_000n;
const ONE = Buffer.from(new Float64Array([1]).buffer).toString("hex");

const stateOf = (mint: string): EconomicState => ({ mint, decimals: 6, multiplierHex: ONE, newMultiplierHex: ONE, effectiveTimestamp: 0n, phase: ActivationPhase.Activated, paused: null });

function resolved(mint: string, symbol: string, issuer: "xStocks" | "Ondo", state: RepresentationState): ResolvedRepresentationState {
  const one = new Uint8Array(new Float64Array([1]).buffer);
  const chain: ChainObservation = { kind: "decoded", mint, slot: SLOT, blockTime: null, observedAt: null, chainUnixTimestamp: 1n, decimals: 6, paused: null, protectedState: { multiplier: one, newMultiplier: one, newMultiplierEffectiveTimestamp: 0n }, hasScheduledChange: false, phase: ActivationPhase.Activated };
  return { underlying: "KO", issuer, symbol, mint, state, stateSource: StateSource.CHAIN, chainState: state, apiState: null, slot: SLOT, blockTime: null, observedAt: null, reason: `test ${state}`, chainObservation: chain, apiObservation: null, transitionPolicy: TEST_POLICY };
}
const preferred = resolved(KOX.mint, "KOx", "xStocks", RepresentationState.TRANSITION);
const alternative = resolved(KOON.mint, "KOon", "Ondo", RepresentationState.SAFE);
const quote = (mint: string, issuer: "xStocks" | "Ondo", outputRaw: bigint): NormalizedQuote => ({ ...TEST_QUOTE_CONTEXT, underlying: "KO", issuer, mint, inputRaw: INPUT_RAW, outputRaw, state: stateOf(mint) });

function evaluate(alternativeOut: bigint, consent: (ReturnType<typeof setup>["grant"]) | ConsentRecord | null = null, currentSlot = SLOT) {
  const s = setup(alternativeOut);
  const record = typeof consent === "function" ? consent() : consent;
  return { ...s, decision: decideExecution({ ...s.input, consent: record, currentSlot }) };
}
function setup(alternativeOut: bigint) {
  const altQuote = quote(KOON.mint, "Ondo", alternativeOut);
  const comparison = compareQuotes(quote(KOX.mint, "xStocks", P), altQuote);
  const input = {
    preferred,
    alternative,
    reroutePolicy: POLICY,
    inputRaw: INPUT_RAW,
    comparison,
    routes: { preferred: null, alternative: { mint: KOON.mint, status: "AVAILABLE" as const, quote: altQuote, source: "test", detail: null } },
    currentSlot: SLOT,
  };
  const grant = (maxAdditionalCostBps = 25n, validForSlots = 10n) => {
    const off = decideExecution({ ...input, consent: null });
    return grantConsent({ decision: off.stateDecision, comparison, reroutePolicy: POLICY, currentSlot: SLOT, maxAdditionalCostBps, validForSlots });
  };
  return { comparison, input, grant };
}

test("worse alternatives: +24 and +25 bps are acceptable, +26 is rejected (max 25)", () => {
  const cases: [string, bigint, bigint, Decision][] = [
    ["+24 bps", 997_600n, 24n, Decision.REQUIRES_CONSENT],
    ["+25 bps", 997_500n, 25n, Decision.REQUIRES_CONSENT],
    ["+26 bps", 997_400n, 26n, Decision.NO_ACCEPTABLE_ROUTE],
  ];
  for (const [label, out, bps, expected] of cases) {
    const { comparison, decision } = evaluate(out);
    assert.equal(comparison.additionalCostBps, bps, label);
    assert.deepEqual(comparison.economicEffect, { kind: "ADDITIONAL_COST", bps }, label);
    assert.equal(decision.stateDecision.decision, expected, label);
    if (expected === Decision.NO_ACCEPTABLE_ROUTE) {
      assert.deepEqual([decision.stateDecision.reasonCode, decision.executionEligibility], ["ALTERNATIVE_OUTSIDE_TOLERANCE", ExecutionEligibility.ALTERNATIVE_OUTSIDE_TOLERANCE], label);
    }
  }
});

test("conservative rounding never makes a worse alternative look cheaper: +25.01 bps rounds to 26 and is rejected", () => {
  const { comparison, decision } = evaluate(997_499n);
  assert.equal(comparison.additionalCostBps, 26n);
  assert.equal(decision.stateDecision.decision, Decision.NO_ACCEPTABLE_ROUTE);
  // A sub-basis-point cost still counts as 1 bps, never 0.
  assert.deepEqual(evaluate(999_999n).comparison.economicEffect, { kind: "ADDITIONAL_COST", bps: 1n });
});

test("equal and better alternatives always pass the maximum-loss check, and still require consent", () => {
  const cases: [string, bigint, { kind: string; bps: bigint }][] = [
    ["equal", P, { kind: "ECONOMICALLY_EQUAL", bps: 0n }],
    ["better by 1 bps", 1_000_100n, { kind: "BETTER_VALUE", bps: 1n }],
    ["better by 25 bps", 1_002_500n, { kind: "BETTER_VALUE", bps: 25n }],
    ["better by 100 bps", 1_010_000n, { kind: "BETTER_VALUE", bps: 100n }],
    ["better by 25.9 bps (benefit rounded down)", 1_002_590n, { kind: "BETTER_VALUE", bps: 25n }],
    ["twice the shares (10,000 bps better)", 2_000_000n, { kind: "BETTER_VALUE", bps: 10_000n }],
    ["better by under 1 bps", 1_000_001n, { kind: "BETTER_VALUE", bps: 0n }],
  ];
  for (const [label, out, effect] of cases) {
    const { comparison, decision } = evaluate(out);
    assert.deepEqual(comparison.economicEffect, effect, label);
    assert.ok(comparison.additionalCostBps <= 0n, label);
    // Benefit never implies an automatic issuer switch.
    assert.deepEqual([decision.stateDecision.decision, decision.executionEligibility], [Decision.REQUIRES_CONSENT, ExecutionEligibility.CONSENT_REQUIRED], label);
    assert.deepEqual(decision.stateDecision.disclosure?.economicEffect, effect, label);
  }
  // Even a zero-loss policy offers a better alternative for consent.
  const s = setup(2_000_000n);
  const strict = decideExecution({ ...s.input, reroutePolicy: { maxAdditionalCostBps: 0n }, consent: null });
  assert.equal(strict.stateDecision.decision, Decision.REQUIRES_CONSENT);
});

test("a better alternative with exact valid consent is USE_ALTERNATIVE / EXECUTABLE", () => {
  for (const out of [1_000_100n, 2_000_000n]) {
    const s = setup(out);
    // Even a user who accepts zero additional cost can consent to a better alternative.
    const consent = s.grant(0n);
    assert.ok(consent.additionalCostBps < 0n);
    const d = decideExecution({ ...s.input, consent });
    assert.deepEqual([d.stateDecision.decision, d.stateDecision.reasonCode, d.executionEligibility], [Decision.USE_ALTERNATIVE, "CONSENT_GIVEN", ExecutionEligibility.EXECUTABLE]);
  }
});

test("a better alternative with wrong, expired or consumed consent is not executable", () => {
  const better = setup(1_010_000n);
  const otherComparison = setup(1_020_000n);
  const wrong = otherComparison.grant();
  const cases: [string, ReturnType<typeof decideExecution>, string][] = [
    ["consent for another comparison", decideExecution({ ...better.input, consent: wrong }), "COMPARISON_MISMATCH"],
    ["expired consent", decideExecution({ ...better.input, consent: better.grant(25n, 10n), currentSlot: SLOT + 11n }), "EXPIRED"],
    ["copied consent", decideExecution({ ...better.input, consent: { ...better.grant() } }), "NOT_ISSUED"],
  ];
  for (const [label, d, code] of cases) {
    assert.equal(d.executionEligibility, ExecutionEligibility.CONSENT_INVALID, label);
    assert.ok(d.consentIssues.some((i) => i.code === code), `${label}: ${d.consentIssues.map((i) => i.code).join(",")}`);
  }
});

test("the user's own maximum is one-sided too: +20 bps against a 19 bps acceptance is refused, better passes", () => {
  const worse = setup(998_000n);
  assert.equal(worse.comparison.additionalCostBps, 20n);
  assert.throws(() => worse.grant(19n), (e) => e instanceof Error && /COST_ABOVE_ACCEPTED_MAX/.test(e.message));
  assert.equal(decideExecution({ ...worse.input, consent: worse.grant(20n) }).executionEligibility, ExecutionEligibility.EXECUTABLE);
});

test("zero alternative output is rejected regardless of the cost metric or policy", () => {
  for (const reroutePolicy of [POLICY, { maxAdditionalCostBps: 10_000n }, { maxAdditionalCostBps: 1_000_000n }]) {
    const s = setup(0n);
    const d = decideExecution({ ...s.input, reroutePolicy, consent: null });
    assert.deepEqual([d.stateDecision.decision, d.executionEligibility], [Decision.NO_ACCEPTABLE_ROUTE, ExecutionEligibility.ALTERNATIVE_OUTSIDE_TOLERANCE]);
    assert.match(d.stateDecision.reason, /delivers nothing/);
  }
});
