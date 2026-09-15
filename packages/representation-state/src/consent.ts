/**
 * Reroute consent as an opaque, single-use, expiring capability.
 *
 * A `ConsentRecord` is what a user produces by accepting ONE exact
 * REQUIRES_CONSENT disclosure. It binds the comparison key (which covers both
 * exact quotes, routes, raw amounts and economic states), the disclosure
 * digest, the trade identity, the actual conservative cost and the maximum
 * cost the user accepted, and it expires at a slot. Only `grantConsent` can
 * mint one: structurally identical or deserialized objects are not consent.
 * A record is consumed when an execution plan is created from it.
 *
 * A standing preference such as "allow issuer rerouting" is not consent and
 * has no representation here.
 */

import type { QuoteComparison } from "./compare.ts";
import { Decision, disclosureDigestOf, outsideTolerance, type DecisionResult, type ReroutePolicy } from "./decision.ts";
import { quoteKey } from "./quote-identity.ts";

export interface ConsentRecord {
  /** Random nonce identifying this grant. */
  readonly consentId: string;
  readonly comparisonKey: string;
  readonly disclosureDigest: string;
  readonly underlying: string;
  readonly preferredMint: string;
  readonly alternativeMint: string;
  readonly inputRaw: bigint;
  readonly preferredQuoteKey: string;
  readonly alternativeQuoteKey: string;
  /** The disclosed conservative cost at grant time. */
  readonly costBps: bigint;
  /** The most the user accepted to pay for this switch. */
  readonly maxCostBps: bigint;
  readonly issuedAtSlot: bigint;
  /** Last slot at which the consent may be used (inclusive). */
  readonly expiresAtSlot: bigint;
}

export type ConsentErrorCode =
  | "NOT_ISSUED"
  | "CONSUMED"
  | "EXPIRED"
  | "NOT_A_CONSENT_DECISION"
  | "COMPARISON_MISMATCH"
  | "DISCLOSURE_MISMATCH"
  | "TRADE_MISMATCH"
  | "QUOTE_MISMATCH"
  | "COST_MISMATCH"
  | "COST_ABOVE_ACCEPTED_MAX"
  | "OUTSIDE_POLICY_TOLERANCE"
  | "INVALID_GRANT";

export interface ConsentIssue {
  readonly code: ConsentErrorCode;
  readonly detail: string;
}

export class ConsentError extends Error {
  readonly issues: readonly ConsentIssue[];

  constructor(issues: readonly ConsentIssue[]) {
    super(`consent rejected: ${issues.map((i) => `${i.code} (${i.detail})`).join("; ")}`);
    this.name = "ConsentError";
    this.issues = issues;
  }
}

const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ConsentContext {
  /** The REQUIRES_CONSENT decision for the current evaluation. */
  readonly decision: DecisionResult;
  /** The comparison presented for the current evaluation. */
  readonly comparison: QuoteComparison;
  readonly reroutePolicy: ReroutePolicy;
  readonly currentSlot: bigint;
}

/**
 * Every reason `consent` does not authorize a reroute for this exact
 * decision, comparison and slot; empty when it does. Does not consume.
 */
export function consentIssues(consent: ConsentRecord, context: ConsentContext): readonly ConsentIssue[] {
  const out: ConsentIssue[] = [];
  const add = (code: ConsentErrorCode, detail: string) => out.push({ code, detail });
  if (typeof consent !== "object" || consent === null || !issued.has(consent)) {
    return [{ code: "NOT_ISSUED", detail: "consent records can only come from grantConsent" }];
  }
  if (consumed.has(consent)) add("CONSUMED", `consent ${consent.consentId} was already used`);
  if (context.currentSlot > consent.expiresAtSlot) add("EXPIRED", `slot ${context.currentSlot} > expiresAtSlot ${consent.expiresAtSlot}`);
  const { decision, comparison } = context;
  const disclosure = decision.disclosure;
  if (decision.decision !== Decision.REQUIRES_CONSENT || !disclosure) {
    add("NOT_A_CONSENT_DECISION", `decision is ${decision.decision}`);
    return out;
  }
  if (consent.comparisonKey !== comparison.comparisonKey || disclosure.comparisonKey !== comparison.comparisonKey) {
    add("COMPARISON_MISMATCH", "consent was given to a different comparison");
  }
  if (consent.disclosureDigest !== disclosure.disclosureDigest || disclosureDigestOf(disclosure) !== disclosure.disclosureDigest) {
    add("DISCLOSURE_MISMATCH", "consent was given to a different disclosure");
  }
  if (
    consent.underlying !== comparison.underlying ||
    consent.preferredMint !== comparison.preferredMint ||
    consent.alternativeMint !== comparison.alternativeMint ||
    consent.inputRaw !== comparison.inputRaw
  ) {
    add("TRADE_MISMATCH", "underlying, representations or input amount differ");
  }
  if (consent.preferredQuoteKey !== quoteKey(comparison.preferredQuote) || consent.alternativeQuoteKey !== quoteKey(comparison.alternativeQuote)) {
    add("QUOTE_MISMATCH", "quotes, routes or economic states differ from the consented ones");
  }
  if (consent.costBps !== comparison.conservativeCostDeltaBps) add("COST_MISMATCH", `${consent.costBps} != ${comparison.conservativeCostDeltaBps} bps`);
  if (comparison.conservativeCostDeltaBps > consent.maxCostBps) {
    add("COST_ABOVE_ACCEPTED_MAX", `${comparison.conservativeCostDeltaBps} bps > accepted ${consent.maxCostBps} bps`);
  }
  const policy = outsideTolerance(comparison, context.reroutePolicy);
  if (policy || comparison.toleranceBps !== context.reroutePolicy.maxCostBps) {
    add("OUTSIDE_POLICY_TOLERANCE", policy ?? "comparison tolerance differs from the reroute policy");
  }
  return out;
}

/**
 * The user accepts exactly the disclosure in `context.decision`, paying at
 * most `maxCostBps`, for `validForSlots` slots from `context.currentSlot`.
 * Throws `ConsentError` if the grant would not authorize this very decision.
 */
export function grantConsent(context: ConsentContext & { readonly maxCostBps: bigint; readonly validForSlots: bigint }): ConsentRecord {
  if (context.maxCostBps < 0n || context.validForSlots <= 0n) {
    throw new ConsentError([{ code: "INVALID_GRANT", detail: "maxCostBps must be >= 0 and validForSlots > 0" }]);
  }
  const { decision, comparison } = context;
  const disclosure = decision.disclosure;
  if (decision.decision !== Decision.REQUIRES_CONSENT || !disclosure) {
    throw new ConsentError([{ code: "NOT_A_CONSENT_DECISION", detail: `decision is ${decision.decision}` }]);
  }
  const record: ConsentRecord = Object.freeze({
    consentId: nonce(),
    comparisonKey: disclosure.comparisonKey,
    disclosureDigest: disclosure.disclosureDigest,
    underlying: comparison.underlying,
    preferredMint: comparison.preferredMint,
    alternativeMint: comparison.alternativeMint,
    inputRaw: comparison.inputRaw,
    preferredQuoteKey: quoteKey(comparison.preferredQuote),
    alternativeQuoteKey: quoteKey(comparison.alternativeQuote),
    costBps: comparison.conservativeCostDeltaBps,
    maxCostBps: context.maxCostBps,
    issuedAtSlot: context.currentSlot,
    expiresAtSlot: context.currentSlot + context.validForSlots,
  });
  issued.add(record);
  const issues = consentIssues(record, context);
  if (issues.length > 0) {
    consumed.add(record);
    throw new ConsentError(issues);
  }
  return record;
}

/** Verifies and consumes in one step; throws unless the consent authorizes this exact reroute now. */
export function consumeConsent(consent: ConsentRecord, context: ConsentContext): void {
  const issues = consentIssues(consent, context);
  if (issues.length > 0) throw new ConsentError(issues);
  consumed.add(consent);
}
