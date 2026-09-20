import { address, createAddressWithSeed, createSolanaRpc, generateKeyPairSigner, lamports, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { DEVNET_RPC_URL, verifyDevnetCluster, verifyEquityGuardDeployment } from "./cluster-gate.ts";
import { DEMO_MINT_AMOUNT, DEMO_MINT_DECIMALS, DEMO_TRANSFER_AMOUNT, buildTransferCheckedInstruction, deriveAta, demoMintSpace, getCreateDemoMintInstructions, getCreateDestinationAtaInstruction, getMintToWalletInstructions, verifyDemoMintAccount, verifyDemoTokenAccountOwners, type DemoAssetSetup } from "./demo-asset.ts";
import { LiveExecutionError, assertSetupTransactionSucceeded, confirmedGuardRejectionResult, confirmedSetupResult, confirmedTransferResult, friendlyLiveError, hasWalletContext, isWalletCancellation, submitAndConfirm, verifyMutationEnvironment, type LiveKind, type LivePhase, type TokenBalances } from "./live-execution.ts";
import { buildSafeGuardedTransfer, buildStaleGuardedTransfer, getMintGuardSnapshot, refreshAndBuildGuardedTransfer } from "./transactions.ts";
import { connectPhantomWallet, detectPhantom, disconnectWallet, type PhantomProvider } from "./wallet.ts";
import { getElement, logActivity, renderResult, setAsset, setBadge, setLiveTechnical, setWallet, setWalletMessage } from "./ui.ts";

interface AppState { provider: PhantomProvider | null; wallet: Address | null; asset: DemoAssetSetup | null; sol: number | null; token: bigint | null; busy: boolean; }
const state: AppState = { provider: null, wallet: null, asset: null, sol: null, token: null, busy: false };
const walletSigner = (wallet: Address): TransactionSigner => ({ address: wallet, signTransactions: async (transactions) => transactions });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function verifyHeader(): Promise<void> {
  try {
    const cluster = await verifyDevnetCluster(DEVNET_RPC_URL);
    setBadge("devnet-badge", cluster.verified ? "Devnet verified" : "Cluster refused", cluster.verified ? "ok" : "bad");
    const deployment = cluster.verified ? await verifyEquityGuardDeployment(DEVNET_RPC_URL) : null;
    setBadge("program-badge", deployment?.verified ? "Program verified" : "Program unverified", deployment?.verified ? "ok" : "bad");
    logActivity(deployment?.verified ? "Reviewed devnet deployment verified" : deployment?.reason ?? cluster.reason ?? "Verification failed");
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
    Object.assign(state, { provider: null, wallet: null, asset: null, sol: null, token: null });
    setWallet(null, null); setAsset(null, null); setWalletMessage("Wallet disconnected."); updateControls(); return;
  }
  try {
    const connection = await connectPhantomWallet();
    state.provider = connection.provider; state.wallet = address(connection.publicKey);
    await refreshBalances(); setWalletMessage("Connected to Phantom on Solana devnet."); logActivity("Phantom connected", connection.publicKey);
  } catch (error) { setWalletMessage(friendlyLiveError("SETUP", error)); logActivity(isWalletCancellation(error) ? "Wallet connection cancelled" : "Wallet connection failed", errorMessage(error)); }
  updateControls();
}

async function refreshBalances(): Promise<void> {
  if (!state.wallet) return;
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  state.sol = Number((await rpc.getBalance(state.wallet, { commitment: "confirmed" }).send()).value) / 1_000_000_000;
  if (state.asset) state.token = (await readTokenBalances(state.asset)).source;
  setWallet(state.wallet, state.sol); setAsset(state.asset?.mintAddress ?? null, state.token);
}

async function requestFaucet(): Promise<void> {
  if (!state.wallet || state.busy) return;
  getElement<HTMLButtonElement>("faucet-btn").disabled = true;
  getElement<HTMLElement>("faucet-status").textContent = "Requesting devnet SOL…";
  try {
    await verifyMutationEnvironment();
    await createSolanaRpc(DEVNET_RPC_URL).requestAirdrop(state.wallet, lamports(1_000_000_000n)).send();
    getElement<HTMLElement>("faucet-status").textContent = "Request sent. Balance may take a moment to update.";
    await new Promise((resolve) => setTimeout(resolve, 2_000)); await refreshBalances();
  } catch (error) {
    getElement<HTMLElement>("faucet-status").textContent = "Devnet faucet is unavailable or rate limited.";
    logActivity("Faucet request failed", errorMessage(error));
  } finally { updateControls(); }
}

function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `eg-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function createAsset(): Promise<void> {
  const context = requireWallet("SETUP", "setup-result"); if (!context) return;
  await withBusy(async () => {
    renderResult("setup-result", { type: "PENDING", kind: "SETUP", phase: "READY" });
    setLiveTechnical("READY");
    const seed = randomSeed();
    const mintAddress = await createAddressWithSeed({ baseAddress: context.wallet, seed, programAddress: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") });
    const recipient = await generateKeyPairSigner();
    const signer = walletSigner(context.wallet); const rpc = createSolanaRpc(DEVNET_RPC_URL);
    const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(demoMintSpace(context.wallet))).send();
    const sourceAta = await deriveAta(context.wallet, mintAddress); const destinationAta = await deriveAta(recipient.address, mintAddress);
    const instructions: Instruction[] = [
      ...getCreateDemoMintInstructions({ payer: signer, mintAddress, seed, rentLamports: rent }),
      ...await getMintToWalletInstructions({ payer: signer, mint: mintAddress, owner: context.wallet, amount: DEMO_MINT_AMOUNT }),
      await getCreateDestinationAtaInstruction({ payer: signer, mint: mintAddress, recipient: recipient.address }),
    ];
    const outcome = await execute("SETUP", "setup-result", instructions, false, context);
    assertSetupTransactionSucceeded(outcome);
    renderResult("setup-result", { type: "PENDING", kind: "SETUP", phase: "VERIFYING_MINT", signature: outcome.signature });
    setLiveTechnical("VERIFYING_MINT", outcome.signature);
    const asset = { mintAddress, sourceAta, destinationAta, recipientAddress: recipient.address } satisfies DemoAssetSetup;
    let balances: TokenBalances;
    try {
      const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
        rpc.getAccountInfo(mintAddress, { commitment: "confirmed", encoding: "base64" }).send(),
        rpc.getAccountInfo(sourceAta, { commitment: "confirmed", encoding: "base64" }).send(),
        rpc.getAccountInfo(destinationAta, { commitment: "confirmed", encoding: "base64" }).send(),
      ]);
      if (!mintAccount.value) throw new Error("Confirmed demo mint account is missing");
      if (!sourceAccount.value) throw new Error("Confirmed source ATA is missing");
      if (!destinationAccount.value) throw new Error("Confirmed destination ATA is missing");
      const mintData = Uint8Array.from(atob(mintAccount.value.data[0] as string), (character) => character.charCodeAt(0));
      verifyDemoMintAccount(mintAccount.value.owner, mintData);
      verifyDemoTokenAccountOwners(sourceAccount.value.owner, destinationAccount.value.owner);
      balances = await readTokenBalances(asset);
    } catch (error) {
      throw new LiveExecutionError("VERIFYING_MINT", errorMessage(error), outcome.signature, outcome.logs, error);
    }
    const result = confirmedSetupResult(outcome, balances, DEMO_MINT_AMOUNT);
    state.asset = asset; state.token = balances.source; setAsset(mintAddress, balances.source);
    setLiveTechnical("SETUP_COMPLETE", outcome.signature);
    renderResult("setup-result", result);
  }, "SETUP", "setup-result");
}

async function runTransfer(kind: "SAFE" | "BLOCK" | "REFRESH", resultId: string): Promise<void> {
  const context = requireWallet(kind, resultId);
  if (!context || !state.asset) { if (context) renderResult(resultId, { type: "FAILED", kind, detail: "Demo asset not found. Create a new demo asset to continue." }); return; }
  await withBusy(async () => {
    const asset = state.asset as DemoAssetSetup; const before = await readTokenBalances(asset);
    const transfer = buildTransferCheckedInstruction({ source: asset.sourceAta, mint: asset.mintAddress, destination: asset.destinationAta, authority: walletSigner(context.wallet), amount: DEMO_TRANSFER_AMOUNT, decimals: DEMO_MINT_DECIMALS });
    let instructions: readonly Instruction[];
    if (kind === "REFRESH") instructions = (await refreshAndBuildGuardedTransfer({ rpcUrl: DEVNET_RPC_URL, feePayer: context.wallet, mint: asset.mintAddress, transferChecked: transfer })).guarded.instructions;
    else {
      const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, asset.mintAddress);
      instructions = (kind === "SAFE" ? buildSafeGuardedTransfer : buildStaleGuardedTransfer)({ feePayer: context.wallet, mint: asset.mintAddress, snapshot, transferChecked: transfer }).instructions;
    }
    renderResult(resultId, { type: "LOCAL_PREVIEW", kind, expected: kind === "BLOCK" ? "REJECT" : "ALLOW" });
    const outcome = await execute(kind, resultId, instructions, kind === "BLOCK", context); const after = await readTokenBalances(asset);
    state.token = after.source; setAsset(asset.mintAddress, after.source);
    if (kind === "BLOCK") {
      renderResult(resultId, confirmedGuardRejectionResult(outcome, before, after));
    } else {
      renderResult(resultId, confirmedTransferResult(kind, outcome, before, after, DEMO_TRANSFER_AMOUNT));
    }
  }, kind, resultId);
}

async function execute(kind: LiveKind, resultId: string, instructions: readonly Instruction[], skipPreflight: boolean, context: { provider: PhantomProvider; wallet: Address }) {
  return submitAndConfirm({ provider: context.provider, feePayer: context.wallet, instructions, skipPreflight, onDiagnostic: (message, raw) => logActivity(message, raw === undefined ? undefined : safeDiagnostic(raw)), onPhase: (phase: LivePhase, signature?: string) => {
    setLiveTechnical(phase, signature);
    logActivity(`${kind} stage: ${phase}`, signature);
    if (phase === "CANCELLED" || phase === "FAILED" || phase === "CONFIRMED" || phase === "SETUP_COMPLETE") return;
    renderResult(resultId, signature === undefined ? { type: "PENDING", kind, phase } : { type: "PENDING", kind, phase, signature });
  } });
}

function safeDiagnostic(value: unknown): string {
  try { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? `${item}n` : item); }
  catch { return String(value); }
}

async function readTokenBalances(asset: DemoAssetSetup): Promise<TokenBalances> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const [source, destination] = await Promise.all([rpc.getTokenAccountBalance(asset.sourceAta, { commitment: "confirmed" }).send(), rpc.getTokenAccountBalance(asset.destinationAta, { commitment: "confirmed" }).send()]);
  return { source: BigInt(source.value.amount), destination: BigInt(destination.value.amount) };
}

function requireWallet(kind: LiveKind, resultId: string): { provider: PhantomProvider; wallet: Address } | null {
  if (!hasWalletContext(state.provider, state.wallet)) { renderResult(resultId, { type: "FAILED", kind, detail: "Connect Phantom before submitting a transaction." }); return null; }
  return { provider: state.provider as PhantomProvider, wallet: state.wallet as Address };
}

async function withBusy(action: () => Promise<void>, kind: LiveKind, resultId: string): Promise<void> {
  if (state.busy) return; state.busy = true; updateControls();
  try { await action(); }
  catch (error) {
    const raw = errorMessage(error); const detail = friendlyLiveError(kind, error);
    const signature = error instanceof LiveExecutionError ? error.signature : undefined;
    if (error instanceof LiveExecutionError) {
      setLiveTechnical(error.stage, signature, error.raw ?? raw);
      for (const line of error.logs) logActivity("Transaction log", line);
    }
    renderResult(resultId, isWalletCancellation(error) ? { type: "CANCELLED", kind, detail } : { type: "FAILED", kind, detail, ...(signature ? { signature } : {}) });
    logActivity(`${kind} flow failed`, raw);
  }
  finally { state.busy = false; updateControls(); }
}

function updateControls(): void {
  const connected = state.wallet !== null;
  getElement<HTMLButtonElement>("faucet-btn").disabled = !connected || state.busy;
  getElement<HTMLButtonElement>("create-asset-btn").disabled = !connected || state.busy || state.asset !== null;
  for (const id of ["safe-btn", "block-btn", "refresh-btn"]) getElement<HTMLButtonElement>(id).disabled = !connected || state.busy || state.asset === null;
  getElement<HTMLButtonElement>("connect-btn").disabled = state.busy;
}

export async function initApp(): Promise<void> {
  getElement<HTMLButtonElement>("connect-btn").addEventListener("click", () => void toggleWallet());
  getElement<HTMLButtonElement>("faucet-btn").addEventListener("click", () => void requestFaucet());
  getElement<HTMLButtonElement>("create-asset-btn").addEventListener("click", () => void createAsset());
  getElement<HTMLButtonElement>("safe-btn").addEventListener("click", () => void runTransfer("SAFE", "safe-result"));
  getElement<HTMLButtonElement>("block-btn").addEventListener("click", () => void runTransfer("BLOCK", "block-result"));
  getElement<HTMLButtonElement>("refresh-btn").addEventListener("click", () => void runTransfer("REFRESH", "refresh-result"));
  setWallet(null, null); setAsset(null, null); updateControls();
  const phantomDetected = detectPhantom() !== null;
  setWalletMessage(phantomDetected ? "Phantom detected. Connect to begin." : "Phantom was not detected. Open this page in a browser profile where Phantom is installed.");
  logActivity(phantomDetected ? "Phantom extension detected" : "Phantom extension not detected"); await verifyHeader();
}

if (typeof window !== "undefined") window.addEventListener("DOMContentLoaded", () => void initApp());
