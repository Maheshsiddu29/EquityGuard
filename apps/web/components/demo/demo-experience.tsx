"use client";

import {
  MonoLabel,
  PublicSurface,
  SectionLabel,
  StatusLabel,
} from "@/components/ui/public-ui";
import { AnimatedPublicPageAtmosphere } from "@/components/ui/animated-public-page-atmosphere";
import { LiveDevnetExperience } from "@/components/demo/live-devnet-experience";
import { useLiveDemo } from "@/components/demo/use-live-demo";
import { CANONICAL, type LiveStaleResult, type LiveUpdatedResult } from "@/lib/live-demo";
import { useReducedMotion } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./live-demo.css";
import "./demo-viewport.css";

type ExecutionProof = {
  signature: string;
  slot: string;
  guard: string;
  jupiter: string;
  whirlpool: string;
  usdc: string;
  kox: string;
  logs: readonly string[];
};

export type DemoEvidence = {
  asset: { name: string; symbol: string };
  order: { input: string; output: string };
  market: {
    prepared: string;
    activation: string;
    post: string;
    sourceHash: string;
  };
  route: {
    captured: string;
    venue: string;
    pool: string;
    commitment: string;
  };
  local: {
    environment: string;
    guardProgram: string;
    guardHash: string;
  };
  stale: ExecutionProof;
  updated: ExecutionProof;
};

type DemoStage = "initial" | "review" | "updated" | "completed";

/** What the single trade card renders, whichever mode produced it. */
type CardCopy = {
  label: string;
  icon: string;
  title: string;
  body: string;
  note?: string;
  action: string;
};

const STAGE_COPY: Record<DemoStage, CardCopy> = {
  initial: {
    label: "Initial order",
    icon: "01",
    title: "Protected order ready",
    body: "Replay the recorded authorization-to-execution window.",
    action: "Run protected trade",
  },
  review: {
    label: "Order needs review",
    icon: "!",
    title: "Order needs review",
    body: "The asset changed while your order was being processed.",
    note: "No tokens were exchanged.",
    action: "Review updated order",
  },
  updated: {
    label: "Updated order",
    icon: "02",
    title: "Updated order ready",
    body: "The authorization now reflects the current recorded economic state.",
    note: "The same protected route can be replayed with fresh authorization.",
    action: "Replay updated order",
  },
  completed: {
    label: "Completed",
    icon: "✓",
    title: "Protected trade replay completed",
    body: "The refreshed authorization passed before Jupiter and Whirlpool executed.",
    note: "0.05504261 KOx received in the recorded local execution proof.",
    action: "Replay again",
  },
};

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function TechnicalValue({ label, value }: { label: string; value: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="technical-value">
      <dt>{label}</dt>
      <dd>
        <code title={value}>{short(value)}</code>
        <button type="button" className="technical-value__copy focus-ring" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
    </div>
  );
}

/**
 * The live run's own record, shown beside the canonical evidence rather than
 * mixed into it: these values came from this machine's proof environment in
 * the last few seconds, and are labelled as such.
 */
function LiveRunEvidence({
  stale,
  updated,
}: {
  stale: LiveStaleResult | null;
  updated: LiveUpdatedResult | null;
}): ReactNode {
  const wallet = updated?.walletPublicKey ?? stale?.walletPublicKey ?? null;
  return (
    <section>
      <SectionLabel>This live run</SectionLabel>
      <h2>Local protected execution, this session</h2>
      <dl className="evidence-list">
        <div>
          <dt>Environment</dt>
          <dd>{CANONICAL.environment}</dd>
        </div>
        {wallet ? <TechnicalValue label="Phantom wallet" value={wallet} /> : null}
        {stale ? (
          <>
            <div><dt>Stale · EquityGuard</dt><dd>{stale.guard} · {stale.guardErrorName}</dd></div>
            <div><dt>Stale · Jupiter</dt><dd>{stale.jupiterInvoked ? "INVOKED" : "NOT INVOKED"}</dd></div>
            <div><dt>Stale · Whirlpool</dt><dd>{stale.whirlpoolInvoked ? "INVOKED" : "NOT INVOKED"}</dd></div>
            <div><dt>Stale · raw token delta</dt><dd>{stale.usdcDelta} USDC · {stale.koxDelta} KOx</dd></div>
            <div><dt>Stale · slot</dt><dd>{stale.slot}</dd></div>
            <TechnicalValue label="Stale signature" value={stale.signature} />
          </>
        ) : null}
        {updated ? (
          <>
            <div><dt>Updated · EquityGuard</dt><dd>{updated.guard}</dd></div>
            <div><dt>Updated · Jupiter</dt><dd>{updated.jupiterInvoked ? "EXECUTED" : "NOT INVOKED"}</dd></div>
            <div><dt>Updated · Whirlpool</dt><dd>{updated.whirlpoolInvoked ? "EXECUTED" : "NOT INVOKED"}</dd></div>
            <div><dt>Updated · raw token delta</dt><dd>−{updated.usdcSpentRaw} USDC · +{updated.koxReceivedRaw} KOx</dd></div>
            <div><dt>Updated · display delta</dt><dd>{updated.usdcDisplay} USDC → {updated.koxDisplay} KOx</dd></div>
            <div><dt>Updated · slot</dt><dd>{updated.slot}</dd></div>
            <TechnicalValue label="Updated signature" value={updated.signature} />
          </>
        ) : null}
      </dl>
      <div className="demo-proof__technical">
        {stale ? (
          <details>
            <summary>Live stale attempt — raw proof</summary>
            <pre>{JSON.stringify(stale.proof, null, 2)}</pre>
          </details>
        ) : null}
        {updated ? (
          <details>
            <summary>Live updated attempt — raw proof</summary>
            <pre>{JSON.stringify(updated.proof, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </section>
  );
}

export function DemoExperience({ evidence }: { evidence: DemoEvidence }): ReactNode {
  const [stage, setStage] = useState<DemoStage>("initial");
  const [busy, setBusy] = useState(false);
  // Null means "whatever this machine supports"; a value is the operator's own
  // explicit choice, which is why it is never overwritten by a later effect.
  const [modeChoice, setModeChoice] = useState<"replay" | "live" | "devnet" | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const live = useLiveDemo();

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  // When the operator has deliberately enabled the local live demo, start in
  // it: one fewer thing to remember during a presentation. The selector below
  // still lets them move back to the replay on purpose.
  const mode = modeChoice ?? (live.available ? "live" : "replay");
  const isLive = mode === "live" && live.available;
  const isDevnet = mode === "devnet";
  const panels = live.panels;
  const liveFailure = panels.failure;

  const advance = useCallback((): void => {
    if (busy) return;
    if (stage === "review") {
      setStage("updated");
      return;
    }
    if (stage === "completed") {
      setStage("initial");
      return;
    }

    setBusy(true);
    timerRef.current = window.setTimeout(
      () => {
        setStage(stage === "initial" ? "review" : "completed");
        setBusy(false);
        timerRef.current = null;
      },
      prefersReducedMotion ? 0 : 620
    );
  }, [busy, prefersReducedMotion, stage]);

  const liveCopy = ((): CardCopy => {
    if (liveFailure) {
      const missing = [
        liveFailure.walletRequested ? null : "No wallet signature was requested.",
        liveFailure.submitted ? null : "No transaction was submitted.",
      ].filter((line): line is string => line !== null);
      return {
        label: "Live demo stopped",
        icon: "✕",
        title: liveFailure.cancelled ? "Signature request cancelled." : liveFailure.headline,
        body: missing.join(" ") || `Stopped at ${liveFailure.stage}.`,
        note: "This is a live-mode failure. It has not been replaced by the deterministic replay.",
        action: "Start over",
      };
    }
    if (panels.busy) {
      return {
        label: "Live execution",
        icon: "··",
        title: "Working…",
        body: panels.message ?? "Connecting Phantom…",
        action: "Working…",
      };
    }
    if (panels.updated) {
      return {
        label: "Completed",
        icon: "✓",
        title: "Protected trade replay completed",
        body: "Local protected execution. Two Phantom approvals, one rejected authorization, one executed trade.",
        note: `${panels.updated.usdcDisplay} USDC → ${panels.updated.koxDisplay} KOx`,
        action: "View what happened",
      };
    }
    if (panels.showUpdatedTerms) {
      return {
        label: "Updated order",
        icon: "02",
        title: "Updated order",
        body: "The economic state has been refreshed. Confirming requests a second Phantom approval for a newly built authorization.",
        note: `${CANONICAL.usdcIn} USDC → ${CANONICAL.koxOut} KOx`,
        action: "Confirm updated order",
      };
    }
    if (panels.showReviewCta) {
      return {
        label: "Order needs review",
        icon: "!",
        title: "Order needs review",
        body: "The asset changed while your order was being processed.",
        note: "No tokens were exchanged.",
        action: "Review updated order",
      };
    }
    return {
      label: "Initial order",
      icon: "01",
      title: "Protected order ready",
      body: "Buy sends a protected authorization built from local state to the local proof environment. Phantom will ask you to approve it.",
      action: "Buy",
    };
  })();

  const copy = isLive ? liveCopy : STAGE_COPY[stage];
  const working = isLive ? panels.busy : busy;

  function act(): void {
    if (!isLive) {
      advance();
      return;
    }
    if (liveFailure) {
      live.reset();
      setDrawerOpen(false);
      return;
    }
    if (panels.updated) {
      setDrawerOpen(true);
      return;
    }
    if (panels.showUpdatedTerms) {
      live.confirm();
      return;
    }
    if (panels.showReviewCta) {
      live.review();
      return;
    }
    live.buy();
  }

  const amounts = isLive && panels.updated
    ? { input: `${panels.updated.usdcDisplay} USDC`, output: `${panels.updated.koxDisplay} KOx` }
    : evidence.order;

  return (
    <main id="main-content" className="route-main unified-route demo-route">
      <AnimatedPublicPageAtmosphere className="demo-route__atmosphere" />
      <section className="page-container demo-page" aria-labelledby="demo-title">
        <header className="route-heading demo-page__heading">
          <SectionLabel>
            {isDevnet ? "Live Devnet" : isLive ? "Local demo · live Phantom proof" : "Public demo · deterministic replay"}
          </SectionLabel>
          <h1 id="demo-title">{isDevnet ? "Live Devnet" : "See a stale trade stop before settlement."}</h1>
          {isDevnet ? (
            <p>
              Run EquityGuard yourself with a simulated tokenized-equity corporate action.
            </p>
          ) : isLive ? (
            <p>
              This machine is running the local proof environment. Buy builds a real
              protected authorization, Phantom signs it, and the local validator
              executes it. Recorded Solana mainnet economic state supplies the market
              evidence; the protected execution itself happens in the local proof
              environment, not on Solana mainnet.
            </p>
          ) : (
            <p>
              Replay the canonical evidence-driven lifecycle from recorded market
              state and protected local execution evidence. It does not connect to a
              visitor&apos;s localhost validator or replace the separate Phantom-signed
              proof environment.
            </p>
          )}
          <div className="demo-mode-switch" role="group" aria-label="Demo evidence">
            <button
              type="button"
              className={`demo-mode-switch__option focus-ring${mode === "replay" ? " is-selected" : ""}`}
              aria-pressed={mode === "replay"}
              onClick={() => setModeChoice("replay")}
            >
              Recorded proof
            </button>
            <button
              type="button"
              className={`demo-mode-switch__option focus-ring${isDevnet ? " is-selected" : ""}`}
              aria-pressed={isDevnet}
              onClick={() => setModeChoice("devnet")}
            >
              Live Devnet
            </button>
          </div>
          {live.available ? (
            <div className="demo-mode-switch" role="group" aria-label="Demo mode">
              <button
                type="button"
                className={`demo-mode-switch__option focus-ring${mode === "replay" ? " is-selected" : ""}`}
                aria-pressed={mode === "replay"}
                onClick={() => setModeChoice("replay")}
              >
                Interactive replay
              </button>
              <button
                type="button"
                className={`demo-mode-switch__option focus-ring${mode === "live" ? " is-selected" : ""}`}
                aria-pressed={mode === "live"}
                onClick={() => setModeChoice("live")}
              >
                Live Phantom proof
              </button>
            </div>
          ) : null}
        </header>

        {isDevnet ? <LiveDevnetExperience /> : <>
        <PublicSurface as="article" tone="gradient" className="demo-trade-card">
          <div className="demo-trade-card__topline">
            <div className="demo-asset">
              <span className="demo-asset__mark" aria-hidden="true">KO</span>
              <div>
                <span>{evidence.asset.name}</span>
                <strong>{evidence.asset.symbol}</strong>
              </div>
            </div>
            <StatusLabel icon={copy.icon}>{copy.label}</StatusLabel>
          </div>

          {isLive ? (
            <p className="demo-live-indicator">
              <span aria-hidden="true">◆</span> Phantom · Local protected execution
            </p>
          ) : null}

          <div className="demo-trade-card__amounts" aria-label={`${amounts.input} to ${amounts.output}`}>
            <div>
              <span>You pay</span>
              <strong>{amounts.input}</strong>
            </div>
            <span className="demo-trade-card__arrow" aria-hidden="true">→</span>
            <div>
              <span>{isLive && panels.updated ? "Received" : "Estimated"}</span>
              <strong>{amounts.output}</strong>
            </div>
          </div>

          <div className="demo-trade-card__state" aria-live="polite" aria-busy={working}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={isLive ? `live-${copy.label}-${copy.title}` : stage}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: prefersReducedMotion ? 0.01 : 0.24 }}
              >
                <MonoLabel>{!isLive && busy ? "REPLAYING EVIDENCE" : copy.label}</MonoLabel>
                <h2>{!isLive && busy ? "Checking protected state…" : copy.title}</h2>
                <p>{copy.body}</p>
                {copy.note ? <strong>{copy.note}</strong> : null}
              </motion.div>
            </AnimatePresence>
          </div>

          <button
            type="button"
            className="button button--primary demo-trade-card__action focus-ring"
            disabled={working}
            onClick={act}
          >
            {working ? (isLive ? "Working…" : "Replaying…") : copy.action}
            {!working ? <span aria-hidden="true">→</span> : null}
          </button>

          {isLive && liveFailure ? (
            <details className="demo-live-failure">
              <summary className="focus-ring">Technical details</summary>
              <pre>{liveFailure.technical}</pre>
            </details>
          ) : null}

          <p className="demo-boundary-note">
            {isLive
              ? "Local proof environment · your Phantom wallet signs · not a Solana mainnet transaction"
              : "Evidence replay only · nothing is signed · no transaction is submitted"}
          </p>
        </PublicSurface>

        <PublicSurface as="section" tone="technical" className="demo-proof" aria-label="Replay evidence">
          <details
            className="demo-proof__drawer"
            open={drawerOpen}
            onToggle={(event) => setDrawerOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="focus-ring">
              <span>View replay evidence</span>
              <span aria-hidden="true">+</span>
            </summary>
            <div className="demo-proof__content">
              {isLive && (panels.stale || panels.updated) ? (
                <LiveRunEvidence stale={panels.stale} updated={panels.updated} />
              ) : null}
              <section>
                <SectionLabel>Real market evidence</SectionLabel>
                <h2>Recorded Solana mainnet KOx state</h2>
                <dl className="evidence-list">
                  <div><dt>Prepared observation</dt><dd>{evidence.market.prepared}</dd></div>
                  <div><dt>Scheduled activation</dt><dd>{evidence.market.activation}</dd></div>
                  <div><dt>Post-activation observation</dt><dd>{evidence.market.post}</dd></div>
                </dl>
              </section>
              <section>
                <SectionLabel>Signed stale attempt</SectionLabel>
                <h2>Stopped at EquityGuard</h2>
                <dl className="evidence-list">
                  <div><dt>EquityGuard</dt><dd>{evidence.stale.guard}</dd></div>
                  <div><dt>Jupiter</dt><dd>{evidence.stale.jupiter}</dd></div>
                  <div><dt>Token movement</dt><dd>{evidence.stale.usdc} USDC · {evidence.stale.kox} KOx</dd></div>
                  <div><dt>Slot</dt><dd>{evidence.stale.slot}</dd></div>
                  <TechnicalValue label="Signature" value={evidence.stale.signature} />
                </dl>
              </section>
              <section>
                <SectionLabel>Signed updated attempt</SectionLabel>
                <h2>Protected route completed</h2>
                <dl className="evidence-list">
                  <div><dt>EquityGuard</dt><dd>{evidence.updated.guard}</dd></div>
                  <div><dt>Jupiter / Whirlpool</dt><dd>{evidence.updated.jupiter} · {evidence.updated.whirlpool}</dd></div>
                  <div><dt>Token movement</dt><dd>{evidence.updated.usdc} USDC · {evidence.updated.kox} KOx</dd></div>
                  <div><dt>Slot</dt><dd>{evidence.updated.slot}</dd></div>
                  <TechnicalValue label="Signature" value={evidence.updated.signature} />
                </dl>
              </section>
              <section>
                <SectionLabel>Provenance</SectionLabel>
                <h2>Evidence and execution boundary</h2>
                <dl className="evidence-list">
                  <div><dt>Route captured</dt><dd>{evidence.route.captured}</dd></div>
                  <div><dt>Venue</dt><dd>{evidence.route.venue}</dd></div>
                  <div><dt>Execution environment</dt><dd>{evidence.local.environment}</dd></div>
                  <TechnicalValue label="Pool" value={evidence.route.pool} />
                  <TechnicalValue label="Market evidence" value={evidence.market.sourceHash} />
                  <TechnicalValue label="Route commitment" value={evidence.route.commitment} />
                  <TechnicalValue label="Guard program" value={evidence.local.guardProgram} />
                  <TechnicalValue label="Reviewed ELF" value={evidence.local.guardHash} />
                </dl>
              </section>
              <div className="demo-proof__technical">
                <details>
                  <summary>Stale-attempt technical details</summary>
                  <pre>{evidence.stale.logs.join("\n")}</pre>
                </details>
                <details>
                  <summary>Updated-attempt technical details</summary>
                  <pre>{evidence.updated.logs.join("\n")}</pre>
                </details>
              </div>
              <p className="demo-proof__boundary">
                Execution did not occur on Solana mainnet. Market state and route
                inputs are independent mainnet-derived evidence; guarded execution
                ran on {evidence.local.environment}.
              </p>
            </div>
          </details>
        </PublicSurface>
        </>}
      </section>
    </main>
  );
}
