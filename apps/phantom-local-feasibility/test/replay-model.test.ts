import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { address } from "@solana/kit";

import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../../../packages/guard-client/src/index.ts";
import { parseBuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import { composeGuardedJupiterTrade } from "../../../packages/jupiter/src/compose.ts";
import { assertOutcome, type ReplayOutcome } from "../src/replay-execution.ts";
import {
  KOX_MINT,
  expectationFromRecordedAuthorization,
  nextReplayStep,
  requiredSignerAddresses,
  retargetBuildForTrader,
} from "../src/replay-model.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "tmp/m9d-c1/route-fixture.json"), "utf8")) as {
  readonly adapterKind: 2;
  readonly computeUnitLimit: number;
  readonly build: unknown;
};
const PHANTOM = address("CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X");
const SOURCE = "7xd18PpPsvi8CmmP5Xr6rVQ63jUeQ2CqJ7i4yqZzmok9";
const DESTINATION = "AnrbNfooXzzthu4kndCspVEEMo14wn8VQYJC6kFqonVj";
const AUTHORIZATION = expectationFromRecordedAuthorization({
  multiplierHex: "73833748164bf03f",
  newMultiplierHex: "df525701685cf03f",
  newMultiplierEffectiveTimestamp: "1789432200",
  expectedPhase: 1,
  window: { beforeSecs: 0, afterSecs: 0 },
});

test("Phantom cleanly replaces the sole fixture signer and canonical user ATAs", async () => {
  const original = parseBuildResponse(FIXTURE.build);
  const retargeted = await retargetBuildForTrader(original, PHANTOM);
  assert.deepEqual(requiredSignerAddresses(retargeted.build), [PHANTOM]);
  assert.equal(retargeted.sourceAta, SOURCE);
  assert.equal(retargeted.destinationAta, DESTINATION);
  assert.deepEqual(retargeted.replacements, { authority: 4, sourceAta: 2, destinationAta: 3 });
  assert.equal(retargeted.build.swapInstruction.data, original.swapInstruction.data);
  assert.deepEqual(retargeted.build.routePlan, original.routePlan);
});

test("only trader-owned account metas change; route and venue semantics remain byte-identical", async () => {
  const original = parseBuildResponse(FIXTURE.build);
  const retargeted = (await retargetBuildForTrader(original, PHANTOM)).build;
  const allowed = new Set([
    "6ZuNEkQXE5WZzsmLH21sSmTXfff6iQKr6EtErcxxBxpy",
    "Bze38ZNYkoKZXBWv7hGfqYkH4KBhAAmUkwPMNqNbzCRp",
    "Cv8LSh7Udip71rxXVqyMKx7bY64ED6ToBE1fSeKGXPyv",
  ]);
  for (const [index, account] of original.swapInstruction.accounts.entries()) {
    const changed = retargeted.swapInstruction.accounts[index];
    assert.ok(changed);
    if (!allowed.has(account.pubkey)) assert.deepEqual(changed, account, `swap account ${index}`);
  }
  assert.deepEqual(
    { ...retargeted, setupInstructions: [], swapInstruction: { ...retargeted.swapInstruction, accounts: [] } },
    { ...original, setupInstructions: [], swapInstruction: { ...original.swapInstruction, accounts: [] } },
  );
});

test("the production composer recomputes the commitment after account-meta substitution", async () => {
  const original = parseBuildResponse(FIXTURE.build);
  const retargeted = await retargetBuildForTrader(original, PHANTOM);
  const originalTrade = await composeGuardedJupiterTrade({
    build: original,
    programAddress: address(EQUITY_GUARD_DEVNET_PROGRAM_ID),
    feePayer: address("6ZuNEkQXE5WZzsmLH21sSmTXfff6iQKr6EtErcxxBxpy"),
    taker: address("6ZuNEkQXE5WZzsmLH21sSmTXfff6iQKr6EtErcxxBxpy"),
    protectedMint: KOX_MINT,
    adapterKind: FIXTURE.adapterKind,
    expectation: AUTHORIZATION,
    computeUnitLimit: FIXTURE.computeUnitLimit,
  });
  const phantomTrade = await composeGuardedJupiterTrade({
    build: retargeted.build,
    programAddress: address(EQUITY_GUARD_DEVNET_PROGRAM_ID),
    feePayer: PHANTOM,
    taker: PHANTOM,
    protectedMint: KOX_MINT,
    adapterKind: FIXTURE.adapterKind,
    expectation: AUTHORIZATION,
    computeUnitLimit: FIXTURE.computeUnitLimit,
  });
  assert.notDeepEqual(phantomTrade.trade.commitment, originalTrade.trade.commitment);
  assert.equal(phantomTrade.metrics.requiredSignatures, 1);
  assert.equal(phantomTrade.binding.authority, PHANTOM);
  assert.equal(phantomTrade.binding.sourceTokenAccount, SOURCE);
  assert.equal(phantomTrade.binding.destinationTokenAccount, DESTINATION);
});

test("stale and refreshed flows require separate explicit approvals", () => {
  assert.equal(nextReplayStep("READY_SAFE", "SAFE"), "READY_STALE");
  assert.equal(nextReplayStep("READY_STALE", "STALE"), "STALE_REJECTED");
  assert.throws(() => nextReplayStep("STALE_REJECTED", "STALE"), /separate approval/);
  assert.equal(nextReplayStep("STALE_REJECTED", "REFRESHED"), "COMPLETE");
});

test("confirmed stale proof requires ix0 error 12, no downstream invocation, and zero token deltas", () => {
  const stale: ReplayOutcome = {
    kind: "STALE",
    signature: "local-signature",
    slot: 1n,
    signer: PHANTOM,
    feePayer: PHANTOM,
    error: { InstructionError: [0, { Custom: 12 }] },
    failedInstruction: 0,
    customCode: 12,
    guardErrorName: "ActivationPhaseChanged",
    guardInvoked: true,
    jupiterInvoked: false,
    whirlpoolInvoked: false,
    before: { usdc: 5_000_000n, kox: 0n },
    after: { usdc: 5_000_000n, kox: 0n },
    skipPreflight: true,
    logs: ["Program EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT invoke [1]"],
    computeUnits: "10955",
    simulation: null,
    authorizationSource: "SEALED_SEP_15_PRE_ACTIVATION_OBSERVATION",
  };
  assert.doesNotThrow(() => assertOutcome(stale));
  assert.throws(() => assertOutcome({ ...stale, jupiterInvoked: true }));
  assert.throws(() => assertOutcome({ ...stale, after: { ...stale.after, kox: 1n } }));
  assert.throws(() => assertOutcome({ ...stale, skipPreflight: false }));
});

test("SAFE and refreshed success require actual confirmed downstream execution and exact token movement", () => {
  const safe: ReplayOutcome = {
    kind: "SAFE",
    signature: "local-signature",
    slot: 1n,
    signer: PHANTOM,
    feePayer: PHANTOM,
    error: null,
    failedInstruction: null,
    customCode: null,
    guardErrorName: null,
    guardInvoked: true,
    jupiterInvoked: true,
    whirlpoolInvoked: true,
    before: { usdc: 5_000_000n, kox: 0n },
    after: { usdc: 0n, kox: 5_504_261n },
    skipPreflight: false,
    logs: ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]"],
    computeUnits: "1",
    simulation: null,
    authorizationSource: "SEALED_SEP_15_POST_ACTIVATION_OBSERVATION",
  };
  assert.doesNotThrow(() => assertOutcome(safe));
  assert.throws(() => assertOutcome({ ...safe, jupiterInvoked: false }));
  assert.throws(() => assertOutcome({ ...safe, after: safe.before }));
  assert.throws(() => assertOutcome({ ...safe, skipPreflight: true }));
  assert.throws(() => assertOutcome({ ...safe, after: { usdc: 0n, kox: 5_504_260n } }));
});

test("browser experiment contains no private-key or automatic-resubmission dependency", () => {
  const src = join(ROOT, "apps/phantom-local-feasibility/src");
  const text = readdirSync(src).map((file) => readFileSync(join(src, file), "utf8")).join("\n");
  for (const pattern of [/createKeyPair/i, /secretKey/i, /seed phrase/i, /local-taker\.json/i, /signAndSendTransaction\s*\(/]) {
    assert.doesNotMatch(text, pattern);
  }
  assert.doesNotMatch(text, /runReplay\("REFRESHED"\).*runReplay/s);
});
