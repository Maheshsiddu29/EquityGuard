import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { address } from "@solana/kit";

import {
  LiveExecutionError,
  assertBlockhashActive,
  assertMutationGate,
  assertSetupTransactionSucceeded,
  confirmedGuardRejectionResult,
  confirmedSetupResult,
  confirmedTransferResult,
  friendlyLiveError,
  hasWalletContext,
  isConfirmedGuardRejection,
  isWalletCancellation,
  parseCustomError,
  phantomSignedTransaction,
  phantomSignature,
  type ConfirmedOutcome,
  type LiveResult,
} from "../src/live-execution.ts";
import { resultMarkup } from "../src/ui.ts";

const before = { source: 1_000_000n, destination: 0n };
const successful: ConfirmedOutcome = { signature: "safe-signature", slot: 42n, error: null, customError: null, logs: [] };
const rejected: ConfirmedOutcome = {
  signature: "block-signature",
  slot: 43n,
  error: { InstructionError: [0, { Custom: 9 }] },
  customError: { instructionIndex: 0, code: 9 },
  logs: ["Program failed: custom program error: 0x9"],
  guardInstructionIndex: 0,
};

describe("live result boundaries", () => {
  it("never renders a local preview as confirmed or transferred", () => {
    const html = resultMarkup({ type: "LOCAL_PREVIEW", kind: "SAFE", expected: "ALLOW" });
    assert.match(html, /Expected/);
    assert.match(html, /No transaction has been signed or submitted/);
    assert.doesNotMatch(html, /Confirmed on devnet|executed|transferred/i);
  });

  it("requires confirmed success metadata and the exact token delta", () => {
    const result = confirmedTransferResult("SAFE", successful, before, { source: 900_000n, destination: 100_000n }, 100_000n);
    assert.equal(result.type, "CONFIRMED_SUCCESS");
    assert.throws(() => confirmedTransferResult("SAFE", { ...successful, error: "failed" }, before, before, 100_000n));
    assert.throws(() => confirmedTransferResult("REFRESH", successful, before, before, 100_000n));
  });

  it("requires confirmed setup evidence and exact minted balances", () => {
    const result = confirmedSetupResult(successful, { source: 100_000_000n, destination: 0n }, 100_000_000n);
    assert.equal(result.type, "CONFIRMED_SUCCESS");
    assert.equal(result.kind, "SETUP");
    assert.throws(() => confirmedSetupResult({ ...successful, error: "failed" }, { source: 100_000_000n, destination: 0n }, 100_000_000n));
    assert.throws(() => confirmedSetupResult(successful, { source: 99_999_999n, destination: 1n }, 100_000_000n));
  });

  it("refuses a Phantom response with no usable signature", () => {
    assert.equal(phantomSignature({ signature: "setup-signature" }), "setup-signature");
    assert.throws(() => phantomSignature({}), (error) => error instanceof LiveExecutionError && error.stage === "SIGNING" && error.signature === undefined);
    assert.throws(() => phantomSignature({ signature: "" }), /no transaction signature/);
  });

  it("accepts only serializable signed transaction bytes from Phantom", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    assert.deepEqual(phantomSignedTransaction(bytes), bytes);
    assert.deepEqual(phantomSignedTransaction({ serialize: () => bytes }), bytes);
    assert.deepEqual(phantomSignedTransaction({ signedTransaction: { serialize: () => bytes } }), bytes);
    assert.throws(() => phantomSignedTransaction({}), /no signed transaction bytes/);
  });

  it("preserves a confirmed on-chain setup failure and its diagnostics", () => {
    assert.throws(
      () => assertSetupTransactionSucceeded(rejected),
      (error) => error instanceof LiveExecutionError && error.stage === "CONFIRMED" && error.signature === "block-signature" && error.logs.length === 1,
    );
    assert.doesNotThrow(() => assertSetupTransactionSucceeded(successful));
  });

  it("distinguishes submission and confirmation failures in primary copy", () => {
    const submission = new LiveExecutionError("SIGNING", "provider threw");
    const confirmation = new LiveExecutionError("CONFIRMING", "RPC unavailable", "returned-signature");
    const verification = new LiveExecutionError("VERIFYING_MINT", "mint missing", "confirmed-signature");
    assert.equal(friendlyLiveError("SETUP", submission), "Transaction was not submitted.");
    assert.equal(friendlyLiveError("SETUP", confirmation), "Transaction could not be confirmed.");
    assert.equal(friendlyLiveError("SETUP", verification), "Transaction confirmed, but the demo asset could not be verified.");
    assert.equal(confirmation.signature, "returned-signature");
  });

  it("uses inclusive blockhash lifetime bounds and preserves a returned signature", () => {
    assert.doesNotThrow(() => assertBlockhashActive(100n, 100n));
    assert.throws(
      () => assertBlockhashActive(101n, 100n, "returned-signature"),
      (error) => error instanceof LiveExecutionError && error.stage === "CONFIRMING" && error.signature === "returned-signature" && /current block height 101, last valid 100/.test(error.message),
    );
  });

  it("requires custom error 0x9 at the verified guard index and zero token delta for BLOCK", () => {
    const result = confirmedGuardRejectionResult(rejected, before, before);
    assert.equal(isConfirmedGuardRejection(result), true);
    assert.throws(() => confirmedGuardRejectionResult({ ...rejected, customError: null }, before, before));
    assert.throws(() => confirmedGuardRejectionResult({ ...rejected, customError: { instructionIndex: 2, code: 9 } }, before, before));
    assert.throws(() => confirmedGuardRejectionResult(rejected, before, { source: 999_999n, destination: 1n }));
  });

  it("parses only Solana custom instruction failures", () => {
    assert.deepEqual(parseCustomError({ InstructionError: [0, { Custom: 9 }] }), { instructionIndex: 0, code: 9 });
    assert.deepEqual(parseCustomError({ InstructionError: [2n, { Custom: 9n }] }), { instructionIndex: 2, code: 9 });
    assert.equal(parseCustomError({ InstructionError: [0, "InvalidArgument"] }), null);
    assert.equal(parseCustomError({ InstructionError: [-1n, { Custom: 9n }] }), null);
  });

  it("refuses mutation when cluster or reviewed deployment verification fails", () => {
    assert.throws(() => assertMutationGate({ verified: false, reason: "mainnet refused" }, null), /mainnet refused/);
    assert.throws(() => assertMutationGate({ verified: true }, { verified: false, reason: "hash mismatch" }), /hash mismatch/);
    assert.doesNotThrow(() => assertMutationGate({ verified: true }, { verified: true }));
  });

  it("requires both a wallet provider and address before submission", () => {
    const provider = {} as never;
    const wallet = address("11111111111111111111111111111111");
    assert.equal(hasWalletContext(null, wallet), false);
    assert.equal(hasWalletContext(provider, null), false);
    assert.equal(hasWalletContext(provider, wallet), true);
  });

  it("maps wallet rejection to CANCELLED without exposing the raw provider error", () => {
    const rejection = Object.assign(new Error("User rejected the request"), { code: 4001 });
    assert.equal(isWalletCancellation(rejection), true);
    assert.equal(friendlyLiveError("SAFE", rejection), "No transaction was submitted.");
    assert.match(resultMarkup({ type: "CANCELLED", kind: "SAFE", detail: friendlyLiveError("SAFE", rejection) }), /Signature request cancelled/);
    assert.equal(isWalletCancellation(new Error("Confirmed failure was not the expected guard rejection")), false);
  });

  it("provides short recovery messages for expected browser failures", () => {
    assert.match(friendlyLiveError("SETUP", new Error("Phantom wallet not found")), /Phantom was not detected/);
    assert.match(friendlyLiveError("SAFE", new Error("AccountNotFound")), /Create a new demo asset/);
    assert.match(friendlyLiveError("SAFE", new Error("Deployment verification failed: hash mismatch")), /No signature was requested/);
    assert.match(friendlyLiveError("REFRESH", new Error("Transaction expired before confirmation")), /could not be confirmed/);
  });

  it("renders confirmed wording only for confirmed result variants", () => {
    const pending: LiveResult = { type: "PENDING", kind: "SAFE", phase: "CONFIRMING", signature: "pending" };
    assert.doesNotMatch(resultMarkup(pending), /Confirmed on devnet/);
    assert.match(resultMarkup(confirmedTransferResult("REFRESH", successful, before, { source: 900_000n, destination: 100_000n }, 100_000n)), /Confirmed on devnet/);
  });
});
