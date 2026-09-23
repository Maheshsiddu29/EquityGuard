import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FeasibilityError,
  assertLocalRpcUrl,
  assertSigningAvailable,
  inspectProvider,
  signedTransactionBytes,
} from "../src/feasibility.ts";

test("RPC submission gate allows only exact localhost HTTP hostnames", () => {
  assert.equal(assertLocalRpcUrl("http://127.0.0.1:8899").hostname, "127.0.0.1");
  assert.equal(assertLocalRpcUrl("http://localhost:8899").hostname, "localhost");
  for (const url of [
    "https://127.0.0.1:8899",
    "http://127.0.0.1.evil.example:8899",
    "http://localhost.evil.example:8899",
    "https://api.devnet.solana.com",
    "https://api.mainnet-beta.solana.com",
  ]) {
    assert.throws(
      () => assertLocalRpcUrl(url),
      (error) => error instanceof FeasibilityError && error.kind === "LOCAL_RPC_REFUSED",
      url,
    );
  }
});

test("provider inspection records actual injected function availability", () => {
  const capabilities = inspectProvider({
    isPhantom: true,
    connect() {},
    signTransaction() {},
    signAndSendTransaction() {},
    request() {},
  });
  assert.deepEqual(capabilities, {
    isPhantom: true,
    connect: true,
    signTransaction: true,
    signAndSendTransaction: true,
    request: true,
  });
  assert.doesNotThrow(() => assertSigningAvailable(capabilities));
});

test("experiment stops when signTransaction is unavailable", () => {
  const capabilities = inspectProvider({ isPhantom: true, connect() {}, request() {} });
  assert.throws(
    () => assertSigningAvailable(capabilities),
    (error) => error instanceof FeasibilityError && error.kind === "SIGN_TRANSACTION_UNAVAILABLE",
  );
});

test("signed response extraction accepts bytes and serializable transaction objects", () => {
  const bytes = Uint8Array.of(1, 2, 3);
  assert.deepEqual(signedTransactionBytes(bytes), bytes);
  assert.deepEqual(signedTransactionBytes({ signedTransaction: { serialize: () => bytes } }), bytes);
  assert.throws(
    () => signedTransactionBytes({}),
    (error) => error instanceof FeasibilityError && error.kind === "SERIALIZATION_FAILURE",
  );
});
