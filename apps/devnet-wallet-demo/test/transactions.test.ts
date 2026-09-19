import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { address, type Address, type TransactionSigner } from "@solana/kit";
import { ActivationPhase, type GuardSnapshot } from "@equityguard/guard-client";
import {
  getBaselineExpectation,
  getStaleExpectation,
  buildSafeGuardedTransfer,
  buildStaleGuardedTransfer,
} from "../src/transactions.ts";
import { buildTransferCheckedInstruction } from "../src/demo-asset.ts";

const MOCK_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const MOCK_FEE_PAYER = address("11111111111111111111111111111111");
const MOCK_SOURCE = address("7w2MRSqKByxbNkYoXWR7vNC2D8yaZ3iPfZCVd4FcrBgT");
const MOCK_DEST = address("ECrVumzWbWA4c352fohUimkUmRkYm6ubAuyU8hb3Yr3y");

function f64Bytes(val: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, val, true);
  return new Uint8Array(buf);
}

const mockSnapshot: GuardSnapshot = {
  mint: MOCK_MINT,
  contextSlot: 1000n,
  clock: { slot: 1000n, unixTimestamp: 1700000000n },
  state: {
    multiplier: f64Bytes(1.0),
    newMultiplierEffectiveTimestamp: 0n,
    newMultiplier: f64Bytes(1.0),
  },
  phase: ActivationPhase.Activated,
  hasScheduledChange: false,
};

describe("Wallet Demo: Guarded Transaction Composition", () => {
  it("derives baseline expectation matching snapshot state", () => {
    const expectation = getBaselineExpectation(mockSnapshot);
    assert.deepEqual(expectation.expected.multiplier, f64Bytes(1.0));
    assert.equal(expectation.expectedPhase, ActivationPhase.Activated);
    assert.equal(expectation.window.beforeSecs, 60);
    assert.equal(expectation.window.afterSecs, 60);
  });

  it("derives stale expectation with corrupted multiplier", () => {
    const staleExpectation = getStaleExpectation(mockSnapshot, 0.05);
    assert.notDeepEqual(staleExpectation.expected.multiplier, f64Bytes(1.0));
    assert.deepEqual(staleExpectation.expected.multiplier, f64Bytes(1.05));
  });

  it("builds safe guarded transfer transaction instructions", () => {
    const mockSigner: TransactionSigner = {
      address: MOCK_FEE_PAYER,
      signTransactions: async (txs) => txs,
    };

    const transferChecked = buildTransferCheckedInstruction({
      source: MOCK_SOURCE,
      mint: MOCK_MINT,
      destination: MOCK_DEST,
      authority: mockSigner,
      amount: 1000n,
      decimals: 6,
    });

    const guarded = buildSafeGuardedTransfer({
      feePayer: MOCK_FEE_PAYER,
      mint: MOCK_MINT,
      snapshot: mockSnapshot,
      transferChecked,
    });

    assert.equal(guarded.instructions.length, 2);
    assert.equal(guarded.instructions[1], transferChecked);
    assert.equal(guarded.commitment.length, 32);
  });

  it("builds stale guarded transfer transaction with corrupted expectation", () => {
    const mockSigner: TransactionSigner = {
      address: MOCK_FEE_PAYER,
      signTransactions: async (txs) => txs,
    };

    const transferChecked = buildTransferCheckedInstruction({
      source: MOCK_SOURCE,
      mint: MOCK_MINT,
      destination: MOCK_DEST,
      authority: mockSigner,
      amount: 1000n,
      decimals: 6,
    });

    const guarded = buildStaleGuardedTransfer({
      feePayer: MOCK_FEE_PAYER,
      mint: MOCK_MINT,
      snapshot: mockSnapshot,
      transferChecked,
      multiplierOffset: 0.1,
    });

    assert.equal(guarded.instructions.length, 2);
    assert.equal(guarded.commitment.length, 32);
  });
});
