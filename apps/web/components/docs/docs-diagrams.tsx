import { DiagramShell } from "@/components/docs/diagram-shell";
import type { ReactNode } from "react";

function Node({
  eyebrow,
  title,
  copy,
  accent = false,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  accent?: boolean;
}): ReactNode {
  return (
    <div className={`docs-node${accent ? " docs-node--accent" : ""}`}>
      <span>{eyebrow}</span>
      <strong>{title}</strong>
      <small>{copy}</small>
    </div>
  );
}

function Arrow({ label }: { label: string }): ReactNode {
  return (
    <div className="docs-arrow" aria-label={label}>
      <span>{label}</span>
      <i aria-hidden="true">→</i>
    </div>
  );
}

export function SystemArchitectureDiagram(): ReactNode {
  return (
    <DiagramShell
      title="System architecture"
      caption="State is read off chain; the decisive comparison remains inside execution."
    >
      <div className="docs-flow docs-flow--architecture">
        <Node eyebrow="Input" title="Jupiter / action builder" copy="Produces an executable downstream plan." />
        <Arrow label="build" />
        <Node eyebrow="Client" title="EquityGuard SDK" copy="Reads mint + Clock, derives state, binds the suffix." accent />
        <Arrow label="authorize" />
        <Node eyebrow="User boundary" title="Wallet" copy="Displays and signs one composed transaction." />
        <Arrow label="land" />
        <Node eyebrow="Solana" title="Guard → action" copy="Re-read, compare, then continue or revert atomically." accent />
      </div>
      <div className="docs-diagram__rail">
        <span>Mainnet watcher: read-only evidence</span>
        <span>Devnet program: deployed, upgradeable</span>
        <span>No EquityGuard mainnet deployment</span>
      </div>
    </DiagramShell>
  );
}

export function ComponentDiagram(): ReactNode {
  return (
    <DiagramShell
      title="Implemented modules"
      caption="Concrete packages and program modules—not a speculative class model."
    >
      <div className="docs-module-map">
        <section>
          <span>On chain · Rust</span>
          <strong>programs/equity_guard</strong>
          <ul>
            <li><code>state.rs</code> · Token-2022 decode</li>
            <li><code>guard.rs</code> · deterministic verdict</li>
            <li><code>downstream.rs</code> · kind 1 binding</li>
            <li><code>jupiter.rs</code> · kinds 2/3 grammar</li>
            <li><code>processor.rs</code> · accounts + Clock</li>
          </ul>
        </section>
        <div className="docs-module-map__join" aria-hidden="true">↔</div>
        <section>
          <span>Off chain · TypeScript</span>
          <strong>packages/*</strong>
          <ul>
            <li><code>guard-client</code> · snapshot + mirror</li>
            <li><code>jupiter/protect</code> · canonical integration</li>
            <li><code>jupiter/advanced</code> · trusted builder</li>
            <li><code>representation-state</code> · normalization</li>
          </ul>
        </section>
      </div>
    </DiagramShell>
  );
}

export function SequenceDiagram(): ReactNode {
  return (
    <DiagramShell
      title="Authorization-to-execution sequence"
      caption="The stale path terminates before router settlement; refresh requires new authorization."
    >
      <div className="docs-sequence">
        <div className="docs-sequence__actors" aria-hidden="true">
          <span>App</span><span>RPC</span><span>Wallet</span><span>Guard</span><span>Router</span>
        </div>
        <ol>
          <li><b>1</b><span>Build downstream action</span><em>App → Router</em></li>
          <li><b>2</b><span>Read mint + Clock at one slot</span><em>App ↔ RPC</em></li>
          <li><b>3</b><span>Derive expectation; prepend guard at ix0</span><em>App</em></li>
          <li><b>4</b><span>Review and sign one transaction</span><em>App ↔ Wallet</em></li>
          <li className="docs-sequence__fork">
            <div><b>5a</b><span>State unchanged → guard passes → router executes</span><em>Solana</em></div>
            <div><b>5b</b><span>State stale → guard fails → router never settles</span><em>Solana</em></div>
          </li>
          <li className="docs-sequence__refresh"><b>6</b><span>Refresh quote + state → request a new signature</span><em>App ↔ Wallet</em></li>
        </ol>
      </div>
    </DiagramShell>
  );
}

export function TransactionDiagram(): ReactNode {
  return (
    <DiagramShell
      title="Protected Jupiter transaction"
      caption="The deployed grammar permits one exact v0 instruction sequence."
    >
      <div className="docs-transaction-strip">
        <div className="docs-transaction-strip__guard"><span>ix0</span><strong>EquityGuard</strong><small>state + phase + suffix hash</small></div>
        <div><span>ix1</span><strong>CU price</strong><small>Jupiter build</small></div>
        <div><span>ix2</span><strong>CU limit</strong><small>explicit</small></div>
        <div><span>ix3?</span><strong>ATA create</strong><small>optional, idempotent</small></div>
        <div><span>last</span><strong>route_v2</strong><small>USDC ↔ protected mint</small></div>
      </div>
      <p className="docs-diagram__note">
        Any unsupported instruction, changed resolved account, changed flag, changed route bytes, or changed order is refused.
      </p>
    </DiagramShell>
  );
}

export function EconomicStateDiagram(): ReactNode {
  return (
    <DiagramShell
      title="Economic-state lifecycle"
      caption="Stored bytes can stay identical while chain time changes which multiplier is effective."
    >
      <div className="docs-lifecycle">
        <div><span>now &lt; T − before</span><strong>Pending / eligible</strong><small>Expected phase: PENDING</small></div>
        <i aria-hidden="true">→</i>
        <div className="docs-lifecycle__blocked"><span>[T − before, T + after]</span><strong>Transition / refuse</strong><small>Inclusive configurable window</small></div>
        <i aria-hidden="true">→</i>
        <div><span>now &gt; T + after</span><strong>Activated / eligible</strong><small>Expected phase: ACTIVATED</small></div>
      </div>
      <div className="docs-lifecycle__boundary">
        <span aria-hidden="true">T</span>
        <p>At <code>now ≥ T</code>, <code>new_multiplier</code> becomes effective even if the mint account bytes do not change.</p>
      </div>
    </DiagramShell>
  );
}

export function RouterIntegrationDiagram(): ReactNode {
  return (
    <DiagramShell
      title="Router integration boundary"
      caption="EquityGuard wraps a supported route; it does not select, price, or replace it."
    >
      <div className="docs-router-flow">
        <Node eyebrow="1" title="Jupiter /build" copy="Raw instructions, quote fields, ALTs, blockhash." />
        <Arrow label="untrusted build" />
        <Node eyebrow="2" title="Classify + protect" copy="Validate mints, deployment, state, grammar, and size." accent />
        <div className="docs-router-flow__branches">
          <section><span>Supported</span><strong>Unsigned protected v0 transaction</strong></section>
          <section><span>Protected but unsupported</span><strong>Typed refusal; no transaction bytes</strong></section>
          <section><span>Not protected</span><strong>NOT_APPLICABLE only after positive classification</strong></section>
        </div>
      </div>
    </DiagramShell>
  );
}
