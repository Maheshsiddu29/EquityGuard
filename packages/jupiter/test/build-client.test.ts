import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JupiterApiError,
  JupiterConfigError,
  buildRequestUrl,
  fetchBuild,
  parseBuildResponse,
  readJupiterApiKey,
} from "../src/index.ts";
import { INPUT_MINT, OUTPUT_MINT, SWAP_PROGRAM, TAKER, syntheticBuild } from "./synthetic.ts";

test("api key is required and never placed in the URL", () => {
  assert.throws(() => readJupiterApiKey({}), JupiterConfigError);
  assert.equal(readJupiterApiKey({ JUPITER_API_KEY: "k" }), "k");
  const url = buildRequestUrl({ inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: 5n, taker: TAKER, slippageBps: 50, maxAccounts: 32 });
  assert.equal(url.origin + url.pathname, "https://api.jup.ag/swap/v2/build");
  assert.equal(url.searchParams.get("maxAccounts"), "32");
  assert.ok(![...url.searchParams.keys()].some((k) => k.toLowerCase().includes("key")));
});

test("request validation rejects bad inputs", () => {
  const base = { inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: 5n, taker: TAKER, slippageBps: 50 };
  for (const bad of [
    { ...base, outputMint: "not-an-address" },
    { ...base, amount: 0n },
    { ...base, slippageBps: -1 },
    { ...base, maxAccounts: 0 },
    { ...base, maxAccounts: 65 },
  ]) {
    assert.throws(() => buildRequestUrl(bad), JupiterConfigError);
  }
});

test("fetchBuild sends the key as a header and keeps it out of errors", async () => {
  const apiKey = "secret-test-key";
  let seenHeader: string | null = null;
  const ok: typeof fetch = async (_url, init) => {
    seenHeader = new Headers(init?.headers).get("x-api-key");
    return new Response(JSON.stringify(syntheticBuild()), { status: 200 });
  };
  const request = { inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: 5n, taker: TAKER, slippageBps: 50 };
  await fetchBuild(request, { apiKey, fetchImpl: ok });
  assert.equal(seenHeader, apiKey);

  const denied: typeof fetch = async () => new Response('{"error":"no route"}', { status: 400 });
  await assert.rejects(fetchBuild(request, { apiKey, fetchImpl: denied }), (e) => {
    assert.ok(e instanceof JupiterApiError && e.status === 400 && !e.message.includes(apiKey));
    return true;
  });
});

test("response parsing enforces the /build contract", () => {
  assert.equal(parseBuildResponse(syntheticBuild()).outputMint, OUTPUT_MINT);
  const invalid = [
    { swapInstruction: undefined },
    { outAmount: "12.5" },
    { blockhashWithMetadata: { blockhash: [1, 2], lastValidBlockHeight: 1 } },
    { addressesByLookupTableAddress: { "not-an-address": [] } },
    { setupInstructions: [{ programId: SWAP_PROGRAM, accounts: [{ pubkey: TAKER, isSigner: "yes", isWritable: true }], data: "" }] },
  ];
  for (const override of invalid) {
    assert.throws(() => parseBuildResponse(syntheticBuild(override)), JupiterApiError, JSON.stringify(override));
  }
  // A null ALT map is documented and treated as no lookup tables.
  assert.deepEqual(parseBuildResponse(syntheticBuild({ addressesByLookupTableAddress: null })).addressesByLookupTableAddress, {});
});
