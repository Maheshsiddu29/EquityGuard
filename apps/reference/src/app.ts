import type { ReferenceState } from "./model.ts";

function loadState(): ReferenceState {
  const node = document.getElementById("eg-reference-state");
  if (!node?.textContent) throw new Error("Reference state is missing. Run npm run app:build.");
  return JSON.parse(node.textContent) as ReferenceState;
}

const byId = (id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing UI node ${id}`);
  return node;
};
const set = (id: string, value: string) => { byId(id).textContent = value; };
const utcTime = (iso: string) => new Date(iso).toISOString().slice(11, 19) + " UTC";
const short = (value: string) => `${value.slice(0, 7)}…${value.slice(-7)}`;
const rawAmount = (raw: string, decimals: number) => {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "−" : "+"}${whole}${fraction ? `.${fraction}` : ""}`;
};

const stages = ["Preparing order", "Checking market state", "Attempting protected trade", "Order needs refresh", "Refreshing automatically", "Protected trade completed"] as const;

function populate(state: ReferenceState): void {
  set("asset-name", state.asset.name);
  set("asset-symbol", state.asset.symbol);
  set("pay-amount", `${state.order.inputAmount} ${state.order.inputSymbol}`);
  set("receive-amount", `${state.order.estimatedOutput} ${state.order.outputSymbol}`);
  set("prepared-time", utcTime(state.marketEvidence.preparedAt));
  set("activation-time", utcTime(state.marketEvidence.activationAt));
  set("post-time", utcTime(state.marketEvidence.postAt));
  set("stale-guard", `${state.staleExecution.equityGuard} at instruction ${String(state.staleExecution.failedInstruction)}`);
  set("stale-jupiter", state.staleExecution.jupiter.replace("_", " "));
  set("stale-usdc", rawAmount(state.staleExecution.usdcDelta, 6));
  set("stale-kox", rawAmount(state.staleExecution.koxDelta, state.asset.decimals));
  set("refresh-guard", state.refreshedExecution.equityGuard);
  set("refresh-jupiter", state.refreshedExecution.jupiter);
  set("refresh-whirlpool", state.refreshedExecution.whirlpool);
  set("refresh-usdc", rawAmount(state.refreshedExecution.usdcDelta, 6));
  set("refresh-kox", rawAmount(state.refreshedExecution.koxDelta, state.asset.decimals));
  set("route-date", new Date(state.routeEvidence.capturedAt).toISOString().slice(0, 10));
  set("route-venue", state.routeEvidence.venue);
  set("route-pool", short(state.routeEvidence.pool));
  set("guard-program", short(state.localExecution.guardProgram));
  set("guard-hash", short(state.localExecution.guardBinarySha256));
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-live-devnet]")) link.href = state.liveDevnetProofUrl;
}

async function runReplay(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  byId("trade-progress").classList.add("running");
  byId("trade-result").hidden = true;
  const rows = [...document.querySelectorAll<HTMLElement>("[data-stage]")];
  for (let i = 0; i < stages.length; i++) {
    rows.forEach((row, index) => row.classList.toggle("active", index === i));
    rows.slice(0, i).forEach((row) => row.classList.add("done"));
    set("stage-live", stages[i]!);
    await new Promise((resolve) => window.setTimeout(resolve, i === 3 ? 700 : 380));
  }
  rows.forEach((row) => { row.classList.remove("active"); row.classList.add("done"); });
  byId("trade-result").hidden = false;
  button.textContent = "Replay complete";
}

function main(): void {
  const state = loadState();
  populate(state);
  const button = byId("run-trade") as HTMLButtonElement;
  button.addEventListener("click", () => { void runReplay(button); });
}

main();
