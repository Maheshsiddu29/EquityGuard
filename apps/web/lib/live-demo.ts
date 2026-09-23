/**
 * The local live-Phantom demo: gating, session state, and the fail-closed
 * boundary the UI renders from.
 *
 * Two things live here and nothing else does:
 *
 * 1. **Gating.** The live mode needs an explicit build-time flag *and* a
 *    loopback page. Either one alone is not enough, so a public deployment
 *    cannot reach a local validator, a local coordinator or a wallet, and a
 *    stray local build cannot turn a deployed page into one that claims live
 *    execution. The default everywhere is the deterministic public replay.
 *
 * 2. **Session state.** The state machine and the invariant checks that decide
 *    what the page is allowed to say. A result is rendered only once it has
 *    been verified; a failed live run stays failed and never becomes a replay.
 *
 * Deliberately dependency-free — no React, no imports at all — so the rules
 * below can be tested directly, and so the module is identical whether it is
 * read by the browser bundle or by `node --test`.
 */

/** Set to the string "true" at build time to make the live mode available. */
export const LIVE_DEMO_ENV_VAR = "NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO";

/**
 * The adapter bundle, built from apps/phantom-local-feasibility by
 * `npm run live-demo:build`. It is gitignored and absent from a public
 * deployment; the gate above means it is never requested there either.
 */
export const LIVE_ADAPTER_MODULE = "/live-demo/equityguard-live-adapter.js";

/** The local coordinator that serves the proof environment and its fixtures. */
export const LIVE_COORDINATOR_ORIGIN = "http://127.0.0.1:4175";

const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** The canonical amounts. Asserted against a run, never substituted for one. */
export const CANONICAL = {
  usdcIn: "5.00",
  koxOut: "0.05504261",
  usdcInRaw: "5000000",
  koxOutRaw: "5504261",
  guardError: "ActivationPhaseChanged",
  environment: "LOCAL_EXECUTION_REPRODUCTION",
} as const;

export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  return typeof hostname === "string" && LOOPBACK_HOSTNAMES.includes(hostname);
}

/** True only for the exact string "true". Any other value leaves live mode off. */
export function liveDemoFlagEnabled(flag: string | undefined): boolean {
  return flag === "true";
}

/**
 * Whether this page may offer the live mode at all.
 *
 * The flag is a build-time decision and the loopback check is a runtime one.
 * Requiring both is what stops a hostname guess, a misconfigured preview, or a
 * production build that happened to carry the flag from reaching local
 * infrastructure or claiming a live transaction.
 */
export function liveDemoAvailable(input: {
  readonly flag: string | undefined;
  readonly hostname: string | null | undefined;
  readonly protocol: string | null | undefined;
}): boolean {
  return liveDemoFlagEnabled(input.flag)
    && isLoopbackHostname(input.hostname)
    // The coordinator is plain http on loopback; an https page could not reach
    // it without mixed content, so it is refused rather than half-offered.
    && input.protocol === "http:";
}

export type LiveLeg = "STALE" | "REFRESHED";

export interface LiveStaleResult {
  readonly leg: "STALE";
  readonly environment: string;
  readonly walletPublicKey: string;
  readonly signature: string;
  readonly slot: string;
  readonly localT: string;
  readonly summary: string;
  readonly guard: string;
  readonly guardErrorName: string;
  readonly failedInstruction: number;
  readonly jupiterInvoked: boolean;
  readonly whirlpoolInvoked: boolean;
  readonly usdcDelta: string;
  readonly koxDelta: string;
  readonly logs: readonly string[];
  readonly proof: unknown;
}

export interface LiveUpdatedResult {
  readonly leg: "REFRESHED";
  readonly environment: string;
  readonly walletPublicKey: string;
  readonly signature: string;
  readonly slot: string;
  readonly localT: string;
  readonly summary: string;
  readonly guard: string;
  readonly jupiterInvoked: boolean;
  readonly whirlpoolInvoked: boolean;
  readonly usdcSpentRaw: string;
  readonly koxReceivedRaw: string;
  readonly usdcDisplay: string;
  readonly koxDisplay: string;
  readonly logs: readonly string[];
  readonly proof: unknown;
}

export interface LiveFailure {
  readonly headline: string;
  readonly technical: string;
  readonly stage: string;
  readonly cancelled: boolean;
  readonly walletRequested: boolean;
  readonly submitted: boolean;
}

export interface LiveStageUpdate {
  readonly stage: string;
  readonly message: string;
}

/** The adapter surface apps/web depends on. Implemented by the proven app. */
export interface LiveAdapter {
  readonly LIVE_ADAPTER_VERSION: number;
  configureLiveDemo(coordinatorOrigin: string): void;
  resetLiveSession(): void;
  startStaleAttempt(onStage: (update: LiveStageUpdate) => void): Promise<LiveStaleResult>;
  confirmUpdatedOrder(onStage: (update: LiveStageUpdate) => void): Promise<LiveUpdatedResult>;
  describeLiveFailure(action: "buy" | "confirm", error: unknown): LiveFailure;
}

export type LiveState =
  | { readonly kind: "IDLE" }
  | { readonly kind: "RUNNING"; readonly leg: LiveLeg; readonly message: string; readonly stale: LiveStaleResult | null }
  | { readonly kind: "STALE_VERIFIED"; readonly stale: LiveStaleResult }
  | { readonly kind: "REVIEWING"; readonly stale: LiveStaleResult }
  | { readonly kind: "COMPLETED"; readonly stale: LiveStaleResult; readonly updated: LiveUpdatedResult }
  | {
      readonly kind: "FAILED";
      readonly leg: LiveLeg;
      readonly failure: LiveFailure;
      readonly stale: LiveStaleResult | null;
    };

export const IDLE_LIVE_STATE: LiveState = Object.freeze({ kind: "IDLE" } as const);

/** A Buy click. Any previous result is dropped before anything else happens. */
export function beginStale(): LiveState {
  return { kind: "RUNNING", leg: "STALE", message: "Connecting Phantom…", stale: null };
}

export function withStageMessage(state: LiveState, message: string): LiveState {
  return state.kind === "RUNNING" ? { ...state, message } : state;
}

/**
 * Records a stale result. It is accepted only from a running stale leg and
 * only once its invariants hold, so the "order needs review" panel cannot
 * appear from an expectation — only from a verified rejection.
 */
export function withStaleResult(state: LiveState, result: LiveStaleResult): LiveState {
  if (state.kind !== "RUNNING" || state.leg !== "STALE") return state;
  assertStaleInvariants(result);
  return { kind: "STALE_VERIFIED", stale: result };
}

/** The trader asked to see the updated order. No transaction is built here. */
export function withReview(state: LiveState): LiveState {
  return state.kind === "STALE_VERIFIED" ? { kind: "REVIEWING", stale: state.stale } : state;
}

/**
 * A Confirm click. Only reachable from `REVIEWING`, which is only reachable
 * from a verified stale result the trader explicitly chose to review: the
 * second wallet approval cannot be started by the first click, by the review
 * click, or by any automatic transition.
 */
export function beginUpdated(state: LiveState): LiveState {
  if (state.kind !== "REVIEWING") return state;
  return { kind: "RUNNING", leg: "REFRESHED", message: "Connecting Phantom…", stale: state.stale };
}

/** Records an updated result, again only once its invariants hold. */
export function withUpdatedResult(state: LiveState, result: LiveUpdatedResult): LiveState {
  if (state.kind !== "RUNNING" || state.leg !== "REFRESHED" || state.stale === null) return state;
  assertUpdatedInvariants(result);
  return { kind: "COMPLETED", stale: state.stale, updated: result };
}

/**
 * Records a failure. The stale result of the same attempt is kept — that
 * execution really happened — but no success affordance survives, and there
 * is no transition from here into the deterministic replay.
 */
export function withFailure(state: LiveState, leg: LiveLeg, failure: LiveFailure): LiveState {
  const stale = state.kind === "RUNNING" ? state.stale
    : state.kind === "STALE_VERIFIED" || state.kind === "REVIEWING" ? state.stale
      : state.kind === "FAILED" ? state.stale
        : null;
  return { kind: "FAILED", leg, failure, stale };
}

/** What the live card is allowed to render, derived only from the state. */
export interface LivePanels {
  readonly busy: boolean;
  readonly message: string | null;
  readonly showBuy: boolean;
  readonly showReviewCta: boolean;
  readonly showUpdatedTerms: boolean;
  readonly stale: LiveStaleResult | null;
  readonly updated: LiveUpdatedResult | null;
  readonly failure: LiveFailure | null;
  readonly failedLeg: LiveLeg | null;
}

export function livePanels(state: LiveState): LivePanels {
  return {
    busy: state.kind === "RUNNING",
    message: state.kind === "RUNNING" ? state.message : null,
    showBuy: state.kind === "IDLE",
    showReviewCta: state.kind === "STALE_VERIFIED",
    showUpdatedTerms: state.kind === "REVIEWING",
    stale: staleOf(state),
    updated: state.kind === "COMPLETED" ? state.updated : null,
    failure: state.kind === "FAILED" ? state.failure : null,
    failedLeg: state.kind === "FAILED" ? state.leg : null,
  };
}

/** The verified stale result of the current attempt, if this attempt has one. */
function staleOf(state: LiveState): LiveStaleResult | null {
  switch (state.kind) {
    case "IDLE": return null;
    case "RUNNING": return state.stale;
    case "STALE_VERIFIED": return state.stale;
    case "REVIEWING": return state.stale;
    case "COMPLETED": return state.stale;
    case "FAILED": return state.stale;
  }
}

/**
 * A failed live run is never repainted as the deterministic replay. The
 * operator may switch modes, but only as their own explicit act — this
 * reports whether that offer should be shown, not that it has happened.
 */
export function liveFailureOffersReplaySwitch(state: LiveState): boolean {
  return state.kind === "FAILED";
}

/**
 * The stale leg's invariants, re-checked at the render boundary.
 *
 * The proven flow already refuses to return an unverified outcome. This is a
 * second, independent check in the place that decides what the trader reads,
 * so "no tokens were exchanged" is never shown on anything but a run that
 * proved it.
 */
export function assertStaleInvariants(result: LiveStaleResult): void {
  const problems: string[] = [];
  if (result.leg !== "STALE") problems.push("result is not the stale leg");
  if (result.environment !== CANONICAL.environment) problems.push("result is not a local proof execution");
  if (result.failedInstruction !== 0) problems.push("EquityGuard did not stop the transaction at ix0");
  if (result.guardErrorName !== CANONICAL.guardError) problems.push(`guard error was not ${CANONICAL.guardError}`);
  if (result.jupiterInvoked) problems.push("Jupiter was invoked");
  if (result.whirlpoolInvoked) problems.push("Whirlpool was invoked");
  if (result.usdcDelta !== "0") problems.push("USDC moved");
  if (result.koxDelta !== "0") problems.push("KOx moved");
  if (result.signature.length === 0) problems.push("no confirmed signature");
  if (problems.length > 0) {
    throw new Error(`Live stale result failed verification: ${problems.join("; ")}`);
  }
}

/** The updated leg's invariants, compared against the canonical values. */
export function assertUpdatedInvariants(result: LiveUpdatedResult): void {
  const problems: string[] = [];
  if (result.leg !== "REFRESHED") problems.push("result is not the updated leg");
  if (result.environment !== CANONICAL.environment) problems.push("result is not a local proof execution");
  if (!result.jupiterInvoked) problems.push("Jupiter did not execute");
  if (!result.whirlpoolInvoked) problems.push("Whirlpool did not execute");
  if (result.usdcSpentRaw !== CANONICAL.usdcInRaw) problems.push(`USDC spent was ${result.usdcSpentRaw}, not ${CANONICAL.usdcInRaw}`);
  if (result.koxReceivedRaw !== CANONICAL.koxOutRaw) problems.push(`KOx received was ${result.koxReceivedRaw}, not ${CANONICAL.koxOutRaw}`);
  if (result.usdcDisplay !== CANONICAL.usdcIn) problems.push("USDC display amount changed");
  if (result.koxDisplay !== CANONICAL.koxOut) problems.push("KOx display amount changed");
  if (result.signature.length === 0) problems.push("no confirmed signature");
  if (problems.length > 0) {
    throw new Error(`Live updated result failed verification: ${problems.join("; ")}`);
  }
}
