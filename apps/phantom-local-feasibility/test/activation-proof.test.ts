import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS } from "../../../packages/guard-client/src/index.ts";
import { deriveLocalMint } from "../server/local-mint.ts";
import { activationDelay, localActivation, equalBytes, executeAcrossActivation, type ActivationDependencies, type PhaseTiming } from "../src/activation-proof.ts";

const WIRE_SHA = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** These orchestration tests all drive the stale leg. */
const PENDING_TIMING: PhaseTiming = {
  encodedPhase: "PENDING",
  clockRelationToLocalT: "BEFORE_ACTIVATION",
  requiredRelationToLocalT: "BEFORE_ACTIVATION",
  clockMatchesExpectedPhase: true,
};

function harness(times = [90n, 91n, 92n, 99n, 100n]) {
  const events: string[] = [];
  const wire = new Uint8Array([1, 9, 8, 7]);
  let submitted: Uint8Array | undefined;
  const messageSha256 = "message-sha";
  const deps: ActivationDependencies<{ hash: string }, string> = {
    build: async () => { events.push("build"); return { hash: "original" }; },
    attestPreSignSimulation: async () => {
      events.push("simulate");
      return { proofId: "presign-1", messageSha256, timing: PENDING_TIMING, source: "LOCAL_COORDINATOR" };
    },
    sign: async () => { events.push("sign"); return wire; },
    attestSignedAuthorization: async (proofId, signed) => {
      events.push("receipt:" + proofId);
      return {
        proofId, messageSha256, signedWireSha256: WIRE_SHA(signed),
        messageMatchesSimulated: true, timing: PENDING_TIMING, signatureVerified: true,
        source: "LOCAL_COORDINATOR",
      };
    },
    attestDeployment: async (stage) => { events.push("deployment:" + stage); return { stage, digest: "guard-digest", matched: true }; },
    clock: async () => ({ unixTimestamp: times.shift() ?? 101n, slot: 1n }),
    lifetime: async p => { events.push("validity:" + p.hash); return { valid: true, height: 10n, lastValidBlockHeight: 100n }; },
    submit: async (_p, bytes, skip) => { events.push("submit:" + skip); submitted = bytes; return "confirmed"; },
    pause: async () => { events.push("hold"); },
    stage: stage => { events.push(stage); },
  };
  return { deps, events, wire, submitted: () => submitted };
}

test("local T uses validator time and validated configurable delay", () => {
  assert.equal(activationDelay(), 15);
  assert.equal(localActivation(100n, 20), 120n);
  for (const invalid of ["0", "-1", "NaN", "31", "15.5"]) assert.throws(() => activationDelay(invalid));
});
test("passing pre-sign simulation precedes signing; one unchanged wire is submitted only after local activation", async () => {
  const h = harness(); const proof = await executeAcrossActivation(h.deps, 100n, true);
  assert.equal(h.events.filter(x => x === "build").length, 1);
  assert.equal(h.events.filter(x => x === "sign").length, 1);
  assert.ok(h.events.indexOf("simulate") < h.events.indexOf("sign"));
  assert.ok(h.events.indexOf("hold") < h.events.indexOf("submit:true"));
  assert.ok(h.events.indexOf("validity:original") < h.events.indexOf("submit:true"));
  assert.deepEqual(h.submitted(), h.wire);
  assert.ok(proof.atSigning.unixTimestamp < proof.localT);
  assert.ok(proof.atSubmission.unixTimestamp >= proof.localT);
  assert.equal(proof.signedWireHashBeforeActivation, proof.signedWireHashAtSubmission);
  assert.equal(proof.signedWireHashAtSubmission, createHash("sha256").update(h.wire).digest("hex"));
});
test("failed pre-sign simulation never invokes Phantom or submission", async () => {
  const h = harness(); const deps = { ...h.deps, attestPreSignSimulation: async () => { throw new Error("ActivationPhaseChanged"); } };
  await assert.rejects(executeAcrossActivation(deps, 100n, true), /ActivationPhaseChanged/);
  assert.ok(!h.events.includes("sign")); assert.equal(h.submitted(), undefined);
});
test("activation during simulation stops before Phantom", async () => {
  const h = harness([99n, 100n]);
  await assert.rejects(executeAcrossActivation(h.deps, 100n, true), /during simulation/);
  assert.ok(!h.events.includes("sign"));
});
test("late Phantom approval aborts without submission or automatic re-sign", async () => {
  const h = harness([98n, 99n, 100n]);
  await assert.rejects(executeAcrossActivation(h.deps, 100n, true), /returned after activation/);
  assert.equal(h.events.filter(x => x === "sign").length, 1); assert.equal(h.submitted(), undefined);
});
test("expired original blockhash aborts without rebuilding", async () => {
  const h = harness();
  await assert.rejects(executeAcrossActivation({ ...h.deps, lifetime: async () => ({ valid: false, height: 101n, lastValidBlockHeight: 100n }) }, 100n, true), /without rebuilding/);
  assert.equal(h.events.filter(x => x === "build").length, 1); assert.equal(h.submitted(), undefined);
});
test("height beyond original validity also aborts", async () => {
  const h = harness();
  await assert.rejects(executeAcrossActivation({ ...h.deps, lifetime: async () => ({ valid: true, height: 101n, lastValidBlockHeight: 100n }) }, 100n, true), /expired/);
  assert.equal(h.submitted(), undefined);
});
test("external mutation of wallet response cannot mutate held signed bytes", async () => {
  const h = harness(); const expected = h.wire.slice();
  const proof = await executeAcrossActivation({ ...h.deps, pause: async () => { h.wire.fill(0); } }, 100n, true);
  assert.deepEqual(h.submitted(), expected); assert.equal(proof.exactEquality, true);
  assert.equal(equalBytes(expected, h.wire), false);
});
test("a stalled validator Clock never permits submission", async () => {
  const h = harness();
  await assert.rejects(executeAcrossActivation({ ...h.deps, clock: async () => ({ unixTimestamp: 90n, slot: 1n }) }, 100n, true), /did not cross/);
  assert.equal(h.submitted(), undefined);
});
test("refresh is newly built and separately signed after activation with normal preflight", async () => {
  const h = harness(); await executeAcrossActivation(h.deps, 100n, true);
  assert.equal(h.events.filter(x => x === "sign").length, 1);
  await executeAcrossActivation(h.deps, 100n, false);
  assert.equal(h.events.filter(x => x === "sign").length, 2);
  assert.equal(h.events.filter(x => x === "build").length, 2);
  assert.ok(h.events.includes("submit:false"));
});
test("the stale authorization is only built while the validator Clock is still before local T", async () => {
  const h = harness([100n]);
  await assert.rejects(executeAcrossActivation(h.deps, 100n, true), /phase is not ready/);
  assert.ok(!h.events.includes("simulate")); assert.ok(!h.events.includes("sign")); assert.equal(h.submitted(), undefined);
});
test("refresh cannot be derived before the current phase activates", async () => {
  const h = harness(); await assert.rejects(executeAcrossActivation(h.deps, 100n, false), /phase is not ready/);
  assert.ok(!h.events.includes("sign"));
});
test("derived local mint preserves source bytes and both multiplier bytes", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/m9d-c1/accounts/XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ.json", import.meta.url), "utf8"));
  const source = Uint8Array.from(Buffer.from(fixture.account.data[0], "base64"));
  const before = source.slice();
  const derived = deriveLocalMint(source, address("CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X"), 12345678900n);
  assert.deepEqual(source, before);
  const decoded = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, derived);
  const old = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, source);
  // The captured source mint still carries the recorded Sep 15 protected fields.
  assert.equal(Buffer.from(old.multiplier).toString("hex"), "73833748164bf03f");
  assert.equal(Buffer.from(old.newMultiplier).toString("hex"), "df525701685cf03f");
  assert.equal(old.newMultiplierEffectiveTimestamp, 1_789_432_200n);
  assert.deepEqual(decoded.multiplier, old.multiplier); assert.deepEqual(decoded.newMultiplier, old.newMultiplier);
  assert.equal(decoded.newMultiplierEffectiveTimestamp, 12345678900n);
  assert.equal(derived.length, source.length);
});

test("hold includes the guard transition second at exactly T", async () => {
  const h = harness([90n, 91n, 92n, 100n, 101n]);
  const proof = await executeAcrossActivation(h.deps, 100n, true);
  assert.equal(proof.atSubmission.unixTimestamp, 101n);
});
