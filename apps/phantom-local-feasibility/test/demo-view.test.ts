/**
 * Result state is scoped by attempt and by leg.
 *
 * The first remediation run failed its refreshed pre-sign attestation and the
 * page kept rendering the stale leg's success ticks beside the error, with no
 * way to tell which leg or which attempt they belonged to. These tests pin the
 * rules that prevent it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginAttempt,
  beginRefreshedLeg,
  failureText,
  initialView,
  panels,
  withFailure,
  withNotice,
  withResult,
  withReview,
  type DemoView,
  type LegFailure,
} from "../src/demo-view.ts";

const STALE_BODY = [
  "STATE CHANGED",
  "Stale authorization rejected",
  "EquityGuard       Rejected",
  "Exact signed transaction preserved ✓",
  "Verified before signing, and signed before the change, by the local coordinator ✓",
].join("\n");
const REFRESHED_BODY = "Updated authorization executed\n5.00 USDC → 0.05504261 KOx";

/** The refusal the human run actually hit: before any wallet request. */
const PRE_SIGN_FAILURE: LegFailure = {
  stage: "PRE_SIGN_SIMULATION",
  headline: "The updated authorization could not be verified before signing.",
  technical: '{"code":"CLOCK_BEFORE_ACTIVATION"}',
  walletRequested: false,
  submitted: false,
};

/** An attempt whose stale leg succeeded and which is ready to confirm. */
function afterStaleSuccess(): { view: DemoView; attempt: number } {
  let view = beginAttempt(initialView);
  const attempt = view.attempt;
  view = withResult(view, attempt, "STALE", STALE_BODY);
  view = withReview(view);
  return { view, attempt };
}

/** Everything currently on screen, as one string. */
function screen(view: DemoView): string {
  const shown = panels(view);
  return [shown.staleResult, shown.refreshedResult, shown.failure?.text, shown.notice]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

test("a completed attempt shows the stale proof and offers the updated authorization", () => {
  const { view } = afterStaleSuccess();
  const shown = panels(view);
  assert.equal(shown.staleResult, STALE_BODY);
  assert.equal(shown.reviewCta, true);
  assert.equal(shown.updatedTerms, true);
  assert.equal(shown.refreshedResult, null);
  assert.equal(shown.failure, null);
});

test("a new attempt clears every result from the previous attempt immediately", () => {
  // 1. a previous successful result exists
  let view = afterStaleSuccess().view;
  view = withResult(view, view.attempt, "REFRESHED", REFRESHED_BODY);
  assert.equal(panels(view).staleResult, STALE_BODY);
  assert.equal(panels(view).refreshedResult, REFRESHED_BODY);

  // 2. a new attempt begins
  view = beginAttempt(view);

  // 3. the previous result disappears immediately — before any await resolves
  const shown = panels(view);
  assert.equal(shown.staleResult, null);
  assert.equal(shown.refreshedResult, null);
  assert.equal(shown.reviewCta, false);
  assert.equal(shown.updatedTerms, false);
  assert.equal(shown.failure, null);
  assert.equal(screen(view), "");
});

test("a refreshed pre-sign failure renders only the current failure", () => {
  const { view: ready, attempt } = afterStaleSuccess();
  // 4. the pre-sign endpoint returns 409 for the refreshed leg
  let view = beginRefreshedLeg(ready);
  view = withFailure(view, attempt, "REFRESHED", PRE_SIGN_FAILURE);
  const shown = panels(view);
  const text = screen(view);

  // 5. no refreshed-success panel
  assert.equal(shown.refreshedResult, null);
  assert.doesNotMatch(text, /Updated authorization executed/);
  assert.doesNotMatch(text, /0\.05504261 KOx/);

  // 6. no "verified before signing" tick is claimed for the failed leg
  assert.doesNotMatch(shown.failure?.text ?? "", /Verified before signing/);
  assert.doesNotMatch(shown.failure?.text ?? "", /✓/);

  // 7. no recovery CTA inviting another attempt from this attempt's state
  assert.equal(shown.reviewCta, false);
  assert.equal(shown.updatedTerms, false);

  // 8. only the current failure appears, and it says what did not happen
  assert.equal(shown.failure?.leg, "REFRESHED");
  assert.match(shown.failure?.text ?? "", /Updated authorization/);
  assert.match(shown.failure?.text ?? "", /could not be verified before signing/);
  assert.match(shown.failure?.text ?? "", /No wallet signature was requested\./);
  assert.match(shown.failure?.text ?? "", /No transaction was submitted\./);
  assert.equal(shown.technical, PRE_SIGN_FAILURE.technical);
});

test("a refreshed failure keeps the stale proof from the same attempt, because it happened", () => {
  const { view: ready, attempt } = afterStaleSuccess();
  const view = withFailure(beginRefreshedLeg(ready), attempt, "REFRESHED", PRE_SIGN_FAILURE);
  const shown = panels(view);
  // The stale execution is real and is in the run record; it is not erased.
  assert.equal(shown.staleResult, STALE_BODY);
  // But it is clearly a different block from the failed leg.
  assert.notEqual(shown.failure?.text, shown.staleResult);
});

test("nothing on screen implies a second wallet approval when none was requested", () => {
  const { view: ready, attempt } = afterStaleSuccess();
  const view = withFailure(beginRefreshedLeg(ready), attempt, "REFRESHED", PRE_SIGN_FAILURE);
  const failure = panels(view).failure?.text ?? "";
  for (const forbidden of [/approved/i, /signed/i, /submitted to/i, /executed/i]) {
    assert.doesNotMatch(failure, forbidden, String(forbidden));
  }
});

test("a leg that did reach the wallet does not claim it did not", () => {
  const { view: ready, attempt } = afterStaleSuccess();
  const afterSigning: LegFailure = { ...PRE_SIGN_FAILURE, stage: "SUBMISSION", headline: "The order could not be submitted.", walletRequested: true, submitted: true };
  const view = withFailure(beginRefreshedLeg(ready), attempt, "REFRESHED", afterSigning);
  const text = panels(view).failure?.text ?? "";
  assert.doesNotMatch(text, /No wallet signature was requested/);
  assert.doesNotMatch(text, /No transaction was submitted/);
});

test("a result from an abandoned attempt can never repaint the screen", () => {
  const { view: first, attempt: oldAttempt } = afterStaleSuccess();
  const fresh = beginAttempt(first);

  // A late promise from the abandoned attempt resolves with a success…
  const late = withResult(fresh, oldAttempt, "REFRESHED", REFRESHED_BODY);
  assert.equal(panels(late).refreshedResult, null, "dropped: wrong attempt");
  assert.deepEqual(late, fresh);

  // …and so does a late failure, and a late notice.
  assert.deepEqual(withFailure(fresh, oldAttempt, "STALE", PRE_SIGN_FAILURE), fresh);
  assert.deepEqual(withNotice(fresh, oldAttempt, "stale notice"), fresh);

  // The current attempt's own updates still apply.
  const current = withResult(fresh, fresh.attempt, "STALE", STALE_BODY);
  assert.equal(panels(current).staleResult, STALE_BODY);
});

test("a stale-leg failure shows no proof panel and no path onward", () => {
  const view = withFailure(beginAttempt(initialView), 1, "STALE", {
    ...PRE_SIGN_FAILURE,
    headline: "This authorization could not be verified before signing. Reset the local reproduction.",
  });
  const shown = panels(view);
  assert.equal(shown.staleResult, null);
  assert.equal(shown.reviewCta, false);
  assert.equal(shown.updatedTerms, false);
  assert.equal(shown.failure?.leg, "STALE");
  assert.match(shown.failure?.text ?? "", /^Stale protection/);
  assert.doesNotMatch(screen(view), /Stale authorization rejected/);
});

test("review is refused until the stale leg has actually produced a proof", () => {
  const running = beginAttempt(initialView);
  assert.equal(withReview(running).reviewed, false, "no proof yet");
  assert.equal(panels(withReview(running)).updatedTerms, false);
});

test("failure copy names the leg it belongs to", () => {
  assert.match(failureText("STALE", PRE_SIGN_FAILURE), /^Stale protection\n/);
  assert.match(failureText("REFRESHED", PRE_SIGN_FAILURE), /^Updated authorization\n/);
});
