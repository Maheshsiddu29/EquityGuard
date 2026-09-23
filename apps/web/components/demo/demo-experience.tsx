"use client";

import {
  MonoLabel,
  PublicSurface,
  SectionLabel,
  StatusLabel,
} from "@/components/ui/public-ui";
import { AnimatedPublicPageAtmosphere } from "@/components/ui/animated-public-page-atmosphere";
import { useReducedMotion } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

const STAGE_COPY: Record<
  DemoStage,
  { label: string; icon: string; title: string; body: string; note?: string; action: string }
> = {
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

export function DemoExperience({ evidence }: { evidence: DemoEvidence }): ReactNode {
  const [stage, setStage] = useState<DemoStage>("initial");
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const copy = STAGE_COPY[stage];

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  function advance(): void {
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
  }

  return (
    <main id="main-content" className="route-main unified-route demo-route">
      <AnimatedPublicPageAtmosphere className="demo-route__atmosphere" />
      <section className="page-container demo-page" aria-labelledby="demo-title">
        <header className="route-heading demo-page__heading">
          <SectionLabel>Public demo · deterministic replay</SectionLabel>
          <h1 id="demo-title">See a stale trade stop before settlement.</h1>
          <p>
            Replay the canonical evidence-driven lifecycle from recorded market
            state and protected local execution evidence. It does not connect to a
            visitor&apos;s localhost validator or replace the separate Phantom-signed
            proof environment.
          </p>
        </header>

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

          <div className="demo-trade-card__amounts" aria-label={`${evidence.order.input} to ${evidence.order.output}`}>
            <div>
              <span>You pay</span>
              <strong>{evidence.order.input}</strong>
            </div>
            <span className="demo-trade-card__arrow" aria-hidden="true">→</span>
            <div>
              <span>Estimated</span>
              <strong>{evidence.order.output}</strong>
            </div>
          </div>

          <div className="demo-trade-card__state" aria-live="polite" aria-busy={busy}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={stage}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: prefersReducedMotion ? 0.01 : 0.24 }}
              >
                <MonoLabel>{busy ? "REPLAYING EVIDENCE" : copy.label}</MonoLabel>
                <h2>{busy ? "Checking protected state…" : copy.title}</h2>
                <p>{copy.body}</p>
                {copy.note ? <strong>{copy.note}</strong> : null}
              </motion.div>
            </AnimatePresence>
          </div>

          <button
            type="button"
            className="button button--primary demo-trade-card__action focus-ring"
            disabled={busy}
            onClick={advance}
          >
            {busy ? "Replaying…" : copy.action}
            {!busy ? <span aria-hidden="true">→</span> : null}
          </button>
          <p className="demo-boundary-note">
            Evidence replay only · nothing is signed · no transaction is submitted
          </p>
        </PublicSurface>

        <PublicSurface as="section" tone="technical" className="demo-proof" aria-label="Replay evidence">
          <details className="demo-proof__drawer">
            <summary className="focus-ring">
              <span>View replay evidence</span>
              <span aria-hidden="true">+</span>
            </summary>
            <div className="demo-proof__content">
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
      </section>
    </main>
  );
}
