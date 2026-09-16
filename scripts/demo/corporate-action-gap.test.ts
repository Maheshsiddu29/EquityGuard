/**
 * M10A: the boundary of what the current model can see.
 *
 * These tests demonstrate a scope limitation rather than a defect. The mint
 * bytes used are REAL — the UNHon and UNHx observations from the sealed chain
 * snapshot — and they are unchanged. What is hypothetical is only the
 * *interpretation*: "suppose a structural corporate action had occurred
 * off-chain while these bytes stayed exactly as captured".
 *
 * No synthetic observation is presented as real evidence here. The point is
 * precisely that the real, unchanged bytes cannot distinguish "nothing
 * happened" from "everything happened somewhere the mint cannot see".
 *
 * See docs/m10a-corporate-action-validation.md sections 7-9.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ActivationPhase, checkGuardOffline } from "@equityguard/guard-client";
import {
  RepresentationState,
  economicStateMismatches,
  economicStateOf,
  findRepresentationBySymbol,
  resolveOndoState,
  type ChainEvidence,
} from "@equityguard/representation-state";

import { decodeObservation, type CuratedObservation } from "./ko-fixtures.ts";
import { KO_DEMO_POLICY } from "./mainnet-replay.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/unh-corporate-action-2026-09.json", import.meta.url), "utf8"),
) as { observations: Record<string, CuratedObservation> };

const UNHON = findRepresentationBySymbol("UNHon")!;

function decoded(key: string): Extract<ChainEvidence, { kind: "decoded" }> {
  const evidence = decodeObservation(fixture.observations[key] as CuratedObservation);
  assert.ok(evidence.kind === "decoded");
  return evidence;
}

test("a representation whose bytes never move is SAFE, whatever happened off-chain", () => {
  // Real UNHon bytes, observed ~57 minutes apart with no change between them.
  const earlier = decoded("unhonPostEventFirst");
  const later = decoded("unhonWindowEnd");
  assert.deepEqual(economicStateMismatches(economicStateOf(earlier)!, economicStateOf(later)!), []);

  const resolved = resolveOndoState(UNHON, { chain: later, api: null }, KO_DEMO_POLICY);
  assert.equal(resolved.state, RepresentationState.SAFE);

  // A payload built at the earlier observation still passes at the later one.
  const built = economicStateOf(earlier)!;
  assert.equal(
    checkGuardOffline(
      {
        expected: {
          multiplier: Uint8Array.from(Buffer.from(built.multiplierHex, "hex")),
          newMultiplier: Uint8Array.from(Buffer.from(built.newMultiplierHex, "hex")),
          newMultiplierEffectiveTimestamp: built.effectiveTimestamp,
        },
        expectedPhase: built.phase,
        window: { beforeSecs: 900, afterSecs: 300 },
      },
      later.protectedState,
      BigInt(fixture.observations.unhonWindowEnd!.blockTime),
    ),
    null,
  );

  // This is the limitation, stated as a test rather than as prose: every
  // signal the model has is "unchanged", so a merger, migration, delisting or
  // redemption handled entirely off-chain is indistinguishable from a quiet
  // hour. The guard is answering the question it was asked -- "is the
  // protected state the one you approved?" -- and the answer is genuinely yes.
  assert.equal(later.hasScheduledChange, false, "no scheduled change to raise a window");
  assert.equal(later.paused, false, "no pause flag to fall back on");
  assert.equal(later.phase, ActivationPhase.Activated, "no phase concern");
  assert.equal(resolved.reason, "no scheduled multiplier change");
});

test("the model has no field in which a successor security could even be expressed", () => {
  // The protected state is exactly three values plus decimals and a pause
  // flag. Enumerating them is the argument: there is nowhere to put a
  // conversion ratio, a cash component, a successor mint or a deadline.
  const state = economicStateOf(decoded("unhonWindowEnd"))!;
  assert.deepEqual(Object.keys(state).sort(), [
    "decimals",
    "effectiveTimestamp",
    "mint",
    "multiplierHex",
    "newMultiplierHex",
    "paused",
    "phase",
  ]);
  // One scalar, one time, one flag. A mixed "0.3 B shares + $12 cash"
  // entitlement has two components of different kinds and no common ratio,
  // so no assignment to these fields can represent it.
  assert.equal(typeof state.multiplierHex, "string");
  assert.equal(state.multiplierHex.length, 16);
});

test("an unrecognised on-chain signal does fail closed, which is the shape a fix would take", () => {
  // If an issuer ever signalled a structural event through a new Token-2022
  // extension, the decoder would refuse the mint rather than guess: unknown
  // extension types are rejected. That is the existing precedent for how a
  // corporate-action signal should behave, and why the gap is about evidence
  // channels rather than about the guard being permissive.
  const real = fixture.observations.unhonWindowEnd as CuratedObservation;
  const bytes = Uint8Array.from(Buffer.from(real.dataBase64, "base64"));
  // Append a TLV entry with an extension type the decoder does not know.
  // Clearly synthetic, and used only to show the decoder's response.
  const withUnknownExtension = new Uint8Array(bytes.length + 4);
  withUnknownExtension.set(bytes);
  new DataView(withUnknownExtension.buffer).setUint16(bytes.length, 0xfff0, true);
  new DataView(withUnknownExtension.buffer).setUint16(bytes.length + 2, 0, true);

  const evidence = decodeObservation({ ...real, dataBase64: Buffer.from(withUnknownExtension).toString("base64") });
  assert.equal(evidence.kind, "decode-error", "an unknown extension type must not decode");
  const resolved = resolveOndoState(UNHON, { chain: evidence, api: null }, KO_DEMO_POLICY);
  assert.equal(resolved.state, RepresentationState.UNKNOWN);
  assert.notEqual(resolved.state, RepresentationState.SAFE);
});
