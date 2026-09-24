import {
  ComponentDiagram,
  EconomicStateDiagram,
  RouterIntegrationDiagram,
  SequenceDiagram,
  SystemArchitectureDiagram,
  TransactionDiagram,
} from "@/components/docs/docs-diagrams";
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
  title: "StateGuard Docs — Architecture, SDK & Integrations",
  description:
    "Architecture, transaction model, SDK integration, security boundaries, evidence, and deployment guidance for StateGuard.",
  path: "/docs",
});

const DOC_SECTIONS = [
  ["overview", "Overview"],
  ["problem", "Problem / Why"],
  ["how-it-works", "How it works"],
  ["architecture", "Architecture"],
  ["transaction-model", "Transaction model"],
  ["economic-state-model", "Economic-state model"],
  ["sdk", "SDK"],
  ["integrations", "Integrations"],
  ["security", "Security"],
  ["evidence", "Evidence & validation"],
  ["deployment", "Deployment"],
  ["limitations", "Limitations"],
  ["future-work", "Future work"],
  ["references", "References"],
] as const;

function DocsLinks(): ReactNode {
  return (
    <>
      {DOC_SECTIONS.map(([id, label], index) => (
        <a key={id} href={`#${id}`}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          {label}
        </a>
      ))}
    </>
  );
}

function CodeBlock({ title, children }: { title: string; children: string }): ReactNode {
  return (
    <div className="code-window" aria-label={`${title} code example`}>
      <div className="code-window__header">
        <span /><span /><span />
        <p>{title}</p>
      </div>
      <pre tabIndex={0}><code>{children}</code></pre>
    </div>
  );
}

function SectionIntro({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <header className="docs-section__intro">
      <SectionLabel>{label}</SectionLabel>
      <h2>{title}</h2>
      <div className="docs-section__lead">{children}</div>
    </header>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <a className="docs-external-link focus-ring" href={href} target="_blank" rel="noreferrer">
      {children} <span aria-hidden="true">↗</span>
    </a>
  );
}

export default function DocsPage(): ReactNode {
  return (
    <main id="main-content" className="route-main unified-route docs-route">
      <PublicPageAtmosphere className="docs-route__atmosphere" />
      <section className="page-container docs-page" aria-labelledby="docs-title">
        <header className="route-heading docs-page__heading">
          <SectionLabel>Technical documentation · ABI v2</SectionLabel>
          <h1 id="docs-title">Execution integrity for tokenized equities.</h1>
          <p>
            StateGuard makes the economic state authorized at quote time a
            condition of execution. This reference describes the code that
            exists today, the proof behind it, and the boundaries it does not cross.
          </p>
          <div className="docs-page__status" aria-label="Current implementation status">
            <span><i /> Program deployed on devnet</span>
            <span><i /> Mainnet observation is read-only</span>
            <span><i /> Packages are private and unpublished</span>
          </div>
        </header>

        <details className="docs-mobile-nav">
          <summary className="focus-ring">
            <span>Documentation index</span>
            <span aria-hidden="true">+</span>
          </summary>
          <nav aria-label="Mobile documentation sections"><DocsLinks /></nav>
        </details>

        <div className="docs-layout">
          <PublicSurface as="aside" tone="glass" className="docs-sidebar">
            <MonoLabel>Documentation</MonoLabel>
            <nav aria-label="Documentation sections"><DocsLinks /></nav>
            <Link className="button button--secondary focus-ring" href="/demo">
              View public demo <span aria-hidden="true">→</span>
            </Link>
          </PublicSurface>

          <article className="docs-content">
            <section id="overview" className="docs-section">
              <SectionIntro label="01 · Overview" title="A guard, not another execution venue.">
                <p>
                  StateGuard is execution-integrity infrastructure for
                  corporate-action-aware tokenized-equity transactions on Solana.
                  It places one read-only instruction before a supported action and
                  refuses the whole transaction when protected state no longer
                  matches the authorization.
                </p>
              </SectionIntro>

              <div className="docs-subsection">
                <MonoLabel>Protocol relationship</MonoLabel>
                <h3>Built on the EquityGuard Protocol.</h3>
                <p>
                  StateGuard is the public application and demo built on the EquityGuard
                  Protocol. The protocol provides the underlying authorization and
                  execution-integrity logic used by StateGuard.
                </p>
              </div>

              <PublicSurface tone="gradient" className="docs-principle">
                <MonoLabel>Core rule</MonoLabel>
                <blockquote>The trade you approved should be the trade that executes.</blockquote>
                <p>
                  More precisely: a supported protected trade executes only against
                  the economic state its authorization was built for. The client is
                  responsible for making that authorization match what the user saw.
                </p>
              </PublicSurface>

              <div className="docs-split-grid">
                <section className="docs-definition docs-definition--is">
                  <span>StateGuard is</span>
                  <ul>
                    <li>execution-integrity infrastructure;</li>
                    <li>a first-instruction guard for supported Solana swaps;</li>
                    <li>compatible with an existing downstream router;</li>
                    <li>fail-closed state decoding and transaction binding.</li>
                  </ul>
                </section>
                <section className="docs-definition">
                  <span>StateGuard is not</span>
                  <ul>
                    <li>a DEX, exchange, oracle, or route optimizer;</li>
                    <li>a replacement for Jupiter or ordinary slippage;</li>
                    <li>an AI trading system or a general intent network;</li>
                    <li>a guarantee of post-transition fair market value.</li>
                  </ul>
                </section>
              </div>
            </section>

            <section id="problem" className="docs-section">
              <SectionIntro label="02 · Problem / Why" title="A valid signature can authorize stale economics.">
                <p>
                  Solana signatures authenticate a transaction message; they do not
                  prove that the market or issuer state used to construct that message
                  stayed unchanged. A transaction can remain cryptographically valid
                  while a Token-2022 multiplier, pending multiplier, activation time,
                  or clock-derived activation phase changes before landing.
                </p>
              </SectionIntro>

              <div
                className="docs-timeline"
                role="region"
                aria-label="Quote to execution risk window"
                tabIndex={0}
              >
                <div><span>t0</span><strong>Quote</strong><p>State S informs amount, route, and approval.</p></div>
                <i aria-hidden="true">→</i>
                <div><span>t1</span><strong>Wallet signature</strong><p>The message is valid for a recent blockhash.</p></div>
                <i aria-hidden="true">→</i>
                <div className="docs-timeline__risk"><span>Δ</span><strong>State becomes S′</strong><p>Bytes, timestamp, or effective phase changes.</p></div>
                <i aria-hidden="true">→</i>
                <div><span>t2</span><strong>Landing</strong><p>Without an execution-time check, stale intent may still run.</p></div>
              </div>

              <aside className="docs-note docs-note--warning">
                <strong>The wedge</strong>
                <p>
                  Quote-time validation is a prediction. The EquityGuard Protocol repeats the
                  decisive comparison against the runtime mint account and Solana
                  Clock inside the same atomic transaction as the protected action.
                </p>
              </aside>
            </section>

            <section id="how-it-works" className="docs-section">
              <SectionIntro label="03 · How it works" title="One authorization, one atomic verdict.">
                <p>
                  The router still builds the trade and the wallet still owns the
                  signature. StateGuard adds an execution condition without becoming
                  a gateway, custody layer, or separate settlement path.
                </p>
              </SectionIntro>

              <ol className="docs-steps">
                <li><span>01</span><div><strong>Build the action</strong><p>Obtain the downstream transfer or supported Jupiter <code>/build</code> response.</p></div></li>
                <li><span>02</span><div><strong>Read chain state</strong><p>Fetch the protected mint and Clock in one RPC context slot.</p></div></li>
                <li><span>03</span><div><strong>Derive expected state</strong><p>Bind stored fields, activation phase, and the caller’s explicit protection window.</p></div></li>
                <li><span>04</span><div><strong>Commit the downstream action</strong><p>Hash the exact instruction or Jupiter suffix, including resolved accounts and flags.</p></div></li>
                <li><span>05</span><div><strong>Prepend the guard</strong><p>For Jupiter kinds 2/3, <code>assert_safe_execution</code> must be instruction zero.</p></div></li>
                <li><span>06</span><div><strong>Request one normal wallet signature</strong><p>The guard needs no separate signature or second approval in the unchanged-state path.</p></div></li>
                <li><span>07</span><div><strong>Execute or stop atomically</strong><p>A match continues to the action. A mismatch fails the transaction before settlement.</p></div></li>
              </ol>

              <SequenceDiagram />

              <aside className="docs-note">
                <strong>When is a second approval needed?</strong>
                <p>
                  Only after rejection. The app refreshes state and quote, constructs a
                  different transaction, and asks the user to authorize that new trade.
                  StateGuard never silently updates a signed transaction.
                </p>
              </aside>
            </section>

            <section id="architecture" className="docs-section">
              <SectionIntro label="04 · Architecture" title="Small modules around a single invariant.">
                <p>
                  The implementation is a native Solana program plus narrowly scoped
                  TypeScript packages. The guard owns no state, writes no account, and
                  performs no CPI. Off-chain state normalization and route policy remain
                  separate from the on-chain execution verdict.
                </p>
              </SectionIntro>

              <SystemArchitectureDiagram />
              <ComponentDiagram />

              <div className="docs-table-wrap" role="region" aria-label="Runtime ownership table" tabIndex={0}>
                <table>
                  <caption>Runtime ownership</caption>
                  <thead><tr><th>Layer</th><th>Implemented responsibility</th><th>Does not do</th></tr></thead>
                  <tbody>
                    <tr><td>Guard program</td><td>Decode mint, read Clock, validate instruction grammar, compare bytes, return a verdict.</td><td>Price, route, custody, write state, or move funds.</td></tr>
                    <tr><td><code>guard-client</code></td><td>Read a one-slot snapshot, mirror checks, verify deployment identity, expose ABI types.</td><td>Sign or submit.</td></tr>
                    <tr><td><code>jupiter/protect</code></td><td>Classify, derive expectation, compose guard-first, return typed results.</td><td>Choose liquidity, weaken protection, or hold keys.</td></tr>
                    <tr><td><code>representation-state</code></td><td>Normalize issuer observations and model consented alternatives off chain.</td><td>Execute a reroute.</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section id="transaction-model" className="docs-section">
              <SectionIntro label="05 · Transaction model" title="The guard is part of the transaction it protects.">
                <p>
                  ABI v2 is a fixed 99-byte payload. It names the protected mint,
                  expected stored state, expected activation phase, protection window,
                  downstream adapter, and a SHA-256 commitment. The program receives
                  exactly two read-only accounts: the mint and Instructions sysvar.
                </p>
              </SectionIntro>

              <TransactionDiagram />

              <div className="docs-table-wrap" role="region" aria-label="ABI version 2 payload table" tabIndex={0}>
                <table>
                  <caption>ABI v2 payload</caption>
                  <thead><tr><th>Bytes</th><th>Field</th><th>Meaning</th></tr></thead>
                  <tbody>
                    <tr><td>0</td><td><code>version = 2</code></td><td>All other versions fail closed.</td></tr>
                    <tr><td>1–32</td><td>expected mint</td><td>Must equal account 0 and the protected role in the action.</td></tr>
                    <tr><td>33–56</td><td>three protected fields</td><td>Stored <code>f64</code> bytes, stored next bytes, and <code>i64</code> timestamp.</td></tr>
                    <tr><td>57</td><td>expected phase</td><td><code>PENDING</code> or <code>ACTIVATED</code>.</td></tr>
                    <tr><td>58–65</td><td>window</td><td>Unsigned seconds before and after activation.</td></tr>
                    <tr><td>66</td><td>adapter kind</td><td>1 transfer; 2 Jupiter buy; 3 Jupiter sell.</td></tr>
                    <tr><td>67–98</td><td>commitment</td><td>SHA-256 binding to the protected downstream action.</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="docs-card-grid docs-card-grid--three">
                <article><MonoLabel>Kind 1</MonoLabel><h3>TransferChecked</h3><p>The guard may appear at any top-level index but must immediately precede the exact committed Token-2022 transfer.</p></article>
                <article><MonoLabel>Kind 2</MonoLabel><h3>Jupiter buy</h3><p>The guard must be ix0. The protected mint is the output side and canonical USDC is the input.</p></article>
                <article><MonoLabel>Kind 3</MonoLabel><h3>Jupiter sell</h3><p>The guard must be ix0. The protected mint is the input side and canonical USDC is the output.</p></article>
              </div>

              <aside className="docs-note docs-note--warning">
                <strong>Wallet-added prefixes matter</strong>
                <p>
                  Jupiter kinds 2/3 require the guard at transaction index zero. A wallet
                  or middleware that prepends compute-budget or other instructions makes
                  the transaction fail with <code>GuardNotFirst</code>. Integrations must
                  preserve the signed message exactly.
                </p>
              </aside>
            </section>

            <section id="economic-state-model" className="docs-section">
              <SectionIntro label="06 · Economic-state model" title="Stored bytes plus the phase selected by chain time.">
                <p>
                  The EquityGuard Protocol’s implemented on-chain model is specifically Token-2022
                  <code>ScaledUiAmountConfig</code>. Safety comparisons use deterministic
                  integer and byte representations; floating-point equality is never a
                  security decision.
                </p>
              </SectionIntro>

              <EconomicStateDiagram />

              <div className="docs-split-grid">
                <section className="docs-definition docs-definition--is">
                  <span>Included in protected state</span>
                  <ul>
                    <li>the stored 8-byte <code>multiplier</code>;</li>
                    <li>the stored 8-byte <code>new_multiplier</code>;</li>
                    <li><code>new_multiplier_effective_timestamp</code>;</li>
                    <li>the activation phase derived from Solana Clock;</li>
                    <li>mint identity and downstream action binding.</li>
                  </ul>
                </section>
                <section className="docs-definition">
                  <span>Deliberately excluded</span>
                  <ul>
                    <li>multiplier authority, which is not economic state;</li>
                    <li>Pausable as a guard verdict—Token-2022 blocks the transfer;</li>
                    <li>issuer announcements not yet reflected on chain;</li>
                    <li>market price, fair value, route quality, and slippage;</li>
                    <li>legal equivalence across issuers.</li>
                  </ul>
                </section>
              </div>

              <CodeBlock title="activation-model.ts">{`effectiveMultiplier = now < T ? multiplier : newMultiplier

if (storedBytes !== expectedBytes) refuse()
if (hasScheduledChange && now >= T - before && now <= T + after) refuse()
if (phaseAt(now) !== expectedPhase) refuse()`}</CodeBlock>

              <aside className="docs-note">
                <strong>Activation boundary</strong>
                <p>
                  The refusal interval is inclusive. The phase check remains decisive
                  outside that interval, so a pending authorization cannot execute after
                  activation even with a zero-second window. Window values are integrator
                  policy and are not calibrated by this release.
                </p>
              </aside>
            </section>

            <section id="sdk" className="docs-section">
              <SectionIntro label="07 · SDK" title="Canonical reads in front; trusted builders behind /advanced.">
                <p>
                  The repository contains three private workspace packages at version
                  <code>0.1.0</code>. They are not published to npm. The import paths below
                  are real package exports for this monorepo, not installation promises.
                </p>
              </SectionIntro>

              <PublicSurface tone="technical" className="docs-api-hero">
                <div><MonoLabel>Recommended entry point</MonoLabel><code>@equityguard/jupiter/protect</code></div>
                <p>It derives the expectation from current chain state and is the only path whose <code>PROTECTED</code> result should be handed to a wallet.</p>
              </PublicSurface>

              <div className="docs-api-reference">
                <article>
                  <h3><code>protectJupiterSwap(input)</code></h3>
                  <p><strong>Purpose.</strong> Convert a validated Jupiter Swap V2 <code>/build</code> response into unsigned guarded v0 bytes or a typed refusal.</p>
                  <dl>
                    <div><dt>Required</dt><dd><code>build</code>, <code>userPublicKey</code>, read-only <code>rpc</code>, and explicit <code>protectionWindow</code>.</dd></div>
                    <div><dt>Optional</dt><dd><code>programAddress</code>, <code>computeUnitLimit</code>, quoted <code>expectedState</code> + phase, and commitment.</dd></div>
                    <div><dt>Returns</dt><dd><code>PROTECTED</code>, <code>NOT_APPLICABLE</code>, <code>UNSUPPORTED_PROTECTED_ASSET</code>, <code>UNSUPPORTED_PROTECTED_ROUTE</code>, or <code>ERROR</code>.</dd></div>
                    <div><dt>Throws</dt><dd>RPC and network failures. They must never be converted into <code>NOT_APPLICABLE</code>.</dd></div>
                    <div><dt>Security</dt><dd>Derives phase from the same one-slot snapshot it checks; never silently returns an unguarded transaction for a protected asset.</dd></div>
                  </dl>
                </article>
              </div>

              <CodeBlock title="protect-swap.ts">{`import { address, createSolanaRpc } from "@solana/kit";
import { fetchBuild } from "@equityguard/jupiter";
import {
  protectJupiterSwap,
  reverifyGuardDeployment,
  verifyProtectedSwap,
} from "@equityguard/jupiter/protect";

const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
const userPublicKey = address(walletAddress);

const build = await fetchBuild({
  inputMint,
  outputMint,
  amount: 5_000_000n,
  taker: userPublicKey,
  slippageBps: 50,
}, { apiKey: process.env.JUPITER_API_KEY! });

const result = await protectJupiterSwap({
  build,
  userPublicKey,
  rpc,
  protectionWindow: { beforeSecs: 900, afterSecs: 300 },
});

if (result.status !== "PROTECTED") throw new Error(result.message);
if ((await verifyProtectedSwap(result)) !== null) throw new Error("transaction changed");
if (!(await reverifyGuardDeployment(result, rpc)).ok) throw new Error("deployment changed");

// Hand result.transaction or result.transactionBase64 to the wallet layer.
// Reverify the deployment again immediately before submission.`}</CodeBlock>

              <div className="docs-table-wrap docs-table-wrap--api" role="region" aria-label="Public API map table" tabIndex={0}>
                <table>
                  <caption>Public API map</caption>
                  <thead><tr><th>Import / API</th><th>Input</th><th>Return or failure</th><th>Security role</th></tr></thead>
                  <tbody>
                    <tr><td><code>@equityguard/jupiter/protect</code><br /><code>supportsJupiterSwap</code></td><td>Build, mint-read RPC, optional commitment.</td><td><code>JupiterSwapSupport</code>; malformed builds become typed errors, network failures throw.</td><td>Structural preview only. It does not validate Clock, deployment, grammar, or signability.</td></tr>
                    <tr><td><code>@equityguard/jupiter/protect</code><br /><code>protectJupiterSwap</code></td><td>Build, user, RPC, explicit window; optional quoted state, deployment, CU limit.</td><td>Five-status result union; RPC/network failures throw.</td><td>Canonical state-derived path. Only <code>PROTECTED</code> returns signable bytes.</td></tr>
                    <tr><td><code>@equityguard/jupiter/protect</code><br /><code>verifyProtectedSwap</code></td><td><code>ProtectedSwap</code> and optional candidate wire bytes.</td><td><code>null</code> or a guard/message mutation verdict.</td><td>Compares the guard itself and resolved suffix before wallet handoff.</td></tr>
                    <tr><td><code>@equityguard/jupiter/protect</code><br /><code>reverifyGuardDeployment</code></td><td><code>ProtectedSwap</code>, genesis-aware RPC, optional commitment.</td><td><code>{`{ ok: true, attestation }`}</code> or typed changed/unavailable deployment.</td><td>Narrows upgrade-authority TOCTOU; call before signature and submission.</td></tr>
                    <tr><td><code>@equityguard/jupiter/protect</code><br /><code>explainEquityGuardError</code></td><td>Any protect result.</td><td>Deterministic string; no network call.</td><td>Explains refusal without using text parsing to make a decision.</td></tr>
                    <tr><td><code>@equityguard/guard-client</code><br /><code>fetchGuardSnapshot</code></td><td>RPC, mint, optional commitment.</td><td>Mint + Clock snapshot at one context slot; typed decode/read errors.</td><td>Avoids mixing economic state and chain time from different reads.</td></tr>
                    <tr><td><code>@equityguard/guard-client</code><br /><code>expectationFromSnapshot</code> / <code>checkGuardOffline</code></td><td>Snapshot + window; or request + actual state + chain time.</td><td>Derived request; or a guard error name / <code>null</code>.</td><td>Mirrors the on-chain verdict without replacing the execution-time check.</td></tr>
                    <tr><td><code>@equityguard/guard-client</code><br />decoders + deployment validators</td><td>Raw account bytes, owners, program and ProgramData views.</td><td>Typed state or attestation; malformed and unknown semantics fail closed.</td><td>Pins Token-2022 ownership, TLV validity, cluster, executable program, and reviewed ELF.</td></tr>
                    <tr><td><code>@equityguard/representation-state</code><br />registry, adapters, normalization, decisions</td><td>Issuer observations, policy, quotes, and consent context.</td><td>Normalized state and route decision objects.</td><td>Off-chain only; keeps cross-issuer semantics explicit and never executes a reroute.</td></tr>
                  </tbody>
                </table>
              </div>

              <aside className="docs-note docs-note--warning">
                <strong>Trusted-builder surface</strong>
                <p>
                  <code>@equityguard/jupiter/advanced</code> and
                  <code>@equityguard/guard-client/advanced</code> accept caller-chosen
                  expectations. They encode what they are given. Use them only when the
                  builder itself derives and authenticates the user’s authorized state.
                </p>
              </aside>
            </section>

            <section id="integrations" className="docs-section">
              <SectionIntro label="08 · Integrations" title="Compose with the systems users already trust.">
                <p>
                  StateGuard does not ask routers or wallets to surrender their role.
                  It consumes an action, validates whether that action fits a supported
                  adapter, and returns a transaction the existing wallet flow can sign.
                </p>
              </SectionIntro>

              <RouterIntegrationDiagram />

              <div className="docs-subsection" id="jupiter-integration">
                <MonoLabel>Jupiter · implemented</MonoLabel>
                <h3>Swap V2 Router <code>GET /build</code></h3>
                <ol className="docs-compact-steps">
                  <li>Call <code>fetchBuild</code> with input/output mint, smallest-unit amount, taker, slippage bps, and optional <code>maxAccounts</code>.</li>
                  <li>Pass the raw or parsed response to <code>protectJupiterSwap</code>.</li>
                  <li>Handle every result status explicitly. For a protected asset, any status other than <code>PROTECTED</code> means no transaction may be sent.</li>
                  <li>Immediately before the signature request, call <code>reverifyGuardDeployment</code> and <code>verifyProtectedSwap</code>.</li>
                  <li>Ask the wallet to sign the exact unsigned v0 transaction. Reverify deployment again before submission.</li>
                </ol>
                <div className="docs-route-matrix">
                  <div><span>Supported</span><strong>Jupiter v6 <code>route_v2</code></strong><p>ExactIn, canonical USDC, Token-2022 ScaledUiAmount, buy or sell, canonical ATAs.</p></div>
                  <div><span>Refused</span><strong>Anything outside the grammar</strong><p>Cleanup, tips, wSOL intermediates, ExactOut, another counterasset, multiple setups, fees, overrides, noncanonical accounts, or another entrypoint.</p></div>
                </div>
              </div>

              <div className="docs-subsection" id="wallet-integration">
                <MonoLabel>Wallets · wallet-neutral contract</MonoLabel>
                <h3>Review and sign the composed message once.</h3>
                <p>
                  A wallet integration receives unsigned bytes, preserves instruction
                  order, shows the protected mint and state warning, and returns a normal
                  Solana signature. The guard has no signer account and requires no
                  independent approval in the normal path.
                </p>
                <CodeBlock title="phantom-demo.ts">{`// Demonstrated in apps/devnet-wallet-demo; provider format is wallet-specific.
const signedWire = await provider.request({
  method: "signTransaction",
  params: { message: encodedTransaction },
});

verifyWalletSignedTransaction(unsignedTransaction, signedWire);
// Submit only the verified, byte-identical signed transaction.`}</CodeBlock>
                <p className="docs-caption">
                  Phantom is the demonstrated wallet, not a protocol dependency. The
                  devnet demo also supports <code>signAndSendTransaction</code>; the
                  protection model remains wallet-neutral.
                </p>
              </div>

              <div className="docs-subsection" id="router-adapter-guide">
                <MonoLabel>Routers & exchanges · adapter guide</MonoLabel>
                <h3>Implement semantics before adding an adapter kind.</h3>
                <div className="docs-table-wrap" role="region" aria-label="Router adapter guide table" tabIndex={0}>
                  <table>
                    <thead><tr><th>Adapter</th><th>Status</th><th>Required security work</th></tr></thead>
                    <tbody>
                      <tr><td>Token-2022 <code>TransferChecked</code></td><td><span className="docs-pill docs-pill--live">Implemented</span></td><td>Exact next-instruction commitment and same-mint check.</td></tr>
                      <tr><td>Jupiter v6 <code>route_v2</code></td><td><span className="docs-pill docs-pill--live">Implemented</span></td><td>Fixed grammar, USDC role, canonical ATAs, ix0, full suffix commitment.</td></tr>
                      <tr><td>Other router or exchange</td><td><span className="docs-pill">Future</span></td><td>New on-chain adapter kind, explicit grammar, program and account identity, mutation tests, client composer, and wallet review.</td></tr>
                    </tbody>
                  </table>
                </div>
                <p>
                  Do not map a future router into Jupiter semantics or fall back to a
                  generic commitment. Unknown adapter bytes fail closed.
                </p>
              </div>
            </section>

            <section id="security" className="docs-section">
              <SectionIntro label="09 · Security" title="What is enforced, what is trusted, and what remains open.">
                <p>
                  The program enforces execution-time state and action binding. The SDK
                  narrows untrusted RPC and Jupiter inputs into a signable candidate.
                  Wallet review, builder honesty, deployment governance, and ordinary
                  price protection remain separate trust boundaries.
                </p>
              </SectionIntro>

              <div className="docs-table-wrap docs-table-wrap--security" role="region" aria-label="Threat and control summary table" tabIndex={0}>
                <table>
                  <caption>Threat and control summary</caption>
                  <thead><tr><th>Threat</th><th>Control</th><th>Residual boundary</th></tr></thead>
                  <tbody>
                    <tr><td>Stale stored state or activation crossing</td><td>Byte comparison + Clock phase + inclusive window at execution.</td><td>A builder outside the canonical SDK can encode a future expectation.</td></tr>
                    <tr><td>Downstream substitution</td><td>Domain-separated SHA-256 commitment; Jupiter suffix grammar.</td><td>The commitment pins signer-approved values; it does not judge their economic quality.</td></tr>
                    <tr><td>Grammar smuggling or reordering</td><td>Guard-first requirement, fixed instruction count/order, pinned programs and entrypoint.</td><td>Unsupported routes fail closed, reducing availability.</td></tr>
                    <tr><td>Mint, account, or program substitution</td><td>Mint in payload = account 0 = protected route role; Token-2022 owner; canonical ATAs; deployment check.</td><td>RPC remains trusted for off-chain classification of unknown assets.</td></tr>
                    <tr><td>Upgrade-authority TOCTOU</td><td>ELF + ProgramData attestation before signature and submission.</td><td>The devnet authority can upgrade between the final read and landing.</td></tr>
                    <tr><td>Demo or localhost confusion</td><td>Genesis-hash gates and explicit mainnet/devnet/local labels.</td><td>Recorded proof is a replay. Live Devnet is Phantom on Solana Devnet for Token-2022 TransferChecked, not Jupiter or Whirlpool.</td></tr>
                    <tr><td>Replay or evidence overclaim</td><td>Raw state provenance, deterministic fixtures, claim matrix, environment disclosures.</td><td>Historical replay is not a mainnet EquityGuard Protocol execution.</td></tr>
                    <tr><td>Wallet mutation or prefix insertion</td><td>Compare signed message to unsigned candidate; verify ix0 and suffix before submit.</td><td>Wallet UI and signing behavior are outside the on-chain program.</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="docs-security-boundaries">
                <article><span>On chain</span><h3>Enforced</h3><p>Owner, mint identity, payload, stored fields, phase, window, top-level position, adapter grammar, resolved accounts, commitment, and atomic failure.</p></article>
                <article><span>Canonical client</span><h3>Derived and rechecked</h3><p>Cluster identity, deployment bytes, snapshot state, quoted-state narrowing, route support, size, exact unsigned message, and typed refusal.</p></article>
                <article><span>Operational</span><h3>Trusted</h3><p>Wallet review, RPC availability, upgrade-authority custody, protection-window policy, and the link between the displayed quote and signed authorization.</p></article>
              </div>

              <aside className="docs-note docs-note--warning">
                <strong>Not externally audited</strong>
                <p>
                  The repository records internal adversarial review, property tests,
                  differential tests, and a release gate. It has no independent external
                  security audit. Production deployment requires a new review and an
                  immutable program or appropriately timelocked multisig governance.
                </p>
              </aside>
            </section>

            <section id="evidence" className="docs-section">
              <SectionIntro label="10 · Evidence & validation" title="Claims are scoped to the environment that produced them.">
                <p>
                  Mainnet evidence is read-only state and route data. The public demo has
                  two modes. Recorded proof replays KOx observations, protected Jupiter
                  transaction composition, and Whirlpool execution from the canonical local
                  reproduction, including the stale rejection and the refreshed execution.
                  It does not represent a live public mainnet EquityGuard Protocol transaction.
                  Live Devnet connects to Phantom on Solana Devnet, verifies the reviewed
                  deployment, and protects Token-2022 TransferChecked on a fresh per-session
                  demo asset. It does not execute Jupiter or Whirlpool. The layers are
                  complementary, not interchangeable.
                </p>
              </SectionIntro>

              <div className="docs-evidence-summary">
                <div><strong>19,986</strong><span>mainnet observations</span></div>
                <div><strong>294,527</strong><span>authorization/execution pairs</span></div>
                <div><strong>1,000,000</strong><span>seeded differential cases</span></div>
                <div><strong>0</strong><span>unexpected accepts</span></div>
              </div>

              <div className="docs-table-wrap" role="region" aria-label="Claim and evidence matrix table" tabIndex={0}>
                <table>
                  <caption>Claim / evidence matrix</caption>
                  <thead><tr><th>Claim</th><th>Evidence</th></tr></thead>
                  <tbody>
                    <tr><td>Six real xStocks and Ondo representations decoded across 19,986 observations with 0 failures; 5/5 known transitions detected.</td><td>Read-only mainnet capture: 3,331 polls, Sep 13–15 2026. Full capture is local; curated raw fixtures and source hashes are committed.</td></tr>
                    <tr><td>7,029 economically stale cases were blocked across 294,527 historical pairs, with 0 unexpected allows or blocks.</td><td>Deterministic replay of captured state; model replay, not submitted mainnet transactions.</td></tr>
                    <tr><td>TypeScript and Rust agreed on 1,000,000 generated cases; compiled SBF agreed on a 20,000-case sample.</td><td>Seeded differential harness, deterministic hashes, 0 disagreements and 0 unexpected accepts.</td></tr>
                    <tr><td>Atomic failure prevents downstream transfer and even rolls back an earlier ATA creation.</td><td>LiteSVM compiled-program tests and public-devnet kind-1 rejection evidence.</td></tr>
                    <tr><td>A human wallet signed SAFE, BLOCK, and REFRESH proofs on devnet.</td><td>Phantom demo records: SAFE and REFRESH moved 100,000 raw units; BLOCK returned custom error 9 with zero token delta.</td></tr>
                    <tr><td>The guard instruction adds 168 bytes; recorded protected Jupiter builds were 675–918 bytes.</td><td>Compiled v0 message regression tests. A recorded transaction was 176 bytes above its original build because the composer also added an 8-byte CU-limit instruction.</td></tr>
                    <tr><td>Valid guard cost measured 4,811–5,615 CU for kind 1 and 10,675–15,243 CU for kinds 2/3.</td><td>LiteSVM over real mint bytes and route fixtures; not a TPS or public-cluster throughput claim.</td></tr>
                    <tr><td>A guarded Jupiter/Whirlpool trade path executed locally for 81,783 total CU.</td><td>Local validator with real binaries and mainnet-derived accounts; not mainnet and not public devnet execution.</td></tr>
                    <tr><td>The reviewed 63,840-byte program ELF was deployed on devnet.</td><td>ProgramData readback matched SHA-256 <code>d7d59ccd…e46</code>; deployment remains upgradeable. There is no mainnet deployment.</td></tr>
                    <tr><td>A public Live Devnet session held a pending Token-2022 authorization, landed the stale transaction, then executed a new activated transfer.</td><td>Devnet <code>2G9qfs13xnUxYheu7t2cqY2EE9sBKodkpCuahMcGDtRZtRt5cwwjU7qYRGZVoMBegfZdqsmZEdqPU5CLUe4G92zj</code> is ActivationPhaseChanged with zero protected movement. <code>2rxQmrThkTgQiG1M4WFLM1YjJtE4mBj93YjSBeDPdnEai3vJ44gU7dSAfcaq1vWLWXCv2GYLrxZGBMhReCGuyddp</code> is a new authorization and Token-2022 TransferChecked of 100000 raw units. Demo asset only.</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="docs-environment-grid">
                <article><MonoLabel>Live mainnet</MonoLabel><h3>Observe only</h3><p>Issuer mint state and Jupiter routes. No EquityGuard Protocol program, signature, or submitted transaction.</p></article>
                <article><MonoLabel>Live Devnet</MonoLabel><h3>TransferChecked proof</h3><p>Phantom on Solana Devnet. The browser verifies the reviewed upgradeable program, creates a KO-DEMO, UNH-DEMO, or CRM-DEMO ScaledUiAmount asset, holds the pending signed bytes, and submits them after the Devnet Clock crosses. Success requires ActivationPhaseChanged and zero protected movement, then a new authorization and Token-2022 TransferChecked. Demo assets are demonstration assets only: not real securities, no market value, and not issuer-affiliated. This path does not execute Jupiter or Whirlpool.</p></article>
                <article><MonoLabel>Local validator</MonoLabel><h3>Composition proof</h3><p>Recorded proof of real Jupiter and Whirlpool binaries with mainnet-derived accounts. Controlled replay, not a public-market trade and not the Live Devnet path.</p></article>
              </div>
            </section>

            <section id="deployment" className="docs-section">
              <SectionIntro label="11 · Deployment" title="Program deployment and web hosting are separate releases.">
                <p>
                  Shipping the documentation site does not deploy or upgrade the guard.
                  Shipping the program does not publish the SDK packages or host a web UI.
                  Treat each artifact, network, and authority as a distinct boundary.
                </p>
              </SectionIntro>

              <div className="docs-deployment-grid">
                <article>
                  <MonoLabel>Program / protocol</MonoLabel>
                  <h3>Devnet only</h3>
                  <dl>
                    <div><dt>Program</dt><dd><code>EbzHf…NnhT</code></dd></div>
                    <div><dt>Loader</dt><dd>BPF Upgradeable Loader</dd></div>
                    <div><dt>Binary</dt><dd>63,840 B · <code>d7d59ccd…e46</code></dd></div>
                    <div><dt>Governance</dt><dd>Single upgrade authority; mutable</dd></div>
                    <div><dt>Mainnet</dt><dd>No deployment</dd></div>
                  </dl>
                  <p>Before any signature, resolve cluster from genesis hash, verify Program + ProgramData in one read, and match the reviewed ELF. Reverify before submission. The website Live Devnet flow does this in the browser against public Devnet and refuses mainnet and testnet.</p>
                </article>
                <article>
                  <MonoLabel>Web documentation</MonoLabel>
                  <h3>Standard Next.js artifact</h3>
                  <dl>
                    <div><dt>Runtime</dt><dd>Node.js ≥ 22.18.0</dd></div>
                    <div><dt>Build</dt><dd><code>npm run build</code> in <code>apps/web</code></dd></div>
                    <div><dt>Serve</dt><dd><code>npm run start</code></dd></div>
                    <div><dt>Secrets</dt><dd>None required for this static docs route</dd></div>
                    <div><dt>Publishing</dt><dd>Not performed by this milestone</dd></div>
                  </dl>
                  <p>The app can run as a Node.js deployment. Provider configuration, headers, observability, DNS, and release ownership remain hosting decisions.</p>
                </article>
              </div>

              <div className="docs-subsection">
                <MonoLabel>Program release procedure</MonoLabel>
                <h3>Build, review, deploy, then independently attest.</h3>
                <ol className="docs-compact-steps">
                  <li>Run the pinned Rust formatting, lint, host tests, <code>cargo build-sbf</code>, and LiteSVM suites against the resulting ELF.</li>
                  <li>Record the exact ELF length and SHA-256 in a cluster-specific reviewed-deployment manifest. Never infer length by trimming ProgramData zeros.</li>
                  <li>Have the human owner deploy or upgrade the intended cluster address. Repository automation and CI do not deploy.</li>
                  <li>Read Program and ProgramData back from that cluster, verify loader ownership, executable flag, PDA pointer, exact ELF hash, zero padding, deployment slot, and upgrade authority.</li>
                  <li>Update client deployment metadata only after independent readback. A mainnet entry must never reuse the devnet address or attestation.</li>
                </ol>
              </div>

              <aside className="docs-note">
                <strong>Production program checklist</strong>
                <p>
                  Rebuild reproducibly, rerun Rust and TypeScript suites, independently
                  review the new ELF, deploy under a mainnet-specific manifest, remove the
                  single-key TOCTOU risk, publish package artifacts intentionally, and
                  obtain external security review. None of those production steps has happened.
                </p>
              </aside>
            </section>

            <section id="limitations" className="docs-section">
              <SectionIntro label="12 · Limitations" title="Deliberate constraints, stated without euphemism.">
                <p>
                  StateGuard is a narrow proof of one execution invariant. The current
                  release should be evaluated by what it refuses as much as by what it accepts.
                </p>
              </SectionIntro>

              <ol className="docs-limitations">
                <li><span>01</span><div><strong>No mainnet program deployment</strong><p>The EquityGuard Protocol program does not exist on mainnet. Mainnet activity is read-only or build-only.</p></div></li>
                <li><span>02</span><div><strong>Strict route subset</strong><p>Only ExactIn Jupiter v6 <code>route_v2</code>, canonical USDC, canonical ATAs, and the fixed suffix grammar are supported.</p></div></li>
                <li><span>03</span><div><strong>No universal protection window</strong><p>Observed windows are test or demo policy, not an issuer-independent calibrated standard.</p></div></li>
                <li><span>04</span><div><strong>Scalar state model</strong><p>One multiplier, a pending multiplier, and one activation timestamp cannot express every corporate action.</p></div></li>
                <li><span>05</span><div><strong>Structural actions need richer semantics</strong><p>Mergers, spin-offs, migrations, redemptions, and legal identity changes may appear safe to this model.</p></div></li>
                <li><span>06</span><div><strong>Upgrade-authority TOCTOU</strong><p>Repeated attestation narrows—but does not eliminate—the time in which an authority can replace the program.</p></div></li>
                <li><span>07</span><div><strong>No external audit</strong><p>Internal campaigns and test depth are evidence, not an independent security assessment.</p></div></li>
                <li><span>08</span><div><strong>Packages are unpublished</strong><p>The documented package paths work in the monorepo and are marked private at version 0.1.0.</p></div></li>
                <li><span>09</span><div><strong>Two public demo modes</strong><p>Recorded proof replays preserved KOx, Jupiter, and Whirlpool evidence and does not submit a visitor transaction. Live Devnet connects to Phantom on Solana Devnet and protects Token-2022 TransferChecked. Its assets are demonstration assets only: not real securities, no market value, and not issuer-affiliated. Live Devnet does not execute Jupiter or Whirlpool, and neither mode is a mainnet EquityGuard Protocol deployment.</p></div></li>
                <li><span>10</span><div><strong>No fair-value guarantee</strong><p>After a corporate-action transition, AMM repricing and ordinary slippage remain market-risk controls.</p></div></li>
              </ol>
            </section>

            <section id="future-work" className="docs-section">
              <SectionIntro label="13 · Future work" title="Directions, not promises.">
                <p>
                  The items below are plausible extensions after the base guard is
                  independently reviewed and proven in a production deployment. They are
                  not implemented commitments, timelines, or current product claims.
                </p>
              </SectionIntro>

              <div className="docs-future-grid">
                <article><span>Future direction</span><h3>Immutable mainnet deployment</h3><p>A separately reviewed binary and governance model suitable for production transaction lifetimes.</p></article>
                <article><span>Future direction</span><h3>Calibrated policy</h3><p>Issuer- and event-specific protection windows backed by a larger corpus.</p></article>
                <article><span>Future direction</span><h3>Additional adapters</h3><p>Router-specific on-chain grammars, not a generic or silent fallback.</p></article>
                <article><span>Future direction</span><h3>Richer economic state</h3><p>Explicit models for structural actions that a scalar multiplier cannot describe.</p></article>
                <article><span>Future direction</span><h3>Consented alternatives</h3><p>Execution only after issuer, reason, value, and quote differences are disclosed and authorized.</p></article>
                <article><span>Future direction</span><h3>External assurance</h3><p>Independent audit, reproducible release artifacts, published packages, and operating runbooks.</p></article>
              </div>
            </section>

            <section id="references" className="docs-section docs-section--references">
              <SectionIntro label="14 · References" title="Primary sources and project evidence.">
                <p>
                  External links below are official documentation or project-owner
                  repositories. EquityGuard Protocol evidence is listed separately so protocol
                  facts are not confused with this project’s empirical claims.
                </p>
              </SectionIntro>

              <div className="docs-reference-columns">
                <section>
                  <MonoLabel>Official external references</MonoLabel>
                  <ul>
                    <li><ExternalLink href="https://solana.com/docs/core/transactions">Solana transactions and atomicity</ExternalLink></li>
                    <li><ExternalLink href="https://solana.com/docs/tokens/extensions/scaled-ui-amount">Token-2022 Scaled UI Amount</ExternalLink></li>
                    <li><ExternalLink href="https://developers.jup.ag/docs/swap">Jupiter Swap API V2</ExternalLink></li>
                    <li><ExternalLink href="https://docs.phantom.com/solana/integrating-phantom">Phantom Solana integration</ExternalLink></li>
                    <li><ExternalLink href="https://github.com/orca-so/whirlpools">Orca Whirlpools program and SDKs</ExternalLink></li>
                    <li><ExternalLink href="https://nextjs.org/docs/app/getting-started/deploying">Next.js deployment guide</ExternalLink></li>
                  </ul>
                </section>
                <section>
                  <MonoLabel>EquityGuard Protocol evidence</MonoLabel>
                  <ul>
                    <li><ExternalLink href="https://explorer.solana.com/address/EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT?cluster=devnet">Devnet program account</ExternalLink></li>
                    <li><ExternalLink href="https://explorer.solana.com/tx/5Vb8aaU47wz2bK8iA5yvAyYFEGQbWPy5vzVTo46kZi6VJb22gman2KaRyEBLpcgkkiQSvJSYkg6nSHZZvvQ1jXmb?cluster=devnet">Reviewed-binary upgrade transaction</ExternalLink></li>
                    <li><ExternalLink href="https://explorer.solana.com/tx/2G9qfs13xnUxYheu7t2cqY2EE9sBKodkpCuahMcGDtRZtRt5cwwjU7qYRGZVoMBegfZdqsmZEdqPU5CLUe4G92zj?cluster=devnet">Public Live Devnet stale rejection</ExternalLink> · ActivationPhaseChanged, zero protected Token-2022 movement</li>
                    <li><ExternalLink href="https://explorer.solana.com/tx/2rxQmrThkTgQiG1M4WFLM1YjJtE4mBj93YjSBeDPdnEai3vJ44gU7dSAfcaq1vWLWXCv2GYLrxZGBMhReCGuyddp?cluster=devnet">Public Live Devnet updated execution</ExternalLink> · new authorization, Token-2022 TransferChecked, 100000 raw units</li>
                    <li><ExternalLink href="https://github.com/Maheshsiddu29/EquityGuard/blob/main/evidence/final-demo/manifest.json">Final-demo evidence manifest</ExternalLink> · hashes and provenance for the reviewed evidence package</li>
                    <li><ExternalLink href="https://github.com/Maheshsiddu29/EquityGuard/blob/main/evidence/final-demo/verification-report.json">Final-demo verification report</ExternalLink> · machine-readable release checks and verified artifacts</li>
                    <li><ExternalLink href="https://github.com/Maheshsiddu29/EquityGuard/tree/main/scripts/m11b">Market-scale validation harness</ExternalLink> · replay, differential, transaction-size, and scenario tests</li>
                    <li><ExternalLink href="https://github.com/Maheshsiddu29/EquityGuard/tree/main/programs/equity_guard/tests">Compiled-program tests</ExternalLink> · LiteSVM invariant and atomicity coverage</li>
                    <li><ExternalLink href="https://github.com/Maheshsiddu29/EquityGuard/tree/main/packages/jupiter/test">Jupiter integration tests</ExternalLink> · grammar, trust-boundary, mutation, and concurrency coverage</li>
                  </ul>
                </section>
              </div>
            </section>
          </article>

          <aside className="docs-on-page" aria-label="On this page">
            <MonoLabel>On this page</MonoLabel>
            <DocsLinks />
          </aside>
        </div>
      </section>
    </main>
  );
}
