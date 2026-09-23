#!/usr/bin/env node
/**
 * LIVE DEVNET proof of the ABI v2 action binding (EG-SEC-H01).
 *
 * Adversarial tooling, not a product path: it deliberately builds guard
 * instructions the product builder would refuse, submits them to the deployed
 * program with preflight disabled so every failure lands on chain, and records
 * the guard error and the token balances around it.
 *
 * Devnet only: the transport refuses any context whose genesis hash is not
 * devnet and re-checks it immediately before signing.
 *
 *   EQUITYGUARD_DEVNET_WALLET=... node scripts/devnet/guard-v2-live-proof.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AccountRole, generateKeyPairSigner, type Address, type Instruction } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  DownstreamAdapterKind,
  SYSVAR_INSTRUCTIONS_ADDRESS,
  asCommittedInstruction,
  downstreamCommitment,
  equityGuardErrorName,
  fetchGuardSnapshot,
  type AssertSafeExecutionRequest,
  type GuardSnapshot,
} from "@equityguard/guard-client";
import {
  encodeAssertSafeExecutionV2,
} from "@equityguard/guard-client/advanced";

import { connectDevnet, readDevnetConfig, type DevnetContext } from "./config.ts";
import { findAsset, loadDevnetState, requireGuardAbiV2Deployment, type TestAsset } from "./devnet-state.ts";
import { explorerUrl, toJson } from "./evidence.ts";
import { sendInstructions } from "./send.ts";

/** Demo window; the same shape the devnet demo uses. */
const WINDOW = { beforeSecs: 900, afterSecs: 300 } as const;
const AMOUNT = 1_000n;
const OTHER_AMOUNT = 2_000n;
/** Spacing between cases, so the shared public devnet RPC does not rate-limit us. */
const CASE_PAUSE_MS = 4_000;

interface CaseResult {
  readonly name: string;
  readonly expectation: string;
  readonly signature: string;
  readonly slot: bigint;
  readonly succeeded: boolean;
  readonly guardError: string | null;
  readonly matched: boolean;
  readonly balances: Record<string, { before: bigint; after: bigint }>;
  readonly explorerUrl: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The public devnet RPC rate-limits bursts; back off and retry reads. */
async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 5 || !message.includes("429")) throw error;
      await sleep(2_000 * (attempt + 1));
    }
  }
}

/** Token-2022 account layout: amount is a u64 LE at offset 64. */
const AMOUNT_OFFSET = 64;

/** One RPC round trip for every watched account, to stay inside the rate limit. */
async function tokenBalances(ctx: DevnetContext, accounts: Record<string, Address>): Promise<Record<string, bigint>> {
  const labels = Object.keys(accounts);
  const { value } = await retryRead(() =>
    ctx.rpc.getMultipleAccounts(labels.map((label) => accounts[label] as Address), { encoding: "base64", commitment: "confirmed" }).send(),
  );
  const balances: Record<string, bigint> = {};
  labels.forEach((label, index) => {
    const account = value[index];
    if (!account) {
      balances[label] = 0n;
      return;
    }
    const data = Buffer.from(account.data[0], "base64");
    balances[label] = data.readBigUInt64LE(AMOUNT_OFFSET);
  });
  return balances;
}

const ata = async (owner: Address, mint: Address): Promise<Address> =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

function expectationOf(snapshot: GuardSnapshot): AssertSafeExecutionRequest {
  return { expected: snapshot.state, expectedPhase: snapshot.phase, window: WINDOW };
}

/** A guard instruction with full control over every field, including invalid ones. */
function guardInstruction(input: {
  readonly programAddress: Address;
  readonly account0: Address;
  readonly expectedMint: Address;
  readonly expectation: AssertSafeExecutionRequest;
  readonly commitment: Uint8Array;
}): Instruction {
  return {
    programAddress: input.programAddress,
    accounts: [
      { address: input.account0, role: AccountRole.READONLY },
      { address: SYSVAR_INSTRUCTIONS_ADDRESS, role: AccountRole.READONLY },
    ],
    data: encodeAssertSafeExecutionV2({
      ...input.expectation,
      expectedMint: input.expectedMint,
      adapterKind: DownstreamAdapterKind.TOKEN_2022_TRANSFER_CHECKED,
      downstreamCommitment: input.commitment,
    }),
  };
}

/** The historical ABI v1 payload (34 bytes), which the upgraded program must refuse. */
function historicalV1Guard(programAddress: Address, mint: Address, expectation: AssertSafeExecutionRequest): Instruction {
  const data = new Uint8Array(34);
  const view = new DataView(data.buffer);
  data[0] = 1;
  data.set(expectation.expected.multiplier, 1);
  data.set(expectation.expected.newMultiplier, 9);
  view.setBigInt64(17, expectation.expected.newMultiplierEffectiveTimestamp, true);
  data[25] = expectation.expectedPhase;
  view.setUint32(26, expectation.window.beforeSecs, true);
  view.setUint32(30, expectation.window.afterSecs, true);
  return { programAddress, accounts: [{ address: mint, role: AccountRole.READONLY }], data };
}

async function run(
  ctx: DevnetContext,
  name: string,
  expectation: string,
  instructions: readonly Instruction[],
  watched: Record<string, Address>,
): Promise<CaseResult> {
  const before = await tokenBalances(ctx, watched);
  // Preflight is skipped so expected failures land on chain and are verifiable by signature.
  const outcome = await sendInstructions(ctx, instructions, { skipPreflight: true });
  const after = await tokenBalances(ctx, watched);
  const balances: CaseResult["balances"] = {};
  for (const label of Object.keys(watched)) {
    balances[label] = { before: before[label] ?? 0n, after: after[label] ?? 0n };
  }
  const guardError = outcome.customError ? equityGuardErrorName(outcome.customError.code) ?? null : null;
  const observed = outcome.succeeded ? "success" : `failure:${guardError ?? "other"}`;
  const result: CaseResult = {
    name,
    expectation,
    signature: outcome.signature,
    slot: outcome.slot,
    succeeded: outcome.succeeded,
    guardError,
    matched: observed === expectation,
    balances,
    explorerUrl: explorerUrl(ctx.cluster, outcome.signature),
  };
  const moved = Object.entries(balances).filter(([, b]) => b.before !== b.after);
  console.log(
    `${result.matched ? "OK  " : "FAIL"} ${name}: expected ${expectation}, observed ${observed}; ` +
      `${moved.length === 0 ? "no token movement" : moved.map(([l, b]) => `${l} ${b.before}->${b.after}`).join(", ")}  ${outcome.signature}`,
  );
  await sleep(CASE_PAUSE_MS);
  return result;
}

export async function proveGuardV2(ctx: DevnetContext): Promise<CaseResult[]> {
  const state = await loadDevnetState();
  const { programId } = requireGuardAbiV2Deployment(state);
  const safe: TestAsset = findAsset(state, "EQ-B");
  const other: TestAsset = findAsset(state, "EQ-A");
  const payer = ctx.payer.address;
  const recipient = (await generateKeyPairSigner()).address;
  const decoy = (await generateKeyPairSigner()).address;

  const [safeSource, otherSource, destination, decoyDestination, otherDestination] = await Promise.all([
    ata(payer, safe.mint),
    ata(payer, other.mint),
    ata(recipient, safe.mint),
    ata(decoy, safe.mint),
    ata(recipient, other.mint),
  ]);
  // Both destinations exist up front, so a rejected attack cannot be confused with a missing account.
  await sendInstructions(
    ctx,
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: ctx.payer, owner: recipient, mint: safe.mint }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: ctx.payer, owner: decoy, mint: safe.mint }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: ctx.payer, owner: recipient, mint: other.mint }),
    ],
    { skipPreflight: false },
  );

  const safeSnapshot = await retryRead(() => fetchGuardSnapshot(ctx.rpc, safe.mint));
  const otherSnapshot = await retryRead(() => fetchGuardSnapshot(ctx.rpc, other.mint));
  const expectation = expectationOf(safeSnapshot);
  const transfer = (mint: Address, source: Address, dest: Address, amount: bigint, decimals: number): Instruction =>
    getTransferCheckedInstruction({ source, mint, destination: dest, authority: ctx.payer, amount, decimals });
  const commitTo = (target: Instruction, layout: readonly Instruction[]): Uint8Array =>
    downstreamCommitment(asCommittedInstruction(target, layout, payer));
  /** Builds `[guard, ...rest]` where the guard commits to `committed`. */
  const layoutWith = (guardOf: (commitment: Uint8Array) => Instruction, rest: readonly Instruction[], committed: Instruction): Instruction[] => {
    const placeholder = [guardOf(new Uint8Array(32)), ...rest];
    return [guardOf(commitTo(committed, placeholder)), ...rest];
  };
  const guardFor = (commitment: Uint8Array) => guardInstruction({ programAddress: programId, account0: safe.mint, expectedMint: safe.mint, expectation, commitment });

  const watched = { source: safeSource, destination, decoyDestination, otherDestination };
  const results: CaseResult[] = [];

  // 1. The exact committed delivery.
  const honest = transfer(safe.mint, safeSource, destination, AMOUNT, safe.decimals);
  results.push(await run(ctx, "valid committed TransferChecked", "success", layoutWith(guardFor, [honest], honest), watched));

  // 2. Guard protects EQ-B; the action moves EQ-A (commitment matches the action).
  const otherAssetTransfer = transfer(other.mint, otherSource, otherDestination, AMOUNT, other.decimals);
  results.push(await run(ctx, "wrong mint in the action", "failure:DownstreamMintMismatch", layoutWith(guardFor, [otherAssetTransfer], otherAssetTransfer), watched));

  // 3. Guard payload expects EQ-B but account 0 is EQ-A.
  const mintKeyGuard = (commitment: Uint8Array) =>
    guardInstruction({ programAddress: programId, account0: other.mint, expectedMint: safe.mint, expectation: expectationOf(otherSnapshot), commitment });
  results.push(await run(ctx, "mint key mismatch (account 0 is another mint)", "failure:MintKeyMismatch", layoutWith(mintKeyGuard, [honest], honest), watched));

  // 4. Commit to AMOUNT, submit OTHER_AMOUNT.
  const substitutedAmount = transfer(safe.mint, safeSource, destination, OTHER_AMOUNT, safe.decimals);
  results.push(await run(ctx, "amount substitution", "failure:DownstreamCommitmentMismatch", layoutWith(guardFor, [substitutedAmount], honest), watched));

  // 5. Commit to `destination`, submit `decoyDestination`.
  const substitutedDestination = transfer(safe.mint, safeSource, decoyDestination, AMOUNT, safe.decimals);
  results.push(await run(ctx, "destination substitution", "failure:DownstreamCommitmentMismatch", layoutWith(guardFor, [substitutedDestination], honest), watched));

  // 6. An unrelated instruction between the guard and the committed action.
  const inserted = getTransferSolInstruction({ source: ctx.payer, destination: recipient, amount: 1_000n });
  results.push(await run(ctx, "instruction inserted after the guard", "failure:UnsupportedDownstreamProgram", layoutWith(guardFor, [inserted, honest], honest), watched));

  // 7. A historical, well-formed ABI v1 payload.
  results.push(await run(ctx, "historical ABI v1 payload", "failure:UnsupportedVersion", [historicalV1Guard(programId, safe.mint, expectation), honest], watched));

  // 8. An expected multiplier that is not the one the mint holds, i.e. what a
  //    snapshot that went stale between build and landing looks like on chain.
  //    (The full build-then-mutate sequence is `npm run devnet -- scenario stale`.)
  const staleExpectation: AssertSafeExecutionRequest = {
    ...expectation,
    expected: { ...expectation.expected, multiplier: new Uint8Array(new Float64Array([7.5]).buffer) },
  };
  const staleGuard = (commitment: Uint8Array) => guardInstruction({ programAddress: programId, account0: safe.mint, expectedMint: safe.mint, expectation: staleExpectation, commitment });
  results.push(await run(ctx, "expected multiplier no longer matches the mint", "failure:MultiplierChanged", layoutWith(staleGuard, [honest], honest), watched));

  // 9. Atomicity: a rejected delivery preceded by a fresh ATA creation must
  //    roll that account creation back too.
  const freshRecipient = (await generateKeyPairSigner()).address;
  const freshDestination = await ata(freshRecipient, safe.mint);
  const createFresh = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: ctx.payer, owner: freshRecipient, mint: safe.mint });
  const freshTransfer = transfer(safe.mint, safeSource, freshDestination, AMOUNT, safe.decimals);
  const guardWithCreate = (commitment: Uint8Array) => guardInstruction({ programAddress: programId, account0: safe.mint, expectedMint: safe.mint, expectation: staleExpectation, commitment });
  const placeholder = [createFresh, guardWithCreate(new Uint8Array(32)), freshTransfer];
  const atomicityLayout = [createFresh, guardWithCreate(commitTo(freshTransfer, placeholder)), freshTransfer];
  results.push(
    await run(ctx, "rejection rolls back the preceding ATA creation", "failure:MultiplierChanged", atomicityLayout, { ...watched, freshDestination }),
  );
  const freshAccount = await retryRead(() => ctx.rpc.getAccountInfo(freshDestination, { encoding: "base64", commitment: "confirmed" }).send());
  console.log(`     ATA rollback: ${freshDestination} ${freshAccount.value === null ? "does not exist (rolled back)" : "EXISTS (NOT rolled back)"}`);
  if (freshAccount.value !== null) throw new Error("the rejected transaction left the ATA created");

  return results;
}

async function main(): Promise<void> {
  const ctx = await connectDevnet(readDevnetConfig(process.env));
  const results = await proveGuardV2(ctx);
  await mkdir("tmp/guard-v2-proof", { recursive: true });
  const path = `tmp/guard-v2-proof/${new Date().toISOString().replaceAll(":", "")}.json`;
  await writeFile(path, `${toJson({ cluster: ctx.cluster, results })}\n`, { flag: "wx" });
  const failed = results.filter((r) => !r.matched);
  console.log(`\n${results.length - failed.length}/${results.length} cases matched; evidence written to ${path}`);
  if (failed.length > 0) throw new Error(`cases did not match: ${failed.map((r) => r.name).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[guard-v2-proof] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
