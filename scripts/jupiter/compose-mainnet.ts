#!/usr/bin/env node
/**
 * LIVE, READ-ONLY / BUILD-ONLY mainnet composition of EquityGuard with a real
 * Jupiter Swap V2 route for a real xStock. Nothing is signed or submitted:
 * this script has no signing or sending code, and the taker is a freshly
 * generated address whose secret key is discarded immediately.
 *
 * EquityGuard is deployed on devnet only; the guard instruction built here
 * targets the same program ID, but a mainnet transaction containing it could
 * not execute. This proves composition and sizing, not mainnet execution.
 *
 *   JUPITER_API_KEY=... EQUITYGUARD_MAINNET_RPC_URL=... \
 *     node scripts/jupiter/compose-mainnet.ts [--symbol KOx] [--amount-usdc-units 5000000] [--write-fixture]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { address, createSolanaRpc, generateKeyPairSigner, type Address } from "@solana/kit";
import {
  fetchGuardSnapshot,
  getAssertSafeExecutionInstruction,
  requestFromSnapshot,
  type GuardSnapshot,
} from "@equityguard/guard-client";
import {
  JupiterApiError,
  composeWithGuard,
  fetchBuild,
  readJupiterApiKey,
  type BuildResponse,
  type CompositionResult,
} from "@equityguard/jupiter";

/** Solana mainnet-beta genesis hash; the only cluster this script reads. */
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/** 5 USDC: small, illustrative notional. Nothing is spent. */
const DEFAULT_AMOUNT_USDC_UNITS = 5_000_000n;
const SLIPPAGE_BPS = 50;
/** Tried in order only if the guarded transaction exceeds the size limit. */
const MAX_ACCOUNTS_FALLBACKS = [48, 40, 32, 24, 16] as const;
/**
 * Illustrative protection window for the composed instruction. It changes
 * none of the size metrics (the ABI is fixed-size) and is not an issuer policy.
 */
const ILLUSTRATIVE_WINDOW = { beforeSecs: 900, afterSecs: 900 } as const;
const EQUITY_GUARD_PROGRAM_ID = address("EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT");
const WATCHLIST = new URL("../evidence/mints.example.json", import.meta.url);
const FIXTURE_DIR = new URL("../../packages/jupiter/test/fixtures/", import.meta.url);

interface Attempt {
  readonly maxAccounts: number | null;
  readonly build: BuildResponse;
  readonly composition: CompositionResult;
}

async function xStockCandidates(symbol: string | undefined): Promise<{ symbol: string; mint: Address }[]> {
  const entries = JSON.parse(await readFile(WATCHLIST, "utf8")) as { symbol: string; issuer: string; mint: string }[];
  const xstocks = entries.filter((e) => e.issuer === "xstocks");
  const preferred = ["KOx", "UNHx", "CRMx"];
  xstocks.sort((a, b) => preferred.indexOf(a.symbol) - preferred.indexOf(b.symbol));
  const selected = symbol ? xstocks.filter((e) => e.symbol === symbol) : xstocks;
  if (selected.length === 0) throw new Error(`no verified xStock ${symbol ?? ""} in the watchlist`);
  return selected.map((e) => ({ symbol: e.symbol, mint: address(e.mint) }));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function snapshotJson(snapshot: GuardSnapshot) {
  return {
    mint: snapshot.mint,
    contextSlot: snapshot.contextSlot,
    chainUnixTimestamp: snapshot.clock.unixTimestamp,
    multiplierHex: hex(snapshot.state.multiplier),
    newMultiplierHex: hex(snapshot.state.newMultiplier),
    newMultiplierEffectiveTimestamp: snapshot.state.newMultiplierEffectiveTimestamp,
    phase: snapshot.phase === 0 ? "pending" : "activated",
    hasScheduledChange: snapshot.hasScheduledChange,
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: "string" },
      "amount-usdc-units": { type: "string" },
      "write-fixture": { type: "boolean", default: false },
    },
  });
  const apiKey = readJupiterApiKey(process.env);
  const rpcUrl = process.env.EQUITYGUARD_MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("EQUITYGUARD_MAINNET_RPC_URL is not set");
  const rpc = createSolanaRpc(rpcUrl);
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== MAINNET_GENESIS_HASH) throw new Error(`RPC is not mainnet-beta (genesis ${genesis})`);

  const amount = values["amount-usdc-units"] ? BigInt(values["amount-usdc-units"]) : DEFAULT_AMOUNT_USDC_UNITS;
  // Build-only taker: the secret key never leaves this process and is never stored.
  const taker = (await generateKeyPairSigner()).address;
  const noRoute: { symbol: string; error: string }[] = [];

  for (const candidate of await xStockCandidates(values.symbol)) {
    // Real, current mainnet state read at one slot with the Clock sysvar.
    const snapshot = await fetchGuardSnapshot(rpc, candidate.mint);
    const guard = {
      mint: candidate.mint,
      instruction: getAssertSafeExecutionInstruction({
        programAddress: EQUITY_GUARD_PROGRAM_ID,
        mint: candidate.mint,
        request: requestFromSnapshot(snapshot, ILLUSTRATIVE_WINDOW),
      }),
    };

    const attempts: Attempt[] = [];
    const recordedAt = new Date().toISOString();
    const baseRequest = { inputMint: USDC_MINT, outputMint: candidate.mint, amount, taker, slippageBps: SLIPPAGE_BPS };
    let build: BuildResponse;
    try {
      build = await fetchBuild(baseRequest, { apiKey });
    } catch (error) {
      if (!(error instanceof JupiterApiError)) throw error;
      noRoute.push({ symbol: candidate.symbol, error: error.message });
      console.error(`[jupiter] ${candidate.symbol}: no usable /build response: ${error.message}`);
      continue;
    }
    attempts.push({ maxAccounts: null, build, composition: composeWithGuard(build, taker, guard) });

    for (const maxAccounts of MAX_ACCOUNTS_FALLBACKS) {
      if (attempts.at(-1)?.composition.guarded.fitsSizeLimit) break;
      const retried = await fetchBuild({ ...baseRequest, maxAccounts }, { apiKey });
      attempts.push({ maxAccounts, build: retried, composition: composeWithGuard(retried, taker, guard) });
    }

    const report = {
      kind: "equityguard-jupiter-mainnet-composition",
      disclaimer:
        "Build-only. No transaction was signed or submitted. EquityGuard is not deployed on mainnet, so this proves composition and sizing only.",
      recordedAt,
      cluster: "mainnet-beta",
      equity: { symbol: candidate.symbol, issuer: "xstocks", ...snapshotJson(snapshot) },
      guard: {
        programId: EQUITY_GUARD_PROGRAM_ID,
        programDeployedOn: "devnet only",
        instructionDataHex: hex(Uint8Array.from(guard.instruction.data ?? [])),
        window: ILLUSTRATIVE_WINDOW,
      },
      taker: { address: taker, note: "ephemeral build-only address; secret key discarded" },
      attempts: attempts.map((a) => ({
        maxAccounts: a.maxAccounts,
        quote: {
          inputMint: a.build.inputMint,
          outputMint: a.build.outputMint,
          inAmount: a.build.inAmount,
          outAmount: a.build.outAmount,
          otherAmountThreshold: a.build.otherAmountThreshold,
          slippageBps: a.build.slippageBps,
          swapMode: a.build.swapMode,
        },
        route: a.build.routePlan.map((s) => ({
          label: s.swapInfo.label,
          ammKey: s.swapInfo.ammKey,
          percent: s.percent,
          inputMint: s.swapInfo.inputMint,
          outputMint: s.swapInfo.outputMint,
        })),
        instructionGroups: {
          computeBudget: a.build.computeBudgetInstructions.length,
          setup: a.build.setupInstructions.length,
          cleanup: a.build.cleanupInstruction !== null,
          other: a.build.otherInstructions.length,
          tip: a.build.tipInstruction !== null,
        },
        lookupTables: Object.keys(a.build.addressesByLookupTableAddress).length,
        lastValidBlockHeight: a.build.blockhashWithMetadata.lastValidBlockHeight,
        ...a.composition,
      })),
      noRoute,
    };

    await mkdir(new URL("../../evidence/jupiter/", import.meta.url), { recursive: true });
    const evidencePath = join("evidence", "jupiter", `${recordedAt.replaceAll(":", "")}-${candidate.symbol}.json`);
    await writeFile(evidencePath, `${toJson(report)}\n`);

    if (values["write-fixture"]) {
      // The final attempt is the one that fits (or the last fallback tried).
      const recorded = attempts.at(-1);
      if (!recorded) throw new Error("no attempt to record");
      await mkdir(FIXTURE_DIR, { recursive: true });
      const fixture = {
        description:
          "Recorded Jupiter Swap V2 /build response (no API key, no secrets) plus the real mainnet xStock snapshot it was composed with. Routes change; this is a point-in-time fixture.",
        recordedAt,
        request: { ...baseRequest, amount: amount.toString(), maxAccounts: recorded.maxAccounts },
        snapshot: snapshotJson(snapshot),
        guardInstructionDataHex: report.guard.instructionDataHex,
        expectedComposition: recorded.composition,
        response: recorded.build,
      };
      await writeFile(new URL(`${candidate.symbol}-usdc-build.json`, FIXTURE_DIR), `${toJson(fixture)}\n`);
    }

    console.log(toJson({ evidencePath, ...report }));
    return;
  }
  throw new Error(`no xStock produced a Jupiter route: ${toJson(noRoute)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[jupiter] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
