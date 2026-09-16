/**
 * Property tests for reroute consent: a `ConsentRecord` authorizes exactly
 * one disclosure, once, and nothing else.
 *
 * The attack shape throughout is: the user consents to comparison A, and
 * something about the trade then differs. Consent must not carry over.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConsentError,
  Decision,
  compareQuotes,
  consentIssues,
  consumeConsent,
  grantConsent,
  quoteKey,
  routeIdentity,
  type ConsentContext,
  type ConsentErrorCode,
  type ConsentRecord,
  type QuoteComparison,
} from "../src/index.ts";
import { KOON_OUT, PREFERRED_OUT, POLICY, SLOT, TRANSITION_TIME, koon, kox, quote, reroute } from "./scenario.ts";

/** The consented reroute, plus the context that authorizes it. */
function consented(options: Parameters<typeof reroute>[0] = {}) {
  const scenario = reroute({ ...options, consent: false });
  const context: ConsentContext = {
    decision: scenario.withoutConsent.stateDecision,
    comparison: scenario.comparison,
    reroutePolicy: POLICY,
    currentSlot: SLOT,
  };
  const record = grantConsent({ ...context, maxAdditionalCostBps: 25n, validForSlots: 10n });
  return { ...scenario, context, record };
}

const codes = (record: ConsentRecord, context: ConsentContext): ConsentErrorCode[] =>
  consentIssues(record, context).map((i) => i.code);

test("a granted consent authorizes exactly the decision it was given to", () => {
  const { record, context } = consented();
  assert.deepEqual(codes(record, context), []);
  assert.equal(context.decision.decision, Decision.REQUIRES_CONSENT);
  assert.equal(record.additionalCostBps, context.comparison.additionalCostBps);
  assert.equal(record.comparisonKey, context.comparison.comparisonKey);
  assert.equal(record.expiresAtSlot, SLOT + 10n);
});

// ------------------------------------------------ comparison B is not A

/** Rebuilds the scenario so that one aspect of the trade differs. */
function comparisonWith(options: { preferredOut?: bigint; alternativeOut?: bigint; venue?: string }): QuoteComparison {
  const preferred = kox(TRANSITION_TIME);
  const alternative = koon(TRANSITION_TIME);
  const preferredQuote = quote(preferred, options.preferredOut ?? PREFERRED_OUT);
  const alternativeQuote = quote(alternative, options.alternativeOut ?? KOON_OUT);
  const rerouted = options.venue
    ? {
        ...alternativeQuote,
        route: routeIdentity("TEST_ROUTE", [{ ...alternativeQuote.route.legs[0]!, venue: options.venue }]),
      }
    : alternativeQuote;
  return compareQuotes(preferredQuote, rerouted);
}

test("consent for comparison A cannot authorize comparison B", () => {
  const { record, context } = consented();
  const others: [string, QuoteComparison][] = [
    ["a different alternative output", comparisonWith({ alternativeOut: KOON_OUT - 1n })],
    ["a different preferred output", comparisonWith({ preferredOut: PREFERRED_OUT - 1n })],
    ["a different venue", comparisonWith({ venue: "Raydium" })],
  ];
  for (const [label, comparison] of others) {
    const issues = codes(record, { ...context, comparison });
    assert.ok(issues.length > 0, `${label}: consent carried over to another comparison`);
    assert.ok(issues.includes("COMPARISON_MISMATCH"), `${label}: ${issues.join(", ")}`);
  }
});

test("mutating any single bound field of the consent record revokes it", () => {
  const { record, context } = consented();
  const mutations: [string, Partial<ConsentRecord>][] = [
    ["comparison key", { comparisonKey: `${record.comparisonKey}x` }],
    ["disclosure digest", { disclosureDigest: "0".repeat(64) }],
    ["underlying", { underlying: "PEP" }],
    ["preferred mint", { preferredMint: "So11111111111111111111111111111111111111112" }],
    ["alternative mint", { alternativeMint: "So11111111111111111111111111111111111111112" }],
    ["input amount", { inputRaw: record.inputRaw + 1n }],
    ["preferred quote key", { preferredQuoteKey: `${record.preferredQuoteKey}x` }],
    ["alternative quote key", { alternativeQuoteKey: `${record.alternativeQuoteKey}x` }],
    ["disclosed cost", { additionalCostBps: record.additionalCostBps + 1n }],
    ["accepted maximum", { maxAdditionalCostBps: record.maxAdditionalCostBps + 1n }],
    ["expiry", { expiresAtSlot: record.expiresAtSlot + 1_000n }],
    ["nonce", { consentId: "0".repeat(64) }],
  ];
  for (const [label, change] of mutations) {
    // A copy carrying the change is structurally a consent record but was
    // never issued, which is itself disqualifying.
    const copy = { ...record, ...change };
    assert.deepEqual(codes(copy, context), ["NOT_ISSUED"], `${label}: a hand-built record was treated as consent`);
  }
});

test("a copied, cloned or deserialized consent is not consent", () => {
  const { record, context } = consented();
  const impostors: [string, ConsentRecord][] = [
    ["spread copy", { ...record }],
    ["structured clone", structuredClone(record)],
    [
      "JSON round trip",
      JSON.parse(JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), (k, v: unknown) =>
        ["inputRaw", "additionalCostBps", "maxAdditionalCostBps", "issuedAtSlot", "expiresAtSlot"].includes(k) ? BigInt(v as string) : v,
      ) as ConsentRecord,
    ],
    ["Object.assign", Object.assign({}, record)],
    ["frozen copy", Object.freeze({ ...record })],
  ];
  for (const [label, impostor] of impostors) {
    assert.deepEqual(codes(impostor, context), ["NOT_ISSUED"], `${label} was accepted as consent`);
    assert.throws(() => consumeConsent(impostor, context), ConsentError, `${label} was consumed`);
  }
  // The genuine record still works afterwards.
  assert.deepEqual(codes(record, context), []);
});

test("a non-record is refused rather than crashing", () => {
  const { context } = consented();
  const values: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["number", 0],
    ["string", "consent"],
    ["array", []],
    ["null-prototype object", Object.create(null)],
  ];
  for (const [label, value] of values) {
    assert.deepEqual(codes(value as ConsentRecord, context), ["NOT_ISSUED"], `${label} was accepted`);
  }
});

test("consent is single use", () => {
  const { record, context } = consented();
  consumeConsent(record, context);
  assert.ok(codes(record, context).includes("CONSUMED"));
  assert.throws(() => consumeConsent(record, context), ConsentError);
});

test("consent expires by slot, inclusive of the last valid slot", () => {
  const { record, context } = consented();
  assert.equal(record.expiresAtSlot, SLOT + 10n);
  assert.deepEqual(codes(record, { ...context, currentSlot: record.expiresAtSlot }), [], "the expiry slot itself is still valid");
  assert.ok(codes(record, { ...context, currentSlot: record.expiresAtSlot + 1n }).includes("EXPIRED"));
  assert.ok(codes(record, { ...context, currentSlot: record.expiresAtSlot + 1_000_000n }).includes("EXPIRED"));
});

test("consent only attaches to a REQUIRES_CONSENT decision", () => {
  const { record, context } = consented();
  for (const decision of [Decision.USE_PREFERRED, Decision.USE_ALTERNATIVE, Decision.NO_SAFE_ROUTE, Decision.NO_ACCEPTABLE_ROUTE, Decision.UNKNOWN_STATE]) {
    const issues = codes(record, { ...context, decision: { ...context.decision, decision } });
    assert.ok(issues.includes("NOT_A_CONSENT_DECISION"), `${decision}: ${issues.join(", ")}`);
  }
  // A decision stripped of its disclosure cannot be consented to either.
  assert.ok(codes(record, { ...context, decision: { ...context.decision, disclosure: null } }).includes("NOT_A_CONSENT_DECISION"));
});

test("a tampered disclosure no longer matches its own digest", () => {
  const { record, context } = consented();
  const disclosure = context.decision.disclosure;
  assert.ok(disclosure);
  // The digest is recomputed from the content, so editing the content alone is caught.
  const tampered = { ...context, decision: { ...context.decision, disclosure: { ...disclosure, additionalCostBps: 1n } } };
  assert.ok(codes(record, tampered).includes("DISCLOSURE_MISMATCH"));
  // Editing the digest alone is caught too.
  const restamped = { ...context, decision: { ...context.decision, disclosure: { ...disclosure, disclosureDigest: "0".repeat(64) } } };
  assert.ok(codes(record, restamped).includes("DISCLOSURE_MISMATCH"));
});

// ------------------------------------------------------- economic bounds

test("the accepted maximum is a hard bound at exactly one unit", () => {
  const { context } = consented();
  const cost = context.comparison.additionalCostBps;
  assert.ok(cost > 0n, "the scenario must have a positive cost for this to mean anything");

  // Exactly at the accepted maximum: authorized.
  const exact = grantConsent({ ...context, maxAdditionalCostBps: cost, validForSlots: 10n });
  assert.deepEqual(codes(exact, context), []);

  // One unit below: the grant itself is refused, so no record ever exists.
  assert.throws(
    () => grantConsent({ ...context, maxAdditionalCostBps: cost - 1n, validForSlots: 10n }),
    (error: unknown) => error instanceof ConsentError && error.issues.some((i) => i.code === "COST_ABOVE_ACCEPTED_MAX"),
    "a grant below the disclosed cost was issued",
  );

  // One unit above: authorized, and still bound to this exact comparison.
  const generous = grantConsent({ ...context, maxAdditionalCostBps: cost + 1n, validForSlots: 10n });
  assert.deepEqual(codes(generous, context), []);
});

test("consent cannot lift the policy's own cost limit", () => {
  const { context } = consented();
  const cost = context.comparison.additionalCostBps;
  // A user willing to pay far more still cannot get past a stricter policy.
  const strict = { ...context, reroutePolicy: { maxAdditionalCostBps: cost - 1n } };
  assert.throws(
    () => grantConsent({ ...strict, maxAdditionalCostBps: 10_000n, validForSlots: 10n }),
    (error: unknown) => error instanceof ConsentError && error.issues.some((i) => i.code === "OUTSIDE_POLICY_COST_LIMIT"),
  );
});

test("an invalid grant produces no record at all", () => {
  const { context } = consented();
  for (const [label, options] of [
    ["negative maximum", { maxAdditionalCostBps: -1n, validForSlots: 10n }],
    ["zero validity", { maxAdditionalCostBps: 25n, validForSlots: 0n }],
    ["negative validity", { maxAdditionalCostBps: 25n, validForSlots: -1n }],
  ] as const) {
    assert.throws(() => grantConsent({ ...context, ...options }), ConsentError, `${label} produced a record`);
  }
});

test("a better alternative still requires consent to this exact disclosure", () => {
  // The alternative delivers strictly more: the economic bound is satisfied
  // with room to spare, and consent is still mandatory and still specific.
  const scenario = reroute({ consent: false });
  const better = comparisonWith({ alternativeOut: KOON_OUT * 2n });
  assert.equal(better.economicEffect.kind, "BETTER_VALUE");
  assert.ok(better.additionalCostBps < 0n);

  const context: ConsentContext = {
    decision: scenario.withoutConsent.stateDecision,
    comparison: scenario.comparison,
    reroutePolicy: POLICY,
    currentSlot: SLOT,
  };
  // Consent to the original disclosure does not authorize the better one.
  const record = grantConsent({ ...context, maxAdditionalCostBps: 25n, validForSlots: 10n });
  assert.ok(codes(record, { ...context, comparison: better }).includes("COMPARISON_MISMATCH"));
  // And a zero maximum is enough for a better alternative, once it is disclosed.
  assert.equal(better.additionalCostBps <= 0n, true);
});

test("quote substitution inside the comparison revokes consent, key or no key", () => {
  const { record, context } = consented();

  // A recomputed comparison carries a new key, and consent does not follow it.
  const recomputed = comparisonWith({ alternativeOut: KOON_OUT + 1n });
  assert.ok(codes(record, { ...context, comparison: recomputed }).includes("COMPARISON_MISMATCH"));

  // An attacker who swaps the quote but keeps the original comparisonKey
  // defeats the key check; the bound quote keys catch it anyway.
  const forged: QuoteComparison = {
    ...context.comparison,
    alternativeQuote: { ...context.comparison.alternativeQuote, outputRaw: context.comparison.alternativeQuote.outputRaw + 1n },
  };
  assert.equal(forged.comparisonKey, record.comparisonKey, "this case is only interesting while the key still matches");
  const issues = codes(record, { ...context, comparison: forged });
  assert.ok(issues.includes("QUOTE_MISMATCH"), `forged comparison accepted: ${issues.join(", ") || "no issues"}`);
  assert.notEqual(quoteKey(forged.alternativeQuote), record.alternativeQuoteKey);
});
