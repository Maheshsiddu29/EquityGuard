import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountRole, address, type Address, type Instruction } from "@solana/kit";

import {
  ABI_VERSION_V2,
  ASSERT_SAFE_EXECUTION_V2_LEN,
  ActivationPhase,
  DOWNSTREAM_COMMITMENT_DOMAIN,
  DownstreamAdapterKind,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  EQUITY_GUARD_ERROR_CODES,
  GuardClientError,
  SYSVAR_INSTRUCTIONS_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  asCommittedInstruction,
  buildGuardedTransferChecked,
  downstreamCommitment,
  encodeAssertSafeExecutionV2,
  equityGuardErrorName,
  isDownstreamAdapterKind,
  getAssertSafeExecutionV2Instruction,
  type AssertSafeExecutionV2Request,
} from "../src/index.ts";
import { fromHex, hex, readGolden, type GoldenVector } from "./fixtures.ts";

const golden = readGolden();

function requestOf(vector: GoldenVector): AssertSafeExecutionV2Request {
  const r = vector.request;
  assert.ok(r.expectedPhase === ActivationPhase.Pending || r.expectedPhase === ActivationPhase.Activated);
  assert.ok(isDownstreamAdapterKind(r.adapterKind), `${vector.name}: adapter ${r.adapterKind}`);
  return {
    expectedMint: address(r.expectedMint),
    expected: {
      multiplier: fromHex(r.multiplierHex),
      newMultiplier: fromHex(r.newMultiplierHex),
      newMultiplierEffectiveTimestamp: BigInt(r.newMultiplierEffectiveTimestamp),
    },
    expectedPhase: r.expectedPhase,
    window: { beforeSecs: r.protectionBeforeSecs, afterSecs: r.protectionAfterSecs },
    adapterKind: r.adapterKind,
    downstreamCommitment: fromHex(r.downstreamCommitmentHex),
  };
}

test("layout constants and offsets match the golden fixture", () => {
  assert.equal(ABI_VERSION_V2, golden.abiVersion);
  assert.equal(ASSERT_SAFE_EXECUTION_V2_LEN, golden.encodedLength);
  assert.equal(DOWNSTREAM_COMMITMENT_DOMAIN, golden.commitmentDomain);
  const encoded = encodeAssertSafeExecutionV2(requestOf(golden.vectors[0]!));
  const o = golden.offsets;
  assert.equal(encoded[o.version!], 2);
  assert.equal(hex(encoded.subarray(o.downstreamCommitment!, o.downstreamCommitment! + 32)), golden.vectors[0]!.request.downstreamCommitmentHex);
  assert.equal(encoded[o.adapterKind!], 1);
});

test("encoder matches every golden vector byte-for-byte, for every adapter kind", () => {
  assert.ok(golden.vectors.length > 0);
  assert.deepEqual([...new Set(golden.vectors.map((v) => v.request.adapterKind))].sort(), [1, 2, 3]);
  for (const vector of golden.vectors) {
    assert.equal(hex(encodeAssertSafeExecutionV2(requestOf(vector))), vector.encodedHex, vector.name);
  }
});

test("downstream commitments match the golden vectors (TypeScript == Rust == independent Python)", () => {
  assert.ok(golden.commitmentVectors.length >= 4);
  for (const vector of golden.commitmentVectors) {
    const commitment = downstreamCommitment({
      programAddress: address(vector.programId),
      accounts: vector.accounts.map((a) => ({ address: address(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: fromHex(vector.dataHex),
    });
    assert.equal(hex(commitment), vector.commitmentHex, vector.name);
  }
  // Every vector commits to something different.
  assert.equal(new Set(golden.commitmentVectors.map((v) => v.commitmentHex)).size, golden.commitmentVectors.length);
});

test("error codes match the program's enum, including the ABI v2 codes", () => {
  assert.deepEqual({ ...EQUITY_GUARD_ERROR_CODES }, golden.errorCodes);
  assert.equal(equityGuardErrorName(16), "UnsupportedVersion");
  assert.equal(equityGuardErrorName(23), "DownstreamCommitmentMismatch");
  assert.equal(equityGuardErrorName(26), "GuardNotFirst");
  assert.equal(equityGuardErrorName(38), "NonCanonicalDestinationAccount");
  assert.equal(equityGuardErrorName(999), undefined);
});

test("encoder refuses invalid fields the program would reject", () => {
  const base = requestOf(golden.vectors[0]!);
  const invalidMultiplier = golden.invalid.find((v) => v.name === "multiplier-positive-zero")!;
  const cases: [string, AssertSafeExecutionV2Request][] = [
    ["zero multiplier", { ...base, expected: { ...base.expected, multiplier: fromHex(invalidMultiplier.dataHex).slice(33, 41) } }],
    ["timestamp above i64", { ...base, expected: { ...base.expected, newMultiplierEffectiveTimestamp: 2n ** 63n } }],
    ["short multiplier", { ...base, expected: { ...base.expected, multiplier: new Uint8Array(7) } }],
    ["phase 2", { ...base, expectedPhase: 2 as ActivationPhase }],
    ["negative window", { ...base, window: { beforeSecs: -1, afterSecs: 0 } }],
    ["window above u32", { ...base, window: { beforeSecs: 0, afterSecs: 2 ** 32 } }],
    ["fractional window", { ...base, window: { beforeSecs: 1.5, afterSecs: 0 } }],
    ["adapter 0", { ...base, adapterKind: 0 as DownstreamAdapterKind }],
    ["adapter 4", { ...base, adapterKind: 4 as DownstreamAdapterKind }],
    ["adapter 255", { ...base, adapterKind: 255 as DownstreamAdapterKind }],
    ["31-byte commitment", { ...base, downstreamCommitment: new Uint8Array(31) }],
  ];
  for (const [label, request] of cases) {
    assert.throws(() => encodeAssertSafeExecutionV2(request), GuardClientError, label);
  }
});

test("the guard instruction passes exactly the mint and the Instructions sysvar, read-only", () => {
  const vector = golden.vectors[0]!;
  const request = requestOf(vector);
  const instruction = getAssertSafeExecutionV2Instruction({
    programAddress: address("11111111111111111111111111111111"),
    mint: request.expectedMint,
    expectation: request,
    downstreamCommitment: request.downstreamCommitment,
  });
  assert.deepEqual(instruction.accounts, [
    { address: request.expectedMint, role: AccountRole.READONLY },
    { address: SYSVAR_INSTRUCTIONS_ADDRESS, role: AccountRole.READONLY },
  ]);
  assert.equal(hex(Uint8Array.from(instruction.data ?? [])), vector.encodedHex);
});

const MINT = address("AwQ8Cx4D4a1fBEcNThsG4kCskmgLNKMnvkf57iQG7wZn");
const PAYER = address("JArGaWxrddR7J1XYjsoEU5XCuHffra3gASBjfVK4BuNT");
const SOURCE = address("7w2MRSqKByxbNkYoXWR7vNC2D8yaZ3iPfZCVd4FcrBgT");
const DESTINATION = address("ECrVumzWbWA4c352fohUimkUmRkYm6ubAuyU8hb3Yr3y");
const PROGRAM = EQUITY_GUARD_DEVNET_PROGRAM_ID;
const ONE = new Uint8Array(new Float64Array([1]).buffer);
const expectation = { expected: { multiplier: ONE, newMultiplier: ONE, newMultiplierEffectiveTimestamp: 0n }, expectedPhase: ActivationPhase.Activated, window: { beforeSecs: 900, afterSecs: 300 } };

function transferChecked(amount: bigint, mint: Address = MINT, program: Address = TOKEN_2022_PROGRAM_ADDRESS as Address): Instruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = 6;
  return {
    programAddress: program,
    accounts: [
      { address: SOURCE, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: DESTINATION, role: AccountRole.WRITABLE },
      { address: PAYER, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

test("the builder commits to the TransferChecked with transaction-level flags and places it right after the guard", () => {
  const transfer = transferChecked(5_990_000n);
  const create: Instruction = { programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }, { address: DESTINATION, role: AccountRole.WRITABLE }], data: new Uint8Array([1]) };
  const built = buildGuardedTransferChecked({ programAddress: PROGRAM, feePayer: PAYER, mint: MINT, expectation, transferChecked: transfer, before: [create] });
  assert.deepEqual(built.instructions, [create, built.guard, transfer]);
  // The authority's instruction meta is a read-only signer, but as fee payer it is a writable signer in the transaction.
  assert.deepEqual(built.committed.accounts.map((a) => [a.isSigner, a.isWritable]), [[false, true], [false, false], [false, true], [true, true]]);
  // Same instruction and flags as the golden vector: identical commitment.
  assert.equal(hex(built.commitment), golden.commitmentVectors[0]!.commitmentHex);
  const data = Uint8Array.from(built.guard.data ?? []);
  assert.equal(hex(data.subarray(67, 99)), hex(built.commitment));
  assert.equal(hex(data.subarray(1, 33)), hex(Uint8Array.from(Buffer.from(golden.vectors[2]!.encodedHex, "hex").subarray(1, 33))));
  assert.deepEqual(asCommittedInstruction(transfer, built.instructions, PAYER), built.committed);
});

test("the builder refuses anything but Token-2022 TransferChecked of the protected mint", () => {
  const other = address("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ");
  const legacy = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const plainTransfer = { ...transferChecked(1n), data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) };
  const cases: [string, Instruction][] = [
    ["another mint", transferChecked(1n, other)],
    ["legacy token program", transferChecked(1n, MINT, legacy)],
    ["Transfer (not checked)", plainTransfer],
    ["trailing data", { ...transferChecked(1n), data: Uint8Array.of(...Uint8Array.from(transferChecked(1n).data ?? []), 0) }],
    ["missing authority", { ...transferChecked(1n), accounts: (transferChecked(1n).accounts ?? []).slice(0, 3) }],
  ];
  for (const [label, instruction] of cases) {
    assert.throws(() => buildGuardedTransferChecked({ programAddress: PROGRAM, feePayer: PAYER, mint: MINT, expectation, transferChecked: instruction }), (e) => e instanceof GuardClientError && e.code === "InvalidDownstream", label);
  }
});

test("any change to the committed instruction changes the commitment", () => {
  const base = buildGuardedTransferChecked({ programAddress: PROGRAM, feePayer: PAYER, mint: MINT, expectation, transferChecked: transferChecked(5_990_000n) }).commitment;
  const variants = [
    buildGuardedTransferChecked({ programAddress: PROGRAM, feePayer: PAYER, mint: MINT, expectation, transferChecked: transferChecked(5_990_001n) }).commitment,
    buildGuardedTransferChecked({ programAddress: PROGRAM, feePayer: SOURCE, mint: MINT, expectation, transferChecked: transferChecked(5_990_000n) }).commitment,
  ];
  for (const variant of variants) assert.notEqual(hex(variant), hex(base));
});
