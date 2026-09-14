#!/usr/bin/env node
/**
 * EquityGuard devnet tooling. Devnet only; see docs/devnet.md.
 *
 *   node scripts/devnet/cli.ts create-mints
 *   node scripts/devnet/cli.ts schedule --label EQ-A --multiplier 1.25 --in-seconds 120
 *   node scripts/devnet/cli.ts snapshot --label EQ-A
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { generateKeyPairSigner } from "@solana/kit";
import { fetchGuardSnapshot, type GuardSnapshot } from "@equityguard/guard-client";

import { connectDevnet, readDevnetConfig, type DevnetContext } from "./config.ts";
import {
  TEST_ASSET_DISCLOSURE,
  findAsset,
  loadDevnetState,
  saveDevnetState,
  type TestAsset,
} from "./devnet-state.ts";
import { sendInstructions } from "./send.ts";
import {
  getCreateTestMintInstructions,
  getMintTestBalanceInstructions,
  getScheduleMultiplierInstruction,
  testMintSpace,
  type TestMintSpec,
} from "./test-mint.ts";

/** Fictional stock both test assets represent. */
const CONCEPTUAL_STOCK = "DEMO (fictional equity for EquityGuard devnet tests)";
const TEST_MINT_DECIMALS = 6;
const INITIAL_MULTIPLIER = 1;
/** 1,000 whole tokens at 6 decimals, for later swap milestones. */
const TEST_BALANCE = 1_000_000_000n;
const TEST_MINT_SPECS: readonly TestMintSpec[] = [
  { label: "EQ-A", decimals: TEST_MINT_DECIMALS, initialMultiplier: INITIAL_MULTIPLIER },
  { label: "EQ-B", decimals: TEST_MINT_DECIMALS, initialMultiplier: INITIAL_MULTIPLIER },
];

/** Prints bigint-safe JSON. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export function describeSnapshot(snapshot: GuardSnapshot) {
  const float = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  return {
    mint: snapshot.mint,
    contextSlot: snapshot.contextSlot,
    chainUnixTimestamp: snapshot.clock.unixTimestamp,
    localWallclockForReferenceOnly: new Date().toISOString(),
    multiplierHex: Buffer.from(snapshot.state.multiplier).toString("hex"),
    multiplierForDisplay: float(snapshot.state.multiplier),
    newMultiplierHex: Buffer.from(snapshot.state.newMultiplier).toString("hex"),
    newMultiplierForDisplay: float(snapshot.state.newMultiplier),
    newMultiplierEffectiveTimestamp: snapshot.state.newMultiplierEffectiveTimestamp,
    phase: snapshot.phase === 0 ? "pending" : "activated",
    hasScheduledChange: snapshot.hasScheduledChange,
  };
}

async function createMints(ctx: DevnetContext): Promise<void> {
  const state = await loadDevnetState();
  if (state.assets.length > 0) {
    throw new Error("devnet.json already lists test assets; remove them to regenerate (see docs/devnet.md)");
  }
  const assets: TestAsset[] = [];
  for (const spec of TEST_MINT_SPECS) {
    const mint = await generateKeyPairSigner();
    const space = testMintSpace(spec, ctx.payer.address);
    const rentLamports = await ctx.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    const created = await sendInstructions(
      ctx,
      getCreateTestMintInstructions({ spec, payer: ctx.payer, mint, rentLamports }),
      { skipPreflight: false },
    );
    const funded = await sendInstructions(
      ctx,
      await getMintTestBalanceInstructions({
        payer: ctx.payer,
        mint: mint.address,
        owner: ctx.payer.address,
        amount: TEST_BALANCE,
      }),
      { skipPreflight: false },
    );
    console.error(`[devnet] ${spec.label} ${mint.address} created ${created.signature}, funded ${funded.signature}`);
    assets.push({
      label: spec.label,
      mint: mint.address,
      decimals: spec.decimals,
      conceptualStock: CONCEPTUAL_STOCK,
      disclosure: TEST_ASSET_DISCLOSURE,
    });
  }
  await saveDevnetState({ ...state, assets });
  printJson(assets);
}

async function schedule(ctx: DevnetContext, values: Record<string, string | boolean | undefined>): Promise<void> {
  const asset = findAsset(await loadDevnetState(), requireString(values, "label"));
  const newMultiplier = Number(requireString(values, "multiplier"));
  const inSeconds = BigInt(requireString(values, "in-seconds"));
  // Chain time, not the local clock, anchors the effective timestamp.
  const before = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  const effectiveTimestamp = before.clock.unixTimestamp + inSeconds;
  const outcome = await sendInstructions(
    ctx,
    [getScheduleMultiplierInstruction({ mint: asset.mint, authority: ctx.payer, newMultiplier, effectiveTimestamp })],
    { skipPreflight: false },
  );
  printJson({
    label: asset.label,
    signature: outcome.signature,
    slot: outcome.slot,
    effectiveTimestamp,
    after: describeSnapshot(await fetchGuardSnapshot(ctx.rpc, asset.mint)),
  });
}

function requireString(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: "string" },
      multiplier: { type: "string" },
      "in-seconds": { type: "string" },
    },
  });
  const [command] = positionals;
  const ctx = await connectDevnet(readDevnetConfig(process.env));
  switch (command) {
    case "create-mints":
      return createMints(ctx);
    case "schedule":
      return schedule(ctx, values);
    case "snapshot": {
      const asset = findAsset(await loadDevnetState(), requireString(values, "label"));
      return printJson(describeSnapshot(await fetchGuardSnapshot(ctx.rpc, asset.mint)));
    }
    default:
      throw new Error(`unknown command ${String(command)}; see docs/devnet.md`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[devnet] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
