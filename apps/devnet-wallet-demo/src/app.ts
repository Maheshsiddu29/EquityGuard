import { address, createAddressWithSeed, createSolanaRpc, generateKeyPairSigner, lamports, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { ActivationPhase } from "@equityguard/guard-client";
import { DEVNET_RPC_URL, verifyDevnetCluster } from "./cluster-gate.ts";
import { DEMO_MINT_AMOUNT, DEMO_MINT_DECIMALS, DEMO_TRANSFER_AMOUNT, buildTransferCheckedInstruction, deriveAta, demoMintSpace, getPrepareSessionInstructions, verifyDemoTokenAccountOwners, verifyScheduledDemoMint, type DemoAssetSetup } from "./demo-asset.ts";
import { LiveExecutionError, StaleAuthorizationExpired, assertSetupTransactionSucceeded, confirmedActivationRejection, confirmedSetupResult, confirmedUpdatedExecution, friendlyLiveError, hasWalletContext, isWalletCancellation, readReviewedDeployment, signPendingProtectedTransfer, submitAndConfirm, submitHeldAuthorization, verifyMutationEnvironment, type HeldSignedTransaction, type LiveKind, type LivePhase, type LiveResult, type TokenBalances } from "./live-execution.ts";
import { formatMultiplier, randomScenario, scenarioById, scenarioForAttempt, startAttempt, type ActiveAttempt, type EquityScenario } from "./scenarios.ts";
import { activationTimestamp, activatedReviewDecision, chainReadyForStaleSubmit, getMintGuardSnapshot, heldWaitDecision, pendingSignDecision, readChainClock, buildClockCrossingTransfer } from "./transactions.ts";
import { connectPhantomWallet, detectPhantom, disconnectWallet, type PhantomProvider } from "./wallet.ts";
import { getElement, installCorporateActionDemo, logActivity, renderResult, renderScenarioPreview, setAsset, setBadge, setLiveTechnical, setWallet, setWalletMessage, showNewAttempt, showUpdatedReview } from "./ui.ts";

interface Session {
  readonly attempt: ActiveAttempt;
  readonly asset: DemoAssetSetup;
  readonly activation: bigint;
  held: HeldSignedTransaction | null;
  staleAccepted: boolean;
  updated: boolean;
}

interface AppState {
  provider: PhantomProvider | null;
  wallet: Address | null;
  session: Session | null;
  sol: number | null;
  token: bigint | null;
  busy: boolean;
}

const state: AppState = { provider: null, wallet: null, session: null, sol: null, token: null, busy: false };
const walletSigner = (wallet: Address): TransactionSigner => ({ address: wallet, signTransactions: async (transactions) => transactions });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_000));

function isPendingPhase(phase: LivePhase): phase is Extract<LiveResult, { type: "PENDING" }>["phase"] {
  return phase !== "CONFIRMED" && phase !== "SETUP_COMPLETE" && phase !== "CANCELLED" && phase !== "FAILED";
}

async function verifyHeader(): Promise<void> {
  try {
    const cluster = await verifyDevnetCluster(DEVNET_RPC_URL);
    setBadge("devnet-badge", cluster.verified ? "Devnet verified" : "Cluster refused", cluster.verified ? "ok" : "bad");
    const deployment = cluster.verified ? await readReviewedDeployment() : null;
    setBadge("program-badge", deployment?.verified ? "Program verified" : "Program unverified", deployment?.verified ? "ok" : "bad");
    logActivity(deployment?.verified
      ? `Reviewed devnet deployment verified. Upgrade authority ${deployment.upgradeAuthority ?? "none"} (${deployment.mutability})`
      : deployment?.reason ?? cluster.reason ?? "Verification failed");
  } catch (error) {
    setBadge("devnet-badge", "Verification unavailable", "bad");
    setBadge("program-badge", "Program unverified", "bad");
    logActivity("Environment verification failed", errorMessage(error));
  }
}

async function toggleWallet(): Promise<void> {
  if (state.busy) return;
  if (state.provider && state.wallet) {
    await disconnectWallet(state.provider);
    state.provider = null;
    state.wallet = null;
    state.session = null;
    state.sol = null;
    state.token = null;
    setWallet(null, null);
    setAsset(null, null);
    setWalletMessage("Wallet disconnected.");
    updateControls();
    return;
  }
  try {
    const connection = await connectPhantomWallet();
    state.provider = connection.provider;
    state.wallet = address(connection.publicKey);
    await refreshBalances();
    setWalletMessage("Connected to Phantom on Solana devnet.");
    logActivity("Phantom connected", connection.publicKey);
  } catch (error) {
    setWalletMessage(friendlyLiveError("SETUP", error));
    logActivity(isWalletCancellation(error) ? "Wallet connection cancelled" : "Wallet connection failed", errorMessage(error));
  }
  updateControls();
}

async function refreshBalances(): Promise<void> {
  if (!state.wallet) return;
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  state.sol = Number((await rpc.getBalance(state.wallet, { commitment: "confirmed" }).send()).value) / 1_000_000_000;
  if (state.session) state.token = (await readTokenBalances(state.session.asset)).source;
  setWallet(state.wallet, state.sol);
  setAsset(state.session?.asset.mintAddress ?? null, state.token);
}

async function requestFaucet(): Promise<void> {
  if (!state.wallet || state.busy) return;
  getElement<HTMLButtonElement>("faucet-btn").disabled = true;
  getElement<HTMLElement>("faucet-status").textContent = "Requesting devnet SOL…";
  try {
    await verifyMutationEnvironment();
    await createSolanaRpc(DEVNET_RPC_URL).requestAirdrop(state.wallet, lamports(1_000_000_000n)).send();
    getElement<HTMLElement>("faucet-status").textContent = "Request sent. Balance may take a moment to update.";
    await pause();
    await pause();
    await refreshBalances();
  } catch (error) {
    getElement<HTMLElement>("faucet-status").textContent = "Devnet faucet is unavailable or rate limited.";
    logActivity("Faucet request failed", errorMessage(error));
  } finally { updateControls(); }
}

function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `eg-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function selectedScenario(): EquityScenario {
  return scenarioById(getElement<HTMLSelectElement>("scenario-select").value);
}

function preview(scenario: EquityScenario, chainClock?: bigint, activation?: bigint): void {
  renderScenarioPreview({
    symbol: scenario.symbol,
    displayName: scenario.displayName,
    eventLabel: scenario.eventLabel,
    currentMultiplier: formatMultiplier(scenario.initialMultiplier),
    scheduledMultiplier: formatMultiplier(scenario.newMultiplier),
    ...(activation !== undefined ? { activation: activation.toString() } : {}),
    ...(chainClock !== undefined ? { chainClock: chainClock.toString() } : {}),
  });
}

async function prepareDemo(): Promise<void> {
  const context = requireWallet("SETUP", "prepare-result");
  if (!context || state.session) return;
  const scenario = selectedScenario();
  const attempt = startAttempt(scenario);
  getElement<HTMLSelectElement>("scenario-select").disabled = true;
  await withBusy(async () => {
    renderResult("prepare-result", { type: "PENDING", kind: "SETUP", phase: "READY" });
    const clock = await readChainClock();
    const activation = activationTimestamp(clock.unixTimestamp);
    const seed = randomSeed();
    const mintAddress = await createAddressWithSeed({
      baseAddress: context.wallet,
      seed,
      programAddress: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    });
    const recipient = await generateKeyPairSigner();
    const signer = walletSigner(context.wallet);
    const rpc = createSolanaRpc(DEVNET_RPC_URL);
    const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(demoMintSpace(context.wallet))).send();
    const sourceAta = await deriveAta(context.wallet, mintAddress);
    const destinationAta = await deriveAta(recipient.address, mintAddress);
    const instructions = await getPrepareSessionInstructions({
      payer: signer,
      mintAddress,
      seed,
      rentLamports: rent,
      recipient: recipient.address,
      scenario: attempt.scenario,
      effectiveTimestamp: activation,
      chainUnixTimestamp: clock.unixTimestamp,
    });
    const outcome = await execute("SETUP", "prepare-result", instructions, false, context);
    assertSetupTransactionSucceeded(outcome);
    renderResult("prepare-result", { type: "PENDING", kind: "SETUP", phase: "VERIFYING_MINT", signature: outcome.signature });
    const asset = { mintAddress, sourceAta, destinationAta, recipientAddress: recipient.address } satisfies DemoAssetSetup;
    let balances: TokenBalances;
    try {
      const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
        rpc.getAccountInfo(mintAddress, { commitment: "confirmed", encoding: "base64" }).send(),
        rpc.getAccountInfo(sourceAta, { commitment: "confirmed", encoding: "base64" }).send(),
        rpc.getAccountInfo(destinationAta, { commitment: "confirmed", encoding: "base64" }).send(),
      ]);
      if (!mintAccount.value || !sourceAccount.value || !destinationAccount.value) throw new Error("Confirmed demo mint account is missing");
      const mintData = Uint8Array.from(atob(mintAccount.value.data[0] as string), (character) => character.charCodeAt(0));
      verifyScheduledDemoMint(mintAccount.value.owner, mintData, attempt.scenario, activation);
      verifyDemoTokenAccountOwners(sourceAccount.value.owner, destinationAccount.value.owner);
      balances = await readTokenBalances(asset);
    } catch (error) {
      throw new Error(`${errorMessage(error)} Start a new attempt.`);
    }
    const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, mintAddress);
    const decision = pendingSignDecision(snapshot, attempt.scenario, activation);
    if (decision === "mismatch" || decision === "missed") {
      throw new Error("The corporate action was already active when the demo was prepared. Start a new attempt. No protected-action signature was requested.");
    }
    state.session = { attempt, asset, activation, held: null, staleAccepted: false, updated: false };
    state.token = balances.source;
    setAsset(mintAddress, balances.source);
    preview(attempt.scenario, snapshot.clock.unixTimestamp, activation);
    renderResult("prepare-result", confirmedSetupResult(outcome, balances, DEMO_MINT_AMOUNT));
    logActivity("Session mint armed", `${attempt.scenario.symbol} T=${activation}`);
  }, "SETUP", "prepare-result");
  if (!state.session) getElement<HTMLSelectElement>("scenario-select").disabled = false;
}

async function authorizeProtectedAction(): Promise<void> {
  const context = requireWallet("STALE", "authorize-result");
  if (!context) return;
  if (!state.session) {
    renderResult("authorize-result", { type: "FAILED", kind: "STALE", detail: "Demo asset not found. Create a new demo asset to continue." });
    return;
  }
  const session = state.session;
  await withBusy(async () => {
    const scenario = scenarioForAttempt(session.attempt, getElement<HTMLSelectElement>("scenario-select").value);
    const signable = await waitForPendingSign(session, scenario);
    preview(scenario, signable.clock.unixTimestamp, session.activation);
    const before = await readTokenBalances(session.asset);
    const transfer = transferInstruction(session, context.wallet);
    const held = await signPendingProtectedTransfer({
      provider: context.provider,
      feePayer: context.wallet,
      mint: session.asset.mintAddress,
      scenario,
      activationTimestamp: session.activation,
      transferChecked: transfer,
      readSnapshot: () => getMintGuardSnapshot(DEVNET_RPC_URL, session.asset.mintAddress),
      onDiagnostic: (message, raw) => logActivity(message, raw === undefined ? undefined : safeDiagnostic(raw)),
      onPhase: (phase, signature) => {
        setLiveTechnical(phase, signature);
        if (!isPendingPhase(phase)) return;
        renderResult("authorize-result", signature === undefined ? { type: "PENDING", kind: "STALE", phase } : { type: "PENDING", kind: "STALE", phase, signature });
      },
    });
    session.held = held;
    renderResult("authorize-result", { type: "PENDING", kind: "STALE", phase: "HOLDING", signature: held.signature });
    try {
      await waitForActivation(session, held);
      const outcome = await submitHeldAuthorization({
        held,
        onDiagnostic: (message, raw) => logActivity(message, raw === undefined ? undefined : safeDiagnostic(raw)),
        onPhase: (phase, signature) => {
          setLiveTechnical(phase, signature);
          if (!isPendingPhase(phase)) return;
          renderResult("authorize-result", { type: "PENDING", kind: "STALE", phase, signature: signature ?? held.signature });
        },
      });
      const after = await readTokenBalances(session.asset);
      state.token = after.source;
      setAsset(session.asset.mintAddress, after.source);
      const result = confirmedActivationRejection({
        outcome,
        before,
        after,
        symbol: scenario.symbol,
        eventLabel: scenario.eventLabel,
        authorizedMultiplier: formatMultiplier(scenario.initialMultiplier),
        currentMultiplier: formatMultiplier(scenario.newMultiplier),
      });
      session.staleAccepted = true;
      renderResult("authorize-result", result);
      showUpdatedReview({
        symbol: scenario.symbol,
        eventLabel: scenario.eventLabel,
        previousMultiplier: formatMultiplier(scenario.initialMultiplier),
        currentMultiplier: formatMultiplier(scenario.newMultiplier),
      });
    } catch (error) {
      if (error instanceof StaleAuthorizationExpired) {
        renderResult("authorize-result", { type: "STALE_AUTHORIZATION_EXPIRED" });
        showNewAttempt();
        logActivity("STALE_AUTHORIZATION_EXPIRED");
        return;
      }
      throw error;
    }
  }, "STALE", "authorize-result");
}

async function confirmUpdatedAction(): Promise<void> {
  const context = requireWallet("UPDATED", "updated-result");
  if (!context || !state.session?.staleAccepted || state.session.updated) return;
  const session = state.session;
  await withBusy(async () => {
    const scenario = scenarioForAttempt(session.attempt, session.attempt.scenario.id);
    const snapshot = await waitForActivatedReview(session, scenario);
    const before = await readTokenBalances(session.asset);
    const transfer = transferInstruction(session, context.wallet);
    const built = buildClockCrossingTransfer({
      snapshot,
      scenario,
      activationTimestamp: session.activation,
      requiredPhase: ActivationPhase.Activated,
      feePayer: context.wallet,
      mint: session.asset.mintAddress,
      transferChecked: transfer,
    });
    const outcome = await execute("UPDATED", "updated-result", built.guarded.instructions, false, context, async () => {
      const latest = await getMintGuardSnapshot(DEVNET_RPC_URL, session.asset.mintAddress);
      if (activatedReviewDecision(latest, scenario, session.activation) !== "ready") {
        throw new Error("Chain state changed before the updated authorization. No signature was requested.");
      }
    });
    const after = await readTokenBalances(session.asset);
    state.token = after.source;
    setAsset(session.asset.mintAddress, after.source);
    const result = confirmedUpdatedExecution({
      outcome,
      before,
      after,
      amount: DEMO_TRANSFER_AMOUNT,
      symbol: scenario.symbol,
      eventLabel: scenario.eventLabel,
    });
    session.updated = true;
    renderResult("updated-result", result);
    showNewAttempt();
  }, "UPDATED", "updated-result");
}

async function waitForPendingSign(session: Session, scenario: EquityScenario) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, session.asset.mintAddress);
    preview(scenario, snapshot.clock.unixTimestamp, session.activation);
    const decision = pendingSignDecision(snapshot, scenario, session.activation);
    if (decision === "sign") return snapshot;
    if (decision === "wait") {
      renderResult("authorize-result", { type: "PENDING", kind: "STALE", phase: "WAITING_FOR_CLOCK" });
      await pause();
      continue;
    }
    throw new Error(decision === "missed"
      ? "The corporate action activated before authorization. No signature was requested."
      : "The session mint does not match the selected scenario. No signature was requested.");
  }
  throw new Error("Timed out waiting for the Devnet clock. No signature was requested.");
}

async function waitForActivation(session: Session, held: HeldSignedTransaction): Promise<void> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, session.asset.mintAddress);
    const height = await rpc.getBlockHeight({ commitment: "processed" }).send();
    const decision = heldWaitDecision({
      blockHeight: height,
      lastValidBlockHeight: held.lastValidBlockHeight,
      ready: chainReadyForStaleSubmit(snapshot, held.expectation),
    });
    if (decision === "expired") throw new StaleAuthorizationExpired();
    if (decision === "submit") return;
    renderResult("authorize-result", { type: "PENDING", kind: "STALE", phase: "WAITING_FOR_CLOCK", signature: held.signature });
    await pause();
  }
  throw new Error("Timed out waiting for the Devnet clock.");
}

async function waitForActivatedReview(session: Session, scenario: EquityScenario) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, session.asset.mintAddress);
    const decision = activatedReviewDecision(snapshot, scenario, session.activation);
    if (decision === "ready") return snapshot;
    if (decision === "mismatch") throw new Error("Updated state could not be verified. No signature was requested.");
    renderResult("updated-result", { type: "PENDING", kind: "UPDATED", phase: "WAITING_FOR_CLOCK" });
    await pause();
  }
  throw new Error("Timed out waiting for the Devnet clock. No signature was requested.");
}

function transferInstruction(session: Session, wallet: Address): Instruction {
  return buildTransferCheckedInstruction({
    source: session.asset.sourceAta,
    mint: session.asset.mintAddress,
    destination: session.asset.destinationAta,
    authority: walletSigner(wallet),
    amount: DEMO_TRANSFER_AMOUNT,
    decimals: DEMO_MINT_DECIMALS,
  });
}

async function execute(
  kind: LiveKind,
  resultId: string,
  instructions: readonly Instruction[],
  skipPreflight: boolean,
  context: { provider: PhantomProvider; wallet: Address },
  beforeSign?: () => Promise<void>,
) {
  return submitAndConfirm({
    provider: context.provider,
    feePayer: context.wallet,
    instructions,
    skipPreflight,
    ...(beforeSign ? { beforeSign } : {}),
    onDiagnostic: (message, raw) => logActivity(message, raw === undefined ? undefined : safeDiagnostic(raw)),
    onPhase: (phase: LivePhase, signature?: string) => {
      setLiveTechnical(phase, signature);
      logActivity(`${kind} stage: ${phase}`, signature);
      if (!isPendingPhase(phase)) return;
      renderResult(resultId, signature === undefined ? { type: "PENDING", kind, phase } : { type: "PENDING", kind, phase, signature });
    },
  });
}

function safeDiagnostic(value: unknown): string {
  try { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? `${item}n` : item); }
  catch { return String(value); }
}

async function readTokenBalances(asset: DemoAssetSetup): Promise<TokenBalances> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const [source, destination] = await Promise.all([
    rpc.getTokenAccountBalance(asset.sourceAta, { commitment: "confirmed" }).send(),
    rpc.getTokenAccountBalance(asset.destinationAta, { commitment: "confirmed" }).send(),
  ]);
  return { source: BigInt(source.value.amount), destination: BigInt(destination.value.amount) };
}

function requireWallet(kind: LiveKind, resultId: string): { provider: PhantomProvider; wallet: Address } | null {
  if (!hasWalletContext(state.provider, state.wallet)) {
    renderResult(resultId, { type: "FAILED", kind, detail: "Connect Phantom before submitting a transaction." });
    return null;
  }
  return { provider: state.provider as PhantomProvider, wallet: state.wallet as Address };
}

async function withBusy(action: () => Promise<void>, kind: LiveKind, resultId: string): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try { await action(); }
  catch (error) {
    const raw = errorMessage(error);
    const detail = friendlyLiveError(kind, error);
    const signature = error instanceof LiveExecutionError ? error.signature : undefined;
    if (error instanceof LiveExecutionError) {
      setLiveTechnical(error.stage, signature, error.raw ?? raw);
      for (const line of error.logs) logActivity("Transaction log", line);
    }
    renderResult(resultId, isWalletCancellation(error) ? { type: "CANCELLED", kind, detail } : { type: "FAILED", kind, detail, ...(signature ? { signature } : {}) });
    if (!(error instanceof StaleAuthorizationExpired)) showNewAttempt();
    logActivity(`${kind} flow failed`, raw);
  }
  finally { state.busy = false; updateControls(); }
}

function resetAttempt(): void {
  if (state.busy) return;
  state.session = null;
  state.token = null;
  setAsset(null, null);
  for (const id of ["prepare-result", "authorize-result", "updated-result", "review-panel"]) getElement<HTMLElement>(id).replaceChildren();
  getElement<HTMLElement>("review-panel").hidden = true;
  getElement<HTMLButtonElement>("confirm-updated-btn").hidden = true;
  getElement<HTMLButtonElement>("attempt-reset-btn").hidden = true;
  getElement<HTMLSelectElement>("scenario-select").disabled = false;
  preview(selectedScenario());
  updateControls();
}

function updateControls(): void {
  const connected = state.wallet !== null;
  const locked = state.session !== null;
  getElement<HTMLButtonElement>("faucet-btn").disabled = !connected || state.busy;
  getElement<HTMLButtonElement>("prepare-btn").disabled = !connected || state.busy || locked;
  getElement<HTMLButtonElement>("authorize-btn").disabled = !connected || state.busy || !state.session || state.session.held !== null;
  getElement<HTMLButtonElement>("confirm-updated-btn").disabled = !connected || state.busy || !state.session?.staleAccepted || state.session.updated;
  getElement<HTMLButtonElement>("random-scenario-btn").disabled = state.busy || locked;
  getElement<HTMLSelectElement>("scenario-select").disabled = state.busy || locked;
  getElement<HTMLButtonElement>("connect-btn").disabled = state.busy;
  getElement<HTMLButtonElement>("attempt-reset-btn").disabled = state.busy;
}

export async function initApp(): Promise<void> {
  installCorporateActionDemo();
  getElement<HTMLButtonElement>("connect-btn").addEventListener("click", () => void toggleWallet());
  getElement<HTMLButtonElement>("faucet-btn").addEventListener("click", () => void requestFaucet());
  getElement<HTMLSelectElement>("scenario-select").addEventListener("change", () => {
    if (state.session || state.busy) return;
    preview(selectedScenario());
  });
  getElement<HTMLButtonElement>("random-scenario-btn").addEventListener("click", () => {
    if (state.session || state.busy) return;
    const scenario = randomScenario();
    getElement<HTMLSelectElement>("scenario-select").value = scenario.id;
    preview(scenario);
  });
  getElement<HTMLButtonElement>("prepare-btn").addEventListener("click", () => void prepareDemo());
  getElement<HTMLButtonElement>("authorize-btn").addEventListener("click", () => void authorizeProtectedAction());
  getElement<HTMLButtonElement>("confirm-updated-btn").addEventListener("click", () => void confirmUpdatedAction());
  getElement<HTMLButtonElement>("attempt-reset-btn").addEventListener("click", () => resetAttempt());
  preview(selectedScenario());
  setWallet(null, null);
  setAsset(null, null);
  updateControls();
  const phantomDetected = detectPhantom() !== null;
  setWalletMessage(phantomDetected ? "Phantom detected. Connect to begin." : "Phantom was not detected. Open this page in a browser profile where Phantom is installed.");
  logActivity(phantomDetected ? "Phantom extension detected" : "Phantom extension not detected");
  await verifyHeader();
}

if (typeof window !== "undefined") window.addEventListener("DOMContentLoaded", () => void initApp());
