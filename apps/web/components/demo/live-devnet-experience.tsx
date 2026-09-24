"use client";

import { PublicSurface, SectionLabel } from "@/components/ui/public-ui";
import {
  AUTHORIZATION_WINDOW_ELAPSED_MESSAGE,
  AUTHORIZATION_WINDOW_ELAPSED_TITLE,
  AUTHORIZATION_WINDOW_MISSED_MESSAGE,
  AUTHORIZATION_WINDOW_MISSED_TITLE,
  DEMO_TRANSFER_RAW,
  DEVNET_PUBLIC_DISCLAIMER,
  PROTECTION_EXPLANATION,
  SCENARIO_CATALOG,
  STALE_AUTHORIZATION_EXPIRED_MESSAGE,
  STALE_AUTHORIZATION_EXPIRED_TITLE,
  TOKEN_2022_PROGRAM_ADDRESS,
  AuthorizationWindowElapsed,
  AuthorizationWindowMissed,
  StaleAuthorizationExpired,
  acceptActivationRejection,
  acceptUpdatedExecution,
  address,
  authorizePending,
  authorizeUpdated,
  bindReviewedProgram,
  chainReadyForStaleSubmit,
  currentBlockHeight,
  detectPhantom,
  devnetExplorerUrl,
  formatMultiplier,
  heldWaitDecision,
  prepareLiveSession,
  presentationCountdownSeconds,
  randomScenario,
  readChainSnapshot,
  readSessionBalances,
  requestDevnetSol,
  reviewedProgramId,
  scenarioById,
  shortAddress,
  startAttempt,
  submissionPermitted,
  submitHeld,
  verifyPublicEnvironment,
  type EquityScenario,
  type HeldAuthorization,
  type PhantomProvider,
  type PreparedSession,
} from "@/lib/devnet-public";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./live-devnet.css";

bindReviewedProgram(address("EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT"));
const EQUITY_GUARD_DEVNET_PROGRAM_ID = reviewedProgramId();

type Phase = "ready" | "preparing" | "armed" | "signing" | "locked" | "activating" | "protected" | "updating" | "executed" | "missed" | "elapsed" | "expired" | "failed";

export function LiveDevnetExperience(): ReactNode {
  const [phase, setPhase] = useState<Phase>("ready");
  const [wallet, setWallet] = useState<string | null>(null);
  const [provider, setProvider] = useState<PhantomProvider | null>(null);
  const [scenarioId, setScenarioId] = useState<EquityScenario["id"]>("KO-DEMO");
  const [session, setSession] = useState<PreparedSession | null>(null);
  const [held, setHeld] = useState<HeldAuthorization | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [staleSignature, setStaleSignature] = useState<string | null>(null);
  const [updatedSignature, setUpdatedSignature] = useState<string | null>(null);
  const [movement, setMovement] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [environment, setEnvironment] = useState("Checking Devnet");
  const locked = session !== null;
  const submitStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    verifyPublicEnvironment()
      .then(() => { if (!cancelled) setEnvironment("Solana Devnet"); })
      .catch(() => { if (!cancelled) setEnvironment("Devnet verification failed"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (phase !== "locked" || !session || !held) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await readChainSnapshot(session.mint);
        if (cancelled) return;
        const displayedSeconds = presentationCountdownSeconds(snapshot.clock.unixTimestamp, session.activation);
        setCountdown(displayedSeconds);
        const decision = heldWaitDecision({
          blockHeight: await currentBlockHeight(),
          lastValidBlockHeight: held.lastValidBlockHeight,
          ready: chainReadyForStaleSubmit(snapshot, held.expectation),
        });
        if (decision === "expired") {
          setPhase("expired");
          return;
        }
        if (submissionPermitted({ displayedSeconds, chainReady: decision === "submit" })) {
          setPhase("activating");
          return;
        }
        window.setTimeout(() => { if (!cancelled) void poll(); }, 1000);
      } catch (error) {
        if (!cancelled) {
          setPhase("failed");
          setDetail(error instanceof Error ? error.message : "The Devnet clock could not be read.");
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [phase, session, held]);

  useEffect(() => {
    if (phase !== "activating" || !session || !held || submitStarted.current) return;
    submitStarted.current = true;
    submitHeld(held)
      .then(async (outcome) => {
        const balances = await readSessionBalances(session);
        const accepted = acceptActivationRejection({
          outcome,
          before: session.balances,
          after: balances,
          programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        if (!accepted) {
          setPhase("failed");
          setDetail("The confirmed transaction was not an ActivationPhaseChanged rejection with zero token movement.");
          return;
        }
        setStaleSignature(outcome.signature);
        setPhase("protected");
      })
      .catch((error: unknown) => {
        if (error instanceof StaleAuthorizationExpired) {
          setPhase("expired");
          return;
        }
        setPhase("failed");
        setDetail(error instanceof Error ? error.message : "The held authorization could not be submitted.");
      });
  }, [phase, session, held]);

  const scenario = scenarioById(scenarioId);
  const connectedWallet = wallet === null ? null : address(wallet);

  async function connect(): Promise<void> {
    const detected = detectPhantom();
    if (!detected) {
      setDetail("Connect Phantom before starting a live Devnet attempt.");
      setPhase("failed");
      return;
    }
    const connected = await detected.connect();
    setProvider(detected);
    setWallet(connected.publicKey.toBase58());
    setDetail(null);
    if (phase === "failed") setPhase("ready");
  }

  async function prepare(): Promise<void> {
    if (!provider || !connectedWallet || session) return;
    const attempt = startAttempt(scenarioById(scenarioId));
    setPhase("preparing");
    setDetail(null);
    try {
      const prepared = await prepareLiveSession({
        provider,
        wallet: connectedWallet,
        scenario: attempt.scenario,
      });
      setSession(prepared);
      setPhase("armed");
    } catch (error) {
      setPhase("failed");
      setDetail(error instanceof Error ? error.message : "The session mint could not be prepared.");
    }
  }

  async function authorize(): Promise<void> {
    if (!provider || !connectedWallet || !session || held) return;
    setPhase("signing");
    try {
      const signed = await authorizePending({
        provider,
        wallet: connectedWallet,
        session,
      });
      setHeld(signed);
      setPhase("locked");
    } catch (error) {
      if (error instanceof AuthorizationWindowMissed) {
        setPhase("missed");
        return;
      }
      if (error instanceof AuthorizationWindowElapsed) {
        setPhase("elapsed");
        setDetail(`Clock ${error.clock} T ${error.activation}`);
        return;
      }
      setPhase("failed");
      setDetail(error instanceof Error ? error.message : "Phantom did not return a pending authorization.");
    }
  }

  async function confirmUpdated(): Promise<void> {
    if (!provider || !connectedWallet || !session || phase !== "protected") return;
    setPhase("updating");
    try {
      const before = await readSessionBalances(session);
      const outcome = await authorizeUpdated({
        provider,
        wallet: connectedWallet,
        session,
      });
      const after = await readSessionBalances(session);
      const accepted = acceptUpdatedExecution({
        outcome,
        before,
        after,
        amount: DEMO_TRANSFER_RAW,
        programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      if (!accepted) {
        setPhase("failed");
        setDetail("The confirmed transaction did not execute the protected transfer.");
        return;
      }
      setUpdatedSignature(outcome.signature);
      setMovement(DEMO_TRANSFER_RAW.toString());
      setPhase("executed");
    } catch (error) {
      setPhase("failed");
      setDetail(error instanceof Error ? error.message : "The updated authorization was not confirmed.");
    }
  }

  function reset(): void {
    submitStarted.current = false;
    setPhase("ready");
    setSession(null);
    setHeld(null);
    setCountdown(null);
    setStaleSignature(null);
    setUpdatedSignature(null);
    setMovement(null);
    setDetail(null);
  }

  const busy = phase === "preparing" || phase === "signing" || phase === "locked" || phase === "activating" || phase === "updating";

  return (
    <PublicSurface as="article" tone="gradient" className="demo-trade-card live-devnet">
      <SectionLabel>Live Devnet</SectionLabel>
      <div className="live-devnet__hero">
        <h2>Run EquityGuard yourself with a simulated tokenized-equity corporate action.</h2>
        <p>{DEVNET_PUBLIC_DISCLAIMER}</p>
      </div>
      <dl className="live-devnet__facts">
        <div><dt>Network</dt><dd>{environment}</dd></div>
        <div><dt>Program</dt><dd><code>{shortAddress(EQUITY_GUARD_DEVNET_PROGRAM_ID)}</code></dd></div>
      </dl>
      <div className="live-devnet__actions">
        <button type="button" className="button button--primary focus-ring" onClick={() => void connect()} disabled={busy}>
          {wallet ? "Phantom connected" : "Connect Phantom"}
        </button>
        {wallet ? (
          <button type="button" className="button button--primary focus-ring" onClick={() => void requestDevnetSol(address(wallet)).catch(() => setDetail("Devnet faucet is unavailable or rate limited."))} disabled={busy}>
            Get devnet SOL
          </button>
        ) : null}
      </div>

      <div className="live-devnet__scenario">
        <label>
          <span>Asset</span>
          <select
            value={scenarioId}
            disabled={locked || busy}
            onChange={(event) => {
              if (locked) return;
              setScenarioId(scenarioById(event.target.value).id);
            }}
          >
            {SCENARIO_CATALOG.map((item) => (
              <option key={item.id} value={item.id}>{item.symbol} · {item.displayName}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button--secondary focus-ring"
          disabled={locked || busy}
          onClick={() => {
            if (locked) return;
            setScenarioId(randomScenario().id);
          }}
        >
          Random event
        </button>
        <div>
          <strong>{scenario.symbol}</strong>
          <p>{scenario.displayName}</p>
          <p>{scenario.eventLabel}</p>
          <p>{formatMultiplier(scenario.initialMultiplier)} → {formatMultiplier(scenario.newMultiplier)}</p>
        </div>
      </div>

      {phase === "ready" || phase === "armed" || phase === "preparing" ? (
        <div className="live-devnet__actions">
          <button type="button" className="button button--primary focus-ring" disabled={!wallet || locked || busy} onClick={() => void prepare()}>
            {phase === "preparing" ? "Preparing…" : "Prepare"}
          </button>
          <button type="button" className="button button--primary focus-ring" disabled={phase !== "armed" || busy} onClick={() => void authorize()}>
            Authorize
          </button>
        </div>
      ) : null}

      {phase === "locked" || phase === "activating" ? (
        <div className="live-devnet__copy" aria-live="polite">
          <h3>{phase === "activating" ? "Corporate action active" : "Authorization locked"}</h3>
          <p>{scenario.symbol}</p>
          <p>Authorized state {formatMultiplier(scenario.initialMultiplier)}</p>
          <p>Corporate action {scenario.eventLabel}</p>
          {phase === "activating" ? (
            <p>{formatMultiplier(scenario.initialMultiplier)} → {formatMultiplier(scenario.newMultiplier)}. Submitting the exact authorization you signed…</p>
          ) : (
            <>
              <p className="live-devnet__countdown">Activates in {countdown ?? "—"}s</p>
              <p>Waiting for on-chain activation…</p>
            </>
          )}
        </div>
      ) : null}

      {phase === "protected" && staleSignature ? (
        <div className="live-devnet__result">
          <h3>Protected by EquityGuard</h3>
          <p>Asset {scenario.symbol}</p>
          <p>Corporate action {scenario.eventLabel}</p>
          <p>Authorized state {formatMultiplier(scenario.initialMultiplier)}</p>
          <p>Current state {formatMultiplier(scenario.newMultiplier)}</p>
          <p>Guard result ActivationPhaseChanged</p>
          <p>Downstream action BLOCKED</p>
          <p>Token movement 0</p>
          <p>Network Solana Devnet</p>
          <a href={devnetExplorerUrl(staleSignature)} target="_blank" rel="noopener noreferrer">View transaction on Solana Explorer</a>
          <p>{PROTECTION_EXPLANATION}</p>
          <h3>Review updated state</h3>
          <p>Previous {formatMultiplier(scenario.initialMultiplier)}</p>
          <p>Current {formatMultiplier(scenario.newMultiplier)}</p>
          <p>{scenario.eventLabel} active</p>
          <button type="button" className="button button--primary focus-ring" onClick={() => void confirmUpdated()}>Confirm updated action</button>
        </div>
      ) : null}

      {phase === "executed" && updatedSignature && movement ? (
        <div className="live-devnet__result">
          <h3>Executed</h3>
          <p>EquityGuard PASSED</p>
          <p>Protected action Token-2022 TransferChecked</p>
          <p>Token movement {movement}</p>
          <p>Network Solana Devnet</p>
          <a href={devnetExplorerUrl(updatedSignature)} target="_blank" rel="noopener noreferrer">View transaction on Solana Explorer</a>
        </div>
      ) : null}

      {phase === "missed" ? <Failure title={AUTHORIZATION_WINDOW_MISSED_TITLE} body={AUTHORIZATION_WINDOW_MISSED_MESSAGE} onReset={reset} /> : null}
      {phase === "elapsed" ? <Failure title={AUTHORIZATION_WINDOW_ELAPSED_TITLE} body={AUTHORIZATION_WINDOW_ELAPSED_MESSAGE} onReset={reset} /> : null}
      {phase === "expired" ? <Failure title={STALE_AUTHORIZATION_EXPIRED_TITLE} body={STALE_AUTHORIZATION_EXPIRED_MESSAGE} onReset={reset} /> : null}
      {phase === "failed" ? <Failure title="Attempt stopped" body={detail ?? "The live Devnet attempt did not complete."} onReset={reset} /> : null}
      {phase === "updating" ? <p>Requesting a new Phantom signature for the activated state…</p> : null}
      {phase === "signing" ? <p>Waiting for Phantom…</p> : null}

      <p className="demo-boundary-note">{DEVNET_PUBLIC_DISCLAIMER}</p>
      <details className="live-devnet__technical">
        <summary>Technical details</summary>
        <p>Program {EQUITY_GUARD_DEVNET_PROGRAM_ID}</p>
        <p>Session mint {session?.mint ?? "Not created"}</p>
        <p>Activation {session?.activation.toString() ?? "Not armed"}</p>
        <p>Setup signature {session?.setupSignature ?? "None"}</p>
        <p>Pending wire hash {held?.sha256 ?? "None"}</p>
        <p>Stale signature {staleSignature ?? "None"}</p>
        <p>Updated signature {updatedSignature ?? "None"}</p>
        {detail ? <p>{detail}</p> : null}
      </details>
    </PublicSurface>
  );
}

function Failure({ title, body, onReset }: { title: string; body: string; onReset: () => void }): ReactNode {
  return (
    <div className="live-devnet__result">
      <h3>{title}</h3>
      <p>{body}</p>
      <button type="button" className="button button--secondary focus-ring" onClick={onReset}>Start a new attempt</button>
    </div>
  );
}
