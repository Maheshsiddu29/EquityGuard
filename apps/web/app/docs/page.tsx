import {
  MonoLabel,
  PublicPageAtmosphere,
  PublicSurface,
  SectionLabel,
} from "@/components/ui/public-ui";
import { createMetadata } from "@/lib/metadata";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Documentation",
  description:
    "Technical documentation for EquityGuard's execution-time economic-state invariant.",
  path: "/docs",
});

const DOC_TOPICS = [
  {
    label: "01",
    title: "Execution invariant",
    copy: "A transaction built against state S must not execute if protected state changes to S′ before landing.",
  },
  {
    label: "02",
    title: "Atomic composition",
    copy: "The guard instruction runs at ix0. A failed check prevents every downstream instruction from settling.",
  },
  {
    label: "03",
    title: "Fail-closed decoding",
    copy: "Unknown, malformed, unsupported, or changed Token-2022 state is rejected explicitly.",
  },
] as const;

export default function DocsPage(): ReactNode {
  return (
    <main id="main-content" className="route-main unified-route docs-route">
      <PublicPageAtmosphere className="docs-route__atmosphere" />
      <section className="page-container docs-page" aria-labelledby="docs-title">
        <header className="route-heading docs-page__heading">
          <SectionLabel>Technical documentation</SectionLabel>
          <h1 id="docs-title">A small guard around a precise invariant.</h1>
          <p>
            EquityGuard compares deterministic protected state inside the same
            Solana transaction as the action it guards.
          </p>
        </header>

        <div className="docs-layout">
          <PublicSurface as="aside" tone="glass" className="docs-sidebar">
            <MonoLabel>Documentation</MonoLabel>
            <nav aria-label="Documentation sections">
              <a href="#execution-invariant">Execution invariant</a>
              <a href="#transaction-composition">Transaction composition</a>
              <a href="#failure-policy">Failure policy</a>
            </nav>
            <Link className="button button--secondary focus-ring" href="/demo">
              View the replay <span aria-hidden="true">→</span>
            </Link>
          </PublicSurface>

          <article className="docs-content">
            <section id="execution-invariant" className="docs-section">
              <SectionLabel>Execution invariant</SectionLabel>
              <h2>The authorized state must still be the execution state.</h2>
              <p>
                A transaction built against state S must not execute if protected
                state changes to S′ before landing. The comparison happens inside
                the same Solana transaction as the protected action.
              </p>
              <PublicSurface tone="gradient" className="docs-callout">
                <MonoLabel>Invariant</MonoLabel>
                <strong>S = S′ before the protected action can execute.</strong>
                <p>Unknown, malformed, unsupported, or changed state fails closed.</p>
              </PublicSurface>
            </section>

            <section id="transaction-composition" className="docs-section">
              <SectionLabel>Transaction composition</SectionLabel>
              <h2>EquityGuard stays inside the transaction.</h2>
              <p>
                The router continues to own execution strategy. EquityGuard is the
                first instruction and does not become an external gateway.
              </p>
              <PublicSurface tone="technical" className="docs-transaction">
                <div className="docs-transaction__row docs-transaction__row--guard">
                  <MonoLabel>ix0</MonoLabel>
                  <div>
                    <strong>EquityGuard</strong>
                    <span>Compare protected economic state</span>
                  </div>
                </div>
                <span className="docs-transaction__line" aria-hidden="true" />
                <div className="docs-transaction__row">
                  <MonoLabel>ix1+</MonoLabel>
                  <div>
                    <strong>Router / protected action</strong>
                    <span>Existing downstream execution</span>
                  </div>
                </div>
              </PublicSurface>

              <div className="code-window" aria-label="Transaction composition code">
                <div className="code-window__header">
                  <span />
                  <span />
                  <span />
                  <p>protected-transaction.ts</p>
                </div>
                <pre>
                  <code>{`transaction
  .add(equityGuard(expectedState)) // ix0
  .add(protectedAction)            // ix1+

// Any protected state mismatch aborts atomically.`}</code>
                </pre>
              </div>
            </section>

            <section id="failure-policy" className="docs-section">
              <SectionLabel>Failure policy</SectionLabel>
              <h2>Small surface. Explicit outcomes.</h2>
              <ol className="docs-topics">
                {DOC_TOPICS.map((topic) => (
                  <li key={topic.label}>
                    <MonoLabel>{topic.label}</MonoLabel>
                    <div>
                      <strong>{topic.title}</strong>
                      <p>{topic.copy}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </article>

          <aside className="docs-on-page" aria-label="On this page">
            <MonoLabel>On this page</MonoLabel>
            <a href="#execution-invariant">Execution invariant</a>
            <a href="#transaction-composition">Transaction composition</a>
            <a href="#failure-policy">Failure policy</a>
          </aside>
        </div>
      </section>
    </main>
  );
}
