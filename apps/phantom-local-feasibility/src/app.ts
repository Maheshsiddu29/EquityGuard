import { connectPhantomWallet, detectPhantom, type PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import { type BuyStage } from "./buy-error.ts";
import { FeasibilityError } from "./feasibility.ts";
import { EXPECTED_PHANTOM } from "./local-funding.ts";
import { loadReplayData, type ReplayData } from "./replay-execution.ts";
import { armLocalActivation, recordEvidence, runLocalActivation, type LocalActivationProof } from "./local-activation.ts";
import { traderFacingError, protectionTechnicalDetails } from "./trader-flow.ts";
import { reproductionMessage } from "./reproduction-view.ts";
import {
  beginAttempt,
  beginRefreshedLeg,
  initialView,
  panels,
  withFailure,
  withNotice,
  withResult,
  withReview,
  type DemoView,
  type Leg,
} from "./demo-view.ts";

let provider: PhantomProvider | null = null;
let data: ReplayData | null = null;
let localT: bigint | null = null;
let stale: LocalActivationProof | null = null;
let refreshed: LocalActivationProof | null = null;
let busy = false;
let started = false;
let failureStage: BuyStage = "ENVIRONMENT_CHECK";
/**
 * All result state, scoped by attempt and leg. Nothing is rendered that did
 * not come from the current attempt (`demo-view.ts`).
 */
let view: DemoView = initialView;
/** Whether the current leg has reached the wallet, for honest failure copy. */
let walletRequested = false;
let submitted = false;
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing UI node " + id);
  return node as T;
}
function text(id: string, value: string): void { element(id).textContent = value; }
function render(): void {
  const shown = panels(view);
  element<HTMLButtonElement>("buy").disabled = busy || started;
  element<HTMLButtonElement>("review-order").disabled = busy || !shown.reviewCta;
  element<HTMLButtonElement>("confirm-order").disabled = busy || !shown.updatedTerms;

  element("review").hidden = shown.staleResult === null;
  text("review-body", shown.staleResult ?? "");
  element("updated-terms").hidden = !shown.updatedTerms;
  element("done").hidden = shown.refreshedResult === null;
  text("done-copy", shown.refreshedResult ?? "");

  // A failed leg renders as its own block, naming what did not happen.
  element("leg-failure").hidden = shown.failure === null;
  text("leg-failure-body", shown.failure?.text ?? "");

  element("notice").hidden = shown.notice === null;
  text("notice", shown.notice ?? "");

  // The drawer carries the current attempt's failure detail, the current
  // attempt's proof, or both. Never a previous attempt's: `stale` and
  // `refreshed` are cleared when a new attempt begins.
  const parts = [shown.technical, proofJson()].filter((value): value is string => value !== null);
  element("technical-drawer").hidden = parts.length === 0;
  if (parts.length > 0) text("technical-body", parts.join("\n\n"));
}

/** The verified proofs this attempt has produced so far, or null. */
function proofJson(): string | null {
  if (!stale && !refreshed) return null;
  return JSON.stringify({ environment: "LOCAL_EXECUTION_REPRODUCTION", stale, refreshed },
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2);
}
function stage(value: BuyStage, clock?: { unixTimestamp: bigint }): void {
  failureStage = value;
  if (value === "SIGN_REQUEST") walletRequested = true;
  if (value === "SUBMISSION") submitted = true;
  const status: Partial<Record<BuyStage, string>> = {
    ENVIRONMENT_CHECK: "Preparing local reproduction…",
    TRANSACTION_BUILD: "Building authorization from local state…",
    PRE_SIGN_SIMULATION: "Checking the complete trade before signing…",
    SIGN_REQUEST: "Pre-sign simulation passed. Approve in Phantom.",
    SIGNED_BYTES_RETURNED: "Phantom returned signed bytes. Verifying signing time…",
    BLOCKHASH_VALIDATION: "Checking the original blockhash and exact signed bytes…",
    SUBMISSION: "Submitting to the local validator…",
    CONFIRMATION: "Waiting for local confirmation…",
    BALANCE_VERIFICATION: "Verifying execution and token balances…",
  };
  const message = value === "WAITING_FOR_ACTIVATION" && clock && localT !== null
    ? (localT - clock.unixTimestamp > 0n
      ? "Authorization signed ✓\nTransaction held\nEconomic state changes in: " + (localT - clock.unixTimestamp) + "…"
      : "State changed\nSubmitting the exact signed transaction once the validator Clock is past local T.")
    : status[value] ?? "Connecting Phantom…";
  view = withNotice(view, view.attempt, message);
  render();
}
/** Evidence capture is a side record; it never changes what the run displayed. */
function showProof(): void {
  recordEvidence({ stale, refreshed }).catch((error: unknown) => console.warn(error));
}
function failure(leg: Leg, attempt: number, error: unknown): void {
  const action = leg === "STALE" ? "buy" : "confirm";
  const facing = traderFacingError(action, error, failureStage, location.hostname === "localhost" || location.hostname === "127.0.0.1");
  view = withNotice(
    withFailure(view, attempt, leg, {
      stage: failureStage,
      headline: facing.headline,
      technical: facing.technical,
      walletRequested,
      submitted,
    }),
    attempt,
    null,
  );
  render();
}
async function start(): Promise<void> {
  if (busy || started) return;
  // A new attempt drops every result from the previous one before anything
  // else happens, so nothing old can survive on screen.
  view = beginAttempt(view);
  const attempt = view.attempt;
  // The proofs belong to the attempt that produced them.
  stale = null; refreshed = null;
  walletRequested = false; submitted = false;
  busy = true; render();
  try {
    stage("PHANTOM_CONNECT");
    if (!detectPhantom()) throw new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected");
    const connected = await connectPhantomWallet();
    if (connected.publicKey !== EXPECTED_PHANTOM) throw new Error("Connect the configured Phantom public key");
    provider = connected.provider;
    stage("ENVIRONMENT_CHECK");
    data = await loadReplayData();
    started = true;
    localT = await armLocalActivation();
    stale = await runLocalActivation(data, provider, localT, true, stage);
    view = withResult(view, attempt, "STALE", reproductionMessage(stale));
    showProof();
  } catch (error) { failure("STALE", attempt, error); }
  finally { busy = false; render(); }
}
function review(): void {
  if (busy) return;
  view = withReview(view);
  render();
}
async function confirm(): Promise<void> {
  if (busy || !stale || !data || !provider || localT === null) return;
  if (!panels(view).updatedTerms) return;
  view = beginRefreshedLeg(view);
  const attempt = view.attempt;
  walletRequested = false; submitted = false;
  busy = true; render();
  try {
    // A new click invokes a new build, live state read, simulation, and Phantom request.
    refreshed = await runLocalActivation(data, provider, localT, false, stage);
    view = withResult(view, attempt, "REFRESHED", reproductionMessage(refreshed));
    showProof();
  } catch (error) { failure("REFRESHED", attempt, error); }
  finally { busy = false; render(); }
}
window.addEventListener("DOMContentLoaded", () => {
  element("buy").addEventListener("click", () => void start());
  element("review-order").addEventListener("click", review);
  element("confirm-order").addEventListener("click", () => void confirm());
  text("recorded-details", protectionTechnicalDetails());
  render();
});
