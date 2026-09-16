/**
 * Fail-closed properties across the whole offline path.
 *
 * Degrade one piece of evidence at a time and require that none of the four
 * "go" outcomes -- SAFE, USE_PREFERRED, USE_ALTERNATIVE, EXECUTABLE --
 * survives. Ambiguity is a state, not an exception, and never an
 * authorization.
 *
 * The second half is the chain/API source matrix: which combinations of
 * evidence may and may not carry a trade.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Decision,
  ExecutionEligibility,
  ExecutionPlanError,
  RepresentationState,
  StateSource,
  createExecutionPlan,
  decideExecution,
  economicStateOf,
  findRepresentationBySymbol,
  observeMintAccount,
  resolveOndoState,
  resolveXStocksState,
  type ApiObservation,
  type ApiSourceClass,
  type ApiStatus,
  type ExecutionInput,
  type NormalizedQuote,
  type ResolvedRepresentationState,
  type RouteObservation,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";
import { INPUT_RAW, KOON, KOON_SAFE, KOX, POLICY, SLOT, TEST_DOWNSTREAM, TRANSITION_TIME, koon, kox, quote, reroute, route } from "./scenario.ts";

const NOW = 1_789_400_000n;
const OBSERVED = "2026-09-14T00:00:00Z";
const VALID_UNTIL = "2026-09-14T00:01:00Z";
const FRESH_AT = "2026-09-14T00:00:30Z";
const STALE_AT = "2026-09-14T00:02:00Z";

/** Outcomes that let value move. Nothing ambiguous may produce one. */
const GO_DECISIONS: readonly Decision[] = [Decision.USE_PREFERRED, Decision.USE_ALTERNATIVE];

/**
 * Nothing may execute. `stateDecisionToo` additionally requires the state
 * layer to refuse: leave it off where the state layer legitimately reaches a
 * decision and the execution layer is the one that blocks, which is the
 * layering working rather than failing.
 */
function assertNoGo(label: string, decision: ReturnType<typeof decideExecution>, stateDecisionToo = true): void {
  assert.notEqual(decision.executionEligibility, ExecutionEligibility.EXECUTABLE, `${label}: became EXECUTABLE`);
  assert.equal(decision.executableQuote, null, `${label}: carried an executable quote`);
  if (stateDecisionToo) {
    assert.ok(!GO_DECISIONS.includes(decision.stateDecision.decision), `${label}: decided ${decision.stateDecision.decision}`);
  }
  // And it can never be turned into a plan.
  assert.throws(
    () => createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: { validForSlots: 100n }, downstream: TEST_DOWNSTREAM }),
    ExecutionPlanError,
    `${label}: produced an execution plan`,
  );
}

// ------------------------------------------------------- degraded inputs

/** The healthy consented reroute, as a baseline the degradations start from. */
function healthy(): ExecutionInput {
  const scenario = reroute({ consent: false });
  return {
    preferred: scenario.preferred,
    alternative: scenario.alternative,
    reroutePolicy: POLICY,
    inputRaw: INPUT_RAW,
    comparison: scenario.comparison,
    routes: { preferred: route(scenario.preferredQuote), alternative: route(scenario.alternativeQuote) },
    consent: null,
    currentSlot: SLOT,
  };
}

test("the baseline really is one consent away from executing", () => {
  const base = healthy();
  const decision = decideExecution(base);
  assert.equal(decision.stateDecision.decision, Decision.REQUIRES_CONSENT);
  assert.equal(decision.executionEligibility, ExecutionEligibility.CONSENT_REQUIRED);
  assert.equal(reroute().decision.executionEligibility, ExecutionEligibility.EXECUTABLE);
});

test("degrading any single piece of evidence fails closed", () => {
  const base = healthy();
  const noQuote = (observation: RouteObservation): RouteObservation => ({ ...observation, status: "UNAVAILABLE", quote: null });
  const degradations: [string, Partial<ExecutionInput>][] = [
    ["no comparison", { comparison: null }],
    ["no alternative", { alternative: null }],
    ["no preferred route", { routes: { ...base.routes, preferred: noQuote(base.routes.preferred!) } }],
    ["no alternative route", { routes: { ...base.routes, alternative: noQuote(base.routes.alternative!) } }],
    ["no routes at all", { routes: { preferred: null, alternative: null } }],
    ["unknown preferred state", { preferred: { ...base.preferred, state: RepresentationState.UNKNOWN } }],
    ["null preferred state", { preferred: { ...base.preferred, state: null } }],
    ["conflicting preferred state", { preferred: { ...base.preferred, stateSource: StateSource.CONFLICT } }],
    ["unknown alternative state", { alternative: { ...base.alternative!, state: RepresentationState.UNKNOWN } }],
    ["conflicting alternative state", { alternative: { ...base.alternative!, stateSource: StateSource.CONFLICT } }],
    ["alternative in transition too", { alternative: { ...base.alternative!, state: RepresentationState.TRANSITION } }],
    ["alternative paused", { alternative: { ...base.alternative!, state: RepresentationState.PAUSED } }],
    ["alternative of another underlying", { alternative: { ...base.alternative!, underlying: "PEP" } }],
    ["no chain observation on the preferred", { preferred: { ...base.preferred, chainObservation: null } }],
    ["no chain observation on the alternative", { alternative: { ...base.alternative!, chainObservation: null } }],
    ["no transition policy", { preferred: { ...base.preferred, transitionPolicy: null } }],
    ["a different input notional", { inputRaw: INPUT_RAW + 1n }],
  ];
  for (const [label, change] of degradations) {
    assertNoGo(label, decideExecution({ ...base, ...change }));
  }
});

test("a comparison built for another trade or another state cannot authorize anything", () => {
  const base = healthy();
  const comparison = base.comparison!;
  const rebound: [string, typeof comparison][] = [
    ["another underlying", { ...comparison, underlying: "PEP" }],
    ["another preferred mint", { ...comparison, preferredMint: KOON.mint }],
    ["another alternative mint", { ...comparison, alternativeMint: KOX.mint }],
    ["another notional", { ...comparison, inputRaw: INPUT_RAW * 2n }],
    [
      "a stale preferred state",
      { ...comparison, preferredQuote: { ...comparison.preferredQuote, state: { ...comparison.preferredQuote.state, multiplierHex: "000000000000f03f" } } },
    ],
    [
      "a stale alternative state",
      { ...comparison, alternativeQuote: { ...comparison.alternativeQuote, state: { ...comparison.alternativeQuote.state, effectiveTimestamp: 1n } } },
    ],
  ];
  for (const [label, substituted] of rebound) {
    assertNoGo(label, decideExecution({ ...base, comparison: substituted }));
  }
});

test("an alternative outside the economic bound is never offered for consent", () => {
  const base = healthy();
  const cost = base.comparison!.additionalCostBps;
  const decision = decideExecution({ ...base, reroutePolicy: { maxAdditionalCostBps: cost - 1n } });
  assert.equal(decision.stateDecision.decision, Decision.NO_ACCEPTABLE_ROUTE);
  assert.equal(decision.stateDecision.disclosure, null, "an unacceptable reroute must not be disclosed for consent");
  assertNoGo("outside the cost limit", decision);
});

test("the route quote must be the compared quote", () => {
  const base = healthy();
  const substitute: NormalizedQuote = { ...base.comparison!.alternativeQuote, outputRaw: base.comparison!.alternativeQuote.outputRaw + 1n, issuer: "Ondo" };
  const scenario = reroute({ alternativeRouteQuote: substitute });
  // The state layer still decides USE_ALTERNATIVE -- consent was given to a
  // real disclosure -- and the execution layer refuses the swapped quote.
  assert.equal(scenario.decision.stateDecision.decision, Decision.USE_ALTERNATIVE);
  assertNoGo("route quote substituted after comparison", scenario.decision, false);
});

// --------------------------------------------------- chain/API source matrix

const chainSafe = observeMintAccount({
  mint: KOON.mint,
  owner: TOKEN_2022,
  data: withScaledUi(mainnetMint("KOon"), { multiplier: 1.02, newMultiplier: 1.02, effectiveTimestamp: NOW - 100n }),
  slot: 1n,
  blockTime: null,
  observedAt: null,
  chainUnixTimestamp: NOW,
});

function api(status: ApiStatus, overrides: Partial<ApiObservation> = {}): ApiObservation {
  return {
    issuer: "Ondo",
    symbol: "KOon",
    observedAt: OBSERVED,
    status,
    detail: null,
    calibration: "UNCALIBRATED",
    sourceClass: "LIVE_API_STATE" as ApiSourceClass,
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

const resolve = (evidence: Parameters<typeof resolveOndoState>[1]) => resolveOndoState(KOON, evidence, TEST_POLICY);

test("the chain/API source matrix resolves exactly as documented", () => {
  const cases: [string, ResolvedRepresentationState, { state: RepresentationState | null; source: StateSource | null }][] = [
    ["live chain only", resolve({ chain: chainSafe, api: null }), { state: RepresentationState.SAFE, source: StateSource.CHAIN }],
    [
      "fresh live API only",
      resolve({ chain: null, api: api("active"), evaluatedAt: FRESH_AT }),
      { state: RepresentationState.SAFE, source: StateSource.API },
    ],
    [
      "historical API only",
      resolve({ chain: null, api: api("active", { sourceClass: "HISTORICAL_API_STATE", validUntil: null }), evaluatedAt: FRESH_AT }),
      // Historical evidence is not merely downgraded, it is not a source at all.
      { state: RepresentationState.UNKNOWN, source: null },
    ],
    [
      "stale live API only",
      resolve({ chain: null, api: api("active"), evaluatedAt: STALE_AT }),
      { state: RepresentationState.UNKNOWN, source: StateSource.API },
    ],
    [
      "chain plus a matching fresh API",
      resolve({ chain: chainSafe, api: api("active"), evaluatedAt: FRESH_AT }),
      { state: RepresentationState.SAFE, source: StateSource.BOTH_AGREE },
    ],
    [
      "chain plus a conflicting fresh API",
      resolve({ chain: chainSafe, api: api("paused"), evaluatedAt: FRESH_AT }),
      { state: null, source: StateSource.CONFLICT },
    ],
    [
      "chain plus a stale API",
      resolve({ chain: chainSafe, api: api("active"), evaluatedAt: STALE_AT }),
      { state: null, source: StateSource.CONFLICT },
    ],
    [
      "chain plus a malformed API status",
      resolve({ chain: chainSafe, api: api("unknown"), evaluatedAt: FRESH_AT }),
      { state: null, source: StateSource.CONFLICT },
    ],
    [
      "a mint that could not be decoded",
      resolve({
        chain: observeMintAccount({ mint: KOON.mint, owner: TOKEN_2022, data: new Uint8Array(10), slot: 1n, blockTime: null, observedAt: null, chainUnixTimestamp: NOW }),
        api: null,
      }),
      { state: RepresentationState.UNKNOWN, source: StateSource.CHAIN },
    ],
    ["no evidence at all", resolve({ chain: null, api: null }), { state: RepresentationState.UNKNOWN, source: null }],
  ];

  for (const [label, resolved, expected] of cases) {
    assert.equal(resolved.state, expected.state, `${label}: state`);
    assert.equal(resolved.stateSource, expected.source, `${label}: source`);
  }
});

test("only live, fresh evidence can carry a trade", () => {
  // Every row that is not an unambiguous SAFE must fail closed all the way
  // through execution, whatever the route and quote look like.
  const state = economicStateOf(chainSafe)!;
  const usable = (resolved: ResolvedRepresentationState) => {
    const q: NormalizedQuote = { ...quote(koon(TRANSITION_TIME, KOON_SAFE), 1_000n), mint: KOON.mint, state };
    return decideExecution({
      preferred: resolved,
      alternative: null,
      reroutePolicy: POLICY,
      inputRaw: q.inputRaw,
      comparison: null,
      routes: { preferred: route(q), alternative: null },
      consent: null,
      currentSlot: SLOT,
    });
  };

  const refused: [string, ResolvedRepresentationState][] = [
    ["historical API only", resolve({ chain: null, api: api("active", { sourceClass: "HISTORICAL_API_STATE", validUntil: null }), evaluatedAt: FRESH_AT })],
    ["stale live API only", resolve({ chain: null, api: api("active"), evaluatedAt: STALE_AT })],
    ["live API with no validUntil", resolve({ chain: null, api: api("active", { validUntil: null }), evaluatedAt: FRESH_AT })],
    ["live API with no evaluation time", resolve({ chain: null, api: api("active") })],
    ["chain and API in conflict", resolve({ chain: chainSafe, api: api("paused"), evaluatedAt: FRESH_AT })],
    ["chain and a stale API", resolve({ chain: chainSafe, api: api("active"), evaluatedAt: STALE_AT })],
    ["no evidence at all", resolve({ chain: null, api: null })],
  ];
  for (const [label, resolved] of refused) {
    assertNoGo(label, usable(resolved));
  }

  // API-only evidence, however fresh, is not chain state: the state layer can
  // read it as SAFE, but there is no decoded economic state to bind a quote
  // to, so execution refuses with STATE_UNKNOWN.
  const apiOnly = resolve({ chain: null, api: api("active"), evaluatedAt: FRESH_AT });
  assert.equal(apiOnly.state, RepresentationState.SAFE);
  assert.equal(apiOnly.stateSource, StateSource.API);
  assert.equal(economicStateOf(apiOnly.chainObservation), null);
  const decision = usable(apiOnly);
  assert.equal(decision.executionEligibility, ExecutionEligibility.STATE_UNKNOWN);
  assertNoGo("fresh API-only SAFE", decision, false);
});

test("chain state stays authoritative for the protected fields", () => {
  // A fresh API claiming "active" cannot talk a transitioning mint into SAFE.
  const transitioning = kox(TRANSITION_TIME);
  assert.equal(transitioning.state, RepresentationState.TRANSITION);
  assert.ok(transitioning.chainObservation);
  const xstocksOnly = resolveXStocksState(KOX, transitioning.chainObservation, TEST_POLICY);
  assert.equal(xstocksOnly.state, RepresentationState.TRANSITION);
  assert.equal(xstocksOnly.stateSource, StateSource.CHAIN);

  // And for Ondo, where an API does exist, disagreement is a conflict rather
  // than a reconciliation in either direction.
  const conflicted = resolve({ chain: chainSafe, api: api("transition"), evaluatedAt: FRESH_AT });
  assert.equal(conflicted.stateSource, StateSource.CONFLICT);
  assert.equal(conflicted.state, null);
  assert.equal(conflicted.chainState, RepresentationState.SAFE);
  assert.equal(conflicted.apiState, RepresentationState.TRANSITION);
});
