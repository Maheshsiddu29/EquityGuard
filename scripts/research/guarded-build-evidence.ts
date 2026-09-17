/**
 * M9D-B2 BUILD-ONLY mainnet evidence for adapter kinds 2/3: fresh Jupiter
 * `/swap/v2/build` responses for the supported xStocks, composed guard-first
 * against the live mainnet mint state, compiled with Jupiter's lookup tables,
 * and checked by the client model on the resolved wire bytes.
 *
 * Read-only by construction: it holds no keypair, signs nothing and submits
 * nothing. Mainnet is only read (mint + Clock, and the guard program ID's
 * account). The `taker` is a public build-only address.
 *
 * Usage:
 *   node --env-file=.env scripts/research/guarded-build-evidence.ts [--out tmp/m9d-b2]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { address, createSolanaRpc, type Address } from "@solana/kit";

import {
  DownstreamAdapterKind,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  USDC_MINT_ADDRESS,
  checkGuardedJupiterTransaction,
  expectationFromSnapshot,
  fetchGuardSnapshot,
  type JupiterAdapterKind,
} from "../../packages/guard-client/src/index.ts";
import { JupiterApiError, fetchBuild, readJupiterApiKey } from "../../packages/jupiter/src/build-client.ts";
import { UnsupportedJupiterBuildError, composeGuardedJupiterTrade, resolveWireTransaction } from "../../packages/jupiter/src/compose.ts";
import { findRepresentationBySymbol } from "../../packages/representation-state/src/registry.ts";
import { toJson } from "../devnet/evidence.ts";

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** The symbols M9D-A recorded; CRMx BUY is the known unsupported shape. */
const SYMBOLS = ["KOx", "UNHx", "CRMx"] as const;
const DIRECTIONS = ["BUY", "SELL"] as const;
/** Public, build-only taker. No key for it exists in this repository. */
const TAKER = address("AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH");
const AMOUNT = 5_000_000n;
const SLIPPAGE_BPS = 50;
const COMPUTE_UNIT_LIMIT = 400_000;
const WINDOW = { beforeSecs: 900, afterSecs: 300 } as const;
const REQUEST_PAUSE_MS = 2_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex === -1 ? "tmp/m9d-b2" : (process.argv[outIndex + 1] as string);
  const apiKey = readJupiterApiKey(process.env);
  const rpcUrl = process.env.EQUITYGUARD_MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("EQUITYGUARD_MAINNET_RPC_URL is required (read-only mainnet reads)");
  const rpc = createSolanaRpc(rpcUrl);
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash !== MAINNET_GENESIS_HASH) throw new Error(`RPC genesis ${genesisHash} is not mainnet-beta`);

  const programAddress = address(EQUITY_GUARD_DEVNET_PROGRAM_ID);
  const programAccount = await rpc.getAccountInfo(programAddress, { encoding: "base64" }).send();
  const guardProgramOnMainnet = programAccount.value === null ? null : { owner: programAccount.value.owner, executable: programAccount.value.executable };
  console.log(`guard program ${programAddress} on mainnet: ${guardProgramOnMainnet === null ? "absent" : toJson(guardProgramOnMainnet)}`);

  const results: unknown[] = [];
  for (const symbol of SYMBOLS) {
    const representation = findRepresentationBySymbol(symbol);
    if (!representation) throw new Error(`${symbol} is not in the registry`);
    const mint: Address = representation.mint;
    for (const direction of DIRECTIONS) {
      const adapterKind: JupiterAdapterKind =
        direction === "BUY" ? DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC : DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC;
      const [inputMint, outputMint] = direction === "BUY" ? [USDC_MINT_ADDRESS, mint] : [mint, USDC_MINT_ADDRESS];
      const base = { symbol, direction, adapterKind, protectedMint: mint, inputMint, outputMint, amountRaw: AMOUNT, taker: TAKER };
      await sleep(REQUEST_PAUSE_MS);

      let build;
      try {
        build = await fetchBuild({ inputMint, outputMint, amount: AMOUNT, taker: TAKER, slippageBps: SLIPPAGE_BPS }, { apiKey });
      } catch (error) {
        const reason = error instanceof JupiterApiError ? `HTTP ${String(error.status)}: ${error.message}` : String(error);
        results.push({ ...base, outcome: "NO_BUILD", reason });
        console.log(`${symbol} ${direction}: no build (${reason})`);
        continue;
      }
      const snapshot = await fetchGuardSnapshot(rpc, mint);
      const expectation = expectationFromSnapshot(snapshot, WINDOW);
      const buildSummary = {
        inAmount: build.inAmount,
        outAmount: build.outAmount,
        otherAmountThreshold: build.otherAmountThreshold,
        slippageBps: build.slippageBps,
        routeLabels: build.routePlan.map((step) => step.swapInfo.label),
        setupInstructions: build.setupInstructions.length,
        cleanupInstruction: build.cleanupInstruction !== null,
        otherInstructions: build.otherInstructions.length,
        tipInstruction: build.tipInstruction !== null,
      };
      const snapshotSummary = {
        contextSlot: snapshot.contextSlot,
        chainUnixTimestamp: snapshot.clock.unixTimestamp,
        multiplierHex: hex(snapshot.state.multiplier),
        newMultiplierHex: hex(snapshot.state.newMultiplier),
        newMultiplierEffectiveTimestamp: snapshot.state.newMultiplierEffectiveTimestamp,
        phase: snapshot.phase === 0 ? "pending" : "activated",
      };

      try {
        const composed = await composeGuardedJupiterTrade({
          build,
          programAddress,
          feePayer: TAKER,
          taker: TAKER,
          protectedMint: mint,
          adapterKind,
          expectation,
          computeUnitLimit: COMPUTE_UNIT_LIMIT,
        });
        // Independent re-check on the decoded wire bytes, not the builder's instruction list.
        const resolved = resolveWireTransaction(composed.wireBytes, build.addressesByLookupTableAddress);
        const wireVerdict = await checkGuardedJupiterTransaction({
          instructions: resolved,
          guardIndex: 0,
          adapterKind,
          protectedMint: mint,
          commitment: composed.trade.commitment,
        });
        results.push({
          ...base,
          outcome: wireVerdict === null ? "COMPOSED" : "COMPOSED_BUT_WIRE_REJECTED",
          wireVerdict,
          build: buildSummary,
          snapshot: snapshotSummary,
          guardDataHex: hex(Uint8Array.from(composed.trade.guard.data ?? [])),
          binding: composed.binding,
          metrics: composed.metrics,
          programs: resolved.map((i) => i.programAddress),
          unsignedWireBase64: Buffer.from(composed.wireBytes).toString("base64"),
        });
        console.log(
          `${symbol} ${direction}: composed, ${composed.metrics.serializedTransactionBytes} bytes, ` +
            `${resolved.length} instructions, wire verdict ${wireVerdict ?? "accept"}, route ${buildSummary.routeLabels.join(" > ")}`,
        );
      } catch (error) {
        const reasons = error instanceof UnsupportedJupiterBuildError ? error.reasons : [error instanceof Error ? error.message : String(error)];
        results.push({ ...base, outcome: "REFUSED", reasons, build: buildSummary, snapshot: snapshotSummary });
        console.log(`${symbol} ${direction}: refused (${reasons.join("; ")})`);
      }
    }
  }

  await mkdir(outDir, { recursive: true });
  const recordedAt = new Date().toISOString();
  const path = join(outDir, `mainnet-build-only-${recordedAt.replaceAll(":", "")}.json`);
  const report = {
    description:
      "M9D-B2 BUILD-ONLY mainnet evidence. Fresh Jupiter /swap/v2/build responses composed guard-first; unsigned; nothing was signed or submitted. The guard program is not deployed on mainnet.",
    recordedAt,
    endpoint: "GET https://api.jup.ag/swap/v2/build",
    guardProgramOnMainnet,
    computeUnitLimit: COMPUTE_UNIT_LIMIT,
    window: WINDOW,
    results,
  };
  await writeFile(path, `${toJson(report)}\n`, { flag: "wx" });
  console.log(`evidence written to ${path}`);
}

main().catch((error: unknown) => {
  console.error(`[guarded-build-evidence] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
