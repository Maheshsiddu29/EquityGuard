/**
 * The security boundary of the integration surface, enforced rather than
 * documented: the package builds transactions and nothing else.
 *
 * It must not be able to sign, submit, hold key material or depend on any
 * environment configuration, and its public entry point must expose only the
 * intended API.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import * as protect from "../src/protect.ts";
import { KOX_MINT, SETTLED_TIMESTAMP, TAKER, fakeRpc, mainnetMint, recordedKoxBuyBuild, token2022Account } from "./protect-fixtures.ts";

const SRC = new URL("../src/", import.meta.url);
const GUARD_CLIENT_SRC = new URL("../../guard-client/src/", import.meta.url);

/** Anything that could sign, submit, hold a key, or reach a network the caller did not choose. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bsendTransaction\b/, "submits transactions"],
  [/\bsendRawTransaction\b/, "submits transactions"],
  [/\bsendAndConfirmTransaction\b/, "submits transactions"],
  [/\brequestAirdrop\b/, "requests airdrops"],
  [/\bsignTransaction\b/, "signs transactions"],
  [/\bsignBytes\b/, "signs"],
  [/\bcreateKeyPair\w*/, "creates key material"],
  [/\bgenerateKeyPair\w*/, "creates key material"],
  [/\bKeypair\b/, "holds key material"],
  [/\bsecretKey\b/, "holds key material"],
  [/\bprivateKey\b/, "holds key material"],
  [/\bprocess\.env\b/, "reads environment configuration"],
];

function sourceFiles(dir: URL): { readonly name: string; readonly text: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));
}

test("J: no source file in the integration path can sign, submit or hold a key", () => {
  const files = [...sourceFiles(SRC), ...sourceFiles(GUARD_CLIENT_SRC)];
  // The scan is only meaningful if it actually reads both packages' sources.
  assert.ok(sourceFiles(SRC).length >= 4 && sourceFiles(GUARD_CLIENT_SRC).length >= 10, `scanned only ${files.length} files`);
  for (const file of files) {
    for (const [pattern, why] of FORBIDDEN) {
      assert.ok(!pattern.test(file.text), `${file.name} ${why} (${pattern})`);
    }
  }
});

test("J: the only network call the package can make is the caller's own Jupiter /build", () => {
  for (const file of sourceFiles(SRC)) {
    const fetches = /\bfetch\b|\bXMLHttpRequest\b|node:http\b|node:net\b|WebSocket/.test(file.text);
    assert.ok(!fetches || file.name === "build-client.ts", `${file.name} must not reach the network`);
  }
  // The protect entry point itself does no I/O beyond the RPC handed to it.
  const text = readFileSync(new URL("protect.ts", SRC), "utf8");
  assert.ok(!/\bfetch\b/.test(text));
  assert.ok(!/JUPITER_API_KEY/.test(text));
});

test("J: a protected transaction comes back unsigned", async () => {
  const result = await protect.protectJupiterSwap({
    build: recordedKoxBuyBuild(),
    userPublicKey: TAKER,
    rpc: fakeRpc({ accounts: { [KOX_MINT]: token2022Account(mainnetMint("KOx")) }, unixTimestamp: SETTLED_TIMESTAMP }).rpc,
    protectionWindow: { beforeSecs: 900, afterSecs: 300 },
  });
  assert.equal(result.status, "PROTECTED");
  if (result.status !== "PROTECTED") return;
  assert.equal(result.transaction[0], 1, "one signature slot");
  assert.deepEqual(result.transaction.subarray(1, 65), new Uint8Array(64), "and it is empty");
  assert.equal(result.metrics.requiredSignatures, 1, "only the user signs");
});

test("K: the entry point exposes exactly the intended API", () => {
  assert.deepEqual(Object.keys(protect).sort(), [
    "DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS",
    "EquityGuardFailureCode",
    "SUPPORTED_JUPITER_ROUTES",
    "USDC_MINT_ADDRESS",
    "explainEquityGuardError",
    "protectJupiterSwap",
    "supportsJupiterSwap",
    "verifyProtectedSwap",
  ]);
  for (const name of ["protectJupiterSwap", "supportsJupiterSwap", "verifyProtectedSwap", "explainEquityGuardError"] as const) {
    assert.equal(typeof protect[name], "function", name);
  }
});

test("K: the package declares the entry point as a subpath export", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
  assert.equal(manifest.exports["./protect"], "./src/protect.ts");
});

test("L: the core helper needs no environment or secret configuration", async () => {
  const saved = process.env;
  try {
    process.env = {};
    const result = await protect.protectJupiterSwap({
      build: recordedKoxBuyBuild(),
      userPublicKey: TAKER,
      rpc: fakeRpc({ accounts: { [KOX_MINT]: token2022Account(mainnetMint("KOx")) }, unixTimestamp: SETTLED_TIMESTAMP }).rpc,
      protectionWindow: { beforeSecs: 900, afterSecs: 300 },
    });
    assert.equal(result.status, "PROTECTED");
  } finally {
    process.env = saved;
  }
});

test("L: every failure code has a deterministic explanation and none suggests falling back", () => {
  const seen = new Set<string>();
  for (const code of Object.values(protect.EquityGuardFailureCode)) {
    const result = { status: "ERROR", code, message: "m", protectedMint: KOX_MINT, guardError: null, details: [] } as const;
    const explanation = protect.explainEquityGuardError(result);
    assert.equal(explanation, protect.explainEquityGuardError(result), `${code} is deterministic`);
    assert.match(explanation, /must not be sent in its place/, code);
    assert.ok(!seen.has(explanation), `${code} has its own explanation`);
    seen.add(explanation);
  }
  assert.equal(seen.size, Object.keys(protect.EquityGuardFailureCode).length);
});
