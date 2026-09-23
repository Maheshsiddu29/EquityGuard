"use client";

import { ScrollExpand } from "@/components/react-bits/scroll-expand";
import { MotionDiv } from "@/lib/motion";
import Link from "next/link";
import type { ReactNode } from "react";

const STORY_MARKERS = ["Authorized", "State changed", "Guard check", "Review"];

export function ScrollExpandHero(): ReactNode {
  return (
    <section className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-hero__intro page-container">
        <MotionDiv className="landing-hero__copy">
          <p className="eyebrow">
            <span className="status-dot" aria-hidden="true" />
            Execution integrity
          </p>
          <h1 id="landing-title">
            The trade you approved
            <span>should be the trade that executes.</span>
          </h1>
          <p className="landing-hero__support">
            EquityGuard prevents tokenized-asset transactions authorized under
            one economic state from silently executing under another.
          </p>
          <div className="hero-actions">
            <Link className="button button--primary focus-ring" href="/demo">
              See it work <span aria-hidden="true">→</span>
            </Link>
            <Link className="button button--secondary focus-ring" href="/docs">
              Read the docs
            </Link>
          </div>
        </MotionDiv>

        <aside className="landing-hero__aside" aria-label="Product principle">
          <span>State-bound authorization</span>
          <strong>Atomic execution check</strong>
        </aside>
      </div>

      <div id="transaction-story" className="hero-scroll-story">
        <ScrollExpand
          startWidth={68}
          startHeight={64}
          startRadius={32}
          endRadius={18}
          mediaZoom={1.07}
          scrollDistance={1.45}
          holdDistance={0.22}
          smoothing={0.11}
          scrollHint="Scroll to follow the transaction"
        >
          <div className="hero-story" aria-hidden="true">
            <div className="hero-story__wash" />
            <div className="hero-story__grid" />
            <div className="hero-story__chrome">
              <span>Protected transaction</span>
              <span>Authorization → execution</span>
            </div>

            <ol className="hero-story__markers">
              {STORY_MARKERS.map((marker, index) => (
                <li key={marker} data-scroll-marker="">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {marker}
                </li>
              ))}
            </ol>

            <div className="hero-story__scene" data-scroll-step="0,0.34">
              <span className="story-status story-status--ready">Authorized</span>
              <div className="story-trade">
                <strong>5.00</strong>
                <span>USDC</span>
                <i>→</i>
                <strong>KOx</strong>
              </div>
              <p>Economic-state snapshot attached</p>
            </div>

            <div className="hero-story__scene" data-scroll-step="0.22,0.57">
              <span className="story-status story-status--changed">
                Economic state changed
              </span>
              <div className="story-state-shift">
                <span>S</span>
                <i>→</i>
                <span>S′</span>
              </div>
              <p>The authorized order is now stale.</p>
            </div>

            <div className="hero-story__scene" data-scroll-step="0.46,0.8">
              <span className="story-status story-status--checking">
                EquityGuard check
              </span>
              <div className="story-guard-check">
                <span>ix0</span>
                <div>
                  <small>expected state</small>
                  <strong>≠ current state</strong>
                </div>
              </div>
              <p>Checked before any downstream instruction.</p>
            </div>

            <div className="hero-story__scene" data-scroll-step="0.7,1">
              <span className="story-status story-status--blocked">
                Order needs review
              </span>
              <strong className="story-result">No protected action executed.</strong>
              <p>The transaction must be refreshed and approved again.</p>
              <div className="story-stop-line">
                <span>ix0 · EquityGuard</span>
                <span>downstream stopped</span>
              </div>
            </div>
          </div>
        </ScrollExpand>

        <p className="sr-only">
          A 5 USDC to KOx transaction is authorized against an economic-state
          snapshot. The state changes before execution, so EquityGuard detects
          the mismatch at instruction zero. The order needs review and no
          protected action executes.
        </p>
      </div>
    </section>
  );
}
