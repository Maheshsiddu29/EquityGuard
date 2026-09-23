/**
 * EG-A-01, the other half: the trusted-builder boundary is a real module
 * boundary, not a comment.
 *
 * The builders that take a caller-chosen economic-state expectation still
 * work — they have to, a first-party wallet composes with them — but they are
 * reachable only through an entry point whose name and documentation say what
 * the caller is taking on. These tests pin that classification so an
 * expectation-accepting builder cannot quietly reappear on the canonical
 * surface.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { address, type Address } from "@solana/kit";

import * as canonical from "../src/index.ts";
import * as advanced from "../src/advanced.ts";
import { ActivationPhase, DownstreamAdapterKind, checkGuardOffline, decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS } from "../src/index.ts";
import { encodeAssertSafeExecutionV2, TRUSTED_BUILDER_APIS, TRUSTED_BUILDER_CONTRACT } from "../src/advanced.ts";
import { mainnetMint } from "./fixtures.ts";

/** Offset of the activation-phase byte in the ABI v2 payload. */
const EXPECTED_PHASE_OFFSET = 57;
const MINT = address("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ") as Address;
const KOX = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, mainnetMint("KOx"));

test("every trusted builder is reachable from /advanced and from nowhere else", () => {
  for (const name of TRUSTED_BUILDER_APIS) {
    assert.equal(typeof (advanced as Record<string, unknown>)[name], "function", `${name} is exported from /advanced`);
    assert.equal(
      (canonical as Record<string, unknown>)[name],
      undefined,
      `${name} accepts a caller-chosen expectation and must not be on the canonical surface`,
    );
  }
});

test("the manifest names every expectation-accepting builder this package has", () => {
  // Guards against adding a builder to /advanced without listing it, which
  // would leave the canonical-surface check above with nothing to assert.
  const exported = Object.keys(advanced).filter((name) => typeof (advanced as Record<string, unknown>)[name] === "function");
  const safeHelpers = ["checkGuardOffline", "expectationFromSnapshot", "fetchGuardSnapshot"];
  assert.deepEqual(
    exported.filter((name) => !safeHelpers.includes(name)).sort(),
    [...TRUSTED_BUILDER_APIS].sort(),
  );
});

test("the package declares /advanced as its own subpath export", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
  assert.equal(manifest.exports["./advanced"], "./src/advanced.ts");
  assert.equal(manifest.exports["."], "./src/index.ts");
});

test("the trusted-builder contract is stated verbatim where the module documents it", () => {
  assert.match(TRUSTED_BUILDER_CONTRACT, /^Trusted-builder API\./);
  assert.match(TRUSTED_BUILDER_CONTRACT, /the caller is responsible/i);
  assert.match(TRUSTED_BUILDER_CONTRACT, /the state under which the user is authorizing the transaction/);

  // The module is the tracked artifact, so this one is unconditional.
  assert.ok(includesWrapped(readFileSync(new URL("../src/advanced.ts", import.meta.url), "utf8"), TRUSTED_BUILDER_CONTRACT));

  // `docs/` is local-only by repository policy (.gitignore keeps every *.md
  // but the root README), so a fresh checkout has no document to compare
  // against. Check it when it is there, to catch drift during development.
  const guide = new URL("../../../docs/sdk-trust-boundary.md", import.meta.url);
  if (existsSync(guide)) {
    assert.ok(includesWrapped(readFileSync(guide, "utf8"), TRUSTED_BUILDER_CONTRACT), "docs/sdk-trust-boundary.md");
  }
});

/**
 * The contract is line-wrapped, and in the document it is a blockquote. Strip
 * leading `*` (JSDoc) and `>` (Markdown) markers, then collapse whitespace, so
 * the comparison is about the sentence rather than its formatting.
 */
function includesWrapped(text: string, sentence: string): boolean {
  const flatten = (value: string) => value.replace(/^[ \t]*[*>][ \t]?/gm, "").replace(/\s+/g, " ").trim();
  return flatten(text).includes(flatten(sentence));
}

test("a trusted builder can still encode an expectation the chain does not currently hold", () => {
  // This is the capability the boundary exists to label, so it is asserted
  // rather than assumed: /advanced really does encode what it is given.
  const future = encodeAssertSafeExecutionV2({
    expectedMint: MINT,
    expected: KOX,
    expectedPhase: ActivationPhase.Activated,
    window: { beforeSecs: 0, afterSecs: 0 },
    adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC,
    downstreamCommitment: new Uint8Array(32),
  });
  assert.equal(future[EXPECTED_PHASE_OFFSET], ActivationPhase.Activated);

  // And it is exactly the payload the guard would reject before T and accept
  // after it — the asymmetry a trusted builder is on the hook for.
  const beforeT = KOX.newMultiplierEffectiveTimestamp - 1n;
  const afterT = KOX.newMultiplierEffectiveTimestamp + 1n;
  const request = { expected: KOX, expectedPhase: ActivationPhase.Activated, window: { beforeSecs: 0, afterSecs: 0 } };
  assert.equal(checkGuardOffline(request, KOX, beforeT), "ActivationPhaseChanged");
  assert.equal(checkGuardOffline(request, KOX, afterT), null, "accepted once the Clock is past T");
});

test("the safety check a trusted builder is told to run is on the same entry point", () => {
  // The module documents "call checkGuardOffline against a fresh snapshot":
  // that must not require importing a second entry point.
  for (const name of ["checkGuardOffline", "expectationFromSnapshot", "fetchGuardSnapshot"]) {
    assert.equal(typeof (advanced as Record<string, unknown>)[name], "function", name);
  }
});
