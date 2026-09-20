import type { LiveResult } from "./live-execution.ts";

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
    const labels = { READY: "Preparing transaction", SIGNING: "Waiting for Phantom", SUBMITTED: "Submitted to devnet", CONFIRMING: "Confirming on devnet", VERIFYING_MINT: "Verifying demo asset" } as const;
    return `<div class="result result-pending"><span class="spinner" aria-hidden="true"></span><div><span class="result-label">Live transaction</span><strong>${labels[result.phase]}</strong>${result.signature ? `<a href="${explorerUrl(result.signature)}" target="_blank" rel="noopener">View pending transaction ↗</a>` : ""}</div></div>`;
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
