/**
 * M11-B scale regressions that are deterministic, so they can gate CI:
 * transaction size, instruction and account counts, the exact size limit,
 * and the absence of any EquityGuard write lock. Timings are deliberately
 * NOT asserted anywhere (see `sdk-bench.ts`, a reporting artifact).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { SYSVAR_INSTRUCTIONS_ADDRESS } from "@equityguard/guard-client";

import { MAX_TRANSACTION_BYTES } from "../../packages/jupiter/src/index.ts";
import { TAKER, recordedBuild } from "../../packages/jupiter/test/protect-fixtures.ts";
import { committedBuilds, measureBuild, sizeBoundary, type SizeRow } from "./transaction-size.ts";

/** Guarded sizes recomputed in M11-B; a change in composition shows up here. */
const EXPECTED: Readonly<Record<string, { status: string; bytes?: number; staticAccounts?: number; lookedUp?: number }>> = {
  "committed 2026-09-14 full /build|KOx BUY": { status: "PROTECTED", bytes: 675, staticAccounts: 10, lookedUp: 13 },
  "committed 2026-09-16 route_v2 recording|KOx BUY": { status: "PROTECTED", bytes: 675, staticAccounts: 10, lookedUp: 13 },
  "committed 2026-09-16 route_v2 recording|KOx SELL": { status: "PROTECTED", bytes: 675, staticAccounts: 10, lookedUp: 13 },
  "committed 2026-09-16 route_v2 recording|UNHx BUY": { status: "PROTECTED", bytes: 675, staticAccounts: 10, lookedUp: 13 },
  "committed 2026-09-16 route_v2 recording|UNHx SELL": { status: "PROTECTED", bytes: 675, staticAccounts: 10, lookedUp: 13 },
  "committed 2026-09-16 route_v2 recording|CRMx BUY": { status: "UNSUPPORTED_PROTECTED_ROUTE" },
  "committed 2026-09-16 route_v2 recording|CRMx SELL": { status: "PROTECTED", bytes: 918, staticAccounts: 18, lookedUp: 3 },
};
/** The guard instruction's own wire cost: program and Instructions-sysvar keys, indexes, 99 data bytes. */
const GUARD_INSTRUCTION_BYTES = 168;
const LARGEST_GUARDED_BYTES = 918;

let rows: SizeRow[] | null = null;
async function measured(): Promise<SizeRow[]> {
  rows ??= await Promise.all(committedBuilds().map((b) => measureBuild(b.source, b.label, b.build, b.taker)));
  return rows;
}

test("every committed real build keeps its recomputed size, counts and headroom", async () => {
  for (const row of await measured()) {
    const expected = EXPECTED[`${row.source}|${row.label}`];
    assert.ok(expected, `${row.source} ${row.label} is not pinned`);
    assert.equal(row.status, expected.status, row.label);
    if (!row.guarded) continue;
    assert.equal(row.guarded.serializedTransactionBytes, expected.bytes, row.label);
    assert.equal(row.guarded.staticAccountCount, expected.staticAccounts, row.label);
    assert.equal(row.guarded.lookedUpAddressCount, expected.lookedUp, row.label);
    assert.equal(row.guarded.instructionCount, 5, `${row.label}: [guard, price, limit, (setup), route_v2]`);
    assert.equal(row.guarded.requiredSignatures, 1, row.label);
    assert.ok(row.guarded.serializedTransactionBytes <= LARGEST_GUARDED_BYTES, row.label);
    assert.equal(row.headroomBytes, MAX_TRANSACTION_BYTES - row.guarded.serializedTransactionBytes, row.label);
  }
});

test("the guard adds exactly one instruction, two static keys and no lookups to the same suffix", async () => {
  for (const row of await measured()) {
    if (!row.guarded || !row.sameSuffix) continue;
    assert.equal(row.addedBytesByGuard, GUARD_INSTRUCTION_BYTES, row.label);
    assert.equal(row.guarded.instructionCount, row.sameSuffix.instructionCount + 1, row.label);
    assert.equal(row.guarded.staticAccountCount, row.sameSuffix.staticAccountCount + 2, `${row.label}: guard program + Instructions sysvar`);
    assert.equal(row.guarded.lookedUpAddressCount, row.sameSuffix.lookedUpAddressCount, row.label);
  }
});

test("EquityGuard adds no write lock: guard accounts are read-only and the writable set is unchanged", async () => {
  for (const row of await measured()) {
    if (!row.guarded) continue;
    assert.equal(row.guardAccountsReadOnlyNonSigner, true, row.label);
    const protectedMint = row.label.startsWith("KOx") ? "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ" : row.label.startsWith("UNHx") ? "XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe" : "XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN";
    assert.deepEqual(row.guardAccounts, [protectedMint, SYSVAR_INSTRUCTIONS_ADDRESS], row.label);
    assert.deepEqual(row.writableAddedByGuard, [], row.label);
    assert.equal(row.writableAccounts.guarded, row.writableAccounts.sameSuffix, row.label);
  }
});

test("the size limit is enforced at exactly 1232 bytes, and a refusal carries no transaction", async () => {
  const boundary = await sizeBoundary(recordedBuild("CRMx", "SELL"), TAKER);
  assert.equal(boundary.largestAccepted, MAX_TRANSACTION_BYTES);
  assert.equal(boundary.smallestRefused, MAX_TRANSACTION_BYTES + 1);
  assert.equal(boundary.refusalCode, "TRANSACTION_TOO_LARGE");
  assert.equal(boundary.refusalCarriesTransaction, false);
});

test("the program writes no account, makes no CPI and derives no account of its own", () => {
  const dir = new URL("../../programs/equity_guard/src/", import.meta.url);
  const code = (file: string) =>
    readFileSync(new URL(file, dir), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".rs"))) {
    const source = code(file);
    for (const forbidden of [/borrow_mut/, /\binvoke(_signed)?\s*\(/, /\brealloc\s*\(/, /\.assign\s*\(/, /create_program_address/]) {
      assert.doesNotMatch(source, forbidden, `${file}: ${forbidden}`);
    }
    // The only address derivations recompute other programs' accounts (ATAs, Jupiter's event authority).
    for (const derivation of source.matchAll(/find_program_address\([^;]*/g)) {
      assert.match(derivation[0], /ASSOCIATED_TOKEN_PROGRAM_ID|JUPITER_PROGRAM_ID/, `${file}: ${derivation[0]}`);
    }
  }
  // Exactly two accounts, and the mint is only ever borrowed immutably.
  const processor = code("processor.rs");
  assert.match(processor, /let \[mint, instructions_sysvar\] = accounts else/);
  assert.match(processor, /mint\s*\.try_borrow_data\(\)/);
});
