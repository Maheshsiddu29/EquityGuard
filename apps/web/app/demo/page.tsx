import { RouteShell, TextLink } from "@/components/ui/route-shell";
import { MotionDiv } from "@/lib/motion";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Demo",
  description:
    "A public, deterministic reproduction of EquityGuard's proven protected-trade lifecycle.",
  path: "/demo",
});

export default function DemoPage(): ReactNode {
  return (
    <RouteShell
      eyebrow="Public demo"
      title="See a stale trade stop before settlement."
      intro="This route will replay the canonical evidence-driven lifecycle. It does not connect to a visitor's localhost validator or replace the separate Phantom-signed proof environment."
    >
      <MotionDiv className="demo-shell glass-hero" delay={0.1}>
        <div className="demo-shell__topline">
          <div>
            <span className="shell-kicker">Preview instrument</span>
            <strong>Coca-Cola · KOx</strong>
          </div>
          <span className="evidence-chip">Deterministic replay</span>
        </div>
        <div className="demo-shell__body">
          <div className="trade-summary">
            <span>You pay</span>
            <strong>5.00 USDC</strong>
          </div>
          <div className="trade-arrow" aria-hidden="true">
            →
          </div>
          <div className="trade-summary">
            <span>Estimated</span>
            <strong>0.05504261 KOx</strong>
          </div>
        </div>
        <div className="notice notice--blocked">
          <span className="notice__icon" aria-hidden="true">
            !
          </span>
          <span>
            <strong>Evidence boundary preserved</strong>
            <small>The interactive lifecycle arrives in the demo milestone.</small>
          </span>
        </div>
      </MotionDiv>
      <div className="route-next">
        <TextLink href="/docs">Understand the execution invariant</TextLink>
      </div>
    </RouteShell>
  );
}
