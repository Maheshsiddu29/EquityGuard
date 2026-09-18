/**
 * M11-B differential corpus, as a CI-sized regression on the TypeScript side.
 *
 * The full run (`differential.ts`, 1,000,000 cases) streams the same corpus
 * through the Rust host model and a LiteSVM sample; that needs a cargo build
 * and minutes, so it is a reporting harness. This test pins what can be
 * pinned without Rust: the generator is deterministic for a seed, and the
 * TypeScript mirror's verdicts on the first 5,000 cases hash to the value
 * the Rust host model produced for the same bytes when it was recorded.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { evaluateGuard } from "../../packages/guard-client/test/guard-mirror.ts";
import { Generator, generateCase } from "./differential.ts";
import { ExpectKind, encodeCase, mirrorInvocation, resultByte } from "./guard-cases.ts";

const SEED = 0x4d11bn;
const COUNT = 5000;
/** Recorded 2026-09-18: TypeScript and the Rust host model both produced this results hash. */
const CORPUS_SHA256 = "d1dcb7068a706c2a3def6c31ed9d3f75682b4b36b674e354562205fedd24d6ec";
const RESULTS_SHA256 = "bf3a732d1938151568c7fa75c8e8b2f81c213ac9d0d98ebae2df442471c9862c";

function corpus(seed: bigint, count: number) {
  const g = new Generator(seed);
  return Array.from({ length: count }, (_, i) => generateCase(g, i));
}

test("the same seed generates the same corpus; another seed does not", () => {
  const hash = (seed: bigint) => {
    const h = createHash("sha256");
    for (const c of corpus(seed, 500)) h.update(encodeCase(c));
    return h.digest("hex");
  };
  assert.equal(hash(SEED), hash(SEED));
  assert.notEqual(hash(SEED), hash(0x5eed2n));
});

test("5,000 cases: pinned corpus, pinned cross-implementation results, no unexpected verdict", async () => {
  const cases = corpus(SEED, COUNT);
  const input = createHash("sha256");
  const results = new Uint8Array(COUNT);
  const surprises: string[] = [];
  for (const [i, c] of cases.entries()) {
    input.update(encodeCase(c));
    const byte = resultByte(await evaluateGuard(mirrorInvocation(c)));
    results[i] = byte;
    const blocked = byte !== 0;
    if (c.expectKind === ExpectKind.ALLOW && blocked) surprises.push(`case ${i}: unexpected block`);
    if ((c.expectKind === ExpectKind.BLOCK_EXACT || c.expectKind === ExpectKind.BLOCK_ANY) && !blocked) surprises.push(`case ${i}: unexpected allow`);
    if (c.expectKind === ExpectKind.BLOCK_EXACT && byte !== c.expectCode + 1) surprises.push(`case ${i}: wrong error`);
  }
  assert.deepEqual(surprises, []);
  assert.equal(input.digest("hex"), CORPUS_SHA256);
  assert.equal(createHash("sha256").update(results).digest("hex"), RESULTS_SHA256);
  // Every expectation class is exercised.
  const kinds = new Set(cases.map((c) => c.expectKind));
  assert.equal(kinds.size, 4);
});
