/**
 * The canonical reroute scenario used by the execution-path tests.
 *
 * Real mainnet mint bytes: KOx carries a scheduled multiplier change and is
 * observed inside its transition window; KOon is SAFE. Both are quoted, the
 * alternative about 10 bps below the preferred in share-equivalents, so the
 * decision is REQUIRES_CONSENT and, with consent, EXECUTABLE.
 *
 * Kept in one place so the amounts, policy and slot cannot drift between the
 * suites that attack different parts of the same path.
 */

import assert from "node:assert/strict";

import { minimumOutFromQuote } from "@equityguard/guard-client";

import {
  compareQuotes,
  decideExecution,
  economicStateOf,
  findRepresentationBySymbol,
  grantConsent,
  observeMintAccount,
  resolveOndoState,
  resolveXStocksState,
  routeIdentity,
  type ConsentRecord,
  type ExecutionDecision,
  type NormalizedQuote,
  type QuoteComparison,
  type ResolvedRepresentationState,
  type RouteObservation,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";

export const KOX = findRepresentationBySymbol("KOx")!;
export const KOON = findRepresentationBySymbol("KOon")!;
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Scheduled activation time of the KOx multiplier change. */
export const T = 1_789_432_200n;
export const INPUT_RAW = 5_000_000n;
/** Chain time inside KOx's transition window. */
export const TRANSITION_TIME = T - 14n;
export const SLOT = 100n;
export const POLICY = { maxAdditionalCostBps: 25n };
export const PREFERRED_OUT = 5_450_395n;
/** KOon raw output about 10 bps below the KOx quote in share-equivalents. */
export const KOON_OUT = 54_153_839n;

export const KOX_SCHEDULED = withScaledUi(mainnetMint("KOx"), {
  multiplier: 1.0183317967386898,
  newMultiplier: 1.0225601246249238,
  effectiveTimestamp: T,
});
export const KOON_SAFE = withScaledUi(mainnetMint("KOon"), {
  multiplier: 1.0238905041551842,
  newMultiplier: 1.0238905041551842,
  effectiveTimestamp: T - 1556n,
});

/** A stand-in downstream binding; the real commitment is exercised in Rust and LiteSVM. */
export const TEST_DOWNSTREAM = { adapterKind: "TOKEN_2022_TRANSFER_CHECKED" as const, commitmentHex: "a".repeat(64) };

export const observe = (mint: string, data: Uint8Array, time: bigint) =>
  observeMintAccount({ mint, owner: TOKEN_2022, data, slot: 7n, blockTime: null, observedAt: null, chainUnixTimestamp: time });

export const kox = (time: bigint, data = KOX_SCHEDULED) => resolveXStocksState(KOX, observe(KOX.mint, data, time), TEST_POLICY);
export const koon = (time: bigint, data = KOON_SAFE) =>
  resolveOndoState(KOON, { chain: observe(KOON.mint, data, time), api: null }, TEST_POLICY);

export const whirlpool = (mint: string) =>
  routeIdentity("TEST_ROUTE", [
    { venue: "Whirlpool", poolId: "BG7f49R2sb2UBCMu3AHuDmgDRyzqVgeMpDEk9S9gvQhy", inputMint: USDC, outputMint: mint, percent: 100 },
  ]);

/**
 * `slippageBps` makes the minimum output Jupiter's own
 * (`minimumOutFromQuote`), as a Jupiter-executed plan needs; without it the
 * minimum is simply 1,000 raw below the output.
 */
export function quote(representation: ResolvedRepresentationState, outputRaw: bigint, slippageBps?: number): NormalizedQuote {
  const state = economicStateOf(representation.chainObservation);
  assert.ok(state, `${representation.symbol} has no decoded chain state`);
  return {
    underlying: representation.underlying,
    issuer: representation.issuer,
    inputMint: USDC,
    mint: representation.mint,
    inputRaw: INPUT_RAW,
    outputRaw,
    minOutputRaw: slippageBps === undefined ? outputRaw - 1_000n : minimumOutFromQuote(outputRaw, slippageBps),
    route: whirlpool(representation.mint),
    quotedAt: "2026-09-15T04:22:16.045Z",
    contextSlot: 447157559n,
    state,
  };
}

export const route = (q: NormalizedQuote): RouteObservation => ({ mint: q.mint, status: "AVAILABLE", quote: q, source: "test", detail: null });

export interface Reroute {
  readonly preferred: ResolvedRepresentationState;
  readonly alternative: ResolvedRepresentationState;
  readonly preferredQuote: NormalizedQuote;
  readonly alternativeQuote: NormalizedQuote;
  readonly comparison: QuoteComparison;
  readonly decision: ExecutionDecision;
  /** The REQUIRES_CONSENT form of the same evaluation. */
  readonly withoutConsent: ExecutionDecision;
  readonly consent: ConsentRecord | null;
}

/** KOx in transition, KOon SAFE and quoted: with consent the reroute is EXECUTABLE. */
export function reroute(
  options: { consent?: boolean; alternativeRouteQuote?: NormalizedQuote; maxAdditionalCostBps?: bigint; validForSlots?: bigint; slippageBps?: number } = {},
): Reroute {
  const preferred = kox(TRANSITION_TIME);
  const alternative = koon(TRANSITION_TIME);
  const preferredQuote = quote(preferred, PREFERRED_OUT, options.slippageBps);
  const alternativeQuote = quote(alternative, KOON_OUT, options.slippageBps);
  const comparison = compareQuotes(preferredQuote, alternativeQuote);
  const base = {
    preferred,
    alternative,
    reroutePolicy: POLICY,
    inputRaw: INPUT_RAW,
    comparison,
    currentSlot: SLOT,
    routes: { preferred: route(preferredQuote), alternative: route(options.alternativeRouteQuote ?? alternativeQuote) },
  };
  const withoutConsent = decideExecution({ ...base, consent: null });
  if (options.consent === false) {
    return { preferred, alternative, preferredQuote, alternativeQuote, comparison, decision: withoutConsent, withoutConsent, consent: null };
  }
  // The user accepts exactly this disclosure.
  const consent = grantConsent({
    decision: withoutConsent.stateDecision,
    comparison,
    reroutePolicy: POLICY,
    currentSlot: SLOT,
    maxAdditionalCostBps: options.maxAdditionalCostBps ?? 25n,
    validForSlots: options.validForSlots ?? 10n,
  });
  return {
    preferred,
    alternative,
    preferredQuote,
    alternativeQuote,
    comparison,
    decision: decideExecution({ ...base, consent }),
    withoutConsent,
    consent,
  };
}
