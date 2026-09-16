/**
 * M9D-A research tooling: fresh, read-only Jupiter route discovery and build
 * inspection for every registered representation.
 *
 * Read-only by construction: it calls `GET /swap/v2/build`, decodes what comes
 * back, compiles unsigned v0 transactions to measure them, and writes a JSON
 * report. It holds no keypair, signs nothing and submits nothing. The `taker`
 * is a public address used only because `/build` requires one.
 *
 * Usage:
 *   node --env-file=.env scripts/research/jupiter-route-matrix.ts \
 *     [--amount 5000000] [--taker <address>] [--out tmp/m9d-a]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AccountRole, address, type Address, type Instruction } from "@solana/kit";

import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../../packages/guard-client/src/index.ts";
import { JupiterApiError, fetchBuild, readJupiterApiKey, type BuildResponse } from "../../packages/jupiter/src/build-client.ts";
import { toKitInstruction } from "../../packages/jupiter/src/compose.ts";
import { listUnderlyings } from "../../packages/representation-state/src/registry.ts";
import { compileAndDecode, decodeApiInstruction, INSTRUCTIONS_SYSVAR_ID, type DecodedInstruction } from "./decode-build.ts";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** ABI v2 `assert_safe_execution` payload length. */
const ABI_V2_LEN = 99;
/**
 * Architecture B sizing: an adapter instruction that states the trade
 * explicitly — protected mint, direction, both mints, amount, minimum output,
 * destination, Jupiter program, route commitment — and then CPIs into Jupiter.
 * 32*5 pubkeys + 8 + 8 + 1 direction + 1 version + 1 adapter kind + 32 digest.
 */
const ADAPTER_PAYLOAD_LEN = 211;
/** Placeholder adapter program, so the size model needs no deployed address. */
const ADAPTER_PROGRAM_PLACEHOLDER = "EqGdAdapter111111111111111111111111111111111";
/** Public, build-only taker. No key for it exists in this repository. */
const DEFAULT_TAKER = "AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH";
const SLIPPAGE_BPS = 50;
const MAX_TRANSACTION_BYTES = 1232;

interface Args {
  readonly amount: bigint;
  readonly taker: string;
  readonly out: string;
  /** Only these symbols, when given; otherwise the whole registry. */
  readonly only: readonly string[] | null;
  /** Pause between requests, so a 429 is never mistaken for "no route". */
  readonly delayMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    amount: BigInt(get("amount") ?? "5000000"),
    taker: get("taker") ?? process.env.EQUITYGUARD_RESEARCH_TAKER ?? DEFAULT_TAKER,
    out: get("out") ?? "tmp/m9d-a",
    only: get("only") ? (get("only") as string).split(",") : null,
    delayMs: Number(get("delay-ms") ?? "2500"),
  };
}

/** A synthetic ABI v2 guard instruction. Only its shape affects transaction size. */
function guardInstruction(mint: Address): Instruction {
  return {
    programAddress: address(EQUITY_GUARD_DEVNET_PROGRAM_ID),
    accounts: [
      { address: mint, role: AccountRole.READONLY },
      { address: address(INSTRUCTIONS_SYSVAR_ID), role: AccountRole.READONLY },
    ],
    data: new Uint8Array(ABI_V2_LEN).fill(2),
  };
}

function jupiterInstructions(build: BuildResponse): Instruction[] {
  return [
    ...build.computeBudgetInstructions.map(toKitInstruction),
    ...build.setupInstructions.map(toKitInstruction),
    toKitInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toKitInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toKitInstruction),
    ...(build.tipInstruction ? [toKitInstruction(build.tipInstruction)] : []),
  ];
}

/** Guarded layout: the guard sits immediately before the Jupiter swap instruction. */
function guardedInstructions(build: BuildResponse, mint: Address): Instruction[] {
  return [
    ...build.computeBudgetInstructions.map(toKitInstruction),
    ...build.setupInstructions.map(toKitInstruction),
    guardInstruction(mint),
    toKitInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toKitInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toKitInstruction),
    ...(build.tipInstruction ? [toKitInstruction(build.tipInstruction)] : []),
  ];
}

/**
 * Architecture B layout: the guard commits to an adapter instruction, which
 * carries every Jupiter account so it can CPI into the swap. The swap
 * instruction itself is no longer top-level.
 */
function adapterInstructions(build: BuildResponse, mint: Address): Instruction[] {
  const swap = toKitInstruction(build.swapInstruction);
  const adapter: Instruction = {
    programAddress: address(ADAPTER_PROGRAM_PLACEHOLDER),
    accounts: [{ address: swap.programAddress, role: AccountRole.READONLY }, ...(swap.accounts ?? [])],
    data: new Uint8Array(ADAPTER_PAYLOAD_LEN).fill(3),
  };
  return [
    ...build.computeBudgetInstructions.map(toKitInstruction),
    ...build.setupInstructions.map(toKitInstruction),
    guardInstruction(mint),
    adapter,
    ...(build.cleanupInstruction ? [toKitInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toKitInstruction),
    ...(build.tipInstruction ? [toKitInstruction(build.tipInstruction)] : []),
  ];
}

interface Attempt {
  readonly symbol: string;
  readonly underlying: string;
  readonly issuer: string;
  readonly direction: "BUY" | "SELL";
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputRaw: string;
  readonly routeAvailable: boolean;
  readonly buildSucceeded: boolean;
  readonly error: string | null;
  readonly quote: {
    readonly inAmount: string;
    readonly outAmount: string;
    readonly otherAmountThreshold: string;
    readonly swapMode: string;
    readonly slippageBps: number;
    readonly routeLegs: readonly { readonly percent: number; readonly label: string; readonly ammKey: string; readonly inputMint: string; readonly outputMint: string; readonly inAmount: string; readonly outAmount: string }[];
  } | null;
  readonly layout: {
    readonly computeBudget: number;
    readonly setup: number;
    readonly cleanup: number;
    readonly other: number;
    readonly tip: number;
    readonly swapProgramId: string;
    readonly swapAccountCount: number;
    readonly swapDataLen: number;
    readonly swapDiscriminatorHex: string | null;
    readonly lookupTables: readonly string[];
  } | null;
  readonly sizes: {
    readonly baselineBytes: number;
    readonly guardedBytes: number;
    readonly deltaBytes: number;
    readonly adapterBytes: number;
    readonly adapterDeltaBytes: number;
    readonly baselineFits: boolean;
    readonly guardedFits: boolean;
    readonly adapterFits: boolean;
    readonly headroomBytes: number;
    readonly adapterHeadroomBytes: number;
  } | null;
  readonly apiInstructions: readonly DecodedInstruction[] | null;
  readonly resolvedGuarded: readonly DecodedInstruction[] | null;
}

async function attempt(
  meta: { symbol: string; underlying: string; issuer: string; mint: string },
  direction: "BUY" | "SELL",
  amount: bigint,
  taker: string,
  apiKey: string,
): Promise<Attempt> {
  const inputMint = direction === "BUY" ? USDC_MINT : meta.mint;
  const outputMint = direction === "BUY" ? meta.mint : USDC_MINT;
  const base = {
    symbol: meta.symbol,
    underlying: meta.underlying,
    issuer: meta.issuer,
    direction,
    inputMint,
    outputMint,
    inputRaw: amount.toString(),
  };
  let build: BuildResponse;
  try {
    build = await fetchBuild({ inputMint, outputMint, amount, taker, slippageBps: SLIPPAGE_BPS }, { apiKey });
  } catch (error) {
    const message = error instanceof JupiterApiError ? `${error.name}(${String(error.status)}): ${error.message}` : String(error);
    return { ...base, routeAvailable: false, buildSucceeded: false, error: message, quote: null, layout: null, sizes: null, apiInstructions: null, resolvedGuarded: null };
  }

  const guardMint = address(meta.mint);
  const feePayer = address(taker);
  const baseline = compileAndDecode(build, feePayer, jupiterInstructions(build));
  const guarded = compileAndDecode(build, feePayer, guardedInstructions(build, guardMint));
  const adapter = compileAndDecode(build, feePayer, adapterInstructions(build, guardMint));
  const swap = decodeApiInstruction(0, build.swapInstruction);

  const apiInstructions: DecodedInstruction[] = [];
  let i = 0;
  for (const group of [build.computeBudgetInstructions, build.setupInstructions, [build.swapInstruction], build.cleanupInstruction ? [build.cleanupInstruction] : [], build.otherInstructions, build.tipInstruction ? [build.tipInstruction] : []]) {
    for (const api of group) apiInstructions.push(decodeApiInstruction(i++, api));
  }

  return {
    ...base,
    routeAvailable: build.routePlan.length > 0,
    buildSucceeded: true,
    error: null,
    quote: {
      inAmount: build.inAmount,
      outAmount: build.outAmount,
      otherAmountThreshold: build.otherAmountThreshold,
      swapMode: build.swapMode,
      slippageBps: build.slippageBps,
      routeLegs: build.routePlan.map((step) => ({
        percent: step.percent,
        label: step.swapInfo.label,
        ammKey: step.swapInfo.ammKey,
        inputMint: step.swapInfo.inputMint,
        outputMint: step.swapInfo.outputMint,
        inAmount: step.swapInfo.inAmount,
        outAmount: step.swapInfo.outAmount,
      })),
    },
    layout: {
      computeBudget: build.computeBudgetInstructions.length,
      setup: build.setupInstructions.length,
      cleanup: build.cleanupInstruction ? 1 : 0,
      other: build.otherInstructions.length,
      tip: build.tipInstruction ? 1 : 0,
      swapProgramId: build.swapInstruction.programId,
      swapAccountCount: build.swapInstruction.accounts.length,
      swapDataLen: swap.dataLen,
      swapDiscriminatorHex: swap.discriminatorHex,
      lookupTables: Object.keys(build.addressesByLookupTableAddress),
    },
    sizes: {
      baselineBytes: baseline.serializedBytes,
      guardedBytes: guarded.serializedBytes,
      deltaBytes: guarded.serializedBytes - baseline.serializedBytes,
      adapterBytes: adapter.serializedBytes,
      adapterDeltaBytes: adapter.serializedBytes - baseline.serializedBytes,
      baselineFits: baseline.serializedBytes <= MAX_TRANSACTION_BYTES,
      guardedFits: guarded.serializedBytes <= MAX_TRANSACTION_BYTES,
      adapterFits: adapter.serializedBytes <= MAX_TRANSACTION_BYTES,
      headroomBytes: MAX_TRANSACTION_BYTES - guarded.serializedBytes,
      adapterHeadroomBytes: MAX_TRANSACTION_BYTES - adapter.serializedBytes,
    },
    apiInstructions,
    resolvedGuarded: guarded.decoded,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A 429 is a gateway limit, never evidence about routing, so it is retried
 * with backoff and only a non-429 failure is recorded as "no route".
 */
async function retryingAttempt(
  meta: { symbol: string; underlying: string; issuer: string; mint: string },
  direction: "BUY" | "SELL",
  amount: bigint,
  taker: string,
  apiKey: string,
  delayMs: number,
): Promise<Attempt> {
  let last = await attempt(meta, direction, amount, taker, apiKey);
  for (let retry = 1; retry <= 4 && last.error?.includes("(429)"); retry += 1) {
    await sleep(delayMs * 2 ** retry);
    last = await attempt(meta, direction, amount, taker, apiKey);
  }
  await sleep(delayMs);
  return last;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = readJupiterApiKey(process.env);
  const all = listUnderlyings().flatMap((u) => u.representations.map((r) => ({ symbol: r.symbol, underlying: r.underlying, issuer: r.issuer, mint: String(r.mint) })));
  const representations = args.only ? all.filter((r) => args.only?.includes(r.symbol)) : all;

  const attempts: Attempt[] = [];
  for (const representation of representations) {
    for (const direction of ["BUY", "SELL"] as const) {
      // SELL uses a raw stock amount; the BUY quote for the same asset gives a
      // comparable size when available, otherwise a fixed illustrative amount.
      const buy = attempts.find((a) => a.symbol === representation.symbol && a.direction === "BUY");
      const amount = direction === "BUY" ? args.amount : BigInt(buy?.quote?.outAmount ?? "5000000");
      const result = await retryingAttempt(representation, direction, amount, args.taker, apiKey, args.delayMs);
      attempts.push(result);
      const status = result.buildSucceeded ? `${result.quote?.outAmount} out, ${String(result.sizes?.baselineBytes)}B base / ${String(result.sizes?.guardedBytes)}B guarded / ${String(result.sizes?.adapterBytes)}B adapter` : `NO ROUTE (${result.error?.slice(0, 90)})`;
      process.stdout.write(`${representation.symbol.padEnd(6)} ${direction.padEnd(4)} ${status}\n`);
    }
  }

  const dualIssuer = listUnderlyings().map((u) => {
    const buys = u.representations.map((r) => attempts.find((a) => a.symbol === r.symbol && a.direction === "BUY"));
    return {
      underlying: u.underlying,
      representations: u.representations.map((r) => r.symbol),
      routable: buys.map((b) => Boolean(b?.buildSucceeded)),
      dualIssuerRoutable: buys.every((b) => b?.buildSucceeded === true),
    };
  });

  const report = {
    milestone: "M9D-A",
    recordedAt: new Date().toISOString(),
    readOnly: true,
    signedOrSubmitted: false,
    api: { endpoint: "GET https://api.jup.ag/swap/v2/build", auth: "x-api-key header", slippageBps: SLIPPAGE_BPS },
    request: { usdcInputRaw: args.amount.toString(), taker: args.taker },
    attempts,
    dualIssuer,
  };
  await mkdir(args.out, { recursive: true });
  const path = join(args.out, `route-matrix-${report.recordedAt.replace(/[:.]/g, "")}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nreport: ${path}\n`);
  for (const entry of dualIssuer) {
    process.stdout.write(`${entry.underlying}: dual-issuer routable = ${String(entry.dualIssuerRoutable)} (${entry.representations.join(", ")} -> ${entry.routable.join(", ")})\n`);
  }
}

await main();
