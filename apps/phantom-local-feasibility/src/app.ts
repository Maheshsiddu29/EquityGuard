import { address, type Address } from "@solana/kit";

import { connectPhantomWallet, detectPhantom, type PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import { FeasibilityError } from "./feasibility.ts";
import {
  REFRESHED_AUTHORIZATION_SOURCE,
  STALE_AUTHORIZATION_SOURCE,
} from "./local-funding.ts";
import {
  loadReplayData,
  prepareReplay,
  signSubmitAndConfirmReplay,
  type ReplayData,
  type ReplayOutcome,
} from "./replay-execution.ts";
import {
  assertReplayApproval,
  nextReplayStep,
  type ReplayStep,
} from "./replay-model.ts";
import {
  TRADER_BUY_KIND,
  TRADER_CONFIRM_KIND,
  TRADER_INITIAL_STEP,
  refreshedSuccessMessage,
  staleReviewMessage,
  technicalEvidence,
  traderFacingError,
} from "./trader-flow.ts";

interface State {
  provider: PhantomProvider | null;
  wallet: Address | null;
  busy: boolean;
  replayData: ReplayData | null;
  replayStep: ReplayStep;
  approvals: number;
  stale: ReplayOutcome | null;
  refreshed: ReplayOutcome | null;
}

const state: State = {
  provider: null,
  wallet: null,
  busy: false,
  replayData: null,
  replayStep: TRADER_INITIAL_STEP,
  approvals: 0,
  stale: null,
  refreshed: null,
};

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI node ${id}`);
  return node as T;
}

function setText(id: string, value: string): void {
  element(id).textContent = value;
}

function showNotice(value: string): void {
  const notice = element("notice");
  notice.hidden = false;
  notice.textContent = value;
}

function showFailure(action: "buy" | "confirm", error: unknown): void {
  const facing = traderFacingError(action, error);
  showNotice(facing.headline);
  element("technical-drawer").hidden = false;
  setText("technical-body", facing.technical);
}

function updateControls(): void {
  element<HTMLButtonElement>("buy").disabled = state.busy || state.replayStep !== "READY_STALE";
  element<HTMLButtonElement>("review-order").disabled = state.busy || state.replayStep !== "STALE_REJECTED";
  element<HTMLButtonElement>("confirm-order").disabled = state.busy || state.replayStep !== "STALE_REJECTED";
}

async function ensureWallet(): Promise<void> {
  if (!detectPhantom()) {
    throw new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected.");
  }
  if (state.provider && state.wallet) return;
  const connected = await connectPhantomWallet();
  state.provider = connected.provider;
  state.wallet = address(connected.publicKey);
}

async function submit(kind: typeof TRADER_BUY_KIND | typeof TRADER_CONFIRM_KIND): Promise<void> {
  if (!state.provider || !state.wallet || !state.replayData) {
    throw new Error("Local replay environment unavailable");
  }
  assertReplayApproval(state.replayStep, kind);
  if (kind === TRADER_CONFIRM_KIND && state.approvals < 1) {
    throw new Error("Updated order requires a second Phantom approval");
  }
  const prepared = await prepareReplay(state.replayData, state.wallet, kind);
  if (kind === TRADER_BUY_KIND && prepared.authorizationSource !== STALE_AUTHORIZATION_SOURCE) {
    throw new Error("Buy authorization is not the sealed pre-activation observation");
  }
  if (kind === TRADER_CONFIRM_KIND && prepared.authorizationSource !== REFRESHED_AUTHORIZATION_SOURCE) {
    throw new Error("Updated authorization is not the sealed post-activation observation");
  }
  const outcome = await signSubmitAndConfirmReplay(state.provider, prepared);
  state.approvals += 1;
  state.replayStep = nextReplayStep(state.replayStep, kind);
  if (kind === TRADER_BUY_KIND) {
    const message = staleReviewMessage(outcome);
    if (!message) throw new Error("Landed stale transaction did not prove zero token movement");
    state.stale = outcome;
    element("notice").hidden = true;
    setText("review-body", message);
    element("review").hidden = false;
    return;
  }
  const message = refreshedSuccessMessage(outcome);
  const proof = state.stale ? technicalEvidence(state.stale, outcome) : null;
  if (!message || !proof) throw new Error("Landed updated transaction did not prove Jupiter and Whirlpool execution");
  state.refreshed = outcome;
  element("review").hidden = true;
  element("order").hidden = true;
  element("done").hidden = false;
  setText("done-copy", message);
  setText("proof-body", proof);
}

async function buy(): Promise<void> {
  if (state.replayStep !== "READY_STALE") return;
  state.busy = true;
  updateControls();
  element("technical-drawer").hidden = true;
  try {
    await ensureWallet();
    state.replayData ??= await loadReplayData();
    await submit(TRADER_BUY_KIND);
  } catch (error) {
    showFailure("buy", error);
  } finally {
    state.busy = false;
    updateControls();
  }
}

async function confirmUpdatedOrder(): Promise<void> {
  if (state.replayStep !== "STALE_REJECTED") return;
  state.busy = true;
  updateControls();
  element("technical-drawer").hidden = true;
  try {
    await submit(TRADER_CONFIRM_KIND);
  } catch (error) {
    showFailure("confirm", error);
  } finally {
    state.busy = false;
    updateControls();
  }
}

function reviewUpdatedOrder(): void {
  if (state.replayStep !== "STALE_REJECTED") return;
  element("updated-terms").hidden = false;
}

function main(): void {
  element<HTMLButtonElement>("buy").addEventListener("click", () => void buy());
  element<HTMLButtonElement>("review-order").addEventListener("click", reviewUpdatedOrder);
  element<HTMLButtonElement>("confirm-order").addEventListener("click", () => void confirmUpdatedOrder());
  updateControls();
}

window.addEventListener("DOMContentLoaded", main);
