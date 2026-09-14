import assert from "node:assert/strict";
import { test } from "node:test";

import type { Signature } from "@solana/kit";
import type { ProtectedState } from "@equityguard/guard-client";

import { describeExpected, describeObserved, explorerUrl, storedStateError, toJson } from "./evidence.ts";
import type { TransactionOutcome } from "./send.ts";

const f64 = (value: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
};

const STATE: ProtectedState = { multiplier: f64(1), newMultiplier: f64(1.25), newMultiplierEffectiveTimestamp: 100n };

function outcome(partial: Partial<TransactionOutcome>): TransactionOutcome {
  return {
    signature: "sig" as Signature,
    slot: 1n,
    blockTime: null,
    succeeded: false,
    customError: null,
    rawError: null,
    logs: [],
    ...partial,
  };
}

test("stored-state error follows the program's check order", () => {
  assert.equal(storedStateError(STATE, STATE), null);
  assert.equal(
    storedStateError(STATE, { multiplier: f64(2), newMultiplier: f64(3), newMultiplierEffectiveTimestamp: 0n }),
    "MultiplierChanged",
  );
  assert.equal(storedStateError(STATE, { ...STATE, newMultiplier: f64(3), newMultiplierEffectiveTimestamp: 0n }), "NewMultiplierChanged");
  assert.equal(storedStateError(STATE, { ...STATE, newMultiplierEffectiveTimestamp: 0n }), "EffectiveTimestampChanged");
});

test("observed result names guard errors only when the guard instruction failed", () => {
  assert.equal(describeObserved(outcome({ succeeded: true })), "success");
  assert.equal(describeObserved(outcome({ customError: { instructionIndex: 0, code: 13 } })), "failure:InsideTransitionWindow");
  // A custom error from the downstream instruction is not a guard rejection.
  assert.equal(describeObserved(outcome({ customError: { instructionIndex: 1, code: 13 } })), "failure:other");
  assert.equal(describeObserved(outcome({})), "failure:other");
  assert.equal(describeExpected({ guardError: "ActivationPhaseChanged" }), "failure:ActivationPhaseChanged");
});

test("explorer links exist only for devnet", () => {
  assert.equal(explorerUrl("devnet", "abc"), "https://explorer.solana.com/tx/abc?cluster=devnet");
  assert.equal(explorerUrl("localnet", "abc"), null);
});

test("evidence JSON keeps bigints exact", () => {
  assert.equal(toJson({ slot: 2n ** 63n }), '{\n  "slot": "9223372036854775808"\n}');
});
