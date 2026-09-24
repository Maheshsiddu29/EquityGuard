import type { LiveResult } from "./live-execution.ts";
import { DEMO_ASSET_DISCLAIMER, SCENARIO_CATALOG } from "./scenarios.ts";

export const PROTECTION_EXPLANATION = "The asset's economic state changed after authorization. EquityGuard required a new authorization instead of silently executing against the changed state.";

export function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element #${id} not found`);
  return element as T;
}

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const token = (raw: bigint) => `${raw < 0n ? "−" : "+"}${(Number(raw < 0n ? -raw : raw) / 1_000_000).toFixed(2)}`;

export function resultMarkup(result: LiveResult): string {
  if (result.type === "LOCAL_PREVIEW") return `<div class="result result-expected"><span class="result-label">Expected</span><strong>${result.expected === "ALLOW" ? "State should match" : "EquityGuard should reject stale state"}</strong><p>No transaction has been signed or submitted.</p></div>`;
  if (result.type === "PENDING") {
    const labels = {
      READY: "Preparing transaction",
      SIGNING: "Waiting for Phantom",
      HOLDING: "Holding signed authorization",
      WAITING_FOR_CLOCK: "Waiting for the Devnet clock",
      SUBMITTED: "Submitted to devnet",
      CONFIRMING: "Confirming on devnet",
      VERIFYING_MINT: "Verifying demo asset",
    } as const;
    return `<div class="result result-pending"><span class="spinner" aria-hidden="true"></span><div><span class="result-label">Live transaction</span><strong>${labels[result.phase]}</strong>${result.signature ? `<a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View pending transaction ↗</a>` : ""}</div></div>`;
  }
  if (result.type === "STALE_AUTHORIZATION_EXPIRED") {
    return `<div class="result result-failed"><span class="result-label">Not submitted</span><strong>STALE_AUTHORIZATION_EXPIRED</strong><p>The signed authorization expired before Solana could land it. This is not a protection result. Start a new attempt.</p></div>`;
  }
  if (result.type === "CONFIRMED_ACTIVATION_REJECTION") {
    return `<div class="result result-block"><span class="result-label">Protected by EquityGuard</span><strong>PROTECTED BY EQUITYGUARD</strong><div class="delta"><span>Asset ${escapeHtml(result.symbol)}</span><span>${escapeHtml(result.eventLabel)}</span></div><p>Authorized state ${escapeHtml(result.authorizedMultiplier)}</p><p>Current state ${escapeHtml(result.currentMultiplier)}</p><p>Guard result ActivationPhaseChanged</p><p>Downstream action BLOCKED</p><p>Token movement 0</p><p>Network Solana Devnet</p><p>${escapeHtml(PROTECTION_EXPLANATION)}</p><p>${escapeHtml(DEMO_ASSET_DISCLAIMER)}</p><a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View on Solana Explorer ↗</a></div>`;
  }
  if (result.type === "CONFIRMED_UPDATED_EXECUTION") {
    return `<div class="result result-success"><span class="result-label">Confirmed on devnet</span><strong>Protected transfer executed</strong><p>Asset ${escapeHtml(result.symbol)}</p><p>${escapeHtml(result.eventLabel)}</p><p>EquityGuard passed</p><p>Token transfer executed</p><p>Token movement ${escapeHtml(result.tokenMovementRaw)}</p><p>Network Solana Devnet</p><p>${escapeHtml(DEMO_ASSET_DISCLAIMER)}</p><a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View on Solana Explorer ↗</a></div>`;
  }
  if (result.type === "CANCELLED") return `<div class="result result-neutral"><span class="result-label">Cancelled</span><strong>Signature request cancelled</strong><p>${escapeHtml(result.detail)}</p></div>`;
  if (result.type === "FAILED") return `<div class="result result-failed"><span class="result-label">Failed</span><strong>Transaction was not confirmed as the expected proof</strong><p>${escapeHtml(result.detail)}</p>${result.signature ? `<a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View transaction ↗</a>` : ""}</div>`;
  if (result.type === "CONFIRMED_GUARD_REJECTION") return `<div class="result result-block"><span class="result-label">Confirmed on devnet</span><strong>Blocked by EquityGuard</strong><p>State changed after authorization.</p><div class="delta"><span>Source 0.00</span><span>Destination 0.00</span></div><p class="fee-note">0 tokens transferred. A network fee may still be charged.</p><a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View on Solana Explorer ↗</a><details><summary>Technical result</summary><code>Instruction ${result.instructionIndex} · MultiplierChanged / 0x${result.customCode.toString(16)}</code></details></div>`;
  const sourceDelta = result.after.source - result.before.source;
  const destinationDelta = result.after.destination - result.before.destination;
  const title = result.kind === "SETUP" ? "Demo asset created" : result.kind === "REFRESH" ? "Protection refreshed · transfer confirmed" : "Protected transfer executed";
  return `<div class="result result-success"><span class="result-label">Confirmed on devnet</span><strong>${title}</strong>${result.kind === "SETUP" ? "" : `<div class="delta"><span>Source ${token(sourceDelta)}</span><span>Destination ${token(destinationDelta)}</span></div>`}<a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View on Solana Explorer ↗</a><span class="slot">Slot ${result.slot}</span></div>`;
}

export function renderResult(id: string, result: LiveResult): void { getElement<HTMLElement>(id).innerHTML = resultMarkup(result); }
export function explorerUrl(signature: string): string { return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`; }
export function setBadge(id: string, label: string, tone: "ok" | "wait" | "bad"): void { const badge = getElement<HTMLElement>(id); badge.textContent = label; badge.className = `badge badge-${tone}`; }

export function setLiveTechnical(stage: string, signature?: string, raw?: unknown): void {
  getElement<HTMLElement>("live-stage").textContent = stage;
  if (signature) getElement<HTMLElement>("live-signature").textContent = signature;
  if (raw !== undefined) logActivity("Raw live-flow error", rawText(raw));
}

function rawText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.stack ?? raw.message;
  try { return JSON.stringify(raw, (_key, value: unknown) => typeof value === "bigint" ? `${value}n` : value); }
  catch { return String(raw); }
}

export function setWallet(address: string | null, sol: number | null): void {
  getElement<HTMLElement>("wallet-address").textContent = address ? short(address) : "Not connected";
  getElement<HTMLElement>("wallet-address").title = address ?? "";
  getElement<HTMLElement>("sol-balance").textContent = sol === null ? "—" : `${sol.toFixed(3)} SOL`;
  getElement<HTMLElement>("wallet-full").textContent = address ?? "Not connected";
  getElement<HTMLButtonElement>("connect-btn").textContent = address ? "Disconnect" : "Connect Phantom";
}

export function setWalletMessage(message: string): void { getElement<HTMLElement>("wallet-status").textContent = message; }

export function setAsset(mint: string | null, balance: bigint | null): void {
  getElement<HTMLElement>("mint-address").textContent = mint ? short(mint) : "Not created";
  getElement<HTMLElement>("mint-address").title = mint ?? "";
  getElement<HTMLElement>("token-balance").textContent = balance === null ? "—" : `${(Number(balance) / 1_000_000).toFixed(2)} demo tokens`;
  getElement<HTMLElement>("mint-full").textContent = mint ?? "Not created";
  getElement<HTMLElement>("token-raw").textContent = balance === null ? "—" : balance.toString();
}

export function logActivity(message: string, raw?: unknown): void {
  const line = document.createElement("div");
  line.textContent = `${new Date().toISOString()}  ${message}${raw === undefined ? "" : ` · ${String(raw)}`}`;
  getElement<HTMLElement>("activity-log").append(line);
}

export interface ScenarioPreview {
  readonly symbol: string;
  readonly displayName: string;
  readonly eventLabel: string;
  readonly currentMultiplier: string;
  readonly scheduledMultiplier: string;
  readonly activation?: string;
  readonly chainClock?: string;
}

export function renderScenarioPreview(preview: ScenarioPreview): void {
  getElement<HTMLElement>("scenario-panel").innerHTML = `<div class="expected"><span>${escapeHtml(preview.symbol)}</span><strong>${escapeHtml(preview.displayName)}</strong><p>${escapeHtml(preview.eventLabel)}</p><p>Current multiplier ${escapeHtml(preview.currentMultiplier)}</p><p>Scheduled multiplier ${escapeHtml(preview.scheduledMultiplier)}</p>${preview.activation ? `<p>Activation ${escapeHtml(preview.activation)}</p>` : ""}${preview.chainClock ? `<p>Chain clock ${escapeHtml(preview.chainClock)}</p>` : ""}<p>Protected action: token transfer</p></div>`;
}

export function showUpdatedReview(input: {
  readonly symbol: string;
  readonly eventLabel: string;
  readonly previousMultiplier: string;
  readonly currentMultiplier: string;
}): void {
  const panel = getElement<HTMLElement>("review-panel");
  panel.hidden = false;
  panel.innerHTML = `<div class="expected"><span>Review updated state</span><strong>${escapeHtml(input.symbol)}</strong><p>${escapeHtml(input.eventLabel)}</p><p>Previous multiplier ${escapeHtml(input.previousMultiplier)}</p><p>Current multiplier ${escapeHtml(input.currentMultiplier)}</p><p>${escapeHtml(DEMO_ASSET_DISCLAIMER)}</p></div>`;
  getElement<HTMLButtonElement>("confirm-updated-btn").hidden = false;
}

export function showNewAttempt(): void {
  getElement<HTMLButtonElement>("attempt-reset-btn").hidden = false;
}

/** Replaces the previous SAFE/BLOCK/REFRESH controls with the corporate-action flow. */
export function installCorporateActionDemo(): void {
  document.querySelectorAll(".setup, .workflow").forEach((element) => element.remove());
  const lede = document.querySelector(".lede");
  if (lede) lede.textContent = "Choose a demo equity, arm its corporate action, and sign the protected transfer before and after activation.";
  const disclosure = document.querySelector(".disclosure");
  if (disclosure) disclosure.textContent = DEMO_ASSET_DISCLAIMER;
  const main = document.querySelector("main.wallet-page");
  if (!main) throw new Error("Demo page is missing its main region");
  const section = document.createElement("section");
  section.className = "setup card";
  section.id = "corporate-demo";
  section.innerHTML = `<div class="step-number">1</div><div class="step-copy"><span class="eyebrow">Devnet demonstration</span><h2>Corporate action</h2><p id="demo-disclaimer" class="disclosure"></p><label class="asset-line">Asset <select id="scenario-select"></select></label><button id="random-scenario-btn" class="text-button" type="button">Random scenario</button><div class="asset-line"><span>Mint <strong id="mint-address">Not created</strong></span><span id="token-balance">—</span></div><div id="scenario-panel"></div></div><div class="step-action"><button id="prepare-btn" class="button button-primary" type="button" disabled>Prepare live demo</button><div id="prepare-result" aria-live="polite"></div><button id="authorize-btn" class="button button-primary" type="button" disabled>Authorize protected action</button><div id="authorize-result" aria-live="polite"></div><div id="review-panel" hidden></div><button id="confirm-updated-btn" class="button button-primary" type="button" hidden disabled>Confirm updated action</button><div id="updated-result" aria-live="polite"></div><button id="attempt-reset-btn" class="text-button" type="button" hidden>Start a new attempt</button></div>`;
  const recorded = main.querySelector(".recorded");
  if (recorded) main.insertBefore(section, recorded);
  else main.append(section);
  getElement<HTMLElement>("demo-disclaimer").textContent = DEMO_ASSET_DISCLAIMER;
  const select = getElement<HTMLSelectElement>("scenario-select");
  for (const scenario of SCENARIO_CATALOG) {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = `${scenario.symbol} · ${scenario.displayName}`;
    select.append(option);
  }
  const first = SCENARIO_CATALOG[0];
  if (first) select.value = first.id;
}
