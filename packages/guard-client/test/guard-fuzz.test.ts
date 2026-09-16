/**
 * Shared decoder fuzz corpus, evaluated against the client's decoders.
 *
 * The same fixture is asserted by
 * `programs/equity_guard/tests/fuzz_decoders.rs`. Every expectation is
 * authored in `scripts/fixtures/generate_guard_fuzz.py`, so agreement here
 * plus agreement there is agreement between the two implementations.
 *
 * An unexpected exception in any of these is a security finding, not a test
 * to wrap in a catch: these decoders are what hostile bytes reach first.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ASSERT_SAFE_EXECUTION_V2_LEN,
  ActivationPhase,
  DownstreamAdapterKind,
  GuardClientError,
  TOKEN_2022_PROGRAM_ADDRESS,
  decodeProtectedState,
  downstreamCommitment,
  downstreamCommitmentPreimage,
  encodeAssertSafeExecutionV2,
  isValidStoredMultiplier,
} from "../src/index.ts";
import type { Address } from "@solana/kit";
import { MirrorRejection, decodeAssertSafeExecutionV2 } from "./guard-mirror.ts";

const CORPUS_PATH = new URL("../../../programs/equity_guard/tests/fixtures/guard_fuzz_v1.json", import.meta.url);

interface MultiplierCase {
  label: string;
  bytesHex: string;
  class: string;
  valid: boolean;
}
interface AbiCase {
  label: string;
  dataHex: string;
  expected: string;
}
interface RawInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  dataHex: string;
}
interface CommitmentCase {
  label: string;
  instruction: RawInstruction;
  preimageHex: string;
  commitmentHex: string;
}
interface MutationCase extends CommitmentCase {
  field: string;
}
interface TlvCase {
  label: string;
  dataHex: string;
  accept: boolean;
  reason: string;
  protected?: { multiplierHex: string; newMultiplierHex: string; effectiveTimestamp: string };
}
interface FuzzCorpus {
  formatVersion: number;
  seed: string;
  counts: Record<string, number>;
  multipliers: MultiplierCase[];
  abiPayloads: AbiCase[];
  commitments: CommitmentCase[];
  commitmentMutations: MutationCase[];
  tlvCases: TlvCase[];
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as FuzzCorpus;
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the fuzz corpus is intact", () => {
  assert.equal(corpus.formatVersion, 1);
  for (const [name, count] of Object.entries(corpus.counts)) {
    const section = corpus[name as keyof FuzzCorpus] as unknown[];
    assert.equal(section.length, count, `${name} count does not match the corpus header`);
    assert.ok(count > 0, `${name} is empty`);
  }
});

// ------------------------------------------------------ f64 bit patterns

test("stored multiplier validity matches the corpus", () => {
  const failures: string[] = [];
  for (const entry of corpus.multipliers) {
    const accepted = isValidStoredMultiplier(fromHex(entry.bytesHex));
    if (accepted !== entry.valid) failures.push(`  ${entry.label} (${entry.class}): accepted=${accepted}, corpus says valid=${entry.valid}`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${corpus.multipliers.length} multiplier patterns disagree:\n${failures.join("\n")}`);
});

test("no Number conversion is used for multiplier identity", () => {
  // Two distinct bit patterns that JavaScript's === would call equal as
  // numbers must stay distinct as stored multipliers.
  const positiveZero = fromHex("0000000000000000");
  const negativeZero = fromHex("0000000000000080");
  // `===` is exactly the hazard: it calls these two distinct bit patterns equal.
  assert.ok(0 === -0);
  assert.notEqual(toHex(positiveZero), toHex(negativeZero));
  assert.equal(isValidStoredMultiplier(positiveZero), false);
  assert.equal(isValidStoredMultiplier(negativeZero), false);
  // Every NaN payload is distinct as bytes and rejected as a multiplier.
  const nans = corpus.multipliers.filter((m) => m.class.endsWith("nan"));
  assert.ok(nans.length >= 3);
  assert.equal(new Set(nans.map((n) => n.bytesHex)).size, nans.length);
  for (const nan of nans) assert.equal(isValidStoredMultiplier(fromHex(nan.bytesHex)), false);
});

test("a multiplier is judged by its bytes, not by an 8-byte window of a longer buffer", () => {
  // The decoder must respect byteOffset/byteLength rather than reading the
  // whole backing ArrayBuffer.
  const backing = new Uint8Array(24);
  backing.set(fromHex("000000000000f03f"), 8);
  assert.equal(isValidStoredMultiplier(backing.subarray(8, 16)), true);
  assert.equal(isValidStoredMultiplier(backing.subarray(0, 8)), false);
  assert.equal(isValidStoredMultiplier(backing.subarray(8, 20)), false, "a 12-byte view is not a multiplier");
});

// --------------------------------------------------------- ABI payloads

function decodeOutcome(data: Uint8Array): string {
  try {
    decodeAssertSafeExecutionV2(data);
    return "ok";
  } catch (error) {
    if (error instanceof MirrorRejection) return error.guardError;
    throw error;
  }
}

test("ABI payload decoding matches the corpus", () => {
  const failures: string[] = [];
  for (const entry of corpus.abiPayloads) {
    const data = fromHex(entry.dataHex);
    const actual = decodeOutcome(data);
    if (actual !== entry.expected) failures.push(`  ${entry.label} (${data.length} bytes): expected ${entry.expected}, got ${actual}`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${corpus.abiPayloads.length} ABI payloads disagree:\n${failures.join("\n")}`);
});

test("the encoder never emits a payload the decoder rejects", () => {
  let encoded = 0;
  for (const entry of corpus.abiPayloads) {
    if (entry.expected !== "ok") continue;
    const decoded = decodeAssertSafeExecutionV2(fromHex(entry.dataHex));
    const bytes = encodeAssertSafeExecutionV2({
      expectedMint: decoded.expectedMint as Address,
      expected: decoded.execution.expected,
      expectedPhase: decoded.execution.expectedPhase,
      window: decoded.execution.window,
      adapterKind: decoded.adapterKind as DownstreamAdapterKind,
      downstreamCommitment: decoded.downstreamCommitment,
    });
    assert.equal(toHex(bytes), entry.dataHex, `${entry.label} does not round trip`);
    assert.equal(bytes.length, ASSERT_SAFE_EXECUTION_V2_LEN);
    encoded += 1;
  }
  assert.ok(encoded > 0, "no valid payload in the corpus");
});

test("the encoder refuses every invalid multiplier in the corpus", () => {
  const valid = corpus.multipliers.find((m) => m.valid);
  assert.ok(valid);
  const mint = "11111111111111111111111111111111" as Address;
  for (const entry of corpus.multipliers) {
    if (entry.valid) continue;
    for (const slot of ["multiplier", "newMultiplier"] as const) {
      assert.throws(
        () =>
          encodeAssertSafeExecutionV2({
            expectedMint: mint,
            expected: {
              multiplier: fromHex(slot === "multiplier" ? entry.bytesHex : valid.bytesHex),
              newMultiplier: fromHex(slot === "newMultiplier" ? entry.bytesHex : valid.bytesHex),
              newMultiplierEffectiveTimestamp: 0n,
            },
            expectedPhase: ActivationPhase.Activated,
            window: { beforeSecs: 0, afterSecs: 0 },
            adapterKind: DownstreamAdapterKind.TOKEN_2022_TRANSFER_CHECKED,
            downstreamCommitment: new Uint8Array(32),
          }),
        GuardClientError,
        `${entry.label} in ${slot} was encoded`,
      );
    }
  }
});

// ------------------------------------------------- downstream commitment

const committedOf = (instruction: RawInstruction) => ({
  programAddress: instruction.programId as Address,
  accounts: instruction.accounts.map((a) => ({ address: a.pubkey as Address, isSigner: a.isSigner, isWritable: a.isWritable })),
  data: fromHex(instruction.dataHex),
});

test("downstream commitments and their preimages match the corpus", () => {
  for (const entry of corpus.commitments) {
    const committed = committedOf(entry.instruction);
    assert.equal(toHex(downstreamCommitmentPreimage(committed)), entry.preimageHex, `${entry.label} preimage`);
    assert.equal(toHex(downstreamCommitment(committed)), entry.commitmentHex, `${entry.label} commitment`);
  }
});

test("every single-field mutation changes the commitment (INV-SEC-22)", () => {
  const base = corpus.commitmentMutations.find((m) => m.label === "base");
  assert.ok(base, "no base mutation");
  const baseCommitment = toHex(downstreamCommitment(committedOf(base.instruction)));

  const seen = new Map<string, string>();
  for (const mutation of corpus.commitmentMutations) {
    const actual = toHex(downstreamCommitment(committedOf(mutation.instruction)));
    assert.equal(actual, mutation.commitmentHex, `${mutation.label} disagrees with the corpus`);
    if (mutation.label !== "base") {
      assert.notEqual(actual, baseCommitment, `${mutation.label} (${mutation.field}) leaves the commitment unchanged`);
    }
    const other = seen.get(actual);
    assert.equal(other, undefined, `${mutation.label} and ${other} share a commitment`);
    seen.set(actual, mutation.label);
  }
  const fields = new Set(corpus.commitmentMutations.map((m) => m.field));
  for (const required of ["programId", "accounts.pubkey", "accounts.isSigner", "accounts.isWritable", "accounts.length", "accounts.order", "data.amount", "data.decimals", "data.tag", "data.length", "framing"]) {
    assert.ok(fields.has(required), `no commitment mutation covers ${required}`);
  }
});

test("equal commitments only ever come from equal preimages", () => {
  const byCommitment = new Map<string, string>();
  for (const entry of [...corpus.commitments, ...corpus.commitmentMutations]) {
    const digest = createHash("sha256").update(Buffer.from(entry.preimageHex, "hex")).digest("hex");
    assert.equal(digest, entry.commitmentHex, `${entry.label}: the corpus preimage does not hash to its commitment`);
    const previous = byCommitment.get(entry.commitmentHex);
    if (previous !== undefined) assert.equal(previous, entry.preimageHex, `commitment collision at ${entry.label}`);
    byCommitment.set(entry.commitmentHex, entry.preimageHex);
  }
  assert.ok(byCommitment.size > 300);
});

// ---------------------------------------------------- Token-2022 layouts

test("Token-2022 layout decisions match the corpus", () => {
  const failures: string[] = [];
  for (const entry of corpus.tlvCases) {
    const data = fromHex(entry.dataHex);
    let decoded;
    let error: unknown;
    try {
      decoded = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, data);
    } catch (thrown) {
      if (!(thrown instanceof GuardClientError)) throw thrown;
      error = thrown;
    }
    const accepted = decoded !== undefined;
    if (accepted !== entry.accept) {
      failures.push(`  ${entry.label} (${data.length} bytes): accepted=${accepted}, corpus says accept=${entry.accept} (${entry.reason})\n      ${String(error ?? "")}`);
      continue;
    }
    if (decoded && entry.protected) {
      assert.equal(toHex(decoded.multiplier), entry.protected.multiplierHex, `${entry.label} multiplier`);
      assert.equal(toHex(decoded.newMultiplier), entry.protected.newMultiplierHex, `${entry.label} new multiplier`);
      assert.equal(decoded.newMultiplierEffectiveTimestamp.toString(), entry.protected.effectiveTimestamp, `${entry.label} effective timestamp`);
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${corpus.tlvCases.length} Token-2022 layouts disagree:\n${failures.join("\n")}`);
});

test("no layout is accepted from a foreign owner", () => {
  for (const entry of corpus.tlvCases) {
    const data = fromHex(entry.dataHex);
    for (const owner of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "11111111111111111111111111111111"]) {
      assert.throws(() => decodeProtectedState(owner, data), (error: unknown) => error instanceof GuardClientError && error.code === "InvalidMintOwner", `${entry.label} under owner ${owner}`);
    }
  }
});

test("no corpus input escapes as an unexpected exception", () => {
  // Everything must terminate as a decision or a GuardClientError; a
  // TypeError or RangeError escaping a decoder would be a finding.
  for (const entry of corpus.tlvCases) {
    try {
      decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, fromHex(entry.dataHex));
    } catch (error) {
      assert.ok(error instanceof GuardClientError, `${entry.label} threw ${String(error)}`);
    }
  }
  for (const entry of corpus.abiPayloads) {
    try {
      decodeAssertSafeExecutionV2(fromHex(entry.dataHex));
    } catch (error) {
      assert.ok(error instanceof MirrorRejection, `${entry.label} threw ${String(error)}`);
    }
  }
  for (const entry of corpus.multipliers) {
    assert.equal(typeof isValidStoredMultiplier(fromHex(entry.bytesHex)), "boolean");
  }
});
