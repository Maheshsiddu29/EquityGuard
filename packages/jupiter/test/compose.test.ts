/**
 * The adapter kind 2/3 composer over REAL recorded mainnet builds:
 *
 * - the full `/build` response of 2026-09-14 (USDC -> KOx), with its real
 *   address lookup table;
 * - the six route_v2 builds of 2026-09-16, with the lookup-table entries that
 *   run recorded (sparse; see the fixture's description).
 *
 * Build-only. Nothing is signed or submitted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { address, getBase58Decoder, type Address } from "@solana/kit";
import {
  ActivationPhase,
  DownstreamAdapterKind,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  USDC_MINT_ADDRESS,
  sysvarView,
  type AssertSafeExecutionRequest,
  type JupiterAdapterKind,
} from "@equityguard/guard-client";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  CompositionError,
  MAX_TRANSACTION_BYTES,
  UnsupportedJupiterBuildError,
  composeGuardedJupiterTrade,
  getSetComputeUnitLimitInstruction,
  parseBuildResponse,
  resolveWireTransaction,
  type ApiInstruction,
  type BuildResponse,
} from "../src/index.ts";

const PROGRAM = EQUITY_GUARD_DEVNET_PROGRAM_ID;
const LIMIT = 400_000;
const TAKER = address("AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH");
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const hexToBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;

interface RecordedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  dataHex: string;
}
interface RecordedBuild {
  symbol: string;
  direction: "BUY" | "SELL";
  inputMint: string;
  outputMint: string;
  quote: { inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode: string; slippageBps: number };
  jupiterInstructions: RecordedInstruction[];
}
interface RecordedTables {
  builds: { symbol: string; direction: string; lookupTables: Record<string, Record<string, string>>; researchSizes: { guardedBytes: number } }[];
}

const RECORDED = read<{ builds: RecordedBuild[] }>("../../../scripts/research/fixtures/route-v2-builds-2026-09-16.json").builds;
const TABLES = read<RecordedTables>("./fixtures/route-v2-lookup-tables-2026-09-16.json").builds;
const FULL_RESPONSE = parseBuildResponse(read<{ response: unknown }>("./fixtures/KOx-usdc-build.json").response);

/** A distinct, deterministic address for table slots the recording did not use. */
function filler(table: number, index: number): string {
  const bytes = new Uint8Array(32).fill(0xf1);
  bytes[1] = table;
  bytes[2] = index;
  return getBase58Decoder().decode(bytes);
}

/** The 2026-09-16 recording as a `/build` response. */
function freshBuild(symbol: string, direction: "BUY" | "SELL"): BuildResponse {
  const b = RECORDED.find((r) => r.symbol === symbol && r.direction === direction);
  const t = TABLES.find((r) => r.symbol === symbol && r.direction === direction);
  assert.ok(b && t);
  const api = (i: RecordedInstruction): ApiInstruction => ({ programId: i.programId, accounts: i.accounts, data: hexToBase64(i.dataHex) });
  const swapIndex = b.jupiterInstructions.findIndex((i) => i.programId === JUPITER);
  const [price, ...setups] = b.jupiterInstructions.slice(0, swapIndex);
  const cleanup = b.jupiterInstructions.slice(swapIndex + 1);
  const addressesByLookupTableAddress: Record<string, string[]> = {};
  Object.entries(t.lookupTables).forEach(([table, entries], tableNumber) => {
    const size = Math.max(...Object.keys(entries).map(Number)) + 1;
    addressesByLookupTableAddress[table] = Array.from({ length: size }, (_, i) => entries[String(i)] ?? filler(tableNumber, i));
  });
  return parseBuildResponse({
    inputMint: b.inputMint,
    outputMint: b.outputMint,
    inAmount: b.quote.inAmount,
    outAmount: b.quote.outAmount,
    otherAmountThreshold: b.quote.otherAmountThreshold,
    swapMode: b.quote.swapMode,
    slippageBps: b.quote.slippageBps,
    routePlan: [],
    computeBudgetInstructions: [api(price as RecordedInstruction)],
    setupInstructions: setups.map(api),
    swapInstruction: api(b.jupiterInstructions[swapIndex] as RecordedInstruction),
    cleanupInstruction: cleanup[0] ? api(cleanup[0]) : null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress,
    blockhashWithMetadata: { blockhash: Array.from({ length: 32 }, (_, i) => i + 1), lastValidBlockHeight: 1 },
  });
}

const EXPECTATION: AssertSafeExecutionRequest = {
  expected: {
    multiplier: Uint8Array.from(Buffer.from("1efbb6d57038f03f", "hex")),
    newMultiplier: Uint8Array.from(Buffer.from("73833748164bf03f", "hex")),
    newMultiplierEffectiveTimestamp: 1_781_481_300n,
  },
  expectedPhase: ActivationPhase.Activated,
  window: { beforeSecs: 900, afterSecs: 300 },
};

const kindOf = (build: BuildResponse): JupiterAdapterKind =>
  build.inputMint === USDC_MINT_ADDRESS ? DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC : DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC;
const protectedOf = (build: BuildResponse) => address(build.inputMint === USDC_MINT_ADDRESS ? build.outputMint : build.inputMint);

const compose = (build: BuildResponse, overrides: { adapterKind?: JupiterAdapterKind; protectedMint?: Address; taker?: Address; feePayer?: Address } = {}) =>
  composeGuardedJupiterTrade({
    build,
    programAddress: PROGRAM,
    feePayer: overrides.feePayer ?? TAKER,
    taker: overrides.taker ?? TAKER,
    protectedMint: overrides.protectedMint ?? protectedOf(build),
    adapterKind: overrides.adapterKind ?? kindOf(build),
    expectation: EXPECTATION,
    computeUnitLimit: LIMIT,
  });

test("the real 2026-09-14 /build response composes guard-first with its real lookup table", async () => {
  const { trade, binding, wireBytes, metrics } = await compose(FULL_RESPONSE);
  const programs = trade.instructions.map((i) => i.programAddress);
  assert.deepEqual(programs, [PROGRAM, COMPUTE_BUDGET_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", JUPITER]);
  assert.equal(trade.instructions[2]?.data?.[0], 2, "the composer's limit follows Jupiter's price");
  assert.equal(metrics.addressLookupTableCount, 1);
  assert.ok(metrics.lookedUpAddressCount > 0);
  assert.ok(metrics.fitsSizeLimit);

  // The wire bytes resolve to exactly what was hashed.
  const resolved = resolveWireTransaction(wireBytes, FULL_RESPONSE.addressesByLookupTableAddress);
  assert.deepEqual(resolved, sysvarView(trade.instructions, TAKER));
  assert.deepEqual(resolved.slice(1), trade.committedSuffix);

  assert.deepEqual(
    { ...binding },
    {
      adapterKind: "JUPITER_ROUTE_V2_BUY_USDC",
      jupiterProgramId: JUPITER,
      routeDiscriminatorHex: "bb64facc31c4af14",
      protectedMintRole: "DESTINATION",
      protectedMint: FULL_RESPONSE.outputMint,
      counterMint: USDC_MINT_ADDRESS,
      authority: TAKER,
      sourceMint: USDC_MINT_ADDRESS,
      destinationMint: FULL_RESPONSE.outputMint,
      sourceTokenAccount: FULL_RESPONSE.swapInstruction.accounts[1]?.pubkey,
      destinationTokenAccount: FULL_RESPONSE.swapInstruction.accounts[2]?.pubkey,
      inAmountRaw: BigInt(FULL_RESPONSE.inAmount),
      quotedOutRaw: BigInt(FULL_RESPONSE.outAmount),
      slippageBps: FULL_RESPONSE.slippageBps,
      minOutRaw: BigInt(FULL_RESPONSE.otherAmountThreshold),
      suffixCommitmentHex: Buffer.from(trade.commitment).toString("hex"),
      suffixInstructionCount: 4,
    },
  );
});

/**
 * Section 27: fresh unsigned v0 guarded transactions. Pinned so a change in
 * composition shows up as a size change.
 */
const FRESH_SIZES: readonly [string, "BUY" | "SELL", number][] = [
  ["KOx", "BUY", 675],
  ["KOx", "SELL", 675],
  ["UNHx", "BUY", 675],
  ["UNHx", "SELL", 675],
  ["CRMx", "SELL", 918],
];

test("fresh KOx, UNHx and CRMx SELL guarded transactions fit, at the recorded sizes", async () => {
  const report: string[] = [];
  for (const [symbol, direction, expected] of FRESH_SIZES) {
    const build = freshBuild(symbol, direction);
    const { wireBytes, metrics, trade } = await compose(build);
    assert.deepEqual(resolveWireTransaction(wireBytes, build.addressesByLookupTableAddress).slice(1), trade.committedSuffix);
    const research = TABLES.find((t) => t.symbol === symbol && t.direction === direction)?.researchSizes.guardedBytes;
    report.push(`${symbol} ${direction}: ${metrics.serializedTransactionBytes} B (${MAX_TRANSACTION_BYTES - metrics.serializedTransactionBytes} B headroom; M9D-A layout ${research} B + ${metrics.serializedTransactionBytes - (research ?? 0)} B for the limit instruction)`);
    assert.equal(metrics.serializedTransactionBytes, expected, `${symbol} ${direction}`);
    assert.ok(metrics.fitsSizeLimit);
    assert.equal(metrics.requiredSignatures, 1);
  }
  console.log(report.join("\n"));
});

test("CRMx BUY is refused with every reason, never trimmed into shape", async () => {
  await assert.rejects(compose(freshBuild("CRMx", "BUY")), (error) => {
    assert.ok(error instanceof UnsupportedJupiterBuildError);
    assert.deepEqual(error.reasons, ["cleanupInstruction is unsupported", "2 setup instructions; at most one is supported"]);
    return true;
  });
});

test("every unsupported /build shape is refused", async () => {
  const base = freshBuild("UNHx", "BUY");
  const swap = base.swapInstruction;
  const withSwapData = (edit: (data: Buffer) => void): BuildResponse => {
    const data = Buffer.from(swap.data, "base64");
    edit(data);
    return { ...base, swapInstruction: { ...swap, data: data.toString("base64") } };
  };
  const limit = getSetComputeUnitLimitInstruction(LIMIT);
  const apiLimit = (units: number): ApiInstruction => ({
    programId: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data: Buffer.from(getSetComputeUnitLimitInstruction(units).data ?? []).toString("base64"),
  });
  const transfer: ApiInstruction = { programId: "11111111111111111111111111111111", accounts: [], data: "AgAAAA==" };
  const cases: [string, BuildResponse, RegExp, { adapterKind?: JupiterAdapterKind; taker?: Address }?][] = [
    ["cleanup", { ...base, cleanupInstruction: transfer }, /cleanupInstruction/],
    ["other instructions", { ...base, otherInstructions: [transfer] }, /otherInstructions/],
    ["tip", { ...base, tipInstruction: transfer }, /tipInstruction/],
    ["two setups", { ...base, setupInstructions: [...base.setupInstructions, ...base.setupInstructions] }, /2 setup instructions/],
    ["unknown setup", { ...base, setupInstructions: [transfer] }, /unknown setup/],
    ["plain Create setup", { ...base, setupInstructions: [{ ...base.setupInstructions[0]!, data: "AA==" }] }, /unknown setup/],
    ["no price", { ...base, computeBudgetInstructions: [] }, /exactly one SetComputeUnitPrice/],
    ["two prices", { ...base, computeBudgetInstructions: [...base.computeBudgetInstructions, ...base.computeBudgetInstructions] }, /exactly one SetComputeUnitPrice/],
    ["heap frame request", { ...base, computeBudgetInstructions: [...base.computeBudgetInstructions, { programId: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data: "AQAAAQA=" }] }, /unsupported ComputeBudget/],
    ["a different limit", { ...base, computeBudgetInstructions: [...base.computeBudgetInstructions, apiLimit(LIMIT + 1)] }, /differs from the requested/],
    ["two limits", { ...base, computeBudgetInstructions: [...base.computeBudgetInstructions, apiLimit(LIMIT), apiLimit(LIMIT)] }, /more than one SetComputeUnitLimit/],
    ["another entrypoint", withSwapData((d) => Buffer.from("d19853937cfed8e9", "hex").copy(d, 0)), /not route_v2/],
    ["a foreign program", { ...base, swapInstruction: { ...swap, programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" } }, /not Jupiter v6/],
    ["exact out", { ...base, swapMode: "ExactOut" }, /swapMode/],
    ["the wrong direction", base, /SELL must be/, { adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC }],
    ["a non-USDC input", { ...base, inputMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }, /BUY must be/, { adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC }],
    ["another taker", base, /not the taker/, { taker: address("9UXVJAZr2hJs7rs1yf3EdKyGVkjs14YEtr8sESKoeJYn") }],
    ["a quote for another amount", { ...base, inAmount: "5000001" }, /inAmount differs/],
    ["a quote for another output", { ...base, outAmount: "1" }, /outAmount differs/],
    ["a quote with other slippage", { ...base, slippageBps: 51 }, /slippageBps differs/],
    ["a threshold the trade does not enforce", { ...base, otherAmountThreshold: "1" }, /otherAmountThreshold/],
  ];
  assert.ok(limit.data);
  for (const [label, build, reason, overrides] of cases) {
    await assert.rejects(compose(build, overrides), (error) => error instanceof UnsupportedJupiterBuildError && error.reasons.some((r) => reason.test(r)), label);
  }
  // A fee the build carries is caught by the client's copy of the program's
  // rules, with the program's own error name.
  const fee = withSwapData((d) => d.writeUInt16LE(25, 26));
  await assert.rejects(compose(fee), (error) => error instanceof Error && "guardError" in error && error.guardError === "UnsupportedJupiterFee");
});

test("a Jupiter-supplied limit equal to the requested one is used once, not duplicated", async () => {
  const base = freshBuild("KOx", "SELL");
  const apiLimit: ApiInstruction = {
    programId: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data: Buffer.from(getSetComputeUnitLimitInstruction(LIMIT).data ?? []).toString("base64"),
  };
  const { trade } = await compose({ ...base, computeBudgetInstructions: [apiLimit, ...base.computeBudgetInstructions] });
  assert.equal(trade.instructions.filter((i) => i.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS).length, 2);
  assert.equal(trade.instructions[1]?.data?.[0], 3, "price stays first");
});

test("a lookup table resolving differently from the one compiled against is detected", async () => {
  const build = freshBuild("KOx", "BUY");
  const { wireBytes, trade } = await compose(build);
  const [table, entries] = Object.entries(build.addressesByLookupTableAddress)[0] as [string, readonly string[]];
  const used = entries.findIndex((entry) => trade.committedSuffix.some((i) => i.accounts.some((a) => a.address === entry)));
  const swapped = entries.map((entry, i) => (i === used ? filler(99, 99) : entry));
  const resolved = resolveWireTransaction(wireBytes, { [table]: swapped });
  assert.notDeepEqual(resolved.slice(1), trade.committedSuffix);
  assert.throws(() => resolveWireTransaction(wireBytes, {}), CompositionError);
});
