#!/usr/bin/env node
/**
 * M11-B transaction size, account and write-lock profile of guarded Jupiter
 * trades, recomputed from the current code over every real `/build` response
 * available: the committed 2026-09-14 and 2026-09-16 recordings and, when
 * present locally, the M9D-C1 replay input. (The M9D-B2 run kept only
 * summaries and cannot be recomposed.)
 *
 * For each build it compiles, with Jupiter's own lookup tables:
 *
 * - AS BUILT: Jupiter's instructions exactly as returned, unguarded;
 * - SAME SUFFIX: the normalized suffix the guard commits to
 *   (`[price, limit, (setup), route_v2]`), unguarded;
 * - GUARDED: what `protectJupiterSwap` returns.
 *
 * and compares the resolved writable-account sets, so "the guard adds no
 * write lock" is a measured fact per transaction, not an assumption.
 *
 * Build-only: nothing is signed or sent. State reads are served from the
 * committed mainnet mint accounts by the test RPC.
 *
 *   node scripts/m11b/transaction-size.ts [--out <new report.json>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { address, getBase58Decoder, type Address } from "@solana/kit";

import {
  MAX_TRANSACTION_BYTES,
  UNSIMULATED_COMPUTE_UNIT_LIMIT,
  compileAndMeasure,
  normalizedJupiterSuffix,
  parseBuildResponse,
  resolveWireTransaction,
  toKitInstruction,
  type BuildResponse,
  type TransactionMetrics,
} from "../../packages/jupiter/src/index.ts";
import { protectJupiterSwap } from "../../packages/jupiter/src/protect.ts";
import { SETTLED_TIMESTAMP, TAKER, fakeRpc, mainnetMint, recordedBuild, recordedKoxBuyBuild, token2022Account } from "../../packages/jupiter/test/protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const SYMBOL_OF: Record<string, string> = {
  XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ: "KOx",
  XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe: "UNHx",
  XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN: "CRMx",
};

export interface SizeRow {
  readonly source: string;
  readonly label: string;
  readonly status: string;
  readonly refusal: string | null;
  readonly asBuilt: TransactionMetrics;
  readonly sameSuffix: TransactionMetrics | null;
  readonly guarded: TransactionMetrics | null;
  readonly addedBytesVsAsBuilt: number | null;
  /** Guarded minus the identical unguarded suffix: the guard instruction alone. */
  readonly addedBytesByGuard: number | null;
  readonly headroomBytes: number | null;
  readonly writableAccounts: { readonly asBuilt: number; readonly sameSuffix: number | null; readonly guarded: number | null };
  /** Writable accounts present only in the guarded transaction. */
  readonly writableAddedByGuard: readonly string[] | null;
  readonly guardAccountsReadOnlyNonSigner: boolean | null;
  readonly guardAccounts: readonly string[] | null;
}

const writableSet = (wire: Uint8Array, build: BuildResponse) =>
  new Set(resolveWireTransaction(wire, build.addressesByLookupTableAddress).flatMap((i) => i.accounts.filter((a) => a.isWritable).map((a) => a.address as string)));

function asBuiltInstructions(build: BuildResponse) {
  return [
    ...build.computeBudgetInstructions,
    ...build.setupInstructions,
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...build.otherInstructions,
    ...(build.tipInstruction ? [build.tipInstruction] : []),
  ].map(toKitInstruction);
}

/** Size, accounts and write locks of one build, unguarded and guarded. */
export async function measureBuild(source: string, label: string, build: BuildResponse, taker: Address): Promise<SizeRow> {
  const protectedMint = [build.inputMint, build.outputMint].find((m) => SYMBOL_OF[m]);
  const accounts = protectedMint ? { [protectedMint]: token2022Account(mainnetMint(SYMBOL_OF[protectedMint]!)) } : {};
  const asBuilt = compileAndMeasure(build, taker, asBuiltInstructions(build));
  const result = await protectJupiterSwap({ build, userPublicKey: taker, rpc: fakeRpc({ accounts, unixTimestamp: SETTLED_TIMESTAMP }).rpc, protectionWindow: WINDOW });
  const asBuiltWritable = writableSet(asBuilt.wireBytes, build);
  if (result.status !== "PROTECTED") {
    return {
      source,
      label,
      status: result.status,
      refusal: "code" in result ? `${result.code}${"details" in result && result.details.length ? `: ${result.details.join("; ")}` : ""}` : null,
      asBuilt: asBuilt.metrics,
      sameSuffix: null,
      guarded: null,
      addedBytesVsAsBuilt: null,
      addedBytesByGuard: null,
      headroomBytes: null,
      writableAccounts: { asBuilt: asBuiltWritable.size, sameSuffix: null, guarded: null },
      writableAddedByGuard: null,
      guardAccountsReadOnlyNonSigner: null,
      guardAccounts: null,
    };
  }
  const limit = result.instructions[2]?.data ? new DataView(Uint8Array.from(result.instructions[2].data).buffer).getUint32(1, true) : UNSIMULATED_COMPUTE_UNIT_LIMIT;
  const sameSuffix = compileAndMeasure(build, taker, normalizedJupiterSuffix(build, limit));
  const suffixWritable = writableSet(sameSuffix.wireBytes, build);
  const guardedWritable = writableSet(result.transaction, build);
  const [guard] = resolveWireTransaction(result.transaction, build.addressesByLookupTableAddress);
  return {
    source,
    label,
    status: result.status,
    refusal: null,
    asBuilt: asBuilt.metrics,
    sameSuffix: sameSuffix.metrics,
    guarded: result.metrics,
    addedBytesVsAsBuilt: result.metrics.serializedTransactionBytes - asBuilt.metrics.serializedTransactionBytes,
    addedBytesByGuard: result.metrics.serializedTransactionBytes - sameSuffix.metrics.serializedTransactionBytes,
    headroomBytes: MAX_TRANSACTION_BYTES - result.metrics.serializedTransactionBytes,
    writableAccounts: { asBuilt: asBuiltWritable.size, sameSuffix: suffixWritable.size, guarded: guardedWritable.size },
    writableAddedByGuard: [...guardedWritable].filter((a) => !suffixWritable.has(a)),
    guardAccountsReadOnlyNonSigner: guard?.accounts.every((a) => !a.isWritable && !a.isSigner) ?? false,
    guardAccounts: guard?.accounts.map((a) => a.address) ?? null,
  };
}

/** The committed real builds. */
export function committedBuilds(): { source: string; label: string; build: BuildResponse; taker: Address }[] {
  const pairs = [
    ["KOx", "BUY"],
    ["KOx", "SELL"],
    ["UNHx", "BUY"],
    ["UNHx", "SELL"],
    ["CRMx", "BUY"],
    ["CRMx", "SELL"],
  ] as const;
  return [
    { source: "committed 2026-09-14 full /build", label: "KOx BUY", build: recordedKoxBuyBuild(), taker: TAKER },
    ...pairs.map(([symbol, direction]) => ({ source: "committed 2026-09-16 route_v2 recording", label: `${symbol} ${direction}`, build: recordedBuild(symbol, direction), taker: TAKER })),
  ];
}

/** Real builds kept only in the local `tmp/` evidence directories. */
export function localBuilds(root: URL): { source: string; label: string; build: BuildResponse; taker: Address }[] {
  const out: { source: string; label: string; build: BuildResponse; taker: Address }[] = [];
  const c1 = new URL("tmp/m9d-c1/route-fixture.json", root);
  if (existsSync(c1)) {
    const f = JSON.parse(readFileSync(c1, "utf8")) as { symbol: string; taker: string; build: unknown };
    out.push({ source: "local M9D-C1 replay input (2026-09-17)", label: `${f.symbol} BUY`, build: parseBuildResponse(f.build), taker: address(f.taker) });
  }
  // The M9D-B2 run kept only build summaries and guarded wire bytes (no swap
  // instruction, no lookup tables), so it cannot be recomposed with current code.
  return out;
}

/**
 * Grows a guarded build — extra read-only route accounts (33 B each), then
 * trailing route data bytes (1 B each) — until the SDK refuses it, so the
 * size limit is shown to be enforced exactly at 1232 bytes.
 */
export async function sizeBoundary(build: BuildResponse, taker: Address): Promise<{ largestAccepted: number | null; smallestRefused: number | null; refusalCode: string | null; refusalCarriesTransaction: boolean | null; extraAccounts: number; paddingBytes: number }> {
  const mint = [build.inputMint, build.outputMint].find((m) => SYMBOL_OF[m])!;
  const account = token2022Account(mainnetMint(SYMBOL_OF[mint]!));
  const attempt = (extraAccounts: number, padding: number) => {
    const accounts = [...build.swapInstruction.accounts];
    for (let i = 0; i < extraAccounts; i += 1) {
      const bytes = new Uint8Array(32).fill(0xe0);
      bytes[1] = i;
      accounts.push({ pubkey: getBase58Decoder().decode(bytes), isSigner: false, isWritable: false });
    }
    const data = Buffer.concat([Buffer.from(build.swapInstruction.data, "base64"), Buffer.alloc(padding)]).toString("base64");
    const grown = { ...build, swapInstruction: { ...build.swapInstruction, accounts, data } };
    return protectJupiterSwap({ build: grown, userPublicKey: taker, rpc: fakeRpc({ accounts: { [mint]: account }, unixTimestamp: SETTLED_TIMESTAMP }).rpc, protectionWindow: WINDOW });
  };
  let extraAccounts = 0;
  while ((await attempt(extraAccounts + 1, 0)).status === "PROTECTED") extraAccounts += 1;
  let largestAccepted: number | null = null;
  for (let padding = 0; padding <= 64; padding += 1) {
    const result = await attempt(extraAccounts, padding);
    if (result.status === "PROTECTED") {
      largestAccepted = result.metrics.serializedTransactionBytes;
      continue;
    }
    // The composer reports the guarded size it refused.
    const refusedAt = /guarded transaction is (\d+) bytes/.exec("message" in result ? result.message : "")?.[1];
    return {
      largestAccepted,
      smallestRefused: refusedAt ? Number(refusedAt) : null,
      refusalCode: "code" in result ? result.code : result.status,
      refusalCarriesTransaction: "transaction" in result,
      extraAccounts,
      paddingBytes: padding,
    };
  }
  return { largestAccepted, smallestRefused: null, refusalCode: null, refusalCarriesTransaction: null, extraAccounts, paddingBytes: -1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const root = new URL("../../", import.meta.url);
  const rows: SizeRow[] = [];
  for (const b of [...committedBuilds(), ...localBuilds(root)]) rows.push(await measureBuild(b.source, b.label, b.build, b.taker));
  const guarded = rows.filter((r) => r.guarded);
  const sizes = guarded.map((r) => r.guarded!.serializedTransactionBytes);
  const boundary = await sizeBoundary(recordedBuild("CRMx", "SELL"), TAKER);
  const report = {
    kind: "equityguard-m11b-transaction-size",
    generatedAt: new Date().toISOString(),
    limitBytes: MAX_TRANSACTION_BYTES,
    rows,
    summary: {
      builds: rows.length,
      guarded: guarded.length,
      refused: rows.length - guarded.length,
      smallestGuardedBytes: Math.min(...sizes),
      largestGuardedBytes: Math.max(...sizes),
      minimumHeadroomBytes: MAX_TRANSACTION_BYTES - Math.max(...sizes),
      addedBytesByGuard: [...new Set(guarded.map((r) => r.addedBytesByGuard))],
      anyOverLimit: guarded.some((r) => !r.guarded!.fitsSizeLimit),
      anyGuardWritable: guarded.some((r) => r.guardAccountsReadOnlyNonSigner !== true),
      anyWritableAddedByGuard: guarded.some((r) => (r.writableAddedByGuard?.length ?? 0) > 0),
    },
    boundary: { base: "CRMx SELL (2026-09-16), grown by read-only route accounts then trailing route data", ...boundary },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, json, { flag: "wx" });
  console.log(json);
}
