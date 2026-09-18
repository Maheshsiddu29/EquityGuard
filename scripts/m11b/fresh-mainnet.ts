#!/usr/bin/env node
/**
 * M11-B fresh, READ-ONLY mainnet check of the six known representations, and
 * an optional fresh Jupiter `/build` matrix.
 *
 * State: one `getMultipleAccounts` (the six mints, the Clock and the devnet
 * guard address) at `confirmed`, after the genesis hash confirms mainnet.
 * Each mint goes through the frozen SDK's resolver and decoders and the
 * representation-state classifier, and is compared with the committed
 * fixtures (slot 446827429) and the end of the sealed capture.
 *
 * Builds (`--jupiter`): read-only GET /swap/v2/build, paced. Each response is
 * then composed OFFLINE by `protectJupiterSwap` against the FRESH mint bytes
 * and Clock, with the reviewed devnet program standing in for a deployment —
 * there is none on mainnet — so the result speaks to grammar support and
 * transaction size only. A route existing says nothing about its price, and a
 * snapshot says nothing about tomorrow.
 *
 * Nothing is signed or sent. The RPC URL and API key are read from the
 * environment and never printed.
 *
 *   node --env-file=.env scripts/m11b/fresh-mainnet.ts [--jupiter] [--out tmp/m11b/fresh]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { address, createSolanaRpc } from "@solana/kit";
import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  KNOWN_PROTECTED_ASSETS,
  SOLANA_GENESIS_HASH,
  SYSVAR_CLOCK_ADDRESS,
  decodeClock,
  decodeMintMetadata,
  hasScheduledChange,
  phaseAt,
  resolveProtectionAdapter,
  type ProtectedState,
} from "@equityguard/guard-client";
import { classifyChainEvidence, observeMintAccount } from "@equityguard/representation-state";

import { fetchBuild, readJupiterApiKey } from "../../packages/jupiter/src/build-client.ts";
import { protectJupiterSwap, supportsJupiterSwap, USDC_MINT_ADDRESS } from "../../packages/jupiter/src/protect.ts";
import { fakeRpc, mainnetMint, token2022Account } from "../../packages/jupiter/test/protect-fixtures.ts";

/** End of the sealed capture (2026-09-15T00:59:47.668Z, slot 447119122), docs/m10a §2. */
const SEALED_END: Record<string, { multiplier: number; newMultiplier: number; t: bigint }> = {
  KOx: { multiplier: 1.0183317967386898, newMultiplier: 1.0225601246249238, t: 1789432200n },
  KOon: { multiplier: 1.0238905041551842, newMultiplier: 1.0238905041551842, t: 1789430644n },
  UNHx: { multiplier: 1.0229655423325776, newMultiplier: 1.0273478685368111, t: 1789173000n },
  UNHon: { multiplier: 1.023046908690707, newMultiplier: 1.023046908690707, t: 1789344245n },
  CRMx: { multiplier: 1.0036630653273484, newMultiplier: 1.0054716788543585, t: 1781137800n },
  CRMon: { multiplier: 1.005894625750097, newMultiplier: 1.005894625750097, t: 1788344044n },
};
const TAKER = address("AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH");
const WINDOW = { beforeSecs: 900, afterSecs: 300 };

const f64 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sameState = (a: ProtectedState, b: { multiplier: number; newMultiplier: number; t: bigint }) =>
  f64(a.multiplier) === b.multiplier && f64(a.newMultiplier) === b.newMultiplier && a.newMultiplierEffectiveTimestamp === b.t;
const redact = (text: string, secrets: readonly string[]) => secrets.reduce((t, s) => (s ? t.replaceAll(s, "<redacted>") : t), text).replace(/https?:\/\/\S+/g, "<url>");

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { jupiter: { type: "boolean" }, out: { type: "string" } } });
  const url = process.env.EQUITYGUARD_MAINNET_RPC_URL;
  if (!url) throw new Error("EQUITYGUARD_MAINNET_RPC_URL is not set");
  const rpc = createSolanaRpc(url);
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== SOLANA_GENESIS_HASH["mainnet-beta"]) throw new Error("the configured RPC is not mainnet-beta; refusing");

  const mints = KNOWN_PROTECTED_ASSETS.map((a) => a.mint);
  const { context, value } = await rpc
    .getMultipleAccounts([...mints, SYSVAR_CLOCK_ADDRESS, EQUITY_GUARD_DEVNET_PROGRAM_ID], { encoding: "base64", commitment: "confirmed" })
    .send();
  const observedAt = new Date().toISOString();
  const clockAccount = value[mints.length];
  if (!clockAccount) throw new Error("Clock sysvar not returned");
  const clock = decodeClock(Uint8Array.from(Buffer.from(clockAccount.data[0], "base64")));
  const guardOnMainnet = value[mints.length + 1];

  const representations = KNOWN_PROTECTED_ASSETS.map((asset, i) => {
    const account = value[i];
    if (!account) return { symbol: asset.symbol, exists: false };
    const data = Uint8Array.from(Buffer.from(account.data[0], "base64"));
    const resolution = resolveProtectionAdapter({ mint: asset.mint, owner: account.owner, data });
    const evidence = observeMintAccount({ mint: asset.mint, owner: account.owner, data, slot: context.slot, blockTime: null, observedAt, chainUnixTimestamp: clock.unixTimestamp });
    const classify = (beforeSecs: bigint, afterSecs: bigint) => classifyChainEvidence(evidence, { beforeSecs, afterSecs, calibration: "UNCALIBRATED", basis: "M11-B fresh check" });
    const fixture = resolveProtectionAdapter({ mint: asset.mint, owner: account.owner, data: mainnetMint(asset.symbol) });
    const base = { symbol: asset.symbol, issuer: asset.issuer, mint: asset.mint, exists: true, owner: account.owner, dataLength: data.length, resolution: resolution.kind, registryAgrees: resolution.kind === "SUPPORTED" && resolution.knownAsset?.symbol === asset.symbol && resolution.knownAsset.issuer === asset.issuer, dataBase64: account.data[0] };
    if (resolution.kind !== "SUPPORTED") return { ...base, message: "message" in resolution ? resolution.message : null };
    const state = resolution.state;
    const metadata = decodeMintMetadata(account.owner, data);
    const phase = phaseAt(state, clock.unixTimestamp);
    const fixtureState = fixture.kind === "SUPPORTED" ? fixture.state : null;
    return {
      ...base,
      decimals: metadata.decimals,
      paused: metadata.paused,
      multiplier: f64(state.multiplier),
      multiplierHex: hex(state.multiplier),
      newMultiplier: f64(state.newMultiplier),
      newMultiplierHex: hex(state.newMultiplier),
      effectiveTimestamp: String(state.newMultiplierEffectiveTimestamp),
      effectiveTimestampIso: new Date(Number(state.newMultiplierEffectiveTimestamp) * 1000).toISOString(),
      hasScheduledChange: hasScheduledChange(state),
      phase: phase === 1 ? "activated" : "pending",
      effectiveMultiplier: f64(phase === 1 ? state.newMultiplier : state.multiplier),
      secondsSinceT: String(clock.unixTimestamp - state.newMultiplierEffectiveTimestamp),
      stateZeroWindow: classify(0n, 0n).state,
      stateDemoWindow: classify(900n, 300n).state,
      unchangedSinceSealedCaptureEnd: sameState(state, SEALED_END[asset.symbol]!),
      unchangedSinceCommittedFixture: fixtureState !== null && hex(fixtureState.multiplier) === hex(state.multiplier) && hex(fixtureState.newMultiplier) === hex(state.newMultiplier) && fixtureState.newMultiplierEffectiveTimestamp === state.newMultiplierEffectiveTimestamp,
    };
  });

  let jupiter: unknown = "skipped: pass --jupiter with JUPITER_API_KEY set";
  if (values.jupiter) {
    const apiKey = readJupiterApiKey(process.env);
    const rows: unknown[] = [];
    for (const asset of KNOWN_PROTECTED_ASSETS) {
      const index = KNOWN_PROTECTED_ASSETS.indexOf(asset);
      const account = value[index];
      for (const direction of ["BUY", "SELL"] as const) {
        const [inputMint, outputMint] = direction === "BUY" ? [USDC_MINT_ADDRESS, asset.mint] : [asset.mint, USDC_MINT_ADDRESS];
        // 5 USDC in; out, 0.05 xStock (8 decimals) or 0.005 Ondo token (9 decimals).
        const amount = 5_000_000n;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const row: Record<string, unknown> = { symbol: asset.symbol, issuer: asset.issuer, direction, amountRaw: String(amount) };
        try {
          const build = await fetchBuild({ inputMint, outputMint, amount, taker: TAKER, slippageBps: 50 }, { apiKey });
          row.routeExists = true;
          row.routeLabels = build.routePlan.map((leg) => (leg as { swapInfo?: { label?: string } }).swapInfo?.label ?? null);
          row.shape = { setup: build.setupInstructions.length, cleanup: build.cleanupInstruction !== null, other: build.otherInstructions.length, tip: build.tipInstruction !== null, swapProgram: build.swapInstruction.programId, lookupTables: Object.keys(build.addressesByLookupTableAddress).length };
          const mintAccounts = account ? { [asset.mint]: token2022Account(Uint8Array.from(Buffer.from(account.data[0], "base64"))) } : {};
          const offline = fakeRpc({ accounts: mintAccounts, unixTimestamp: clock.unixTimestamp }).rpc;
          const support = await supportsJupiterSwap({ build, rpc: offline });
          row.structurallySupported = support.supported;
          const result = await protectJupiterSwap({ build, userPublicKey: TAKER, rpc: offline, protectionWindow: WINDOW });
          row.composedStatus = result.status;
          if (result.status === "PROTECTED") {
            row.guardedBytes = result.metrics.serializedTransactionBytes;
            row.headroomBytes = 1232 - result.metrics.serializedTransactionBytes;
            row.instructions = result.metrics.instructionCount;
            row.staticAccounts = result.metrics.staticAccountCount;
            row.lookedUp = result.metrics.lookedUpAddressCount;
          } else {
            row.refusal = "code" in result ? result.code : "reason" in result ? result.reason : null;
            row.details = "details" in result ? result.details : [];
            row.guardError = "guardError" in result ? result.guardError : null;
          }
        } catch (error) {
          row.routeExists = false;
          row.error = redact(error instanceof Error ? error.message : String(error), [apiKey, url]).slice(0, 240);
        }
        rows.push(row);
      }
    }
    jupiter = { composedAgainst: "reviewed devnet program as a stand-in; EquityGuard is not deployed on mainnet", window: WINDOW, taker: TAKER, rows };
  }

  const report = {
    kind: "equityguard-m11b-fresh-mainnet",
    observedAt,
    cluster: "mainnet-beta (genesis hash verified)",
    contextSlot: String(context.slot),
    clockSlot: String(clock.slot),
    clockUnixTimestamp: String(clock.unixTimestamp),
    clockIso: new Date(Number(clock.unixTimestamp) * 1000).toISOString(),
    devnetGuardAddressOnMainnet: guardOnMainnet ? { exists: true, executable: guardOnMainnet.executable, owner: guardOnMainnet.owner } : { exists: false },
    representations,
    jupiter,
  };
  const outDir = values.out ?? "tmp/m11b/fresh";
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `fresh-mainnet-${observedAt.replaceAll(":", "")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ ...report, representations: representations.map((r) => ({ ...r, dataBase64: undefined })), savedTo: path }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? redact(error.message, [process.env.EQUITYGUARD_MAINNET_RPC_URL ?? "", process.env.JUPITER_API_KEY ?? ""]) : "failed");
    process.exitCode = 1;
  });
}
