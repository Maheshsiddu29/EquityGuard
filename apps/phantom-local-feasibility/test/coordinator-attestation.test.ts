/**
 * EG-A-03: the local coordinator establishes pre-sign validity and signing
 * time itself, and a dishonest browser cannot manufacture either.
 *
 * Every transaction here is real: built with the production composer from the
 * recorded route fixture and signed with a generated key, so the Ed25519
 * verification, the message-identity check and the shape parser all run
 * against bytes a wallet would actually return. The validator Clock and the
 * simulation are stubs, because the point is that the *coordinator* supplies
 * them — the browser never gets to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
  type Address,
} from "@solana/kit";

import { ActivationPhase, checkGuardOffline, decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS, type JupiterAdapterKind } from "../../../packages/guard-client/src/index.ts";
import { composeGuardedJupiterTrade } from "../../../packages/jupiter/src/advanced.ts";
import { parseBuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import {
  AttestationError,
  CoordinatorAttestations,
  EQUITY_GUARD_PROGRAM,
  JUPITER_PROGRAM,
  WHIRLPOOL_PROGRAM,
  decodeProtectedTradeWire,
  observedRelation,
  phaseTiming,
  requiredRelation,
  verifySignature,
  type AttestationClock,
  type SimulationResult,
} from "../server/attestation.ts";
import { retargetBuildForTrader, KOX_MINT } from "../src/replay-model.ts";

const LOCAL_T = 1_790_160_566n;
const GUARD = address(EQUITY_GUARD_PROGRAM);
const SUCCESS_LOGS = [EQUITY_GUARD_PROGRAM, JUPITER_PROGRAM, WHIRLPOOL_PROGRAM].map((program) => `Program ${program} success`);

const fixture = JSON.parse(
  readFileSync(new URL("../../../tmp/m9d-c1/route-fixture.json", import.meta.url), "utf8"),
) as { adapterKind: number; computeUnitLimit: number; build: unknown };
const mintAccount = JSON.parse(
  readFileSync(new URL("../../../tmp/m9d-c1/accounts/XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ.json", import.meta.url), "utf8"),
) as { account: { data: [string, string] } };
const KOX_STATE = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, Uint8Array.from(Buffer.from(mintAccount.account.data[0], "base64")));

/** Builds a real guarded KOx trade for `taker`, at the phase and activation given. */
async function guardedWire(options: {
  readonly taker: Address;
  readonly phase: ActivationPhase;
  readonly localT?: bigint;
  readonly adapterKind?: number;
}): Promise<Uint8Array> {
  const retargeted = await retargetBuildForTrader(parseBuildResponse(fixture.build), options.taker);
  const composed = await composeGuardedJupiterTrade({
    build: retargeted.build,
    programAddress: GUARD,
    feePayer: options.taker,
    taker: options.taker,
    protectedMint: KOX_MINT,
    adapterKind: (options.adapterKind ?? fixture.adapterKind) as JupiterAdapterKind,
    expectation: {
      expected: { ...KOX_STATE, newMultiplierEffectiveTimestamp: options.localT ?? LOCAL_T },
      expectedPhase: options.phase,
      window: { beforeSecs: 0, afterSecs: 0 },
    },
    computeUnitLimit: fixture.computeUnitLimit,
  });
  return composed.wireBytes;
}

/** Signs a composed wire the way Phantom would: over the message, in place. */
async function sign(wire: Uint8Array, signer: Awaited<ReturnType<typeof generateKeyPairSigner>>): Promise<Uint8Array> {
  const unsigned = getTransactionDecoder().decode(wire);
  const signed = await signTransaction([signer.keyPair], unsigned);
  return Uint8Array.from(getTransactionEncoder().encode(signed));
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

interface Harness {
  readonly store: CoordinatorAttestations;
  readonly calls: string[];
  simulation: SimulationResult;
  clock: AttestationClock;
}

function harness(overrides: { readonly clock?: AttestationClock; readonly simulation?: Partial<SimulationResult> } = {}): Harness {
  const calls: string[] = [];
  const state: Harness = {
    calls,
    clock: overrides.clock ?? { unixTimestamp: LOCAL_T - 10n, slot: 500n },
    simulation: { err: null, logs: SUCCESS_LOGS, unitsConsumed: 81_783, contextSlot: 500n, ...overrides.simulation },
    store: undefined as unknown as CoordinatorAttestations,
  };
  (state as { store: CoordinatorAttestations }).store = new CoordinatorAttestations({
    protectedMint: KOX_MINT,
    clock: async () => { calls.push("clock"); return state.clock; },
    simulate: async (wire) => { calls.push("simulate:" + wire.slice(0, 8)); return state.simulation; },
    now: () => new Date("2026-09-23T05:05:00.000Z"),
  });
  return state;
}

// ------------------------------------------------------------- wire decoding

test("EG-A-03: the coordinator parses the real guarded trade and its ABI payload", async () => {
  const signer = await generateKeyPairSigner();
  const decoded = decodeProtectedTradeWire(b64(await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending })), {
    protectedMint: KOX_MINT,
    localT: LOCAL_T,
  });
  assert.equal(decoded.shape.version, 0);
  assert.equal(decoded.shape.signerCount, 1);
  assert.equal(decoded.shape.feePayer, signer.address);
  assert.equal(decoded.shape.protectedMint, KOX_MINT);
  assert.equal(decoded.shape.encodedPhase, "PENDING");
  assert.equal(decoded.shape.effectiveTimestamp, LOCAL_T);
  assert.equal(decoded.shape.instructionPrograms[0], EQUITY_GUARD_PROGRAM);
  assert.equal(decoded.shape.instructionPrograms.at(-1), JUPITER_PROGRAM);
  assert.equal(decoded.signature, null, "an unsigned wire carries no signature");
});

test("EG-A-03: a transaction that is not this protected trade is refused, with a reason", async () => {
  const signer = await generateKeyPairSigner();
  const wire = b64(await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending }));
  const cases: readonly (readonly [string, Parameters<typeof decodeProtectedTradeWire>[1], string])[] = [
    ["another mint", { protectedMint: address("XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe"), localT: LOCAL_T }, "UNEXPECTED_MINT"],
    ["another activation", { protectedMint: KOX_MINT, localT: LOCAL_T + 1n }, "UNEXPECTED_ACTIVATION"],
  ];
  for (const [label, expected, code] of cases) {
    assert.throws(() => decodeProtectedTradeWire(wire, expected), (error: AttestationError) => {
      assert.equal(error.code, code, label);
      return true;
    }, label);
  }
  for (const [label, bad] of [["empty", ""], ["not a transaction", "AAAA"]] as const) {
    assert.throws(() => decodeProtectedTradeWire(bad, { protectedMint: KOX_MINT, localT: LOCAL_T }), AttestationError, label);
  }
});

test("EG-A-03: Ed25519 verification accepts only the real signer over the real message", async () => {
  const signer = await generateKeyPairSigner();
  const other = await generateKeyPairSigner();
  const signed = await sign(await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending }), signer);
  const decoded = decodeProtectedTradeWire(b64(signed), { protectedMint: KOX_MINT, localT: LOCAL_T });
  const signature = decoded.signature;
  assert.ok(signature);
  assert.equal(verifySignature(signer.address, decoded.messageBytes, signature), true);
  assert.equal(verifySignature(other.address, decoded.messageBytes, signature), false, "another key");

  const tamperedMessage = Uint8Array.from(decoded.messageBytes);
  tamperedMessage.set([(tamperedMessage.at(-1) ?? 0) ^ 1], tamperedMessage.length - 1);
  assert.equal(verifySignature(signer.address, tamperedMessage, signature), false, "changed message");

  const tamperedSignature = Uint8Array.from(signature);
  tamperedSignature.set([(tamperedSignature[0] ?? 0) ^ 1], 0);
  assert.equal(verifySignature(signer.address, decoded.messageBytes, tamperedSignature), false, "changed signature");
  assert.equal(verifySignature(signer.address, decoded.messageBytes, new Uint8Array(32)), false, "wrong length");
});

// ---------------------------------------------------- pre-sign simulation

test("EG-A-03: the coordinator runs the simulation itself and records its own Clock", async () => {
  const h = harness();
  const signer = await generateKeyPairSigner();
  const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending });
  const record = await h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T });

  assert.equal(record.source, "LOCAL_COORDINATOR");
  assert.deepEqual(record.timing, {
    encodedPhase: "PENDING",
    clockRelationToLocalT: "BEFORE_ACTIVATION",
    requiredRelationToLocalT: "BEFORE_ACTIVATION",
    clockMatchesExpectedPhase: true,
  });
  assert.equal(record.clock.unixTimestamp, (LOCAL_T - 10n).toString());
  assert.equal(record.localT, LOCAL_T.toString());
  assert.equal(record.err, null);
  assert.equal(record.computeUnits, 81_783);
  assert.deepEqual([...record.programsSucceeded].sort(), [EQUITY_GUARD_PROGRAM, JUPITER_PROGRAM, WHIRLPOOL_PROGRAM].sort());
  // The simulation really ran here, against the bytes it was handed.
  assert.ok(h.calls.some((call) => call.startsWith("simulate:")), "the coordinator simulated");
  assert.ok(h.calls.includes("clock"), "the coordinator read the Clock");
});

test("EG-A-03: a browser cannot supply a successful simulation", async () => {
  const h = harness({ simulation: { err: { InstructionError: [0, { Custom: 12 }] } } });
  const signer = await generateKeyPairSigner();
  const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending });
  // The only thing the browser sends is bytes; the verdict is the coordinator's.
  await assert.rejects(
    h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "SIMULATION_FAILED",
  );
  assert.deepEqual(h.store.snapshot().preSignSimulations, [], "nothing was recorded");
});

test("EG-A-03: a simulation that did not reach Jupiter or Whirlpool is not a pre-sign proof", async () => {
  for (const missing of [EQUITY_GUARD_PROGRAM, JUPITER_PROGRAM, WHIRLPOOL_PROGRAM]) {
    const h = harness({ simulation: { logs: SUCCESS_LOGS.filter((line) => !line.includes(missing)) } });
    const signer = await generateKeyPairSigner();
    const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending });
    await assert.rejects(
      h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T }),
      (error: AttestationError) => error.code === "SIMULATION_INCOMPLETE",
      missing,
    );
  }
});

test("EG-A-03: the coordinator refuses to simulate a PENDING authorization at or after the activation", async () => {
  for (const clock of [LOCAL_T, LOCAL_T + 1n]) {
    const h = harness({ clock: { unixTimestamp: clock, slot: 900n } });
    const signer = await generateKeyPairSigner();
    const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending });
    await assert.rejects(
      h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T }),
      (error: AttestationError) => error.code === "CLOCK_AT_OR_PAST_ACTIVATION",
      `clock ${clock}`,
    );
    assert.ok(!h.calls.some((call) => call.startsWith("simulate:")), "it did not even simulate");
  }
});

// ------------------------------------------------- signed-byte receipt

async function attested(h: Harness) {
  const signer = await generateKeyPairSigner();
  const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending });
  const record = await h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T });
  const signed = await sign(wire, signer);
  return { signer, wire, record, signed };
}

test("EG-A-03: the receipt verifies the signature, the message identity and the Clock", async () => {
  const h = harness();
  const { signer, record, signed } = await attested(h);
  const receipt = await h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T });

  assert.equal(receipt.source, "LOCAL_COORDINATOR");
  assert.equal(receipt.signatureVerified, true);
  assert.equal(receipt.messageMatchesSimulated, true);
  assert.equal(receipt.timing.clockMatchesExpectedPhase, true);
  assert.equal(receipt.timing.encodedPhase, "PENDING");
  assert.equal(receipt.timing.clockRelationToLocalT, "BEFORE_ACTIVATION");
  assert.equal(receipt.signer, signer.address);
  assert.equal(receipt.messageSha256, record.messageSha256, "the signed message is the simulated message");
  assert.equal(receipt.simulationProofId, record.proofId);
  // The recorded signature is the transaction id the validator will report.
  const decoded = getTransactionDecoder().decode(signed);
  const signatureBytes = decoded.signatures[signer.address];
  assert.ok(signatureBytes);
  assert.equal(receipt.signature, getBase58Decoder().decode(signatureBytes));
  assert.equal(receipt.signedWireSha256.length, 64);
});

test("EG-A-03: a signature over a different message is refused", async () => {
  const h = harness();
  const { signer, record } = await attested(h);
  // A validly signed transaction — just not the one that was simulated.
  const otherWire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Activated });
  const otherSigned = await sign(otherWire, signer);
  await assert.rejects(
    h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(otherSigned), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "MESSAGE_MISMATCH",
  );
  assert.deepEqual(h.store.snapshot().signedAuthorizations, []);
});

test("EG-A-03: a forged or absent signature is refused", async () => {
  const h = harness();
  const { record, signed } = await attested(h);

  const forged = Uint8Array.from(signed);
  forged.set([(forged[1] ?? 0) ^ 0xff], 1); // inside the 64-byte signature
  await assert.rejects(
    h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(forged), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "INVALID_SIGNATURE",
  );

  const { wire } = await attested(harness());
  await assert.rejects(
    h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(wire), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "MISSING_SIGNATURE" || error.code === "MESSAGE_MISMATCH",
  );
});

test("EG-A-03: a PENDING receipt at or after the activation aborts and records nothing", async () => {
  for (const clock of [LOCAL_T, LOCAL_T + 5n]) {
    const h = harness();
    const { record, signed } = await attested(h);
    h.clock = { unixTimestamp: clock, slot: 900n };
    await assert.rejects(
      h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T }),
      (error: AttestationError) => error.code === "CLOCK_AT_OR_PAST_ACTIVATION",
      `clock ${clock}`,
    );
    assert.deepEqual(h.store.snapshot().signedAuthorizations, [], `clock ${clock}: nothing recorded`);
  }
});

test("EG-A-03: a browser timestamp cannot create a pre-activation attestation", async () => {
  // There is no input through which a caller supplies a time: the only clock
  // the store consults is its own dependency. Moving it past localT refuses,
  // whatever the browser would have claimed.
  const h = harness();
  const signer = await generateKeyPairSigner();
  const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Pending });
  h.clock = { unixTimestamp: LOCAL_T + 1n, slot: 901n };
  await assert.rejects(
    h.store.recordPreSignSimulation({
      unsignedWireBase64: b64(wire),
      localT: LOCAL_T,
      // A browser-shaped claim is simply not part of the input type.
      ...({ clock: { unixTimestamp: LOCAL_T - 100n }, signedBeforeLocalT: true } as object),
    } as Parameters<typeof h.store.recordPreSignSimulation>[0]),
    (error: AttestationError) => error.code === "CLOCK_AT_OR_PAST_ACTIVATION",
  );
});

test("EG-A-03: a receipt requires a simulation, matches its activation, and is single-use", async () => {
  const h = harness();
  const { record, signed } = await attested(h);

  await assert.rejects(
    h.store.recordSignedAuthorization({ proofId: "presign-unknown", signedWireBase64: b64(signed), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "UNKNOWN_PROOF",
  );
  await assert.rejects(
    h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T + 1n }),
    (error: AttestationError) => error.code === "ACTIVATION_MISMATCH",
  );

  await h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T });
  await assert.rejects(
    h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "ALREADY_ATTESTED",
  );
});

test("EG-A-03: the run snapshot links simulation to receipt by message hash", async () => {
  const h = harness();
  const { record, signed } = await attested(h);
  const receipt = await h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T });
  const snapshot = h.store.snapshot();

  assert.equal(snapshot.preSignSimulations.length, 1);
  assert.equal(snapshot.signedAuthorizations.length, 1);
  assert.equal(snapshot.preSignSimulations[0]?.messageSha256, snapshot.signedAuthorizations[0]?.messageSha256);
  // The chain a verifier follows: simulated M -> signed M -> this wire hash.
  assert.equal(h.store.authorizationForWire(receipt.signedWireSha256)?.proofId, record.proofId);
  assert.equal(h.store.authorizationForWire("00".repeat(32)), null);
});

test("EG-A-03: the attested signed wire is the exact wire the browser holds", async () => {
  const h = harness();
  const { record, signed } = await attested(h);
  const receipt = await h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T });

  // What the demo will submit is this same byte array, base64 of which is what
  // the coordinator hashed. Nothing re-encoded it in between.
  const { createHash } = await import("node:crypto");
  assert.equal(receipt.signedWireSha256, createHash("sha256").update(signed).digest("hex"));
  assert.equal(receipt.wireLength, signed.length);
  assert.equal(b64(signed), getBase64EncodedWireTransaction(getTransactionDecoder().decode(signed)));
});

// ------------------------------------------- phase × Clock matrix (both endpoints)

/**
 * The regression that broke the first remediation run.
 *
 * The clock precondition was written for the stale leg only, so every
 * ACTIVATED authorization — the refreshed leg, by construction built after
 * `localT` — was refused with `CLOCK_AT_OR_PAST_ACTIVATION` before its
 * simulation ever ran. The rule is now directed by the authorization's own
 * encoded phase, decoded server-side from the signed ABI payload.
 */
const PHASE_CLOCK_MATRIX = [
  { phase: ActivationPhase.Pending, label: "PENDING", clock: LOCAL_T - 10n, at: "before T", code: null },
  { phase: ActivationPhase.Pending, label: "PENDING", clock: LOCAL_T, at: "at T", code: "CLOCK_AT_OR_PAST_ACTIVATION" },
  { phase: ActivationPhase.Pending, label: "PENDING", clock: LOCAL_T + 10n, at: "after T", code: "CLOCK_AT_OR_PAST_ACTIVATION" },
  { phase: ActivationPhase.Activated, label: "ACTIVATED", clock: LOCAL_T, at: "at T", code: null },
  { phase: ActivationPhase.Activated, label: "ACTIVATED", clock: LOCAL_T + 10n, at: "after T", code: null },
  { phase: ActivationPhase.Activated, label: "ACTIVATED", clock: LOCAL_T - 1n, at: "before T", code: "CLOCK_BEFORE_ACTIVATION" },
  { phase: ActivationPhase.Activated, label: "ACTIVATED", clock: LOCAL_T - 10n, at: "before T", code: "CLOCK_BEFORE_ACTIVATION" },
] as const;

test("EG-A-03: pre-sign simulation holds each phase to its own side of the activation", async () => {
  for (const row of PHASE_CLOCK_MATRIX) {
    const h = harness({ clock: { unixTimestamp: row.clock, slot: 500n } });
    const signer = await generateKeyPairSigner();
    const wire = await guardedWire({ taker: signer.address, phase: row.phase });
    const attempt = h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T });
    const label = `${row.label} ${row.at}`;
    if (row.code === null) {
      const record = await attempt;
      assert.equal(record.shape.encodedPhase, row.label, label);
      // PENDING proves < T; ACTIVATED proves >= T. Never a bare "before".
      const expected = row.label === "PENDING" ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
      assert.deepEqual(record.timing, {
        encodedPhase: row.label,
        clockRelationToLocalT: expected,
        requiredRelationToLocalT: expected,
        clockMatchesExpectedPhase: true,
      }, label);
      assert.equal(row.clock < LOCAL_T, expected === "BEFORE_ACTIVATION", `${label}: relation matches the raw Clock`);
      assert.ok(h.calls.some((call) => call.startsWith("simulate:")), `${label}: reached simulation`);
    } else {
      await assert.rejects(attempt, (error: AttestationError) => {
        assert.equal(error.code, row.code, label);
        // The refusal carries enough non-secret context to diagnose it.
        assert.equal(error.context.phase, row.label, label);
        assert.equal(error.context.clock, row.clock.toString(), label);
        assert.equal(error.context.localT, LOCAL_T.toString(), label);
        assert.equal(error.context.endpoint, "pre-sign-simulation", label);
        return true;
      }, label);
      assert.ok(!h.calls.some((call) => call.startsWith("simulate:")), `${label}: refused before simulating`);
      assert.deepEqual(h.store.snapshot().preSignSimulations, [], `${label}: nothing recorded`);
    }
  }
});

test("EG-A-03: the signed receipt holds each phase to the same side of the activation", async () => {
  for (const row of PHASE_CLOCK_MATRIX) {
    // Attest the simulation in a window the phase accepts, then move the
    // Clock to the row under test before handing over the signed bytes.
    const accepted = row.phase === ActivationPhase.Pending ? LOCAL_T - 10n : LOCAL_T + 10n;
    const h = harness({ clock: { unixTimestamp: accepted, slot: 500n } });
    const signer = await generateKeyPairSigner();
    const wire = await guardedWire({ taker: signer.address, phase: row.phase });
    const record = await h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T });
    const signed = await sign(wire, signer);

    h.clock = { unixTimestamp: row.clock, slot: 900n };
    const attempt = h.store.recordSignedAuthorization({ proofId: record.proofId, signedWireBase64: b64(signed), localT: LOCAL_T });
    const label = `${row.label} receipt ${row.at}`;
    if (row.code === null) {
      const receipt = await attempt;
      const expected = row.label === "PENDING" ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
      assert.deepEqual(receipt.timing, {
        encodedPhase: row.label,
        clockRelationToLocalT: expected,
        requiredRelationToLocalT: expected,
        clockMatchesExpectedPhase: true,
      }, label);
      assert.equal(receipt.signatureVerified, true, label);
    } else {
      await assert.rejects(attempt, (error: AttestationError) => {
        assert.equal(error.code, row.code, label);
        assert.equal(error.context.endpoint, "signed-authorization", label);
        assert.equal(error.context.proofId, record.proofId, label);
        return true;
      }, label);
      assert.deepEqual(h.store.snapshot().signedAuthorizations, [], `${label}: nothing recorded`);
    }
  }
});

// ------------------------------- phase direction is not the transition window

/**
 * The two checks are deliberately separate. Phase direction is the
 * coordinator's; the transition window belongs to the program. An ACTIVATED
 * authorization exactly at `localT` passes the coordinator's phase rule and
 * is then refused by the guard itself.
 *
 * `checkGuardOffline` is the mirror of `guard.rs::check`, pinned to the
 * compiled program by the conformance corpus, so it is used here to produce
 * the verdict the real simulation would return.
 */
function guardVerdictAt(phase: ActivationPhase, clock: bigint, window: { beforeSecs: number; afterSecs: number }) {
  const expected = { ...KOX_STATE, newMultiplierEffectiveTimestamp: LOCAL_T };
  return checkGuardOffline({ expected, expectedPhase: phase, window }, expected, clock);
}

test("EG-A-03: an ACTIVATED authorization exactly at T passes phase direction and is refused by the guard", async () => {
  // The guard's own verdict for this state and clock, zero-width window.
  const verdict = guardVerdictAt(ActivationPhase.Activated, LOCAL_T, { beforeSecs: 0, afterSecs: 0 });
  assert.equal(verdict, "InsideTransitionWindow", "the program refuses the inclusive [T,T] second");

  const h = harness({
    clock: { unixTimestamp: LOCAL_T, slot: 500n },
    // What the local validator would return for that verdict.
    simulation: { err: { InstructionError: [0, { Custom: 13 }] }, logs: [`Program ${EQUITY_GUARD_PROGRAM} failed: custom program error: 0xd`] },
  });
  const signer = await generateKeyPairSigner();
  const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Activated });

  await assert.rejects(
    h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T }),
    (error: AttestationError) => {
      assert.equal(error.code, "SIMULATION_FAILED", "refused by the simulation, not by phase direction");
      assert.equal(error.context.phase, "ACTIVATED");
      return true;
    },
  );
  // It really did reach the simulation — that is the point of the separation.
  assert.ok(h.calls.some((call) => call.startsWith("simulate:")), "phase direction let it through");
  // And nothing is recorded, so no signing can follow.
  assert.deepEqual(h.store.snapshot().preSignSimulations, [], "no pre-sign proof recorded");
  assert.deepEqual(h.store.snapshot().signedAuthorizations, [], "no signed authorization recorded");
});

test("EG-A-03: an ACTIVATED authorization inside a non-zero after-window is refused the same way", async () => {
  const window = { beforeSecs: 0, afterSecs: 900 };
  for (const offset of [1n, 450n, 900n]) {
    assert.equal(
      guardVerdictAt(ActivationPhase.Activated, LOCAL_T + offset, window),
      "InsideTransitionWindow",
      `T+${offset} is inside the 900s after-window`,
    );
  }
  // Past the window the same authorization is accepted again.
  assert.equal(guardVerdictAt(ActivationPhase.Activated, LOCAL_T + 901n, window), null, "T+901 is outside");

  const h = harness({
    clock: { unixTimestamp: LOCAL_T + 450n, slot: 500n },
    simulation: { err: { InstructionError: [0, { Custom: 13 }] }, logs: [] },
  });
  const signer = await generateKeyPairSigner();
  const wire = await guardedWire({ taker: signer.address, phase: ActivationPhase.Activated });
  await assert.rejects(
    h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T }),
    (error: AttestationError) => error.code === "SIMULATION_FAILED",
  );
  assert.deepEqual(h.store.snapshot().preSignSimulations, []);
});

// ------------------------------------------ timing evidence is phase-neutral

/**
 * The schema defect this replaced: both records carried
 * `simulatedBeforeLocalT: true` / `receivedBeforeLocalT: true` as literals, so
 * the refreshed leg — attested after `localT` by construction — asserted
 * "before" while its own `clock` field showed the opposite.
 */
test("EG-A-03: no record claims a timing its own Clock contradicts", async () => {
  for (const [phase, label, clock] of [
    [ActivationPhase.Pending, "PENDING", LOCAL_T - 10n],
    [ActivationPhase.Activated, "ACTIVATED", LOCAL_T + 10n],
  ] as const) {
    const h = harness({ clock: { unixTimestamp: clock, slot: 500n } });
    const signer = await generateKeyPairSigner();
    const wire = await guardedWire({ taker: signer.address, phase });
    const record = await h.store.recordPreSignSimulation({ unsignedWireBase64: b64(wire), localT: LOCAL_T });
    const receipt = await h.store.recordSignedAuthorization({
      proofId: record.proofId,
      signedWireBase64: b64(await sign(wire, signer)),
      localT: LOCAL_T,
    });

    for (const [what, timing, at] of [["pre-sign", record.timing, record.clock], ["receipt", receipt.timing, receipt.clock]] as const) {
      // The recorded relation is exactly what the recorded Clock shows.
      const actual = BigInt(at.unixTimestamp) < LOCAL_T ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
      assert.equal(timing.clockRelationToLocalT, actual, `${label} ${what}: relation matches its own Clock`);
      assert.equal(timing.encodedPhase, label, `${label} ${what}`);
      assert.equal(timing.requiredRelationToLocalT, label === "PENDING" ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION", `${label} ${what}`);
      assert.equal(timing.clockMatchesExpectedPhase, true, `${label} ${what}`);
    }

    // And the old field names are gone, so nothing can read a phase-specific
    // boolean off these records again.
    for (const record_ of [record as unknown as Record<string, unknown>, receipt as unknown as Record<string, unknown>]) {
      assert.equal(record_["simulatedBeforeLocalT"], undefined, `${label}: no simulatedBeforeLocalT`);
      assert.equal(record_["receivedBeforeLocalT"], undefined, `${label}: no receivedBeforeLocalT`);
    }
  }
});

test("EG-A-03: timing evidence cannot be minted for a Clock the phase forbids", () => {
  // `phaseTiming` is the only way a record gets `clockMatchesExpectedPhase`,
  // and it refuses rather than asserting a relation that is not there.
  for (const [phase, clock] of [
    ["PENDING", LOCAL_T],
    ["PENDING", LOCAL_T + 1n],
    ["ACTIVATED", LOCAL_T - 1n],
  ] as const) {
    assert.throws(
      () => phaseTiming({ unixTimestamp: clock, slot: 1n }, LOCAL_T, phase),
      (error: AttestationError) => error.code === "PHASE_TIMING_MISMATCH",
      `${phase} at ${clock}`,
    );
  }
  // The two permitted combinations, and the exact boundary.
  assert.equal(phaseTiming({ unixTimestamp: LOCAL_T - 1n, slot: 1n }, LOCAL_T, "PENDING").clockRelationToLocalT, "BEFORE_ACTIVATION");
  assert.equal(phaseTiming({ unixTimestamp: LOCAL_T, slot: 1n }, LOCAL_T, "ACTIVATED").clockRelationToLocalT, "AT_OR_AFTER_ACTIVATION");
  assert.equal(observedRelation({ unixTimestamp: LOCAL_T, slot: 1n }, LOCAL_T), "AT_OR_AFTER_ACTIVATION", "localT itself is not 'before'");
  assert.equal(requiredRelation("PENDING"), "BEFORE_ACTIVATION");
  assert.equal(requiredRelation("ACTIVATED"), "AT_OR_AFTER_ACTIVATION");
});
