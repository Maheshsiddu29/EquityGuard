/**
 * Property tests for the execution plan: nothing but a plan issued by
 * `createExecutionPlan`, still fresh, still unused, matching the presented
 * quote, policy and downstream action, may reach signing.
 *
 * Authenticity here is runtime provenance, not content. A plan that is
 * internally perfect but was not issued is still not a plan.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ExecutionPlanError,
  assertPlanDownstream,
  assertPlanFresh,
  assertPlanPolicy,
  canonicalKey,
  consumeExecutionPlan,
  createExecutionPlan,
  planDigestOf,
  verifyExecutionPlan,
  type DownstreamBinding,
  type ExecutionPlan,
  type TransitionPolicy,
} from "../src/index.ts";
import { TEST_POLICY } from "./fixtures.ts";
import { SLOT, TEST_DOWNSTREAM, reroute } from "./scenario.ts";

const FRESHNESS = { validForSlots: 100n };

function plan(): { plan: ExecutionPlan; presented: Parameters<typeof verifyExecutionPlan>[1] } {
  const scenario = reroute();
  const issued = createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", {
    currentSlot: SLOT,
    freshness: FRESHNESS,
    downstream: TEST_DOWNSTREAM,
  });
  return { plan: issued, presented: { quote: scenario.alternativeQuote, comparison: scenario.comparison } };
}

function stripDigest(value: ExecutionPlan) {
  const { planDigest: _digest, ...content } = value;
  return content;
}

const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExecutionPlanError) return error.code;
    throw error;
  }
  return "accepted";
};

test("an issued plan verifies, and is a faithful record of the decision", () => {
  const { plan: issued, presented } = plan();
  verifyExecutionPlan(issued, presented);
  assert.equal(issued.environment, "DEVNET_EXECUTION");
  assert.equal(issued.executionEligibility, "EXECUTABLE");
  assert.equal(issued.planDigest, planDigestOf(stripDigest(issued)));
  assert.equal(issued.expiresAtSlot, SLOT + FRESHNESS.validForSlots);
  assert.deepEqual(issued.downstream, TEST_DOWNSTREAM);
});

// -------------------------------------------------------- provenance

test("only a plan issued by createExecutionPlan reaches signing", () => {
  const { plan: issued, presented } = plan();
  const impostors: [string, ExecutionPlan][] = [
    ["spread copy", { ...issued }],
    ["structured clone", structuredClone(issued)],
    ["Object.assign", Object.assign({}, issued)],
    ["frozen copy", Object.freeze({ ...issued })],
    [
      "JSON round trip",
      JSON.parse(JSON.stringify(issued, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as ExecutionPlan,
    ],
  ];
  for (const [label, impostor] of impostors) {
    assert.equal(codeOf(() => verifyExecutionPlan(impostor, presented)), "PLAN_NOT_ISSUED", `${label} was accepted`);
    assert.equal(codeOf(() => consumeExecutionPlan(impostor, presented)), "PLAN_NOT_ISSUED", `${label} was consumed`);
  }
  // A copy that recomputes its own digest is still not a plan.
  const rehashed = { ...issued, planDigest: planDigestOf(stripDigest(issued)) };
  assert.equal(rehashed.planDigest, issued.planDigest, "the digest is reproducible, which is exactly why it is not authentication");
  assert.equal(codeOf(() => verifyExecutionPlan(rehashed, presented)), "PLAN_NOT_ISSUED");
  // And the genuine plan still verifies afterwards.
  verifyExecutionPlan(issued, presented);
});

test("a non-object is refused rather than crashing", () => {
  const { presented } = plan();
  const values: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["number", 0],
    ["string", "plan"],
    ["array", []],
    ["null-prototype object", Object.create(null)],
  ];
  for (const [label, value] of values) {
    assert.equal(codeOf(() => verifyExecutionPlan(value as ExecutionPlan, presented)), "PLAN_NOT_ISSUED", `${label} was accepted`);
  }
});

test("a plan is deep-frozen, so nested mutation cannot take", () => {
  const { plan: issued, presented } = plan();
  assert.ok(Object.isFrozen(issued));
  assert.ok(Object.isFrozen(issued.quote));
  assert.ok(Object.isFrozen(issued.quote.state));
  assert.ok(Object.isFrozen(issued.route));
  assert.ok(Object.isFrozen(issued.route.legs));
  assert.ok(Object.isFrozen(issued.downstream));
  assert.ok(Object.isFrozen(issued.policy));

  const before = issued.planDigest;
  const attempts: [string, () => void][] = [
    ["top-level output", () => ((issued as { expectedOutputRaw: bigint }).expectedOutputRaw = 1n)],
    ["nested quote output", () => ((issued.quote as { outputRaw: bigint }).outputRaw = 1n)],
    ["nested state multiplier", () => ((issued.quote.state as { multiplierHex: string }).multiplierHex = "00".repeat(8))],
    ["nested route leg", () => ((issued.route.legs[0] as { percent: number }).percent = 1)],
    ["downstream commitment", () => ((issued.downstream as { commitmentHex: string }).commitmentHex = "b".repeat(64))],
    ["digest", () => ((issued as { planDigest: string }).planDigest = "0".repeat(64))],
  ];
  for (const [label, mutate] of attempts) {
    // A frozen object either throws in strict mode or silently ignores the write.
    try {
      mutate();
    } catch (error) {
      assert.ok(error instanceof TypeError, `${label}: ${String(error)}`);
    }
  }
  assert.equal(issued.planDigest, before);
  verifyExecutionPlan(issued, presented);
});

test("the plan is detached from the objects it was built from", () => {
  const scenario = reroute();
  const issued = createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: { ...TEST_DOWNSTREAM } });
  // Mutating the caller's own quote afterwards must not reach into the plan.
  const caller = scenario.alternativeQuote as { outputRaw: bigint };
  const planned = issued.quote.outputRaw;
  caller.outputRaw = planned + 1n;
  assert.equal(issued.quote.outputRaw, planned);
  assert.equal(codeOf(() => verifyExecutionPlan(issued, { quote: scenario.alternativeQuote, comparison: scenario.comparison })), "QUOTE_SUBSTITUTED");
});

// ---------------------------------------------------------- single use

test("a plan is consumed before signing and never accepted again", () => {
  const { plan: issued, presented } = plan();
  consumeExecutionPlan(issued, presented);
  assert.equal(codeOf(() => verifyExecutionPlan(issued, presented)), "PLAN_CONSUMED");
  assert.equal(codeOf(() => consumeExecutionPlan(issued, presented)), "PLAN_CONSUMED");
});

test("one consent yields one plan", () => {
  const scenario = reroute();
  createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: TEST_DOWNSTREAM });
  // The consent was consumed by the first plan; a second cannot be made.
  assert.equal(
    codeOf(() => {
      createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: TEST_DOWNSTREAM });
    }),
    "CONSENT_REJECTED",
  );
});

// ----------------------------------------------------------- freshness

test("a plan expires by slot, inclusive of the last valid slot", () => {
  const { plan: issued } = plan();
  assertPlanFresh(issued, SLOT);
  assertPlanFresh(issued, issued.expiresAtSlot);
  assert.equal(codeOf(() => assertPlanFresh(issued, issued.expiresAtSlot + 1n)), "PLAN_EXPIRED");
  assert.equal(codeOf(() => assertPlanFresh(issued, issued.expiresAtSlot + 1_000_000n)), "PLAN_EXPIRED");
  // A non-bigint slot is refused rather than coerced.
  assert.equal(codeOf(() => assertPlanFresh(issued, Number(SLOT) as unknown as bigint)), "PLAN_EXPIRED");
});

test("freshness must be stated explicitly and positively", () => {
  for (const [label, options] of [
    ["zero slots", { validForSlots: 0n }],
    ["negative slots", { validForSlots: -1n }],
    ["a number", { validForSlots: 100 as unknown as bigint }],
    ["missing", {} as { validForSlots: bigint }],
  ] as const) {
    const scenario = reroute();
    assert.equal(
      codeOf(() => {
        createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: options, downstream: TEST_DOWNSTREAM });
      }),
      "INVALID_FRESHNESS",
      `${label} was accepted`,
    );
  }
});

// ------------------------------------------------------- what it binds

test("a substituted quote is not the planned quote", () => {
  const { plan: issued, presented } = plan();
  const substitutions: [string, unknown][] = [
    ["output amount", { ...presented.quote, outputRaw: presented.quote.outputRaw + 1n }],
    ["minimum output", { ...presented.quote, minOutputRaw: (presented.quote.minOutputRaw ?? 0n) + 1n }],
    ["route", { ...presented.quote, route: { ...presented.quote.route, routeId: "other" } }],
    ["economic state", { ...presented.quote, state: { ...presented.quote.state, multiplierHex: "000000000000f03f" } }],
    ["context slot", { ...presented.quote, contextSlot: 1n }],
  ];
  for (const [label, quote] of substitutions) {
    assert.equal(codeOf(() => verifyExecutionPlan(issued, { ...presented, quote: quote as typeof presented.quote })), "QUOTE_SUBSTITUTED", `${label} was accepted`);
  }
});

test("the comparison consent was given to must be the one presented", () => {
  const { plan: issued, presented } = plan();
  assert.ok(issued.comparisonKey, "this scenario is a consented reroute");
  assert.equal(codeOf(() => verifyExecutionPlan(issued, { ...presented, comparison: null })), "COMPARISON_NOT_FOR_PLAN");
  const other = { ...presented.comparison!, comparisonKey: "other" };
  assert.equal(codeOf(() => verifyExecutionPlan(issued, { ...presented, comparison: other })), "COMPARISON_NOT_FOR_PLAN");
});

test("the executor's policy must be exactly the plan's", () => {
  const { plan: issued } = plan();
  assertPlanPolicy(issued, issued.policy);
  assertPlanPolicy(issued, structuredClone(issued.policy));
  const policies: [string, TransitionPolicy][] = [
    ["a wider window", { ...TEST_POLICY, beforeSecs: TEST_POLICY.beforeSecs + 1n }],
    ["a narrower window", { ...TEST_POLICY, afterSecs: TEST_POLICY.afterSecs - 1n }],
    ["a different basis", { ...TEST_POLICY, basis: "something else" }],
    ["a different calibration", { ...TEST_POLICY, calibration: "CALIBRATED" }],
  ];
  for (const [label, policy] of policies) {
    assert.equal(codeOf(() => assertPlanPolicy(issued, policy)), "POLICY_MISMATCH", `${label} was accepted`);
  }
  assert.equal(canonicalKey(issued.policy), canonicalKey(TEST_POLICY));
});

test("the action being submitted must be exactly the planned action", () => {
  const { plan: issued } = plan();
  assertPlanDownstream(issued, TEST_DOWNSTREAM);
  assertPlanDownstream(issued, { ...TEST_DOWNSTREAM });
  const wrong: [string, unknown][] = [
    ["a different commitment", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: "b".repeat(64) }],
    ["one flipped hex digit", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: `b${"a".repeat(63)}` }],
    ["a different adapter", { adapterKind: "SOMETHING_ELSE", commitmentHex: "a".repeat(64) }],
    ["uppercase hex", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: "A".repeat(64) }],
    ["a short commitment", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: "a".repeat(63) }],
    ["no commitment", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED" }],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [label, binding] of wrong) {
    assert.equal(codeOf(() => assertPlanDownstream(issued, binding as DownstreamBinding)), "DOWNSTREAM_COMMITMENT_MISMATCH", `${label} was accepted`);
  }
});

test("a plan cannot be created without a valid downstream binding", () => {
  for (const [label, downstream] of [
    ["null", null],
    ["missing commitment", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED" }],
    ["uppercase hex", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: "A".repeat(64) }],
    ["short hex", { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: "a".repeat(32) }],
    ["unknown adapter", { adapterKind: "RAW_INSTRUCTION", commitmentHex: "a".repeat(64) }],
  ] as const) {
    const scenario = reroute();
    assert.equal(
      codeOf(() => {
        createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: downstream as DownstreamBinding });
      }),
      "INVALID_DOWNSTREAM",
      `${label} was accepted`,
    );
  }
});

test("an observation-only environment never produces a submit-capable plan", () => {
  const scenario = reroute();
  assert.equal(
    codeOf(() => {
      createExecutionPlan(scenario.decision, "MAINNET_OBSERVATION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: TEST_DOWNSTREAM });
    }),
    "OBSERVATION_ONLY_ENVIRONMENT",
  );
});

test("a decision that is not EXECUTABLE never becomes a plan", () => {
  const scenario = reroute({ consent: false });
  assert.equal(
    codeOf(() => {
      createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: TEST_DOWNSTREAM });
    }),
    "NOT_EXECUTABLE",
  );
});
