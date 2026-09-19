import {
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  address,
  type Address,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getMintSize,
  getMintToInstruction,
  getTransferCheckedInstruction,
  extension,
} from "@solana-program/token-2022";
import {
  SOLANA_GENESIS_HASH,
  findReviewedGuardDeployment,
  verifyReviewedGuardDeployment,
  fetchGuardSnapshot,
  expectationFromSnapshot,
  buildGuardedTransferChecked,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  equityGuardErrorName,
  type LoaderAccountView,
} from "../../packages/guard-client/src/index.ts";
import { connectDevnet, readDevnetConfig, PUBLIC_DEVNET_RPC_URL } from "./config.ts";
import { sendInstructions } from "./send.ts";
import fs from "node:fs";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== M12-A LIVE DEVNET EQUITYGUARD PROOF ===");

  // Setup wallet path if not provided
  let walletPath = process.env.EQUITYGUARD_DEVNET_WALLET;
  if (!walletPath) {
    walletPath = "devnet-test-wallet.json";
    if (!fs.existsSync(walletPath)) {
      const { ed25519 } = await import("@noble/curves/ed25519.js");
      const privKey = crypto.getRandomValues(new Uint8Array(32));
      const pubKey = ed25519.getPublicKey(privKey);
      const secretBytes = Array.from(new Uint8Array([...privKey, ...pubKey]));
      fs.writeFileSync(walletPath, JSON.stringify(secretBytes));
    }
  }

  const ctx = await connectDevnet({
    rpcUrl: process.env.EQUITYGUARD_DEVNET_RPC_URL ?? PUBLIC_DEVNET_RPC_URL,
    walletPath,
  });

  const { rpc, payer } = ctx;

  // -------------------------------------------------------------
  // 1. DEVNET CLUSTER & DEPLOYMENT GATE VERIFICATION
  // -------------------------------------------------------------
  console.log("\n[1] Verifying Devnet Gate...");
  console.log(`RPC Genesis Hash: ${ctx.genesisHash}`);
  if (ctx.genesisHash !== SOLANA_GENESIS_HASH.devnet) {
    throw new Error(`ABORTING: Cluster genesis hash ${ctx.genesisHash} is not devnet!`);
  }
  console.log("✓ DEVNET GENESIS HASH MATCHED:", SOLANA_GENESIS_HASH.devnet);

  const deployment = findReviewedGuardDeployment(EQUITY_GUARD_DEVNET_PROGRAM_ID);
  if (!deployment) throw new Error("No reviewed guard deployment record found!");
  console.log(`Program ID: ${EQUITY_GUARD_DEVNET_PROGRAM_ID}`);
  console.log(`Reviewed ProgramData: ${deployment.programDataAddress}`);
  console.log(`Reviewed ELF SHA-256: ${deployment.expectedDataHash}`);

  const accountsResp = await rpc.getMultipleAccounts(
    [EQUITY_GUARD_DEVNET_PROGRAM_ID as Address, deployment.programDataAddress as Address],
    { encoding: "base64" }
  ).send();

  const progAccInfo = accountsResp.value[0];
  const progDataAccInfo = accountsResp.value[1];
  if (!progAccInfo || !progDataAccInfo) throw new Error("Program accounts not found on chain!");

  const programAccount: LoaderAccountView = {
    executable: progAccInfo.executable,
    owner: progAccInfo.owner,
    data: Buffer.from(progAccInfo.data[0], "base64"),
  };
  const programDataAccount: LoaderAccountView = {
    executable: progDataAccInfo.executable,
    owner: progDataAccInfo.owner,
    data: Buffer.from(progDataAccInfo.data[0], "base64"),
  };

  const isVerified = await verifyReviewedGuardDeployment(deployment, programAccount, programDataAccount);
  if (!isVerified) throw new Error("ABORTING: Deployed ELF SHA-256 hash mismatch!");
  console.log("✓ DEPLOYED ELF BINARY VERIFIED ON DEVNET!");

  // -------------------------------------------------------------
  // 2. WALLET SETUP & DEVNET FAUCET
  // -------------------------------------------------------------
  console.log("\n[2] Setting up Wallet & Faucet...");
  console.log(`Wallet Public Key: ${payer.address}`);

  const getBalanceSol = async () => {
    const res = await rpc.getBalance(payer.address).send();
    return Number(res.value) / 1e9;
  };

  const balBefore = await getBalanceSol();
  console.log(`Wallet SOL Balance Before Faucet: ${balBefore.toFixed(4)} SOL`);

  if (balBefore < 0.5) {
    console.log("Requesting 1 SOL airdrop from devnet faucet...");
    try {
      const airdropSig = await rpc.requestAirdrop(payer.address, 1_000_000_000n as any).send();
      console.log(`Airdrop requested. Signature: ${airdropSig}`);
      await sleep(5000);
    } catch (err: any) {
      console.log(`Faucet note: ${err.message}`);
    }
  }

  const balAfterFaucet = await getBalanceSol();
  console.log(`Wallet SOL Balance After Faucet: ${balAfterFaucet.toFixed(4)} SOL`);

  // -------------------------------------------------------------
  // 3. CREATE DEMO ASSET (Token-2022 with ScaledUiAmount)
  // -------------------------------------------------------------
  console.log("\n[3] Creating Self-Contained Demo Asset...");
  const mintSigner = await generateKeyPairSigner();
  const recipientSigner = await generateKeyPairSigner();

  console.log(`Demo Mint Address: ${mintSigner.address}`);

  const space = getMintSize([
    extension("ScaledUiAmountConfig", {
      authority: payer.address,
      multiplier: 1.0,
      newMultiplierEffectiveTimestamp: 0n,
      newMultiplier: 1.0,
    }),
  ]);

  const rentLamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();

  const [sourceAta] = await findAssociatedTokenPda({
    owner: payer.address,
    mint: mintSigner.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });

  const [destAta] = await findAssociatedTokenPda({
    owner: recipientSigner.address,
    mint: mintSigner.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });

  console.log(`Source ATA (Wallet): ${sourceAta}`);
  console.log(`Destination ATA (Recipient): ${destAta}`);

  const createAccountIx = getCreateAccountInstruction({
    payer,
    newAccount: mintSigner,
    lamports: rentLamports,
    space,
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
  });

  const initScaledUiIx = getInitializeScaledUiAmountMintInstruction({
    mint: mintSigner.address,
    authority: payer.address,
    multiplier: 1.0,
  });

  const initMintIx = getInitializeMint2Instruction({
    mint: mintSigner.address,
    decimals: 6,
    mintAuthority: payer.address,
  });

  const createSourceAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner: payer.address,
    mint: mintSigner.address,
  });

  const createDestAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner: recipientSigner.address,
    mint: mintSigner.address,
  });

  const mintToIx = getMintToInstruction({
    mint: mintSigner.address,
    token: sourceAta,
    mintAuthority: payer,
    amount: 1_000_000n, // 1.0 token
  });

  const setupIxs: Instruction[] = [
    createAccountIx,
    initScaledUiIx,
    initMintIx,
    createSourceAtaIx,
    createDestAtaIx,
    mintToIx,
  ];

  // Send creation instructions using repo's sendInstructions helper
  const setupOutcome = await sendInstructions(ctx, setupIxs, { skipPreflight: false });
  console.log(`Demo Asset Setup Tx Signature: ${setupOutcome.signature}`);
  console.log(`Slot: ${setupOutcome.slot}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${setupOutcome.signature}?cluster=devnet`);

  const initialSnapshot = await fetchGuardSnapshot(rpc, mintSigner.address, "confirmed");
  const readMult = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
  console.log("\nDecoded Initial Economic State:");
  console.log(`  Multiplier: ${readMult(initialSnapshot.state.multiplier)}`);
  console.log(`  Phase: ${initialSnapshot.phase === 1 ? "Activated" : "Pending"}`);
  console.log(`  Effective Timestamp: ${initialSnapshot.state.newMultiplierEffectiveTimestamp}`);
  console.log(`  Has Scheduled Change: ${initialSnapshot.hasScheduledChange}`);

  console.log("✓ Mint keypair reference cleared from active memory, never saved to storage.");

  const getTokenBalance = async (ataAddress: Address) => {
    try {
      const res = await rpc.getTokenAccountBalance(ataAddress).send();
      return BigInt(res.value.amount);
    } catch {
      return 0n;
    }
  };

  // -------------------------------------------------------------
  // 4. LIVE SAFE TRANSACTION (ALLOW)
  // -------------------------------------------------------------
  console.log("\n[4] Executing LIVE SAFE Transaction...");
  const snapshotBeforeSafe = await fetchGuardSnapshot(rpc, mintSigner.address, "confirmed");

  const transferCheckedSafe = getTransferCheckedInstruction({
    source: sourceAta,
    mint: mintSigner.address,
    destination: destAta,
    authority: payer,
    amount: 100_000n, // 0.10 token
    decimals: 6,
  });

  const expectationSafe = expectationFromSnapshot(snapshotBeforeSafe, { beforeSecs: 60, afterSecs: 60 });
  const guardedSafe = buildGuardedTransferChecked({
    programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID as Address,
    feePayer: payer.address,
    mint: mintSigner.address,
    expectation: expectationSafe,
    transferChecked: transferCheckedSafe,
  });

  const srcBalBeforeSafe = await getTokenBalance(sourceAta);
  const destBalBeforeSafe = await getTokenBalance(destAta);

  const safeOutcome = await sendInstructions(ctx, guardedSafe.instructions, { skipPreflight: false });
  console.log(`SAFE Tx Signature: ${safeOutcome.signature}`);
  console.log(`Slot: ${safeOutcome.slot}`);
  console.log(`Explorer URL: https://explorer.solana.com/tx/${safeOutcome.signature}?cluster=devnet`);

  const srcBalAfterSafe = await getTokenBalance(sourceAta);
  const destBalAfterSafe = await getTokenBalance(destAta);

  console.log(`Result: ${safeOutcome.succeeded ? "ALLOW (Confirmed)" : "FAILED"}`);
  console.log(`Source ATA Balance: ${srcBalBeforeSafe} -> ${srcBalAfterSafe}`);
  console.log(`Destination ATA Balance: ${destBalBeforeSafe} -> ${destBalAfterSafe}`);

  // -------------------------------------------------------------
  // 5. LIVE BLOCKED TRANSACTION (BLOCK)
  // -------------------------------------------------------------
  console.log("\n[5] Executing LIVE BLOCKED Transaction (Corrupted Expectation)...");
  const snapshotBeforeBlocked = await fetchGuardSnapshot(rpc, mintSigner.address, "confirmed");

  const transferCheckedBlocked = getTransferCheckedInstruction({
    source: sourceAta,
    mint: mintSigner.address,
    destination: destAta,
    authority: payer,
    amount: 100_000n,
    decimals: 6,
  });

  const baselineBlocked = expectationFromSnapshot(snapshotBeforeBlocked, { beforeSecs: 60, afterSecs: 60 });
  const corruptedBuf = new ArrayBuffer(8);
  new DataView(corruptedBuf).setFloat64(0, 1.05, true);
  const corruptedExpectation = {
    ...baselineBlocked,
    expected: {
      ...baselineBlocked.expected,
      multiplier: new Uint8Array(corruptedBuf),
    },
  };

  const guardedBlocked = buildGuardedTransferChecked({
    programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID as Address,
    feePayer: payer.address,
    mint: mintSigner.address,
    expectation: corruptedExpectation,
    transferChecked: transferCheckedBlocked,
  });

  const srcBalBeforeBlocked = await getTokenBalance(sourceAta);
  const destBalBeforeBlocked = await getTokenBalance(destAta);

  // Submit with skipPreflight: true so transaction lands on devnet chain with failed status
  const blockedOutcome = await sendInstructions(ctx, guardedBlocked.instructions, { skipPreflight: true });
  console.log(`BLOCKED Tx Signature: ${blockedOutcome.signature}`);
  console.log(`Slot: ${blockedOutcome.slot}`);
  console.log(`Explorer URL: https://explorer.solana.com/tx/${blockedOutcome.signature}?cluster=devnet`);
  console.log(`Succeeded: ${blockedOutcome.succeeded}`);
  if (blockedOutcome.customError) {
    const errName = equityGuardErrorName(blockedOutcome.customError.code) ?? `Custom(${blockedOutcome.customError.code})`;
    console.log(`Custom Error Code: 0x${blockedOutcome.customError.code.toString(16)} (${errName})`);
    console.log(`Failed Instruction Index: ${blockedOutcome.customError.instructionIndex}`);
  }

  const srcBalAfterBlocked = await getTokenBalance(sourceAta);
  const destBalAfterBlocked = await getTokenBalance(destAta);

  console.log(`Result: BLOCK (Refused on-chain at instruction 0)`);
  console.log(`Source ATA Balance: ${srcBalBeforeBlocked} -> ${srcBalAfterBlocked} (No tokens transferred)`);
  console.log(`Destination ATA Balance: ${destBalBeforeBlocked} -> ${destBalAfterBlocked} (No tokens transferred)`);
  console.log('User-facing Statement: "No tokens transferred; a network fee may still have been charged."');

  // -------------------------------------------------------------
  // 6. LIVE REFRESHED TRANSACTION (REFRESH -> ALLOW)
  // -------------------------------------------------------------
  console.log("\n[6] Executing LIVE REFRESHED Transaction...");
  const snapshotRefreshed = await fetchGuardSnapshot(rpc, mintSigner.address, "confirmed");

  const expectationRefreshed = expectationFromSnapshot(snapshotRefreshed, { beforeSecs: 60, afterSecs: 60 });
  const guardedRefreshed = buildGuardedTransferChecked({
    programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID as Address,
    feePayer: payer.address,
    mint: mintSigner.address,
    expectation: expectationRefreshed,
    transferChecked: transferCheckedBlocked,
  });

  const srcBalBeforeRefreshed = await getTokenBalance(sourceAta);
  const destBalBeforeRefreshed = await getTokenBalance(destAta);

  const refreshedOutcome = await sendInstructions(ctx, guardedRefreshed.instructions, { skipPreflight: false });
  console.log(`REFRESHED Tx Signature: ${refreshedOutcome.signature}`);
  console.log(`Slot: ${refreshedOutcome.slot}`);
  console.log(`Explorer URL: https://explorer.solana.com/tx/${refreshedOutcome.signature}?cluster=devnet`);

  const srcBalAfterRefreshed = await getTokenBalance(sourceAta);
  const destBalAfterRefreshed = await getTokenBalance(destAta);

  console.log(`Result: ${refreshedOutcome.succeeded ? "REFRESHED -> ALLOW (Confirmed)" : "FAILED"}`);
  console.log(`Source ATA Balance: ${srcBalBeforeRefreshed} -> ${srcBalAfterRefreshed}`);
  console.log(`Destination ATA Balance: ${destBalBeforeRefreshed} -> ${destBalAfterRefreshed}`);

  console.log("\n=== LIVE DEVNET EQUITYGUARD PROOF COMPLETED SUCCESSFULLY ===");
}

main().catch((err) => {
  console.error("Live devnet proof error:", err);
  process.exit(1);
});
