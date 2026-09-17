import assert from "node:assert/strict";
import { test } from "node:test";

import { EQUITY_GUARD_ERROR_CODES } from "@equityguard/guard-client";

import {
  ECONOMIC_STATE_ERRORS,
  INTENT_MISMATCH_ERRORS,
  blockReasonOf,
  fromGuardResult,
  fromRepresentationDecision,
  type ConsentDisclosureView,
} from "../src/decision.ts";

const ALL_ERRORS = Object.keys(EQUITY_GUARD_ERROR_CODES);

test("the adapter only names real on-chain guard errors, each in one group", () => {
  for (const name of [...ECONOMIC_STATE_ERRORS, ...INTENT_MISMATCH_ERRORS]) assert.ok(ALL_ERRORS.includes(name), `${name} is not an EquityGuardError`);
  assert.deepEqual(ECONOMIC_STATE_ERRORS.filter((n) => INTENT_MISMATCH_ERRORS.includes(n)), []);
});

test("a passing guard is ALLOW and every guard error blocks", () => {
  assert.deepEqual(fromGuardResult(null), { type: "ALLOW", guardResult: null });
  for (const name of ALL_ERRORS) {
    const decision = fromGuardResult(name);
    assert.equal(decision.type, "BLOCK", name);
  }
});

test("state changes and transaction changes are told apart", () => {
  for (const name of ["MultiplierChanged", "NewMultiplierChanged", "EffectiveTimestampChanged", "ActivationPhaseChanged", "InsideTransitionWindow"]) {
    assert.equal(blockReasonOf(name), "ECONOMIC_STATE_CHANGED", name);
  }
  for (const name of ["DownstreamCommitmentMismatch", "GuardNotFirst", "InvalidJupiterInstruction", "MintKeyMismatch"]) {
    assert.equal(blockReasonOf(name), "INTENT_MISMATCH", name);
  }
});

test("unknown, malformed or unsupported state fails closed", () => {
  for (const name of ["InvalidMintData", "InvalidMintOwner", "MissingScaledUiAmount", "ClockUnavailable", "ArithmeticOverflow", "UnsupportedVersion", "NotAGuardError", ""]) {
    assert.equal(blockReasonOf(name), "UNVERIFIABLE_STATE", name);
  }
});

const disclosure: ConsentDisclosureView = {
  fromSymbol: "KOx",
  fromIssuer: "xStocks",
  toSymbol: "KOon",
  toIssuer: "Ondo",
  additionalCostBps: "19",
  policyMaxAdditionalCostBps: "50",
  notice: "not identical",
  disclosureDigest: "00",
};

test("only an engine REQUIRES_CONSENT with a disclosure becomes a consent prompt", () => {
  assert.equal(fromRepresentationDecision("REQUIRES_CONSENT", "InsideTransitionWindow", disclosure).type, "REQUIRES_CONSENT");
  // Without a disclosure there is nothing to consent to.
  assert.deepEqual(fromRepresentationDecision("REQUIRES_CONSENT", "InsideTransitionWindow", null), {
    type: "BLOCK",
    reason: "ECONOMIC_STATE_CHANGED",
    guardResult: "InsideTransitionWindow",
  });
  for (const engine of ["NO_SAFE_ROUTE", "NO_ACCEPTABLE_ROUTE", "UNKNOWN_STATE", "USE_ALTERNATIVE"]) {
    const decision = fromRepresentationDecision(engine, null, disclosure);
    assert.equal(decision.type, "BLOCK", engine);
  }
  // USE_PREFERRED is ALLOW only when the guard also passes.
  assert.equal(fromRepresentationDecision("USE_PREFERRED", null, null).type, "ALLOW");
  assert.equal(fromRepresentationDecision("USE_PREFERRED", "MultiplierChanged", null).type, "BLOCK");
});
