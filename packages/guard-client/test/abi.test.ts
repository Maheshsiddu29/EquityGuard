import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountRole, address } from "@solana/kit";

import {
  ABI_VERSION_V1,
  ASSERT_SAFE_EXECUTION_V1_LEN,
  ActivationPhase,
  EQUITY_GUARD_ERROR_CODES,
  GuardClientError,
  encodeAssertSafeExecutionV1,
  equityGuardErrorName,
  getAssertSafeExecutionInstruction,
  type AssertSafeExecutionRequest,
} from "../src/index.ts";
import { fromHex, hex, readGolden, type GoldenVector } from "./fixtures.ts";

const golden = readGolden();

function requestOf(vector: GoldenVector): AssertSafeExecutionRequest {
  const r = vector.request;
  assert.ok(r.expectedPhase === ActivationPhase.Pending || r.expectedPhase === ActivationPhase.Activated);
  return {
    expected: {
      multiplier: fromHex(r.multiplierHex),
      newMultiplier: fromHex(r.newMultiplierHex),
      newMultiplierEffectiveTimestamp: BigInt(r.newMultiplierEffectiveTimestamp),
    },
    expectedPhase: r.expectedPhase,
    window: { beforeSecs: r.protectionBeforeSecs, afterSecs: r.protectionAfterSecs },
  };
}

test("layout constants match the golden fixture", () => {
  assert.equal(ABI_VERSION_V1, golden.abiVersion);
  assert.equal(ASSERT_SAFE_EXECUTION_V1_LEN, golden.encodedLength);
});

test("encoder matches every golden vector byte-for-byte", () => {
  assert.ok(golden.vectors.length > 0);
  for (const vector of golden.vectors) {
    assert.equal(hex(encodeAssertSafeExecutionV1(requestOf(vector))), vector.encodedHex, vector.name);
  }
});

test("error codes match the program's enum", () => {
  assert.deepEqual({ ...EQUITY_GUARD_ERROR_CODES }, golden.errorCodes);
  assert.equal(equityGuardErrorName(13), "InsideTransitionWindow");
  assert.equal(equityGuardErrorName(999), undefined);
});

test("encoder refuses invalid expected multipliers the program would reject", () => {
  const base = requestOf(golden.vectors[0]!);
  // Only multiplier-field invalid vectors map onto encoder inputs.
  for (const invalid of golden.invalid.filter((v) => v.name.includes("multiplier"))) {
    const data = fromHex(invalid.dataHex);
    const request: AssertSafeExecutionRequest = {
      ...base,
      expected: { ...base.expected, multiplier: data.slice(1, 9), newMultiplier: data.slice(9, 17) },
    };
    assert.throws(
      () => encodeAssertSafeExecutionV1(request),
      (e) => e instanceof GuardClientError && e.code === "InvalidExpectedState",
      invalid.name,
    );
  }
});

test("encoder refuses out-of-range fields", () => {
  const base = requestOf(golden.vectors[0]!);
  const cases: AssertSafeExecutionRequest[] = [
    { ...base, expected: { ...base.expected, newMultiplierEffectiveTimestamp: 2n ** 63n } },
    { ...base, expected: { ...base.expected, multiplier: new Uint8Array(7) } },
    { ...base, expectedPhase: 2 as ActivationPhase },
    { ...base, window: { beforeSecs: -1, afterSecs: 0 } },
    { ...base, window: { beforeSecs: 0, afterSecs: 2 ** 32 } },
    { ...base, window: { beforeSecs: 1.5, afterSecs: 0 } },
  ];
  for (const request of cases) {
    assert.throws(() => encodeAssertSafeExecutionV1(request), GuardClientError);
  }
});

test("instruction passes only the mint, read-only", () => {
  const vector = golden.vectors[0]!;
  const instruction = getAssertSafeExecutionInstruction({
    programAddress: address("11111111111111111111111111111111"),
    mint: address("XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe"),
    request: requestOf(vector),
  });
  assert.equal(instruction.accounts?.length, 1);
  assert.equal(instruction.accounts?.[0]?.role, AccountRole.READONLY);
  assert.equal(hex(Uint8Array.from(instruction.data ?? [])), vector.encodedHex);
});
