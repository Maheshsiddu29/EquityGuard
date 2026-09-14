#!/usr/bin/env node
/**
 * EquityGuard devnet tooling. Devnet only; see docs/devnet.md.
 *
 *   node scripts/devnet/cli.ts create-mints
 *   node scripts/devnet/cli.ts schedule --label EQ-A --multiplier 1.25 --in-seconds 120
 *   node scripts/devnet/cli.ts snapshot --label EQ-A
 *   node scripts/devnet/cli.ts scenario safe --label EQ-B
 *   node scripts/devnet/cli.ts scenario stale --label EQ-A
 *   node scripts/devnet/cli.ts scenario transition --label EQ-A --lead-seconds 75
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
  requireDeployment,
  saveDevnetState,
  type TestAsset,
} from "./devnet-state.ts";
import { toJson, type EvidenceRecord } from "./evidence.ts";
import { runSafe, runStale, runTransition, type ScenarioEnv } from "./scenarios.ts";
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

/**
 * Demo protection window for devnet scenarios, in chain seconds. Short so a
 * run completes in minutes; it is test policy, not an issuer value.
 */
const DEFAULT_WINDOW_SECS = 20;
/** Chain seconds between scheduling and activation in the transition scenario. */
const DEFAULT_TRANSITION_LEAD_SECS = 75n;

function printJson(value: unknown): void {
  console.log(toJson(value));
}

function describeSnapshot(snapshot: GuardSnapshot) {
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

async function scenario(
  ctx: DevnetContext,
  name: string | undefined,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const state = await loadDevnetState();
  const { programId } = requireDeployment(state);
  const program = await ctx.rpc.getAccountInfo(programId, { encoding: "base64" }).send();
  if (!program.value?.executable) {
    throw new Error(`program ${programId} is not deployed on this cluster; see docs/devnet.md`);
  }
  const window = {
    beforeSecs: Number(values.before ?? DEFAULT_WINDOW_SECS),
    afterSecs: Number(values.after ?? DEFAULT_WINDOW_SECS),
  };
  const env: ScenarioEnv = {
    ctx,
    programId,
    asset: findAsset(state, requireString(values, "label")),
    runId: `${ctx.cluster}-${new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z")}`,
  };

  let records: EvidenceRecord[];
  switch (name) {
    case "safe":
      records = await runSafe(env, window);
      break;
    case "stale":
      records = await runStale(env, window);
      break;
    case "transition": {
      const lead = typeof values["lead-seconds"] === "string" ? BigInt(values["lead-seconds"]) : DEFAULT_TRANSITION_LEAD_SECS;
      records = await runTransition(env, window, lead);
      break;
    }
    default:
      throw new Error("scenario must be one of: safe, stale, transition");
  }

  printJson(
    records.map((r) => ({
      step: `${r.scenario}/${r.step}`,
      expected: r.expectedResult,
      observed: r.observedResult,
      matched: r.matchedExpectation,
      signature: r.transactionSignature,
      explorerUrl: r.explorerUrl,
      slot: r.slot,
      blockTime: r.blockTime,
      recipientBalance: `${r.downstream.recipientBalanceBefore} -> ${r.downstream.recipientBalanceAfter}`,
    })),
  );
  if (records.some((r) => !r.matchedExpectation)) {
    throw new Error("at least one step did not match its expected result");
  }
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
      "lead-seconds": { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
    },
  });
  const [command, subcommand] = positionals;
  const ctx = await connectDevnet(readDevnetConfig(process.env));
  switch (command) {
    case "create-mints":
      return createMints(ctx);
    case "schedule":
      return schedule(ctx, values);
    case "scenario":
      return scenario(ctx, subcommand, values);
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
