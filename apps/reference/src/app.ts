/**
 * Reference app renderer. It renders the build-time `ReferenceState` and
 * switches between its precomputed scenarios. It has no network, wallet or
 * signing code: every button either changes the displayed scenario or
 * explains that nothing is sent.
 *
 * The Sep 15 state-transition cases and the separate Sep 17 local replay are
 * rendered in separate sections and never share values.
 */

import type { BlockReason, GuardDecision } from "./decision.ts";
import type { EconomicStateView, GuardWindowView, Provenance, ReferenceState, ReplayCase, Scenario, ScenarioId } from "./model.ts";

const SCENARIO_ORDER: readonly ScenarioId[] = ["safe", "stale", "refreshed", "consent"];
const MAIN_FLOW: readonly ScenarioId[] = ["safe", "stale", "refreshed"];

const esc = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const short = (value: string, head = 4, tail = 4) => (value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`);
const grouped = (raw: string) => raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function utc(isoTime: string, withSeconds = true): string {
  const d = new Date(isoTime);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSeconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${time} UTC`;
}
const day = (isoTime: string) => {
  const d = new Date(isoTime);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const clock = (isoTime: string) => new Date(isoTime).toISOString().slice(11, 19);
const minSec = (secs: number) => `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;

const PROVENANCE_LABEL: Record<Provenance, string> = {
  MAINNET_OBSERVATION: "Mainnet observation",
  LOCAL_REPLAY: "Local replay",
  GUARD_MODEL: "Guard model",
  ILLUSTRATIVE: "Illustrative",
};

const BLOCK_COPY: Record<BlockReason, string> = {
  ECONOMIC_STATE_CHANGED: "Economic state changed",
  INTENT_MISMATCH: "Transaction changed",
  UNVERIFIABLE_STATE: "State could not be verified",
};

const ICON = {
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 7" /></svg>',
  cross: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>',
  dot: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 2.7v5.6c0 4.4-3 7.9-7 9.3-4-1.4-7-4.9-7-9.3V5.7z" /><path d="M8.8 12.2l2.2 2.2 4.2-4.6" /></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 2.7v5.6c0 4.4-3 7.9-7 9.3-4-1.4-7-4.9-7-9.3V5.7z" /><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" /></svg>',
  question: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 2.7v5.6c0 4.4-3 7.9-7 9.3-4-1.4-7-4.9-7-9.3V5.7z" /><path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.3" /><path d="M12 16.4v.1" /></svg>',
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" /></svg>',
  refresh: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 8A6 6 0 0 0 4.6 7M4.5 12a6 6 0 0 0 10.9 1" /><path d="M4.3 3.8v3.4h3.4M15.7 16.2v-3.4h-3.4" /></svg>',
};

type Tone = "allow" | "block" | "consent";
const toneOf = (d: GuardDecision): Tone => (d.type === "ALLOW" ? "allow" : d.type === "BLOCK" ? "block" : "consent");
const decisionCode = (d: GuardDecision) => (d.type === "ALLOW" ? "ALLOW" : `${d.type}: ${d.reason}`);

function loadState(): ReferenceState {
  const node = document.getElementById("eg-reference-state");
  if (!node?.textContent) throw new Error("reference state missing: run npm run app:build");
  return JSON.parse(node.textContent) as ReferenceState;
}

function initialScenario(): ScenarioId {
  const requested = new URLSearchParams(location.search).get("state");
  return SCENARIO_ORDER.find((id) => id === requested) ?? "safe";
}

function chip(p: Provenance) {
  return `<span class="prov prov-${p.toLowerCase().replace("_", "-")}">${esc(PROVENANCE_LABEL[p])}</span>`;
}

const windowShort = (w: GuardWindowView) => (w.beforeSecs === 0 && w.afterSecs === 0 ? "None (0 s)" : `${w.beforeSecs / 60} min before / ${w.afterSecs / 60} min after`);

function flowBar(active: ScenarioId, state: ReferenceState, demoOpen: boolean) {
  const labels: Record<string, string> = { safe: "Trade prepared", stale: "KOx changed state", refreshed: "Trade refreshed" };
  const index = MAIN_FLOW.indexOf(active);
  const steps = MAIN_FLOW.map((id, i) => {
    const status = index === -1 ? "idle" : i < index ? "done" : i === index ? "current" : "idle";
    return `<li class="step step-${status}"><span class="step-n">${i + 1}</span><span>${esc(labels[id])}</span></li>`;
  }).join('<li class="step-sep" aria-hidden="true"></li>');
  const extra = index === -1 ? `<span class="case-tag">Illustrative case · ${esc(state.scenarios[active].label)}</span>` : "";
  const controls = SCENARIO_ORDER.map((id, i) => {
    const s = state.scenarios[id];
    const sep = s.illustrative ? '<span class="seg-divider" aria-hidden="true"></span>' : "";
    return `${sep}<button role="radio" aria-checked="${id === active}" class="${id === active ? "on" : ""}${s.illustrative ? " seg-illustrative" : ""}" data-scenario="${id}"><kbd>${i + 1}</kbd>${esc(s.label)}${s.illustrative ? " (illustrative)" : ""}</button>`;
  }).join("");
  return `
  <div class="flow">
    <ol class="steps" aria-label="Trade flow">${steps}</ol>
    <div class="flow-right">${extra}<button class="demo-toggle" data-action="toggle-demo" aria-expanded="${demoOpen}">Demo controls</button></div>
  </div>
  <div class="demo-panel" ${demoOpen ? "" : "hidden"}>
    <span class="demo-note">Precomputed cases · keys 1–4</span>
    <div class="seg-control" role="radiogroup" aria-label="Demo case">${controls}</div>
  </div>`;
}

function tradeCard(s: Scenario, state: ReferenceState) {
  const { order, asset } = state;
  const tone = toneOf(s.decision);
  const icon = tone === "allow" ? ICON.shield : tone === "block" ? ICON.stop : ICON.question;
  let actions: string;
  if (s.id === "stale") {
    actions = `<button class="btn btn-primary" data-action="refresh">${ICON.refresh}<span>Refresh trade</span></button>`;
  } else if (s.decision.type === "REQUIRES_CONSENT") {
    const d = s.decision.disclosure;
    actions = `<button class="btn btn-consent" data-action="approve">Review switch to ${esc(d.toSymbol)} (illustrative)</button>
      <button class="btn btn-ghost" data-action="wait">Keep ${esc(d.fromSymbol)} and refresh later</button>`;
  } else {
    actions = `<button class="btn btn-primary" data-action="submit">Continue to wallet</button>`;
    if (s.id === "safe") actions += `<button class="btn btn-link" data-action="what-if">What if KOx changes state first?${ICON.arrow}</button>`;
  }
  const banner = s.illustrative
    ? `<div class="illustrative-banner">${chip("ILLUSTRATIVE")}<span>Not a real reroute. No KOon route existed; the quote is made up to show the approval step.</span></div>`
    : "";
  return `
  <section class="card trade" aria-labelledby="trade-title">
    <div class="card-head">
      <h2 id="trade-title">Buy</h2>
      <span class="muted small">Example order</span>
    </div>
    <div class="asset">
      <div class="asset-logo" aria-hidden="true">KO</div>
      <div class="asset-text">
        <div class="asset-name">${esc(asset.name)}</div>
        <div class="muted">${esc(asset.symbol)} · ${esc(asset.issuer)}</div>
      </div>
      <span class="pill">Tokenized stock</span>
    </div>
    <div class="fields">
      <div class="field">
        <span class="field-label">You pay</span>
        <span class="field-value"><span class="amount">${esc(order.inputUsdc)}</span><span class="unit">USDC</span></span>
      </div>
      <div class="field">
        <span class="field-label">You receive</span>
        <span class="field-value"><span class="amount amount-soft">${esc(asset.symbol)}</span><span class="unit">quoted at signing</span></span>
      </div>
    </div>
    <dl class="route">
      <div><dt>Route</dt><dd>${esc(order.aggregator)}</dd></div>
      <div><dt>Protection</dt><dd class="protect-on">${ICON.check}EquityGuard</dd></div>
    </dl>
    ${banner}
    <div class="status status-${tone}" role="status" aria-live="polite">
      <div class="status-icon">${icon}</div>
      <div>
        <div class="status-title">${esc(s.headline)}</div>
        <p>${esc(s.detail)}</p>
        <p class="status-settle">${esc(s.settlement)}</p>
      </div>
    </div>
    <div class="actions">${actions}</div>
    <p class="toast" id="toast" hidden></p>
  </section>`;
}

function stateLine(v: EconomicStateView) {
  return `<span class="state-tag">${esc(v.tag)}</span><span>${esc(v.summary)}</span><span class="muted small">${esc(clock(v.chainTime))} UTC</span>`;
}

function protectionPanel(s: Scenario, state: ReferenceState) {
  const d = s.decision;
  const tone = toneOf(d);
  const stateChanged = s.authorized.fingerprint !== s.current.fingerprint;
  const currentOk = !stateChanged && !s.illustrative;
  const row = (ok: boolean | null, title: string, body: string) => `
    <li class="check ${ok === null ? "check-neutral" : ok ? "check-ok" : "check-bad"}">
      <span class="check-icon">${ok === null ? ICON.dot : ok ? ICON.check : ICON.cross}</span>
      <div><div class="check-title">${title}</div><div class="check-body">${body}</div></div>
    </li>`;
  const verdict =
    d.type === "ALLOW"
      ? `<div class="verdict-word">ALLOW</div><div class="verdict-sub">Guard passes · trade can proceed</div>`
      : d.type === "BLOCK"
        ? `<div class="verdict-word">BLOCK</div><div class="verdict-sub">${esc(BLOCK_COPY[d.reason])}</div>`
        : `<div class="verdict-word">CONSENT</div><div class="verdict-sub">Illustrative · representation change needs approval</div>`;
  const consent =
    d.type === "REQUIRES_CONSENT"
      ? `<div class="disclosure">
          <div class="disclosure-head"><span>${esc(d.disclosure.fromSymbol)} <span class="muted">${esc(d.disclosure.fromIssuer)}</span></span>${ICON.arrow}<span>${esc(d.disclosure.toSymbol)} <span class="muted">${esc(d.disclosure.toIssuer)}</span></span>${chip("ILLUSTRATIVE")}</div>
          <p>With the made-up quote, switching would cost about <strong>${esc(d.disclosure.additionalCostBps)} bps</strong> more in share terms (limit ${esc(d.disclosure.policyMaxAdditionalCostBps)} bps). ${esc(d.disclosure.notice)}</p>
        </div>`
      : "";
  return `
  <section class="card protection protection-${tone}" aria-labelledby="protection-title">
    <div class="card-head">
      <h2 id="protection-title">Protection</h2>
      <span class="muted small">Checked at ${esc(utc(s.evaluatedAt))}</span>
    </div>
    <div class="verdict verdict-${tone}">${verdict}</div>
    <ul class="checks">
      ${row(true, "Representation verified", `${esc(s.symbol)} · ${esc(s.issuer)} · Token-2022 mint <span class="mono">${esc(short(state.asset.mint))}</span>`)}
      ${row(null, "Authorized economic state", stateLine(s.authorized))}
      ${row(currentOk, "Current economic state", `${stateLine(s.current)}${stateChanged ? `<span class="delta">changed since authorization</span>` : ""}`)}
      ${row(null, "Protection window", `<span>${esc(windowShort(s.window))}</span><span class="muted small">${esc(s.window.note)}</span>`)}
      ${row(null, "Swap binding", `<span>Enforced by the program at execution. Not part of this state check; see the separate local replay below.</span>`)}
    </ul>
    ${consent}
    <div class="typed"><span class="muted">Decision</span><code>${esc(decisionCode(d))}</code></div>
    <ul class="backing">
      ${s.backing.map((b) => `<li>${chip(b.provenance)}<span>${esc(b.text)}</span></li>`).join("")}
    </ul>
  </section>`;
}

function transitionSection(s: Scenario, state: ReferenceState, active: ScenarioId, demoOpen: boolean) {
  const { kox } = state.divergence;
  return `
  <section class="section section-first" aria-labelledby="transition-title">
    <div class="section-head">
      <div>
        <div class="eyebrow">State-transition case · ${esc(day(kox.effectiveAt))}</div>
        <h2 id="transition-title">A stale KOx trade, stopped</h2>
        <p class="muted">Real KOx states recorded at ${esc(clock(kox.lastPendingBlockTime))} and ${esc(clock(kox.firstActivatedBlockTime))} UTC, either side of its ${esc(clock(kox.effectiveAt))} dividend adjustment. Checked by EquityGuard's guard model; no transaction was sent.</p>
      </div>
      <div class="chips">${chip("MAINNET_OBSERVATION")}${chip("GUARD_MODEL")}</div>
    </div>
    ${flowBar(active, state, demoOpen)}
    <div class="grid">${tradeCard(s, state)}${protectionPanel(s, state)}</div>
  </section>`;
}

/** Position of a time on the 23:55–00:40 UTC axis, as a percentage. */
function axis() {
  const start = Date.parse("2026-09-14T23:55:00Z");
  const end = Date.parse("2026-09-15T00:40:00Z");
  const pos = (t: string) => `${(((Date.parse(t) - start) / (end - start)) * 100).toFixed(2)}%`;
  const ticks = ["2026-09-15T00:00:00Z", "2026-09-15T00:10:00Z", "2026-09-15T00:20:00Z", "2026-09-15T00:30:00Z"];
  return { pos, ticks };
}

function timeline(state: ReferenceState) {
  const { kox, koon, seconds, pollingSecs } = state.divergence;
  const { pos, ticks } = axis();
  const koxT = pos(kox.effectiveAt);
  const koonT = pos(koon.effectiveAt);
  return `
  <section class="section" aria-labelledby="timeline-title">
    <div class="section-head">
      <div>
        <div class="eyebrow">Observed evidence · ${esc(day(kox.effectiveAt))}</div>
        <h2 id="timeline-title">Corporate-action timeline</h2>
        <p class="muted">Coca-Cola dividend adjustment. Two tokenized representations, two update mechanisms.</p>
      </div>
      ${chip("MAINNET_OBSERVATION")}
    </div>

    <ol class="sequence" aria-label="How a stale trade is stopped">
      <li><span class="seq-k">Prepared ${esc(clock(kox.lastPendingBlockTime))}</span><span class="seq-v"><span class="state-tag">S</span> adjustment scheduled</span></li>
      <li><span class="seq-k">Corporate action</span><span class="seq-v">KOx activates ${esc(clock(kox.effectiveAt))}</span></li>
      <li><span class="seq-k">Current ${esc(clock(kox.firstActivatedBlockTime))}</span><span class="seq-v"><span class="state-tag">S′</span> adjustment active</span></li>
      <li class="seq-end"><span class="seq-k">Result</span><span class="seq-v">Stale transaction rejected</span></li>
    </ol>

    <div class="card chart">
      <div class="lanes">
        <div class="lane">
          <div class="lane-label"><strong>KOon</strong><span class="muted">Ondo</span></div>
          <div class="track">
            <div class="seg seg-old" style="left:0;width:${koonT}"></div>
            <div class="seg seg-new" style="left:${koonT};right:0"></div>
            <div class="marker marker-immediate" style="left:${koonT}"><span class="marker-label">Immediate update · ${esc(clock(koon.effectiveAt))}</span></div>
          </div>
        </div>
        <div class="lane">
          <div class="lane-label"><strong>KOx</strong><span class="muted">xStocks</span></div>
          <div class="track">
            <div class="seg seg-pending" style="left:0;width:${koxT}"><span class="seg-note">Scheduled since ${esc(clock(kox.pendingFirstObservedAt))} Sep 14</span></div>
            <div class="seg seg-new" style="left:${koxT};right:0"></div>
            <div class="marker marker-clock" style="left:${koxT}"><span class="marker-label">Clock activation · ${esc(clock(kox.effectiveAt))}</span></div>
          </div>
        </div>
        <div class="lane lane-gap">
          <div class="lane-label"></div>
          <div class="track track-gap">
            <div class="gap" style="left:${koonT};width:calc(${koxT} - ${koonT})"><span>${esc(minSec(seconds))} apart</span></div>
          </div>
        </div>
        <div class="lane lane-axis">
          <div class="lane-label"></div>
          <div class="track track-axis">${ticks.map((t) => `<span class="tick" style="left:${pos(t)}">${esc(clock(t).slice(0, 5))}</span>`).join("")}</div>
        </div>
      </div>
      <div class="legend">
        <span><i class="sw sw-old"></i>Previous multiplier</span>
        <span><i class="sw sw-pending"></i>New multiplier scheduled</span>
        <span><i class="sw sw-new"></i>New multiplier active</span>
        <span class="muted">Times UTC, Sep 15 2026 · ~${pollingSecs}s observation cadence</span>
      </div>
    </div>

    <div class="facts">
      <div class="fact">
        <div class="fact-big">${esc(minSec(seconds))}</div>
        <div class="muted">between the stored effective times of KOon (${esc(clock(koon.effectiveAt))}) and KOx (${esc(clock(kox.effectiveAt))}) for the same corporate action.</div>
      </div>
      <div class="fact">
        <div class="fact-title">KOx · scheduled</div>
        <div class="muted">New multiplier stored in advance (first seen ${esc(utc(kox.pendingFirstObservedAt, false))}; issuer API reason “${esc(kox.apiReason)}”). It became active when the Solana Clock passed ${esc(clock(kox.effectiveAt))}, with ${kox.bytesUnchangedAtActivation ? "no change to the account bytes" : "an account update"}.</div>
      </div>
      <div class="fact">
        <div class="fact-title">KOon · immediate</div>
        <div class="muted">New multiplier written already active. Last old state seen ${esc(clock(koon.lastOldObservedAt))}, first new state ${esc(clock(koon.firstNewObservedAt))}; ${koon.pendingPhaseObserved ? "a" : "no"} pending phase observed.</div>
      </div>
    </div>
  </section>`;
}

function replayCaseCard(c: ReplayCase) {
  const tone = toneOf(c.decision);
  const outcome = c.succeeded
    ? `<span class="ok">Executed</span> · ${esc(Number(c.usdcDelta) / -1e6)} USDC in, ${esc(grouped(c.stockDelta))} raw KOx out`
    : `<span class="bad">Rejected at instruction ${esc(c.failedInstruction)}</span> · no tokens moved · ${esc(c.feeLamports)} lamport fee`;
  return `
  <div class="rcase rcase-${tone}">
    <div class="rcase-head"><h3>${esc(c.title)}</h3><code>${esc(decisionCode(c.decision))}</code></div>
    <p class="muted">${esc(c.description)}</p>
    <p class="rcase-out">${outcome}</p>
    <p class="muted small">Jupiter ${c.jupiterRan ? "ran" : "never ran"} · ${esc(c.programsInvoked)} program${c.programsInvoked === 1 ? "" : "s"} invoked${c.decision.type === "BLOCK" ? ` · ${esc(c.decision.guardResult)}` : ""}</p>
  </div>`;
}

function replaySection(state: ReferenceState) {
  const r = state.replay;
  return `
  <section class="section replay" aria-labelledby="replay-title">
    <div class="section-head">
      <div>
        <div class="eyebrow eyebrow-replay">Separate test · ${esc(day(r.recordedAt))}</div>
        <h2 id="replay-title">Local execution replay</h2>
        <p class="muted">A real Jupiter route for KOx, captured from mainnet and run with EquityGuard on a local validator loaded with the real Jupiter and Orca Whirlpool programs.</p>
      </div>
      ${chip("LOCAL_REPLAY")}
    </div>
    <div class="boundary-note">
      <strong>Not the Sep 15 event.</strong> This replay ran two days after KOx's activation. The KOx mint was already active on the local clock (${esc(utc(r.localClock, false))}), and no corporate action happened during it. Its outdated-state case uses a deliberately wrong phase expectation. Not mainnet, not devnet, not a real purchase.
    </div>
    <div class="replay-route">
      <div><span class="muted">Route</span><span>${esc(r.inputUsdc)} USDC → KOx · Jupiter → ${esc(r.venue)}</span></div>
      <div><span class="muted">Captured</span><span>${esc(utc(r.routeObservedAt, false))}</span></div>
      <div><span class="muted">Max slippage</span><span>${(r.slippageBps / 100).toFixed(1)}%</span></div>
      <div><span class="muted">Transaction</span><span>${esc(r.transactionBytes)} bytes, guard first</span></div>
    </div>
    <div class="rcases">${r.cases.map(replayCaseCard).join("")}</div>
  </section>`;
}

function evidence(state: ReferenceState) {
  const { seconds } = state.divergence;
  const card = (title: string, tone: string, items: string[]) => `
    <div class="card ev ev-${tone}">
      <h3>${title}</h3>
      <ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>
    </div>`;
  return `
  <section class="section" aria-labelledby="evidence-title">
    <div class="section-head"><div><h2 id="evidence-title">Evidence</h2><p class="muted">What is real, what is enforced, and where the claims stop.</p></div></div>
    <div class="ev-grid">
      ${card("What we observed", "observed", [
        "KOx (xStocks) and KOon (Ondo) are two tokenized representations of Coca-Cola.",
        "They applied the same dividend adjustment differently: KOx scheduled it and activated on the Solana Clock; KOon updated immediately.",
        `Their stored effective times differ by ${esc(minSec(seconds))}.`,
        "Recorded read-only from Solana mainnet account state; no mainnet transaction was sent.",
      ])}
      ${card("What EquityGuard enforces", "enforces", [
        "A guard instruction runs first, inside the same transaction as the trade.",
        "It re-reads the token's economic state at execution time and compares it byte-for-byte with what the trade was authorized under, including whether a scheduled change has activated.",
        "It binds the guard to the exact swap that was approved.",
        "If anything differs, the whole transaction fails and the trade never runs.",
      ])}
      ${card("What this demo proves", "proves", [
        "Sep 15: on real KOx states recorded 14 s before and 16 s after activation, the guard model allows the earlier authorization before activation and rejects it after.",
        "Sep 17, separately: locally, with a mainnet-derived Jupiter route, mainnet-derived account state, and the real Jupiter and Orca Whirlpool program binaries, a guarded KOx trade executed.",
        "In that replay, a stale-state transaction and a modified transaction were rejected at the guard, before Jupiter ran.",
      ])}
      ${card("What this demo does not prove", "not", [
        "EquityGuard running on mainnet, or a real purchase. It is deployed on devnet only.",
        "A trade that crossed the Sep 15 event. The local replay ran two days later.",
        "A guarded Jupiter trade on devnet (Jupiter is not executable there).",
        "A real cross-issuer reroute. The issuer-switch case is illustrative.",
        "Calibrated issuer policies: the 15 min / 5 min protection window is an uncalibrated demo value.",
        "Support for other DEXs, other corporate actions, production readiness, or an external audit.",
      ])}
    </div>
  </section>`;
}

function advanced(s: Scenario, state: ReferenceState) {
  const { asset, replay } = state;
  const row = (k: string, v: string) => `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const mono = (v: string) => `<span class="mono">${esc(v)}</span>`;
  const stateRows = (v: EconomicStateView) =>
    `${mono(`${v.multiplier} → ${v.newMultiplier}`)}<br><span class="muted mono">0x${esc(v.multiplierHex)} → 0x${esc(v.newMultiplierHex)} · ${esc(v.phase)} · slot ${esc(v.slot)} · ${esc(v.fingerprint)}</span>`;
  return `
  <details class="card advanced" id="advanced">
    <summary><span>Advanced details</span><span class="muted small">For integrators · current case: ${esc(s.label)}</span></summary>
    <div class="adv-grid">
      <dl>
        <h3>State-transition case · Sep 15 mainnet state</h3>
        ${row("Mint", mono(asset.mint))}
        ${row("Issuer", esc(asset.issuer))}
        ${row("Decimals", esc(asset.decimals))}
        ${row("Expected multiplier (authorized)", stateRows(s.authorized))}
        ${row("Live multiplier (at check)", stateRows(s.current))}
        ${row("Scheduled activation", esc(utc(s.current.effectiveAt)))}
        ${row("Phase", `${esc(s.authorized.phase)} → ${esc(s.current.phase)}`)}
        ${row("Protection window", `${esc(windowShort(s.window))} · <span class="muted">${esc(s.window.note)}</span>`)}
        ${row("Typed decision", `<pre class="mono">${esc(JSON.stringify(s.decision, null, 2))}</pre>`)}
      </dl>
      <dl>
        <h3>Local execution replay · Sep 17</h3>
        ${row("Jupiter route binding", `adapter kind ${replay.adapterKind} · ${mono(replay.adapterName)}`)}
        ${row("Route", `Jupiter route_v2 → ${esc(replay.venue)} · captured ${esc(replay.routeObservedAt)}`)}
        ${row("Amounts (raw)", mono(`in ${Number(replay.inputUsdc) * 1e6} USDC · out ${replay.outputRaw} KOx · min ${replay.minOutputRaw}`))}
        ${row("Transaction size", `${replay.transactionBytes} bytes (limit 1232)`)}
        ${row("Downstream commitment", mono(replay.commitmentHex))}
        ${row("Replay window", `${replay.window.beforeSecs}s before / ${replay.window.afterSecs}s after`)}
        ${row("Local clock", `${esc(replay.localClock)} · KOx ${esc(replay.localClockPhase)}`)}
        ${row("Guard program", `${mono(replay.guardProgram)}<br><span class="muted">devnet deployment · binary sha256 ${esc(short(replay.guardBinarySha256, 8, 8))}</span>`)}
        ${row("Other binaries", `<span class="muted">Jupiter v6 ${esc(short(replay.jupiterBinarySha256, 8, 8))} · Whirlpool ${esc(short(replay.whirlpoolBinarySha256, 8, 8))}</span>`)}
      </dl>
    </div>
    <h3 class="adv-sub">Local replay outcomes ${chip("LOCAL_REPLAY")}</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Case</th><th>Expected phase</th><th>Result</th><th>Guard</th><th>Programs run</th><th>USDC Δ</th><th>KOx Δ (raw)</th><th>Fee</th></tr></thead>
        <tbody>
          ${replay.cases
            .map(
              (c) => `<tr>
                <td class="mono">${esc(c.label)}</td>
                <td class="mono">${esc(c.expectedPhase)}</td>
                <td>${c.succeeded ? '<span class="ok">executed</span>' : `<span class="bad">rejected at ix ${esc(c.failedInstruction)}</span>`}</td>
                <td class="mono">${esc(c.decision.guardResult ?? "safe")}</td>
                <td>${esc(c.programsInvoked)}</td>
                <td class="mono">${esc(c.usdcDelta)}</td>
                <td class="mono">${esc(c.stockDelta)}</td>
                <td class="mono">${c.feeLamports === null ? "—" : `${esc(c.feeLamports)} lamports`}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="muted small">Local solana-test-validator, recorded ${esc(replay.recordedAt)}. The taker's USDC balance was created locally.</p>
    <h3 class="adv-sub">Generated from</h3>
    <ul class="sources">${state.generatedFrom.map((g) => `<li><span>${esc(g.name)}</span><span class="mono muted">${esc(short(g.sha256, 10, 10))}</span></li>`).join("")}</ul>
  </details>`;
}

function main() {
  const state = loadState();
  const root = document.getElementById("app");
  if (!root) return;
  const hero = root.querySelector(".hero")?.outerHTML ?? "";
  let active = initialScenario();
  let demoOpen = new URLSearchParams(location.search).has("demo");
  let busy = false;

  const render = () => {
    const s = state.scenarios[active];
    const advancedOpen = root.querySelector<HTMLDetailsElement>("details.advanced")?.open ?? location.hash === "#advanced";
    root.innerHTML = `
      ${hero}
      ${transitionSection(s, state, active, demoOpen)}
      ${timeline(state)}
      ${replaySection(state)}
      ${evidence(state)}
      ${advanced(s, state)}`;
    const details = root.querySelector<HTMLDetailsElement>("details.advanced");
    if (details) details.open = advancedOpen;
    document.body.dataset.decision = toneOf(s.decision);
  };

  const go = (id: ScenarioId) => {
    active = id;
    const url = new URL(location.href);
    url.searchParams.set("state", id);
    history.replaceState(null, "", url);
    render();
  };

  const toast = (text: string) => {
    const node = document.getElementById("toast");
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
  };

  const refresh = (button: HTMLButtonElement) => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const label = button.querySelector("span");
    const steps = ["Reading current KOx state…", "Preparing a new protected transaction…"];
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    button.classList.add("loading");
    steps.forEach((text, i) => setTimeout(() => label && (label.textContent = text), reduce ? 0 : i * 550));
    setTimeout(() => {
      busy = false;
      go("refreshed");
    }, reduce ? 50 : steps.length * 550 + 150);
  };

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action],[data-scenario]");
    if (!target) return;
    const scenario = target.dataset.scenario as ScenarioId | undefined;
    if (scenario) return go(scenario);
    switch (target.dataset.action) {
      case "refresh":
        return refresh(target as HTMLButtonElement);
      case "what-if":
        return go("stale");
      case "wait":
        return go("refreshed");
      case "submit":
        return toast("Reference app: this is where a wallet would sign the guarded transaction. Nothing is signed or sent from this page.");
      case "approve":
        return toast("Illustrative only: there is no real KOon route or quote. A real switch would need a fresh quote and your explicit approval, and this reference app never executes it.");
      case "toggle-demo":
        demoOpen = !demoOpen;
        return render();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest("input,textarea")) return;
    const id = SCENARIO_ORDER[Number(event.key) - 1];
    if (id) go(id);
  });

  render();
}

main();
