import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { createSolanaRpc } from "@solana/kit";
import { fetchGuardSnapshot, ActivationPhase } from "../../../packages/guard-client/src/index.ts";
import { prepareReplay, type ReplayData } from "../src/replay-execution.ts";
import { parseBuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import { KOX_MINT } from "../src/replay-model.ts";
import { EXPECTED_PHANTOM } from "../src/local-funding.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "../src/feasibility.ts";

test("live local activation: same unsigned wire passes before T, rejects at ix0 after T, refresh passes", { skip: process.env.EQUITYGUARD_ACTIVATION_LIVE_TEST !== "1", timeout: 90000 }, async () => {
  const fixture = await fetch("http://127.0.0.1:4175/route-fixture.json").then(r => r.json());
  const armed = await fetch("http://127.0.0.1:4175/api/arm", { method: "POST", headers: { origin: "http://127.0.0.1:4175" } }).then(r => r.json());
  assert.ok(armed.localT, JSON.stringify(armed));
  const rpc = createSolanaRpc(assertLocalRpcUrl(LOCAL_RPC_URL).href);
  const snapshot = await fetchGuardSnapshot(rpc, KOX_MINT);
  assert.equal(snapshot.phase, ActivationPhase.Pending);
  const expectation = { expected: snapshot.state, expectedPhase: snapshot.phase, window: { beforeSecs: 0, afterSecs: 0 } };
  const data: ReplayData = { fixture, build: parseBuildResponse(fixture.build), stale: expectation, refreshed: expectation, staleSource: "LOCAL_EXECUTION_REPRODUCTION", refreshedSource: "LOCAL_EXECUTION_REPRODUCTION" };
  const old = await prepareReplay(data, EXPECTED_PHANTOM, "STALE");
  const wire = Buffer.from(old.wireBytes).toString("base64");
  const sim = async (message: string) => fetch(assertLocalRpcUrl(LOCAL_RPC_URL), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [message, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: [old.sourceAta, old.destinationAta] } }] }) }).then(r => r.json());
  const before = await sim(wire);
  assert.equal(before.result?.value.err, null, JSON.stringify(before));
  assert.ok(before.result.value.logs.some((line: string) => line.includes("whirLb") && line.endsWith("success")));
  let current = await fetchGuardSnapshot(rpc, KOX_MINT);
  while (current.clock.unixTimestamp <= BigInt(armed.localT)) {
    await new Promise(r => setTimeout(r, 250)); current = await fetchGuardSnapshot(rpc, KOX_MINT);
  }
  const after = await sim(wire);
  assert.deepEqual(after.result?.value.err, { InstructionError: [0, { Custom: 12 }] });
  assert.ok(!after.result.value.logs.some((line: string) => /Program (JUP6|whirLb).* invoke/.test(line)));
  const fresh = await prepareReplay({ ...data, refreshed: { ...expectation, expected: current.state, expectedPhase: current.phase } }, EXPECTED_PHANTOM, "REFRESHED");
  assert.equal(fresh.commitmentHex, old.commitmentHex);
  const recovery = await sim(Buffer.from(fresh.wireBytes).toString("base64"));
  assert.equal(recovery.result?.value.err, null, JSON.stringify(recovery));
  const amounts = recovery.result.value.accounts.map((account: { data: [string, string] }) => Buffer.from(account.data[0], "base64").readBigUInt64LE(64));
  assert.deepEqual(amounts, [0n, 5_504_261n]);
  // Simulations do not consume the baseline.
  assert.equal((await rpc.getTokenAccountBalance(old.sourceAta).send()).value.amount, "5000000");
  await writeFile("tmp/phantom-activation/simulation-proof.json", JSON.stringify({ kind: "UNSIGNED_SIMULATION_ONLY", armed, preClock: snapshot.clock, postClock: current.clock, oldBlockhash: old.blockhash, lastValidBlockHeight: old.lastValidBlockHeight, before, after, recovery }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
});
