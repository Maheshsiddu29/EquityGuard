import { ScrollExpandHero } from "@/components/landing/scroll-expand-hero";
import { RevealSection } from "@/components/ui/reveal-section";
import Link from "next/link";
import type { ReactNode } from "react";

const PRINCIPLES = [
  {
    index: "01",
    title: "Atomic protection",
    copy: "Checks the authorized state before the protected action executes.",
  },
  {
    index: "02",
    title: "Router-native",
    copy: "Keep the existing execution router and wallet flow.",
  },
  {
    index: "03",
    title: "Fail closed",
    copy: "If authorization is stale, the protected action never executes.",
  },
] as const;

const METRICS = [
  { value: "19,986", label: "real mainnet observations" },
  { value: "294,527", label: "authorization → execution comparisons" },
  { value: "7,029 / 7,029", label: "stale cases blocked" },
  { value: "1,000,000", label: "TypeScript / Rust differential cases" },
  { value: "0", label: "disagreements" },
] as const;

const KOX_LIFECYCLE = [
  { environment: "Recorded mainnet state", label: "Pre-activation authorization" },
  { environment: "Recorded mainnet state", label: "KOx state changes" },
  { environment: "Local proof environment", label: "Old protected transaction" },
  { environment: "Local proof environment", label: "Rejected at ix0" },
  { environment: "Local proof environment", label: "0 token movement" },
  { environment: "Local proof environment", label: "Updated authorization" },
  { environment: "Local proof environment", label: "Trader approves again" },
  { environment: "Local proof environment", label: "Jupiter + Whirlpool execute" },
] as const;

export function LandingPage(): ReactNode {
  return (
    <main id="main-content" className="landing-main">
      <ScrollExpandHero />

      <RevealSection
        className="landing-section invisible-section page-container"
        labelledBy="invisible-title"
      >
        <div className="section-heading section-heading--wide">
          <p className="eyebrow">Designed to stay out of the way</p>
          <h2 id="invisible-title">
            Invisible when nothing changes.
            <span>There when it matters.</span>
          </h2>
        </div>

        <div className="outcome-comparison">
          <article className="outcome-lane outcome-lane--normal">
            <header>
              <span className="outcome-lane__signal" aria-hidden="true" />
              <div>
                <p>Normal</p>
                <strong>Nothing changed</strong>
              </div>
            </header>
            <div className="outcome-flow" aria-label="Approve, then execute">
              <span>Approve</span>
              <i aria-hidden="true">↓</i>
              <span className="outcome-flow__result">Execute</span>
            </div>
            <p className="outcome-lane__note">
              The existing experience continues without interruption.
            </p>
          </article>

          <article className="outcome-lane outcome-lane--changed">
            <header>
              <span className="outcome-lane__signal" aria-hidden="true" />
              <div>
                <p>Changed state</p>
                <strong>Authorization is stale</strong>
              </div>
            </header>
            <div
              className="outcome-flow"
              aria-label="Approve, state changes, then order needs review"
            >
              <span>Approve</span>
              <i aria-hidden="true">↓</i>
              <span>State changes</span>
              <i aria-hidden="true">↓</i>
              <span className="outcome-flow__result">Order needs review</span>
            </div>
            <p className="outcome-lane__note">
              Execution pauses before the protected action can run.
            </p>
          </article>
        </div>
      </RevealSection>

      <RevealSection
        className="landing-section principles-section page-container"
        labelledBy="principles-title"
      >
        <div className="section-heading">
          <p className="eyebrow">What EquityGuard does</p>
          <h2 id="principles-title">One check, at the point that matters.</h2>
        </div>

        <div className="principle-grid">
          {PRINCIPLES.map((principle) => (
            <article className="principle-card" key={principle.title}>
              <span>{principle.index}</span>
              <h3>{principle.title}</h3>
              <p>{principle.copy}</p>
            </article>
          ))}
        </div>
      </RevealSection>

      <RevealSection
        className="landing-section proof-section page-container"
        labelledBy="proof-title"
      >
        <div className="proof-panel">
          <div className="proof-panel__heading">
            <div>
              <p className="eyebrow">Real proof</p>
              <h2 id="proof-title">Measured against state that actually moved.</h2>
            </div>
            <p>
              Deterministic evidence from recorded Solana mainnet state and the
              project&apos;s protected local execution proof.
            </p>
          </div>

          <dl className="proof-metrics">
            {METRICS.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.value}</dt>
                <dd>{metric.label}</dd>
              </div>
            ))}
          </dl>

          <div className="proof-lifecycle">
            <div className="proof-lifecycle__intro">
              <p className="proof-kicker">KOx lifecycle</p>
              <h3>A stale order stops. A fresh approval proceeds.</h3>
              <p>
                Real Solana mainnet state was observed read-only. The protected
                stale and refreshed executions were proven separately on local
                solana-test-validator using mainnet-derived state and real
                Jupiter and Whirlpool program binaries. No EquityGuard
                transaction was sent on mainnet.
              </p>
            </div>

            <ol className="lifecycle-track">
              {KOX_LIFECYCLE.map((step, index) => (
                <li key={step.label}>
                  <span className="lifecycle-track__index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <small>{step.environment}</small>
                    <strong>{step.label}</strong>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </RevealSection>

      <RevealSection
        className="landing-section stack-section page-container"
        labelledBy="stack-title"
      >
        <div className="stack-copy">
          <p className="eyebrow">Fits the existing stack</p>
          <h2 id="stack-title">Protect execution without replacing the stack.</h2>
          <p>
            EquityGuard does not choose the route. The router still owns
            execution strategy. EquityGuard verifies that execution still
            matches the authorization.
          </p>
          <Link className="button button--secondary focus-ring" href="/docs">
            Explore integration <span aria-hidden="true">→</span>
          </Link>
        </div>

        <div className="stack-diagram" aria-label="EquityGuard execution stack">
          <div className="stack-diagram__node">Trading app</div>
          <span className="stack-diagram__arrow" aria-hidden="true">↓</span>
          <div className="stack-diagram__node">Router / Jupiter</div>
          <span className="stack-diagram__arrow" aria-hidden="true">↓</span>
          <div className="protected-transaction">
            <p>Protected transaction</p>
            <div className="protected-transaction__instruction protected-transaction__instruction--guard">
              <span>ix0</span>
              <strong>EquityGuard</strong>
              <small>state check</small>
            </div>
            <div className="protected-transaction__instruction">
              <span>ix1+</span>
              <strong>Router / protected action</strong>
              <small>existing execution</small>
            </div>
          </div>
          <span className="stack-diagram__arrow" aria-hidden="true">↓</span>
          <div className="stack-diagram__node">DEX / Protocol</div>
        </div>
      </RevealSection>

      <RevealSection
        className="landing-section final-cta-section page-container"
        labelledBy="final-cta-title"
      >
        <div className="final-cta">
          <p className="eyebrow">Protect the moment of execution</p>
          <h2 id="final-cta-title">Authorization should not expire silently.</h2>
          <div className="hero-actions">
            <Link className="button button--light focus-ring" href="/demo">
              Try the demo <span aria-hidden="true">→</span>
            </Link>
            <Link className="button button--dark-outline focus-ring" href="/docs">
              Read the docs
            </Link>
          </div>
        </div>
      </RevealSection>
    </main>
  );
}
