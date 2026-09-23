import { connectPhantomWallet, detectPhantom, type PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import { type BuyStage } from "./buy-error.ts";
import { FeasibilityError } from "./feasibility.ts";
import { EXPECTED_PHANTOM } from "./local-funding.ts";
import { loadReplayData, type ReplayData } from "./replay-execution.ts";
import { armLocalActivation, recordEvidence, runLocalActivation, type LocalActivationProof } from "./local-activation.ts";
import { traderFacingError, protectionTechnicalDetails } from "./trader-flow.ts";
import { reproductionMessage } from "./reproduction-view.ts";

let provider: PhantomProvider | null = null;
let data: ReplayData | null = null;
let localT: bigint | null = null;
let stale: LocalActivationProof | null = null;
let refreshed: LocalActivationProof | null = null;
let busy = false;
let started = false;
let reviewed = false;
let failureStage: BuyStage = "ENVIRONMENT_CHECK";
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing UI node " + id);
  return node as T;
}
function text(id: string, value: string): void { element(id).textContent = value; }
function controls(): void {
  element<HTMLButtonElement>("buy").disabled = busy || started;
  element<HTMLButtonElement>("review-order").disabled = busy || !stale;
  element<HTMLButtonElement>("confirm-order").disabled = busy || !reviewed || !!refreshed;
}
function stage(value: BuyStage, clock?: { unixTimestamp: bigint }): void {
  failureStage = value;
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
  element("notice").hidden = false;
  if (value === "WAITING_FOR_ACTIVATION" && clock && localT !== null) {
    const left = localT - clock.unixTimestamp;
    text("notice", left > 0n
      ? "Authorization signed ✓\nTransaction held\nEconomic state changes in: " + left + "…"
      : "State changed\nSubmitting the exact signed transaction once the validator Clock is past local T.");
  } else text("notice", status[value] ?? "Connecting Phantom…");
}
function showProof(): void {
  element("technical-drawer").hidden = false;
  text("technical-body", JSON.stringify({ environment: "LOCAL_EXECUTION_REPRODUCTION", stale, refreshed },
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  // Evidence capture is a side record; it never changes what the verified run displayed.
  recordEvidence({ stale, refreshed }).catch((error: unknown) => console.warn(error));
}
function failure(error: unknown): void {
  const facing = traderFacingError("buy", error, failureStage, location.hostname === "localhost" || location.hostname === "127.0.0.1");
  element("notice").hidden = false; text("notice", facing.headline);
  element("technical-drawer").hidden = false; text("technical-body", facing.technical);
}
async function start(): Promise<void> {
  if (busy || started) return;
  busy = true; controls();
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
    text("review-body", reproductionMessage(stale));
    element("review").hidden = false; element("notice").hidden = true;
    showProof();
  } catch (error) { failure(error); }
  finally { busy = false; controls(); }
}
function review(): void {
  if (!stale || busy || refreshed) return;
  reviewed = true; element("updated-terms").hidden = false; controls();
}
async function confirm(): Promise<void> {
  if (busy || !reviewed || !stale || !data || !provider || localT === null || refreshed) return;
  busy = true; controls();
  try {
    // A new click invokes a new build, live state read, simulation, and Phantom request.
    refreshed = await runLocalActivation(data, provider, localT, false, stage);
    text("done-copy", reproductionMessage(refreshed));
    element("done").hidden = false; element("updated-terms").hidden = true; element("notice").hidden = true;
    showProof();
  } catch (error) { failure(error); }
  finally { busy = false; controls(); }
}
window.addEventListener("DOMContentLoaded", () => {
  element("buy").addEventListener("click", () => void start());
  element("review-order").addEventListener("click", review);
  element("confirm-order").addEventListener("click", () => void confirm());
  text("recorded-details", protectionTechnicalDetails());
  controls();
});
