/**
 * Rust ↔ TypeScript differential over the shared guard conformance corpus.
 *
 * The same fixture is asserted by
 * `programs/equity_guard/tests/guard_conformance.rs`. Each vector's expected
 * result is authored once, in
 * `scripts/fixtures/generate_guard_conformance.py`; neither implementation
 * derives it. Agreement here plus agreement there is agreement between the
 * two implementations.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EQUITY_GUARD_ERROR_CODES, type EquityGuardErrorName } from "../src/index.ts";
import { evaluateGuard, type MirrorInvocation } from "./guard-mirror.ts";

const CORPUS_PATH = new URL("../../../programs/equity_guard/tests/fixtures/guard_conformance_v1.json", import.meta.url);

interface RawMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
interface RawInstruction {
  programId: string;
  accounts: RawMeta[];
  dataHex: string;
}
interface RawVector {
  id: string;
  group: string;
  description: string;
  /** "same": identical result required. "client-stricter": the client may reject where the program accepts. */
  clientRule: "same" | "client-stricter";
  invocation: { programId: string; dataHex: string; accounts: { pubkey: string; owner: string; dataHex: string }[] };
  transaction: { currentInstructionIndex: number; instructions: RawInstruction[] };
  clockUnixTimestamp: string;
  expected: { result: "ok" } | { result: "error"; error: EquityGuardErrorName };
}
interface Corpus {
  formatVersion: number;
  vectorCount: number;
  seed: string;
  vectors: RawVector[];
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

function invocationOf(vector: RawVector): MirrorInvocation {
  return {
    programId: vector.invocation.programId,
    data: fromHex(vector.invocation.dataHex),
    accounts: vector.invocation.accounts.map((a) => ({ pubkey: a.pubkey, owner: a.owner, data: fromHex(a.dataHex) })),
    instructions: vector.transaction.instructions.map((i) => ({
      programId: i.programId,
      accounts: i.accounts,
      data: fromHex(i.dataHex),
    })),
    currentInstructionIndex: vector.transaction.currentInstructionIndex,
    clockUnixTimestamp: BigInt(vector.clockUnixTimestamp),
  };
}

const expectedOf = (vector: RawVector) => (vector.expected.result === "ok" ? null : vector.expected.error);

test("the shared corpus is intact", () => {
  assert.equal(corpus.formatVersion, 1);
  assert.equal(corpus.vectors.length, corpus.vectorCount);
  assert.ok(corpus.vectors.length >= 200, `corpus shrank to ${corpus.vectors.length}`);
  assert.equal(new Set(corpus.vectors.map((v) => v.id)).size, corpus.vectors.length, "duplicate vector ids");
  for (const vector of corpus.vectors) {
    if (vector.expected.result === "error") {
      assert.ok(vector.expected.error in EQUITY_GUARD_ERROR_CODES, `${vector.id}: unknown error ${vector.expected.error}`);
    }
  }
});

test("every conformance vector produces its expected result", () => {
  const failures: string[] = [];
  for (const vector of corpus.vectors) {
    const actual = evaluateGuard(invocationOf(vector));
    const expected = expectedOf(vector);
    if (actual === expected) continue;
    // A client that rejects where the program accepts is fail-closed and allowed;
    // a client that accepts where the program rejects never is.
    if (vector.clientRule === "client-stricter" && expected === null && actual !== null) continue;
    failures.push(`  ${vector.id} [${vector.group}]: expected ${expected ?? "ok"}, got ${actual ?? "ok"}\n      ${vector.description}`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${corpus.vectors.length} vectors disagree:\n${failures.join("\n")}`);
});

test("no vector the corpus rejects is ever classified safe", () => {
  for (const vector of corpus.vectors) {
    const passed = evaluateGuard(invocationOf(vector)) === null;
    if (expectedOf(vector) !== null) {
      assert.equal(passed, false, `${vector.id}: the client accepted an invocation the program rejects`);
    }
  }
});

test("the corpus reaches every guard outcome on the client side too", () => {
  const produced = new Set(corpus.vectors.map((v) => evaluateGuard(invocationOf(v)) ?? "ok"));
  // The clock is a syscall the client never performs, so it cannot fail client-side.
  const unreachableOnChainOnly = new Set(["ClockUnavailable"]);
  for (const name of Object.keys(EQUITY_GUARD_ERROR_CODES) as EquityGuardErrorName[]) {
    if (unreachableOnChainOnly.has(name)) continue;
    assert.ok(produced.has(name), `no vector makes the client produce ${name}`);
  }
  assert.ok(produced.has("ok"));
});

test("every vector group is represented", () => {
  const groups = new Set(corpus.vectors.map((v) => v.group));
  assert.deepEqual([...groups].sort(), ["abi", "accounts", "clock", "downstream", "mint", "random", "state", "valid"]);
});
