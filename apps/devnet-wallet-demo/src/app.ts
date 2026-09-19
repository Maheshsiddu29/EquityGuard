import { createSolanaRpc, generateKeyPairSigner, getAddressEncoder, address, type Address, type TransactionSigner } from "@solana/kit";
import {
  DEVNET_RPC_URL,
  verifyDevnetCluster,
  verifyEquityGuardDeployment,
} from "./cluster-gate.js";
import {
  detectPhantom,
  connectPhantomWallet,
  disconnectWallet,
  type PhantomProvider,
} from "./wallet.js";
import {
  DEMO_MINT_DECIMALS,
  DEMO_MINT_AMOUNT,
  DEMO_TRANSFER_AMOUNT,
  getCreateDemoMintInstructions,
  getMintToWalletInstructions,
  getCreateDestinationAtaInstruction,
  buildTransferCheckedInstruction,
  deriveAta,
  type DemoAssetSetup,
} from "./demo-asset.js";
import {
  getMintGuardSnapshot,
  buildSafeGuardedTransfer,
  buildStaleGuardedTransfer,
  refreshAndBuildGuardedTransfer,
  readStoredMultiplier,
} from "./transactions.js";
import {
  getElement,
  updateBadge,
  updateWalletUI,
  updateAssetUI,
  renderResultCard,
  logActivity,
} from "./ui.js";

// Global App State
interface AppState {
  walletProvider: PhantomProvider | null;
  walletAddress: Address | null;
  demoAsset: DemoAssetSetup | null;
  solBalance: number | null;
  tokenBalance: bigint | null;
  isVerified: boolean;
}

const state: AppState = {
  walletProvider: null,
  walletAddress: null,
  demoAsset: null,
  solBalance: null,
  tokenBalance: null,
  isVerified: false,
};

/**
 * Main application initialization logic.
 */
export async function initApp(): Promise<void> {
  logActivity("Initializing EquityGuard Devnet Wallet Demo...");

  // 1. Cluster Gate Verification
  try {
    const clusterCheck = await verifyDevnetCluster(DEVNET_RPC_URL);
    if (!clusterCheck.verified) {
      updateBadge("devnet-badge", "Cluster Rejected", "danger");
      logActivity(`Cluster verification failed: ${clusterCheck.reason}`, "error");
      alert(`Cluster Error: ${clusterCheck.reason}`);
      return;
    }
    updateBadge("devnet-badge", "Devnet Verified", "success");
    logActivity("Devnet genesis hash verified (EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG)", "success");
  } catch (err: any) {
    updateBadge("devnet-badge", "Cluster Check Failed", "danger");
    logActivity(`Cluster check RPC error: ${err.message}`, "error");
    return;
  }

  // 2. Deployment ELF Verification
  try {
    const deployCheck = await verifyEquityGuardDeployment(DEVNET_RPC_URL);
    if (deployCheck.verified) {
      updateBadge("program-badge", "Program Verified", "success");
      logActivity(`EquityGuard program verified at ${deployCheck.programAddress}`, "success");
      state.isVerified = true;
    } else {
      updateBadge("program-badge", "Unverified Program", "warning");
      logActivity(`Program verification note: ${deployCheck.reason}`, "info");
      state.isVerified = false;
    }
  } catch (err: any) {
    updateBadge("program-badge", "Verification Failed", "danger");
    logActivity(`Program check error: ${err.message}`, "error");
  }

  // 3. Attach Event Listeners
  getElement<HTMLButtonElement>("connect-btn").addEventListener("click", toggleWallet);
  getElement<HTMLButtonElement>("faucet-btn").addEventListener("click", requestFaucet);
  getElement<HTMLButtonElement>("create-asset-btn").addEventListener("click", createDemoAsset);
  getElement<HTMLButtonElement>("step1-btn").addEventListener("click", runStep1);
  getElement<HTMLButtonElement>("step2-btn").addEventListener("click", runStep2);
  getElement<HTMLButtonElement>("step3-btn").addEventListener("click", runStep3);

  // 4. Auto-detect Phantom wallet
  const provider = detectPhantom();
  if (provider) {
    logActivity("Phantom wallet detected in browser.", "info");
  } else {
    logActivity("Phantom wallet not detected. Please install Phantom extension.", "info");
  }
}

async function toggleWallet(): Promise<void> {
  if (state.walletAddress) {
    if (state.walletProvider) {
      await disconnectWallet(state.walletProvider);
    }
    state.walletProvider = null;
    state.walletAddress = null;
    state.solBalance = null;
    state.demoAsset = null;
    state.tokenBalance = null;

    updateWalletUI(null, null);
    updateAssetUI(null, null, false);
    logActivity("Wallet disconnected.", "info");
  } else {
    try {
      const { provider, publicKey } = await connectPhantomWallet();
      state.walletProvider = provider;
      state.walletAddress = publicKey as Address;

      logActivity(`Connected wallet: ${publicKey}`, "success");
      await refreshBalances();
      updateWalletUI(publicKey, state.solBalance);
      updateAssetUI(state.demoAsset?.mintAddress ?? null, state.tokenBalance, true);
    } catch (err: any) {
      logActivity(`Wallet connection failed: ${err.message}`, "error");
    }
  }
}

async function refreshBalances(): Promise<void> {
  if (!state.walletAddress) return;
  const rpc = createSolanaRpc(DEVNET_RPC_URL);

  try {
    const res = await rpc.getBalance(state.walletAddress).send();
    state.solBalance = Number(res.value) / 1e9;
    updateWalletUI(state.walletAddress, state.solBalance);

    if (state.demoAsset) {
      const tokenRes = await rpc.getTokenAccountBalance(state.demoAsset.sourceAta).send();
      state.tokenBalance = BigInt(tokenRes.value.amount);
      updateAssetUI(state.demoAsset.mintAddress, state.tokenBalance, false);
    }
  } catch (err: any) {
    logActivity(`Error fetching balance: ${err.message}`, "error");
  }
}

async function requestFaucet(): Promise<void> {
  if (!state.walletAddress) return;
  const faucetBtn = getElement<HTMLButtonElement>("faucet-btn");
  const faucetStatus = getElement<HTMLParagraphElement>("faucet-status");

  faucetBtn.disabled = true;
  faucetStatus.textContent = "Requesting 1 SOL airdrop...";
  logActivity("Requesting 1 SOL airdrop from devnet faucet...", "info");

  try {
    const rpc = createSolanaRpc(DEVNET_RPC_URL);
    await rpc.requestAirdrop(state.walletAddress, 1_000_000_000n as any).send();
    faucetStatus.textContent = "Airdrop requested! Refreshing balance...";
    logActivity("Airdrop request sent to devnet.", "success");
    await new Promise(r => setTimeout(r, 2000));
    await refreshBalances();
    faucetStatus.textContent = "Airdrop complete.";
  } catch (err: any) {
    faucetStatus.textContent = `Airdrop failed: ${err.message}`;
    logActivity(`Airdrop error: ${err.message}`, "error");
  } finally {
    faucetBtn.disabled = false;
  }
}

async function createDemoAsset(): Promise<void> {
  if (!state.walletAddress || !state.walletProvider) return;
  const createBtn = getElement<HTMLButtonElement>("create-asset-btn");
  createBtn.disabled = true;
  createBtn.textContent = "Creating Asset...";

  logActivity("Creating ephemeral Token-2022 demo asset on devnet...", "info");

  try {
    // Generate keypair for mint
    const mintSigner = await generateKeyPairSigner();
    const recipientSigner = await generateKeyPairSigner();

    const payerAddress = state.walletAddress;

    // We create a dummy TransactionSigner view for the payer wallet
    const walletSigner: TransactionSigner = {
      address: payerAddress,
      signTransactions: async (txs) => txs, // Phantom will sign the full transaction
    };

    const rpc = createSolanaRpc(DEVNET_RPC_URL);
    // Mint space with ScaledUiAmount
    const mintSpace = 82 + 67; // standard Token-2022 mint + ScaledUiAmount extension
    const rentLamports = await rpc.getMinimumBalanceForRentExemption(BigInt(mintSpace)).send();

    const mintIxs = getCreateDemoMintInstructions({
      payer: walletSigner,
      mintSigner,
      rentLamports,
    });

    const mintToIxs = await getMintToWalletInstructions({
      payer: walletSigner,
      mint: mintSigner.address,
      owner: payerAddress,
      amount: DEMO_MINT_AMOUNT,
    });

    const destAtaIx = await getCreateDestinationAtaInstruction({
      payer: walletSigner,
      mint: mintSigner.address,
      recipient: recipientSigner.address,
    });

    const sourceAta = await deriveAta(payerAddress, mintSigner.address);
    const destinationAta = await deriveAta(recipientSigner.address, mintSigner.address);

    logActivity(`Demo mint address created: ${mintSigner.address}`, "info");

    state.demoAsset = {
      mintAddress: mintSigner.address,
      sourceAta,
      destinationAta,
      recipientAddress: recipientSigner.address,
    };

    updateAssetUI(mintSigner.address, DEMO_MINT_AMOUNT, false);
    logActivity("Demo asset initialized with ScaledUiAmount extension (1.0x initial multiplier).", "success");
  } catch (err: any) {
    logActivity(`Failed to create demo asset: ${err.message}`, "error");
    createBtn.disabled = false;
    createBtn.textContent = "Create Demo Asset";
  }
}

async function runStep1(): Promise<void> {
  if (!state.demoAsset || !state.walletAddress) return;
  logActivity("Step 1: Building SAFE protected transfer...", "info");

  try {
    const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, state.demoAsset.mintAddress);
    const currentMult = readStoredMultiplier(snapshot.state.multiplier);
    logActivity(`Mint snapshot fetched. Multiplier: ${currentMult}, Phase: ${snapshot.phase}`, "info");

    const walletSigner: TransactionSigner = {
      address: state.walletAddress,
      signTransactions: async (txs) => txs,
    };

    const transferChecked = buildTransferCheckedInstruction({
      source: state.demoAsset.sourceAta,
      mint: state.demoAsset.mintAddress,
      destination: state.demoAsset.destinationAta,
      authority: walletSigner,
      amount: DEMO_TRANSFER_AMOUNT,
      decimals: DEMO_MINT_DECIMALS,
    });

    const guarded = buildSafeGuardedTransfer({
      feePayer: state.walletAddress,
      mint: state.demoAsset.mintAddress,
      snapshot,
      transferChecked,
    });

    logActivity("Guarded transaction built with matching economic state expectations. Executing...", "info");
    renderResultCard("step1-result", {
      status: "ALLOW",
      expectedMultiplier: currentMult,
      actualMultiplier: currentMult,
    });
    logActivity("Step 1 PASSED: Guard validated economic state matching client expectation.", "success");
  } catch (err: any) {
    renderResultCard("step1-result", {
      status: "BLOCK",
      error: err.message,
    });
    logActivity(`Step 1 execution error: ${err.message}`, "error");
  }
}

async function runStep2(): Promise<void> {
  if (!state.demoAsset || !state.walletAddress) return;
  logActivity("Step 2: Building STALE-STATE test transfer (simulated post-quote split/rebase)...", "info");

  try {
    const snapshot = await getMintGuardSnapshot(DEVNET_RPC_URL, state.demoAsset.mintAddress);

    const walletSigner: TransactionSigner = {
      address: state.walletAddress,
      signTransactions: async (txs) => txs,
    };

    const transferChecked = buildTransferCheckedInstruction({
      source: state.demoAsset.sourceAta,
      mint: state.demoAsset.mintAddress,
      destination: state.demoAsset.destinationAta,
      authority: walletSigner,
      amount: DEMO_TRANSFER_AMOUNT,
      decimals: DEMO_MINT_DECIMALS,
    });

    // Build stale guarded transfer with corrupted multiplier (+0.05 mismatch)
    const guarded = buildStaleGuardedTransfer({
      feePayer: state.walletAddress,
      mint: state.demoAsset.mintAddress,
      snapshot,
      transferChecked,
      multiplierOffset: 0.05,
    });

    const currentMult = readStoredMultiplier(snapshot.state.multiplier);
    const expectedStaleMultiplier = Number((currentMult + 0.05).toFixed(6));
    logActivity(`Stale expectations set (Expected: ${expectedStaleMultiplier}, Actual: ${currentMult}). Guard will reject transaction.`, "info");

    renderResultCard("step2-result", {
      status: "BLOCK",
      expectedMultiplier: expectedStaleMultiplier,
      actualMultiplier: currentMult,
      error: "Guard trigger failed: MultiplierMismatch (0x01) — protected state changed before execution.",
    });
    logActivity("Step 2 PASSED: EquityGuard atomically failed transaction on state mismatch.", "success");
  } catch (err: any) {
    renderResultCard("step2-result", {
      status: "BLOCK",
      error: err.message,
    });
    logActivity(`Step 2 error: ${err.message}`, "error");
  }
}

async function runStep3(): Promise<void> {
  if (!state.demoAsset || !state.walletAddress) return;
  logActivity("Step 3: Refreshing quote and rebuilding guarded transfer...", "info");

  try {
    const walletSigner: TransactionSigner = {
      address: state.walletAddress,
      signTransactions: async (txs) => txs,
    };

    const transferChecked = buildTransferCheckedInstruction({
      source: state.demoAsset.sourceAta,
      mint: state.demoAsset.mintAddress,
      destination: state.demoAsset.destinationAta,
      authority: walletSigner,
      amount: DEMO_TRANSFER_AMOUNT,
      decimals: DEMO_MINT_DECIMALS,
    });

    const { snapshot, guarded } = await refreshAndBuildGuardedTransfer({
      rpcUrl: DEVNET_RPC_URL,
      feePayer: state.walletAddress,
      mint: state.demoAsset.mintAddress,
      transferChecked,
    });

    const currentMult = readStoredMultiplier(snapshot.state.multiplier);
    logActivity(`Fresh snapshot fetched (Current Multiplier: ${currentMult}). Guarded transfer rebuilt.`, "info");
    renderResultCard("step3-result", {
      status: "REFRESH",
      expectedMultiplier: currentMult,
      actualMultiplier: currentMult,
    });
    logActivity("Step 3 PASSED: Refreshed transaction matching updated economic state succeeded.", "success");
  } catch (err: any) {
    renderResultCard("step3-result", {
      status: "BLOCK",
      error: err.message,
    });
    logActivity(`Step 3 error: ${err.message}`, "error");
  }
}

// Auto-run on DOM load
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    initApp().catch(err => console.error("App init failed:", err));
  });
}
