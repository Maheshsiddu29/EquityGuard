import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { address } from "@solana/kit";

import { parseBuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import { prepareReplay, type ReplayData } from "../src/replay-execution.ts";
import { expectationFromRecordedAuthorization, type RecordedAuthorization } from "../src/replay-model.ts";

const enabled = process.env.EQUITYGUARD_LOCAL_REPLAY_TEST === "1";

test("builds the Phantom-owned guarded route against a live local M9D-C1 validator without submitting", { skip: !enabled }, async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const fixture = JSON.parse(readFileSync(join(root, "tmp/m9d-c1/route-fixture.json"), "utf8")) as {
    readonly adapterKind: 2;
    readonly taker: string;
    readonly outputMint: string;
    readonly computeUnitLimit: number;
    readonly build: unknown;
  };
  const evidence = JSON.parse(readFileSync(join(root, "apps/reference/data/kox-trade-replay.json"), "utf8")) as {
    readonly staleExecution: { readonly authorization: RecordedAuthorization };
    readonly refreshedExecution: { readonly authorization: RecordedAuthorization };
  };
  const data: ReplayData = {
    fixture,
    build: parseBuildResponse(fixture.build),
    stale: expectationFromRecordedAuthorization(evidence.staleExecution.authorization),
    refreshed: expectationFromRecordedAuthorization(evidence.refreshedExecution.authorization),
    staleSource: "SEALED_SEP_15_PRE_ACTIVATION_OBSERVATION",
    refreshedSource: "SEALED_SEP_15_POST_ACTIVATION_OBSERVATION",
  };
  const phantom = address("CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X");
  const prepared = await prepareReplay(data, phantom, "SAFE");
  assert.equal(prepared.requiredSigner, phantom);
  assert.equal(prepared.feePayer, phantom);
  assert.equal(prepared.sourceAta, "7xd18PpPsvi8CmmP5Xr6rVQ63jUeQ2CqJ7i4yqZzmok9");
  assert.equal(prepared.destinationAta, "AnrbNfooXzzthu4kndCspVEEMo14wn8VQYJC6kFqonVj");
  assert.equal(prepared.programs[0], "EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT");
  assert.equal(prepared.programs.at(-1), "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  assert.equal(prepared.routeDataUnchanged, true);
  assert.equal(prepared.routePlanUnchanged, true);
  assert.equal(prepared.inAmount, 5_000_000n);
  assert.equal(prepared.skipPreflight, false);
  assert.equal(prepared.requiredSigner, prepared.feePayer);
});
