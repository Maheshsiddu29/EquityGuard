import { RouteShell, TextLink } from "@/components/ui/route-shell";
import { MotionDiv } from "@/lib/motion";
import { createMetadata } from "@/lib/metadata";
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
    <RouteShell
      eyebrow="Technical documentation"
      title="A small guard around a precise invariant."
      intro="EquityGuard compares deterministic protected state inside the same Solana transaction as the action it guards. This foundation route will grow into the integration and evidence guide."
    >
      <MotionDiv className="docs-panel technical-glass" delay={0.1}>
        <div className="code-window" aria-label="Transaction composition">
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
        <ol className="docs-topics">
          {DOC_TOPICS.map((topic) => (
            <li key={topic.label}>
              <span>{topic.label}</span>
              <div>
                <strong>{topic.title}</strong>
                <p>{topic.copy}</p>
              </div>
            </li>
          ))}
        </ol>
      </MotionDiv>
      <div className="route-next">
        <TextLink href="/demo">View the demo foundation</TextLink>
      </div>
    </RouteShell>
  );
}
