/**
 * What the page is allowed to show, scoped by attempt and by leg.
 *
 * The first remediation run exposed the problem this solves: the refreshed
 * leg failed its pre-sign attestation, and the page went on showing the stale
 * leg's success panel — "Exact signed transaction preserved ✓", "Verified
 * before signing ✓" — beside the failure. A viewer could not tell which
 * attempt, or which leg, those ticks belonged to.
 *
 * The rules:
 *
 * - **Attempt scope.** A new attempt clears every result from the previous
 *   one. A result carrying a stale attempt number is dropped, so a slow
 *   promise from an abandoned attempt can never repaint the screen.
 * - **Leg scope.** The stale and refreshed legs are recorded separately. A
 *   refreshed failure never erases a stale success from the *same* attempt —
 *   that execution really happened and is in the run record — but it also
 *   never borrows it. Each leg states its own outcome.
 * - **No implied wallet activity.** A leg that failed before signing says so
 *   explicitly, because "could not be verified" must not read as "was
 *   rejected on chain".
 *
 * Pure: no DOM, no globals. `app.ts` renders whatever this returns.
 */

import type { BuyStage } from "./buy-error.ts";

/** Which half of the reproduction a result belongs to. */
export type Leg = "STALE" | "REFRESHED";

export interface LegFailure {
  readonly stage: BuyStage;
  readonly headline: string;
  readonly technical: string;
  /** True only once a wallet signature was actually requested for this leg. */
  readonly walletRequested: boolean;
  /** True only once bytes were actually sent to the validator for this leg. */
  readonly submitted: boolean;
}

export type LegState =
  | { readonly kind: "IDLE" }
  | { readonly kind: "RUNNING" }
  | { readonly kind: "SUCCESS"; readonly body: string }
  | { readonly kind: "FAILED"; readonly failure: LegFailure };

export interface DemoView {
  /** Monotonic; results from an older attempt are ignored. */
  readonly attempt: number;
  readonly stale: LegState;
  readonly refreshed: LegState;
  /** Whether the user has asked to see the updated-authorization step. */
  readonly reviewed: boolean;
  readonly notice: string | null;
}

const IDLE: LegState = { kind: "IDLE" };

export const initialView: DemoView = Object.freeze({
  attempt: 0,
  stale: IDLE,
  refreshed: IDLE,
  reviewed: false,
  notice: null,
} satisfies DemoView);

/**
 * Starts a fresh attempt: a new scope, and every previous result dropped.
 * This is what makes an old success incapable of surviving into a new run.
 */
export function beginAttempt(view: DemoView): DemoView {
  return {
    attempt: view.attempt + 1,
    stale: { kind: "RUNNING" } satisfies LegState,
    refreshed: IDLE,
    reviewed: false,
    notice: null,
  };
}

/** Begins the refreshed leg of the current attempt, keeping the stale result. */
export function beginRefreshedLeg(view: DemoView): DemoView {
  return { ...view, refreshed: { kind: "RUNNING" } satisfies LegState, notice: null };
}

function ignoreStale(view: DemoView, attempt: number): boolean {
  return attempt !== view.attempt;
}

/** Records a verified result for `leg`, unless it belongs to an older attempt. */
export function withResult(view: DemoView, attempt: number, leg: Leg, body: string): DemoView {
  if (ignoreStale(view, attempt)) return view;
  const state: LegState = { kind: "SUCCESS", body };
  return leg === "STALE" ? { ...view, stale: state, notice: null } : { ...view, refreshed: state, notice: null };
}

/** Records a failure for `leg`, unless it belongs to an older attempt. */
export function withFailure(view: DemoView, attempt: number, leg: Leg, failure: LegFailure): DemoView {
  if (ignoreStale(view, attempt)) return view;
  const state: LegState = { kind: "FAILED", failure };
  return leg === "STALE" ? { ...view, stale: state } : { ...view, refreshed: state };
}

/** The user asked to see the updated-authorization step. */
export function withReview(view: DemoView): DemoView {
  return view.stale.kind === "SUCCESS" ? { ...view, reviewed: true } : view;
}

/** A message that belongs to no leg yet (connecting, preparing, holding). */
export function withNotice(view: DemoView, attempt: number, notice: string | null): DemoView {
  return ignoreStale(view, attempt) ? view : { ...view, notice };
}

/** Which panels the page may render, derived only from the current attempt. */
export interface RenderedPanels {
  /** The stale leg's verified rejection proof. */
  readonly staleResult: string | null;
  /** The "review the updated authorization" call to action. */
  readonly reviewCta: boolean;
  /** The updated-authorization confirmation step. */
  readonly updatedTerms: boolean;
  /** The refreshed leg's verified execution proof. */
  readonly refreshedResult: string | null;
  /** A leg that failed, rendered as its own block. */
  readonly failure: { readonly leg: Leg; readonly text: string } | null;
  readonly notice: string | null;
  readonly technical: string | null;
}

/**
 * Copy for a leg that failed. It states what did *not* happen, because the
 * absence of a wallet request and of a submission is the load-bearing fact
 * when a pre-sign gate refuses.
 */
export function failureText(leg: Leg, failure: LegFailure): string {
  const lines = [leg === "STALE" ? "Stale protection" : "Updated authorization", `✕ ${failure.headline}`];
  if (!failure.walletRequested) lines.push("No wallet signature was requested.");
  if (!failure.submitted) lines.push("No transaction was submitted.");
  return lines.join("\n");
}

/**
 * The panels for the current view.
 *
 * A refreshed failure leaves the stale success visible — it happened — but
 * hides every refreshed-success affordance, so nothing on screen can be read
 * as a second wallet approval or a completed trade.
 */
export function panels(view: DemoView): RenderedPanels {
  const staleResult = view.stale.kind === "SUCCESS" ? view.stale.body : null;
  const refreshedResult = view.refreshed.kind === "SUCCESS" ? view.refreshed.body : null;
  const failedLeg: { leg: Leg; failure: LegFailure } | null =
    view.refreshed.kind === "FAILED" ? { leg: "REFRESHED", failure: view.refreshed.failure }
      : view.stale.kind === "FAILED" ? { leg: "STALE", failure: view.stale.failure }
        : null;
  return {
    staleResult,
    // Once the refreshed leg has failed, do not invite another attempt at it
    // from this attempt's state: the reproduction must be reset.
    reviewCta: staleResult !== null && view.refreshed.kind === "IDLE",
    updatedTerms: staleResult !== null && view.reviewed && view.refreshed.kind === "IDLE",
    refreshedResult,
    failure: failedLeg === null ? null : { leg: failedLeg.leg, text: failureText(failedLeg.leg, failedLeg.failure) },
    notice: view.notice,
    technical: failedLeg?.failure.technical ?? null,
  };
}
