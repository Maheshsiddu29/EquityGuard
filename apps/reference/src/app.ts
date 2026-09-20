import type { ReferenceState, ScenarioId } from "./model.ts";

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
const utc = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace(".000Z", " UTC");
const short = (value: string) => `${value.slice(0, 7)}…${value.slice(-7)}`;

function loadState(): ReferenceState {
  const node = document.getElementById("eg-reference-state");
  if (!node?.textContent) throw new Error("Reference state is missing. Run npm run app:build.");
  return JSON.parse(node.textContent) as ReferenceState;
}

function scenarioDemo(state: ReferenceState, active: Exclude<ScenarioId, "consent">): string {
  const scenario = state.scenarios[active];
  const blocked = scenario.decision.type === "BLOCK";
  const refreshed = active === "refreshed";
  const rows = refreshed
    ? [["New authorization", scenario.authorized.tag], ["Execution", scenario.current.tag]]
    : [["State at authorization", scenario.authorized.tag], ["State at execution", scenario.current.tag]];
  return `<div class="demo-panel demo-${active}">
    <div class="demo-timeline">${rows.map(([label, value], index) => `<div class="state-point"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>${index === 0 ? '<div class="state-line"><span></span></div>' : ""}`).join("")}</div>
    <div class="verdict"><span>Result</span><strong>${blocked ? "BLOCK" : "ALLOW"}</strong><p>${esc(scenario.headline)}. ${esc(scenario.detail)}</p></div>
    <details><summary>View evidence details</summary><div class="evidence-detail"><div><span>Authorization time</span><code>${esc(utc(scenario.authorized.chainTime))}</code></div><div><span>Execution time</span><code>${esc(utc(scenario.current.chainTime))}</code></div><div><span>Multiplier</span><code>${esc(scenario.current.multiplier)}</code></div><div><span>New multiplier</span><code>${esc(scenario.current.newMultiplier)}</code></div><div><span>Activation T</span><code>${esc(utc(scenario.current.effectiveAt))}</code></div><div><span>Slot</span><code>${esc(scenario.current.slot)}</code></div><div><span>State fingerprint</span><code>${esc(scenario.current.fingerprint)}</code></div><div><span>Transaction commitment</span><code>Not applicable — guard-model replay</code></div></div></details>
  </div>`;
}

function render(state: ReferenceState, active: Exclude<ScenarioId, "consent">): void {
  const demo = document.getElementById("interactive-demo");
  if (!demo) return;
  demo.innerHTML = scenarioDemo(state, active);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
    const selected = button.dataset.scenario === active;
    button.classList.toggle("selected", selected); button.setAttribute("aria-selected", String(selected));
  }
}

function main(): void {
  const state = loadState(); let active: Exclude<ScenarioId, "consent"> = "safe";
  document.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-scenario]");
    const next = target?.dataset.scenario;
    if (next === "safe" || next === "stale" || next === "refreshed") { active = next; render(state, active); }
  });
  const fields: Record<string, string> = {
    "kox-effective": utc(state.divergence.kox.effectiveAt), "koon-effective": utc(state.divergence.koon.effectiveAt),
    "replay-bytes": String(state.replay.transactionBytes), "guard-hash": short(state.replay.guardBinarySha256),
  };
  for (const [id, value] of Object.entries(fields)) { const node = document.getElementById(id); if (node) node.textContent = value; }
  render(state, active);
}

main();
