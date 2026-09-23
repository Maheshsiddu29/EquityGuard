#!/usr/bin/env node
/**
 * LIVE DEVNET proof of the Jupiter adapter kinds (2 = BUY_USDC, 3 = SELL_USDC)
 * on the deployed program, and of the devnet limitation that bounds it.
 *
 * Adversarial tooling, not a product path: it deliberately builds guard
 * transactions the product composer would refuse, submits them with preflight
 * disabled so every failure lands on chain, and records the outcome.
 *
 * Devnet has no Jupiter: `JUP6…` there is a system-owned, non-executable
 * account. Any transaction that invokes it fails while the runtime loads the
 * transaction (`InvalidProgramForExecution`), before any instruction — the
 * guard included — executes. Therefore:
 *
 * - Part A (semantic rejections) uses only transactions that do not invoke
 *   `JUP6…`, i.e. the checks the guard makes before it requires the trade's
 *   program to be Jupiter. Every commitment is recomputed so each rejection is
 *   semantic, and each on-chain verdict is compared with the client model.
 * - Part B (positive path) submits client-accepted kind 2/3 trades and a
 *   malicious one, and records that none reaches the guard. The positive
 *   Jupiter path remains proven only in LiteSVM with a stand-in program.
 *
 * Devnet only: the transport refuses any context whose genesis hash is not
 * devnet and re-checks it immediately before signing.
 *
 *   EQUITYGUARD_DEVNET_WALLET=... node scripts/devnet/jupiter-adapter-live-proof.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AccountRole, address, generateKeyPairSigner, getBase64Encoder, type Address, type Instruction } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DownstreamAdapterKind,
  JUPITER_V6_PROGRAM_ADDRESS,
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  ROUTE_V2_ACCOUNT,
  TOKEN_2022_PROGRAM_ADDRESS as TOKEN_2022_PROGRAM_ID,
  USDC_MINT_ADDRESS,
  asCommittedInstruction,
  canonicalAta,
  checkGuardedJupiterTransaction,
  downstreamCommitment,
  equityGuardErrorName,
  expectationFromSnapshot,
  fetchGuardSnapshot,
  jupiterSuffixCommitment,
  sysvarView,
  type AssertSafeExecutionRequest,
  type JupiterAdapterKind,
} from "@equityguard/guard-client";
import {
  buildGuardedJupiterTrade,
  getAssertSafeExecutionV2Instruction,
} from "@equityguard/guard-client/advanced";

import { connectDevnet, readDevnetConfig, type DevnetContext } from "./config.ts";
import { findAsset, loadDevnetState, requireGuardAbiV2Deployment } from "./devnet-state.ts";
import { explorerUrl, toJson } from "./evidence.ts";
import { sendInstructions } from "./send.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 } as const;
const AMOUNT = 1_000n;
const CASE_PAUSE_MS = 4_000;
/** SPL Memo v2, deployed on devnet: an executable program that is not Jupiter. */
const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** A real 2026-09-14 KOx/USDC `route_v2` build; its route accounts and data are reused. */
const ROUTE_FIXTURE = "packages/jupiter/test/fixtures/KOx-usdc-build.json";
/** Token-2022 account layout: amount is a u64 LE at offset 64. */
const AMOUNT_OFFSET = 64;
const TOKEN_2022_PROGRAM_ADDRESS = address(TOKEN_2022_PROGRAM_ID);

interface CaseResult {
  readonly part: "A" | "B";
  readonly name: string;
  readonly adapterKindByte: number;
  readonly expectation: string;
  /** The client model's verdict for the same transaction, where it applies. */
  readonly modelVerdict: string | null;
  readonly signature: string;
  readonly slot: bigint;
  readonly observed: string;
  readonly failingInstructionIndex: number | null;
  readonly guardInstructionIndex: number;
  readonly guardExecuted: boolean;
  readonly guardComputeUnits: number | null;
  readonly matched: boolean;
  readonly balances: Record<string, { before: bigint; after: bigint }>;
  readonly logs: readonly string[];
  readonly explorerUrl: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function tokenBalances(ctx: DevnetContext, accounts: Record<string, Address>): Promise<Record<string, bigint>> {
  const labels = Object.keys(accounts);
  const { value } = await retryRead(() =>
    ctx.rpc.getMultipleAccounts(labels.map((label) => accounts[label] as Address), { encoding: "base64", commitment: "confirmed" }).send(),
  );
  const balances: Record<string, bigint> = {};
  labels.forEach((label, index) => {
    const account = value[index];
    balances[label] = account ? Buffer.from(account.data[0], "base64").readBigUInt64LE(AMOUNT_OFFSET) : 0n;
  });
  return balances;
}

interface FixtureMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

function roleOf(meta: FixtureMeta): AccountRole {
  if (meta.isSigner) return meta.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

const price: Instruction = { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) };
/** SetComputeUnitLimit(200,000). */
const limit: Instruction = { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: Uint8Array.of(2, 0x40, 0x0d, 0x03, 0x00) };

export async function proveJupiterAdapter(ctx: DevnetContext): Promise<{ jupiterAccount: unknown; results: CaseResult[] }> {
  const state = await loadDevnetState();
  const { programId } = requireGuardAbiV2Deployment(state);
  const protectedAsset = findAsset(state, "EQ-B");
  const mint = protectedAsset.mint;
  const payer = ctx.payer.address;

  const jupiter = await retryRead(() => ctx.rpc.getAccountInfo(JUPITER_V6_PROGRAM_ADDRESS, { encoding: "base64" }).send());
  const jupiterAccount = jupiter.value === null ? null : { owner: jupiter.value.owner, executable: jupiter.value.executable, space: jupiter.value.space };
  console.log(`JUP6 on devnet: ${toJson(jupiterAccount)}`);
  if (jupiter.value?.executable) {
    throw new Error("JUP6 is executable on this cluster; this proof's premises no longer hold, re-plan before running it");
  }

  const fixture = JSON.parse(await readFile(ROUTE_FIXTURE, "utf8")) as {
    response: { swapInstruction: { accounts: FixtureMeta[]; data: string } };
  };
  const swap = fixture.response.swapInstruction;
  const routeData = Uint8Array.from(getBase64Encoder().encode(swap.data));
  const usdcAta = await canonicalAta(payer, USDC_MINT_ADDRESS, LEGACY_TOKEN_PROGRAM_ADDRESS);
  const equityAta = await canonicalAta(payer, mint, TOKEN_2022_PROGRAM_ADDRESS);

  /** The fixture's `route_v2`, retargeted to this wallet and EQ-B, invoking `program`. */
  const route = (kind: JupiterAdapterKind, program: Address, counterMint: Address = USDC_MINT_ADDRESS): Instruction => {
    const buy = kind === DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC;
    const A = ROUTE_V2_ACCOUNT;
    const override: Record<number, Address> = {
      [A.authority]: payer,
      [A.source]: buy ? usdcAta : equityAta,
      [A.destination]: buy ? equityAta : usdcAta,
      [A.sourceMint]: buy ? counterMint : mint,
      [A.destinationMint]: buy ? mint : counterMint,
      [A.sourceTokenProgram]: buy ? LEGACY_TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS,
      [A.destinationTokenProgram]: buy ? TOKEN_2022_PROGRAM_ADDRESS : LEGACY_TOKEN_PROGRAM_ADDRESS,
    };
    return {
      programAddress: program,
      accounts: swap.accounts.map((meta, index) => {
        if (index === A.authority) return { address: payer, role: AccountRole.READONLY_SIGNER, signer: ctx.payer };
        return { address: override[index] ?? address(meta.pubkey), role: roleOf(meta) };
      }),
      data: routeData,
    };
  };

  const snapshot = await retryRead(() => fetchGuardSnapshot(ctx.rpc, mint));
  const expectation: AssertSafeExecutionRequest = expectationFromSnapshot(snapshot, WINDOW);

  const guard = (kindByte: number, commitment: Uint8Array): Instruction => {
    const kind = kindByte === 1 || kindByte === 2 || kindByte === 3 ? kindByte : DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC;
    const instruction = getAssertSafeExecutionV2Instruction({ programAddress: programId, mint, expectation, downstreamCommitment: commitment, adapterKind: kind });
    const data = Uint8Array.from(instruction.data ?? []);
    data[66] = kindByte; // the encoder refuses unknown kinds; the program must too
    return { ...instruction, data };
  };

  /**
   * `[...before, guard, ...after]` with a valid commitment over what follows
   * the guard (the Jupiter suffix commitment for kinds 2/3 and unknown kinds,
   * the kind 1 commitment to the next instruction for kind 1).
   */
  const layout = (kindByte: number, before: readonly Instruction[], after: readonly Instruction[]) => {
    const placeholder = [...before, guard(kindByte, new Uint8Array(32)), ...after];
    const guardIndex = before.length;
    let commitment: Uint8Array;
    if (kindByte === DownstreamAdapterKind.TOKEN_2022_TRANSFER_CHECKED) {
      commitment = downstreamCommitment(asCommittedInstruction(after[0] as Instruction, placeholder, payer));
    } else {
      commitment = jupiterSuffixCommitment(sysvarView(placeholder, payer).slice(guardIndex + 1));
    }
    return { instructions: [...before, guard(kindByte, commitment), ...after], guardIndex, commitment };
  };

  const modelOf = async (kindByte: number, instructions: readonly Instruction[], guardIndex: number, commitment: Uint8Array) => {
    if (kindByte !== 2 && kindByte !== 3) return null;
    const verdict = await checkGuardedJupiterTransaction({
      instructions: sysvarView(instructions, payer),
      guardIndex,
      adapterKind: kindByte,
      protectedMint: mint,
      commitment,
    });
    return verdict === null ? "success" : `failure:${verdict}`;
  };

  const recipient = (await generateKeyPairSigner()).address;
  const recipientAta = await canonicalAta(recipient, mint, TOKEN_2022_PROGRAM_ADDRESS);
  await sendInstructions(ctx, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: ctx.payer, owner: recipient, mint })], { skipPreflight: false });
  const watched: Record<string, Address> = { payerEquity: equityAta, recipientEquity: recipientAta };
  const transfer = getTransferCheckedInstruction({ source: equityAta, mint, destination: recipientAta, authority: ctx.payer, amount: AMOUNT, decimals: protectedAsset.decimals });

  const results: CaseResult[] = [];
  const run = async (
    part: CaseResult["part"],
    name: string,
    expectationText: string,
    built: { instructions: readonly Instruction[]; guardIndex: number; commitment: Uint8Array },
    kindByte: number,
    extraWatched: Record<string, Address> = {},
    /** Part B: the verdict the guard would give if the transaction could load. */
    expectedModelVerdict: string | null = null,
  ): Promise<void> => {
    const accounts = { ...watched, ...extraWatched };
    const modelVerdict = await modelOf(kindByte, built.instructions, built.guardIndex, built.commitment);
    const before = await tokenBalances(ctx, accounts);
    const outcome = await sendInstructions(ctx, built.instructions, { skipPreflight: true });
    const after = await tokenBalances(ctx, accounts);
    const balances: CaseResult["balances"] = {};
    for (const label of Object.keys(accounts)) balances[label] = { before: before[label] ?? 0n, after: after[label] ?? 0n };

    const guardExecuted = outcome.logs.some((line) => line.startsWith(`Program ${programId} invoke`));
    const consumed = outcome.logs.map((line) => new RegExp(`^Program ${programId} consumed (\\d+) of`).exec(line)).find((m) => m !== null);
    let observed: string;
    if (outcome.succeeded) observed = "success";
    else if (outcome.customError && outcome.customError.instructionIndex === built.guardIndex) {
      observed = `failure:${equityGuardErrorName(outcome.customError.code) ?? `custom-${outcome.customError.code}`}`;
    } else if (typeof outcome.rawError === "string") observed = `load-failure:${outcome.rawError}`;
    else observed = `failure:other:${toJson(outcome.rawError)}`;

    const moved = Object.entries(balances).filter(([, b]) => b.before !== b.after);
    const modelAgrees = part === "B" ? modelVerdict === expectedModelVerdict : modelVerdict === null || modelVerdict === expectationText;
    const matched = observed === expectationText && modelAgrees && moved.length === 0 && (part === "A" ? guardExecuted : !guardExecuted);
    results.push({
      part,
      name,
      adapterKindByte: kindByte,
      expectation: expectationText,
      modelVerdict,
      signature: outcome.signature,
      slot: outcome.slot,
      observed,
      failingInstructionIndex: outcome.customError?.instructionIndex ?? null,
      guardInstructionIndex: built.guardIndex,
      guardExecuted,
      guardComputeUnits: consumed ? Number(consumed[1]) : null,
      matched,
      balances,
      logs: outcome.logs,
      explorerUrl: explorerUrl(ctx.cluster, outcome.signature),
    });
    console.log(
      `${matched ? "OK  " : "FAIL"} [${part}] ${name}: expected ${expectationText}, observed ${observed}` +
        `${modelVerdict === null ? "" : `, model ${modelVerdict}`}; guard ${guardExecuted ? `ran (${consumed?.[1] ?? "?"} CU)` : "did not run"}; ` +
        `${moved.length === 0 ? "no token movement" : moved.map(([l, b]) => `${l} ${b.before}->${b.after}`).join(", ")}  ${outcome.signature}`,
    );
    await sleep(CASE_PAUSE_MS);
  };

  const BUY = DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC;
  const SELL = DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC;
  const buyLookalike = route(BUY, MEMO_PROGRAM_ADDRESS);
  const sellLookalike = route(SELL, MEMO_PROGRAM_ADDRESS);

  // ---- Part A: semantic rejections the guard reaches on devnet.
  await run("A", "kind 2, guard alone", "failure:UnsupportedTransactionGrammar", layout(BUY, [], []), BUY);
  await run("A", "kind 3, guard alone", "failure:UnsupportedTransactionGrammar", layout(SELL, [], []), SELL);
  await run("A", "kind 2, route_v2 bytes at a non-Jupiter program", "failure:InvalidJupiterProgram", layout(BUY, [], [price, limit, buyLookalike]), BUY);
  await run("A", "kind 3, route_v2 bytes at a non-Jupiter program", "failure:InvalidJupiterProgram", layout(SELL, [], [price, limit, sellLookalike]), SELL);
  await run("A", "kind 2, Token-2022 TransferChecked in the trade position", "failure:InvalidJupiterProgram", layout(BUY, [], [price, limit, transfer]), BUY);
  await run("A", "kind 3, System transfer in the trade position", "failure:InvalidJupiterProgram", layout(SELL, [], [price, limit, getTransferSolInstruction({ source: ctx.payer, destination: recipient, amount: 1_000n })]), SELL);
  await run("A", "kind 2, non-ComputeBudget program in the price position", "failure:UnsupportedTransactionGrammar", layout(BUY, [], [{ ...buyLookalike }, limit, buyLookalike]), BUY);
  await run("A", "kind 2, five-instruction suffix", "failure:UnsupportedTransactionGrammar", layout(BUY, [], [price, limit, transfer, buyLookalike, buyLookalike]), BUY);
  await run("A", "kind 3, TransferChecked in the setup position", "failure:UnsupportedTransactionGrammar", layout(SELL, [], [price, limit, transfer, sellLookalike]), SELL);
  await run("A", "kind 2, ComputeBudget before the guard", "failure:GuardNotFirst", layout(BUY, [price], [limit, buyLookalike]), BUY);

  // Atomicity: a token movement before a misplaced guard is rolled back.
  await run("A", "kind 3, TransferChecked before the guard is rolled back", "failure:GuardNotFirst", layout(SELL, [transfer], [price, limit, sellLookalike]), SELL);
  const freshOwner = (await generateKeyPairSigner()).address;
  const freshAta = await canonicalAta(freshOwner, mint, TOKEN_2022_PROGRAM_ADDRESS);
  const createFresh = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: ctx.payer, owner: freshOwner, mint });
  // The fixed ten route accounts only: the full route plus the ATA creation exceeds 1,232 bytes.
  const shortLookalike: Instruction = { ...buyLookalike, accounts: (buyLookalike.accounts ?? []).slice(0, 10) };
  await run("A", "kind 2, ATA creation before the guard is rolled back", "failure:GuardNotFirst", layout(BUY, [createFresh], [price, limit, shortLookalike]), BUY, { freshAta });
  const fresh = await retryRead(() => ctx.rpc.getAccountInfo(freshAta, { encoding: "base64", commitment: "confirmed" }).send());
  console.log(`     ATA rollback: ${freshAta} ${fresh.value === null ? "does not exist (rolled back)" : "EXISTS (NOT rolled back)"}`);
  if (fresh.value !== null) throw new Error("the rejected transaction left the ATA created");

  // Adapter-kind confusion.
  await run("A", "unknown adapter kind 4 with a Jupiter-shaped suffix", "failure:UnsupportedAdapter", layout(4, [], [price, limit, buyLookalike]), 4);
  await run("A", "adapter kind 0 with a Jupiter-shaped suffix", "failure:UnsupportedAdapter", layout(0, [], [price, limit, buyLookalike]), 0);
  await run("A", "kind 1 guard with a Jupiter-shaped suffix", "failure:UnsupportedDownstreamProgram", layout(1, [], [price, limit, buyLookalike]), 1);

  // ---- Part B: the positive path cannot reach the guard on devnet.
  const LOAD_FAILURE = "load-failure:InvalidProgramForExecution";
  const accepted = async (kind: JupiterAdapterKind) => {
    const trade = await buildGuardedJupiterTrade({ programAddress: programId, feePayer: payer, protectedMint: mint, adapterKind: kind, expectation, suffix: [price, limit, route(kind, JUPITER_V6_PROGRAM_ADDRESS)] });
    return { instructions: trade.instructions, guardIndex: 0, commitment: trade.commitment };
  };
  await run("B", "client-accepted kind 2 BUY trade", LOAD_FAILURE, await accepted(BUY), BUY, {}, "success");
  await run("B", "client-accepted kind 3 SELL trade", LOAD_FAILURE, await accepted(SELL), SELL, {}, "success");
  const wrongCounter = layout(BUY, [], [price, limit, route(BUY, JUPITER_V6_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS)]);
  await run("B", "kind 2 with a non-USDC counter mint", LOAD_FAILURE, wrongCounter, BUY, {}, "failure:InvalidCounterMint");

  return { jupiterAccount, results };
}

async function main(): Promise<void> {
  const ctx = await connectDevnet(readDevnetConfig(process.env));
  const { jupiterAccount, results } = await proveJupiterAdapter(ctx);
  await mkdir("tmp/m9d-b2", { recursive: true });
  const path = `tmp/m9d-b2/jupiter-adapter-live-proof-${new Date().toISOString().replaceAll(":", "")}.json`;
  await writeFile(path, `${toJson({ cluster: ctx.cluster, jupiterAccount, results })}\n`, { flag: "wx" });
  const failed = results.filter((r) => !r.matched);
  console.log(`\n${results.length - failed.length}/${results.length} cases matched; evidence written to ${path}`);
  if (failed.length > 0) throw new Error(`cases did not match: ${failed.map((r) => r.name).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[jupiter-adapter-proof] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
