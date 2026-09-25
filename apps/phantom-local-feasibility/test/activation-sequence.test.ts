/**
 * The whole reproduction, end to end, against the real coordinator.
 *
 * `activation-proof.test.ts` drives `executeAcrossActivation` with stubs, so
 * it checks the orchestration — ordering, byte preservation, abort paths —
 * and nothing about what the coordinator actually decides. That gap let a
 * real bug through: the clock precondition was written for the stale leg
 * only, so every ACTIVATED authorization was refused before its simulation
 * ran, and the stub said yes anyway. The human run failed at exactly that
 * point.
 *
 * So this file wires the real `CoordinatorAttestations` to real composed and
 * Ed25519-signed transactions, and runs the full sequence:
 *
 *   PENDING before T -> simulate -> sign -> hold -> stale execution after T
 *   ACTIVATED after T -> simulate -> sign -> refreshed execution
 *
 * The simulation is backed by `checkGuardOffline`, the mirror of
 * `guard.rs::check` that the conformance corpus pins to the compiled program,
 * so the verdicts are the program's rather than a stub's opinion.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { generateKeyPairSigner, getTransactionDecoder, getTransactionEncoder, signTransaction, type Address } from "@solana/kit";

import {
  ActivationPhase,
  checkGuardOffline,
  decodeProtectedState,
  TOKEN_2022_PROGRAM_ADDRESS,
  type JupiterAdapterKind,
  type ProtectedState,
} from "../../../packages/guard-client/src/index.ts";
import { composeGuardedJupiterTrade } from "../../../packages/jupiter/src/advanced.ts";
import { parseBuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import { executeAcrossActivation, type DeploymentAttestation } from "../src/activation-proof.ts";
import {
  AttestationError,
  CoordinatorAttestations,
  decodeProtectedTradeWire,
  EQUITY_GUARD_PROGRAM,
  JUPITER_PROGRAM,
  WHIRLPOOL_PROGRAM,
} from "../server/attestation.ts";
import { retargetBuildForTrader, KOX_MINT } from "../src/replay-model.ts";

const LOCAL_T = 1_790_166_844n;
const ZERO_WINDOW = { beforeSecs: 0, afterSecs: 0 };
const DEPLOYMENT_DIGEST = "guard|programdata|d7d59ccd|1111|NO_USABLE_AUTHORITY|REVIEWED_BINARY";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/m9d-c1/route-fixture.json", import.meta.url), "utf8"),
) as { adapterKind: number; computeUnitLimit: number; build: unknown };
const mintAccount = JSON.parse(
  readFileSync(new URL("./fixtures/m9d-c1/accounts/XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ.json", import.meta.url), "utf8"),
) as { account: { data: [string, string] } };
const CAPTURED = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, Uint8Array.from(Buffer.from(mintAccount.account.data[0], "base64")));
/** The local mint as armed: captured multipliers, activation moved to localT. */
const LOCAL_STATE: ProtectedState = { ...CAPTURED, newMultiplierEffectiveTimestamp: LOCAL_T };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * The phase the payload itself encodes, read with the coordinator's decoder
 * rather than remembered from the build — the simulation must react to the
 * bytes it was handed, exactly as the validator would.
 */
function phaseOf(wireBase64: string): ActivationPhase {
  const { shape } = decodeProtectedTradeWire(wireBase64, { protectedMint: KOX_MINT, localT: LOCAL_T });
  return shape.encodedPhase === "PENDING" ? ActivationPhase.Pending : ActivationPhase.Activated;
}

interface Prepared {
  readonly wire: Uint8Array;
  readonly phase: ActivationPhase;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

interface Submitted {
  readonly leg: "STALE" | "REFRESHED";
  readonly wireSha: string;
  readonly bytes: Uint8Array;
  readonly clock: bigint;
  readonly skipPreflight: boolean;
}

/** One run of the reproduction against the real coordinator. */
function sequence(signer: Awaited<ReturnType<typeof generateKeyPairSigner>>, window = ZERO_WINDOW) {
  let clock = LOCAL_T - 12n;
  let slot = 1_000n;
  const events: string[] = [];
  const submitted: Submitted[] = [];
  const simulations: string[] = [];

  const store = new CoordinatorAttestations({
    protectedMint: KOX_MINT,
    clock: async () => ({ unixTimestamp: clock, slot }),
    // The program's own verdict, not a stub's.
    simulate: async (wireBase64) => {
      simulations.push(wireBase64.slice(0, 12));
      const phase = phaseOf(wireBase64);
      const verdict = checkGuardOffline({ expected: LOCAL_STATE, expectedPhase: phase, window }, LOCAL_STATE, clock);
      if (verdict === null) {
        return {
          err: null,
          logs: [EQUITY_GUARD_PROGRAM, JUPITER_PROGRAM, WHIRLPOOL_PROGRAM].map((p) => `Program ${p} success`),
          unitsConsumed: 81_783,
          contextSlot: slot,
        };
      }
      return { err: { InstructionError: [0, { Custom: verdict === "InsideTransitionWindow" ? 13 : 12 }] }, logs: [], unitsConsumed: null, contextSlot: slot };
    },
  });

  async function build(stale: boolean): Promise<Prepared> {
    const phase = stale ? ActivationPhase.Pending : ActivationPhase.Activated;
    const retargeted = await retargetBuildForTrader(parseBuildResponse(fixture.build), signer.address as Address);
    const composed = await composeGuardedJupiterTrade({
      build: retargeted.build,
      programAddress: EQUITY_GUARD_PROGRAM as Address,
      feePayer: signer.address,
      taker: signer.address,
      protectedMint: KOX_MINT,
      adapterKind: fixture.adapterKind as JupiterAdapterKind,
      expectation: { expected: LOCAL_STATE, expectedPhase: phase, window },
      computeUnitLimit: fixture.computeUnitLimit,
    });
    return { wire: composed.wireBytes, phase, blockhash: "hash", lastValidBlockHeight: 10_000n };
  }

  const run = (stale: boolean) =>
    executeAcrossActivation<Prepared, Submitted>(
      {
        stage: (value) => events.push(value),
        clock: async () => ({ unixTimestamp: clock, slot }),
        pause: async () => { clock += 1n; slot += 2n; },
        build: () => build(stale),
        attestPreSignSimulation: async (prepared) => {
          const record = await store.recordPreSignSimulation({ unsignedWireBase64: b64(prepared.wire), localT: LOCAL_T });
          return record;
        },
        sign: async (prepared) => {
          const unsigned = getTransactionDecoder().decode(prepared.wire);
          const signed = await signTransaction([signer.keyPair], unsigned);
          return Uint8Array.from(getTransactionEncoder().encode(signed));
        },
        attestSignedAuthorization: async (proofId, signed) =>
          store.recordSignedAuthorization({ proofId, signedWireBase64: b64(signed), localT: LOCAL_T }),
        attestDeployment: async (stage: DeploymentAttestation["stage"]) => ({ stage, digest: DEPLOYMENT_DIGEST, matched: true }),
        lifetime: async (prepared) => ({ valid: true, height: 100n, lastValidBlockHeight: prepared.lastValidBlockHeight }),
        submit: async (prepared, bytes, deliberateStale) => {
          const { createHash } = await import("node:crypto");
          const record: Submitted = {
            leg: deliberateStale ? "STALE" : "REFRESHED",
            wireSha: createHash("sha256").update(bytes).digest("hex"),
            bytes: Uint8Array.from(bytes),
            clock,
            skipPreflight: deliberateStale,
          };
          submitted.push(record);
          return record;
        },
      },
      LOCAL_T,
      stale,
    );

  return { run, store, events, submitted, simulations, clockNow: () => clock, advance: (by: bigint) => { clock += by; } };
}

test("the full sequence runs against the real coordinator: PENDING before T, then ACTIVATED after T", async () => {
  const signer = await generateKeyPairSigner();
  const s = sequence(signer);

  // ---- stale leg: authorized before T, executed after it ----
  const stale = await s.run(true);
  assert.equal(stale.preSign.source, "LOCAL_COORDINATOR");
  // PENDING proves strictly before the activation, on both readings.
  assert.deepEqual(stale.preSign.timing, {
    encodedPhase: "PENDING",
    clockRelationToLocalT: "BEFORE_ACTIVATION",
    requiredRelationToLocalT: "BEFORE_ACTIVATION",
    clockMatchesExpectedPhase: true,
  });
  assert.deepEqual(stale.signedAuthorization.timing, stale.preSign.timing);
  assert.equal(stale.signedAuthorization.signatureVerified, true);
  assert.equal(stale.signedAuthorization.messageMatchesSimulated, true);
  assert.equal(stale.signedAuthorization.messageSha256, stale.preSign.messageSha256);
  assert.ok(stale.atSigning.unixTimestamp < LOCAL_T, "signed before activation");
  assert.ok(stale.atSubmission.unixTimestamp > LOCAL_T, "submitted after activation");
  assert.equal(stale.exactEquality, true);
  assert.equal(stale.signedWireHashBeforeActivation, stale.signedWireHashAtSubmission);
  assert.equal(stale.outcome.leg, "STALE");
  assert.equal(stale.outcome.skipPreflight, true);
  assert.equal(stale.outcome.wireSha, stale.signedAuthorization.signedWireSha256, "the attested wire is the submitted wire");

  // ---- refreshed leg: authorized and executed after T ----
  // This is what the first remediation run could never reach.
  const refreshed = await s.run(false);
  assert.equal(refreshed.preSign.source, "LOCAL_COORDINATOR");
  // ACTIVATED proves at or after the activation — the record no longer claims
  // "before" for a leg that is post-activation by construction.
  assert.deepEqual(refreshed.preSign.timing, {
    encodedPhase: "ACTIVATED",
    clockRelationToLocalT: "AT_OR_AFTER_ACTIVATION",
    requiredRelationToLocalT: "AT_OR_AFTER_ACTIVATION",
    clockMatchesExpectedPhase: true,
  });
  assert.deepEqual(refreshed.signedAuthorization.timing, refreshed.preSign.timing);
  assert.equal(refreshed.signedAuthorization.signatureVerified, true);
  assert.equal(refreshed.signedAuthorization.messageSha256, refreshed.preSign.messageSha256);
  assert.ok(refreshed.atSigning.unixTimestamp >= LOCAL_T, "the refreshed authorization is signed after activation");
  assert.equal(refreshed.outcome.leg, "REFRESHED");
  assert.equal(refreshed.outcome.skipPreflight, false, "only the stale submission skips preflight");
  assert.equal(refreshed.outcome.wireSha, refreshed.signedAuthorization.signedWireSha256);

  // ---- the two legs are distinct authorizations over the same trade ----
  assert.notEqual(stale.preSign.messageSha256, refreshed.preSign.messageSha256, "different encoded phase");
  assert.notEqual(stale.outcome.wireSha, refreshed.outcome.wireSha);

  // ---- the coordinator recorded exactly one proof and one receipt per leg ----
  const snapshot = s.store.snapshot();
  assert.equal(snapshot.preSignSimulations.length, 2);
  assert.equal(snapshot.signedAuthorizations.length, 2);
  assert.deepEqual(snapshot.preSignSimulations.map((r) => r.shape.encodedPhase), ["PENDING", "ACTIVATED"]);
  // Each leg is attributable to its leg by the phase in its own payload.
  for (const record of snapshot.preSignSimulations) {
    assert.equal(record.shape.effectiveTimestamp, LOCAL_T);
    assert.equal(record.shape.protectedMint, KOX_MINT);
  }
  assert.equal(s.simulations.length, 2, "the coordinator simulated once per leg");
  assert.equal(s.submitted.length, 2);
});

test("the refreshed leg cannot be authorized before the activation", async () => {
  const signer = await generateKeyPairSigner();
  const s = sequence(signer);
  // Ask for the refreshed leg while the Clock is still pre-activation. The
  // orchestration refuses first, before any coordinator call.
  await assert.rejects(s.run(false), /phase is not ready/);
  assert.deepEqual(s.store.snapshot().preSignSimulations, []);
  assert.equal(s.submitted.length, 0);
});

test("the stale leg cannot be authorized after the activation", async () => {
  const signer = await generateKeyPairSigner();
  const s = sequence(signer);
  s.advance(20n); // past T
  await assert.rejects(s.run(true), /phase is not ready/);
  assert.deepEqual(s.store.snapshot().preSignSimulations, []);
  assert.equal(s.submitted.length, 0);
});

test("a transition window the guard refuses stops the refreshed leg before any signature", async () => {
  const signer = await generateKeyPairSigner();
  // A 900s after-window puts the post-activation authorization inside the
  // guard's refusal interval, so the coordinator's own simulation fails.
  const s = sequence(signer, { beforeSecs: 0, afterSecs: 900 });
  await s.run(true);
  const beforeRefresh = s.store.snapshot();

  await assert.rejects(s.run(false), (error: AttestationError) => {
    assert.equal(error.code, "SIMULATION_FAILED");
    assert.match(error.message, /Custom":13|Custom": *13/);
    return true;
  });

  // No new proof, no second signature, no second submission.
  assert.equal(s.store.snapshot().preSignSimulations.length, beforeRefresh.preSignSimulations.length);
  assert.equal(s.store.snapshot().signedAuthorizations.length, beforeRefresh.signedAuthorizations.length);
  assert.equal(s.submitted.length, 1, "only the stale submission happened");
  assert.equal(s.submitted[0]?.leg, "STALE");
});
