import { MotionDiv } from "@/lib/motion";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Protected execution for tokenized equities",
  description:
    "EquityGuard checks protected economic state at execution time, before a downstream Solana action can run.",
  path: "/",
});

const FLOW = [
  { index: "01", label: "Trading application", detail: "Builds against state S" },
  { index: "02", label: "EquityGuard", detail: "Checks state at ix0" },
  { index: "03", label: "Protected action", detail: "Runs only if unchanged" },
] as const;

export default function HomePage(): ReactNode {
  return (
    <main id="main-content" className="home-main">
      <section id="product" className="home-hero page-container">
        <MotionDiv className="home-hero__copy">
          <p className="eyebrow">
            <span className="status-dot" aria-hidden="true" />
            Execution-time protection
          </p>
          <h1>The trade you approved should be the trade that executes.</h1>
          <p className="home-hero__intro">
            EquityGuard fails a Solana transaction before the protected action
            when a tokenized equity&apos;s economic state changed after authorization.
          </p>
          <div className="hero-actions">
            <Link href="/demo" className="button button--primary focus-ring">
              Explore the demo
              <span aria-hidden="true">→</span>
            </Link>
            <Link href="/docs" className="button button--secondary focus-ring">
              Read the architecture
            </Link>
          </div>
        </MotionDiv>

        <MotionDiv className="guard-card glass-hero" delay={0.12}>
          <div className="guard-card__header">
            <div>
              <p className="guard-card__label">Protected transaction</p>
              <p className="guard-card__asset">KOx / USDC</p>
            </div>
            <span className="guard-badge">Guard first</span>
          </div>
          <ol className="transaction-stack">
            <li className="transaction-stack__item transaction-stack__item--guard">
              <span className="transaction-stack__index">ix0</span>
              <span>
                <strong>EquityGuard</strong>
                <small>Verify economic state</small>
              </span>
              <span className="check-mark" aria-label="State matches">
                ✓
              </span>
            </li>
            <li className="transaction-stack__connector" aria-hidden="true" />
            <li className="transaction-stack__item">
              <span className="transaction-stack__index">ix1+</span>
              <span>
                <strong>Protected action</strong>
                <small>Router / venue execution</small>
              </span>
              <span className="arrow-mark" aria-hidden="true">
                →
              </span>
            </li>
          </ol>
          <p className="guard-card__footnote">
            State changed? The transaction fails atomically before settlement.
          </p>
        </MotionDiv>
      </section>

      <section className="foundation-strip page-container" aria-labelledby="flow-title">
        <div className="foundation-strip__heading">
          <p className="eyebrow">Transaction order</p>
          <h2 id="flow-title">One invariant. Enforced before execution.</h2>
        </div>
        <ol className="flow-grid">
          {FLOW.map((item) => (
            <li key={item.index}>
              <span>{item.index}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
