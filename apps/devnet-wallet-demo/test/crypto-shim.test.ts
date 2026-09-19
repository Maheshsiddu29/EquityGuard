import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash as nodeCreateHash } from "node:crypto";
import { createHash as shimCreateHash } from "../src/crypto-shim.ts";
import { downstreamCommitmentPreimage, downstreamCommitment } from "@equityguard/guard-client";
import { address } from "@solana/kit";

describe("Wallet Demo: Crypto Shim Equivalence", () => {
  it("produces byte-identical SHA-256 hashes compared to node:crypto", () => {
    const testPayloads = [
      new TextEncoder().encode("EQUITYGUARD_DOWNSTREAM_V2"),
      new Uint8Array([0, 1, 2, 3, 4, 255, 254, 253]),
      new Uint8Array(1024).fill(0xab),
    ];

    for (const payload of testPayloads) {
      const nodeHash = nodeCreateHash("sha256").update(payload).digest("hex");
      const shimHash = shimCreateHash("sha256").update(payload).digest("hex");
      assert.equal(shimHash, nodeHash, "SHA-256 hash mismatch between node:crypto and crypto-shim");
    }
  });

  it("produces byte-identical downstream commitments for real instruction preimages", () => {
    const committedInst = {
      programAddress: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      accounts: [
        { address: address("7w2MRSqKByxbNkYoXWR7vNC2D8yaZ3iPfZCVd4FcrBgT"), isSigner: false, isWritable: true },
        { address: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), isSigner: false, isWritable: false },
        { address: address("ECrVumzWbWA4c352fohUimkUmRkYm6ubAuyU8hb3Yr3y"), isSigner: false, isWritable: true },
        { address: address("JArGaWxrddR7J1XYjsoEU5XCuHffra3gASBjfVK4BuNT"), isSigner: true, isWritable: true },
      ],
      data: Uint8Array.from([12, 0, 225, 245, 5, 0, 0, 0, 0, 6]),
    };

    const preimage = downstreamCommitmentPreimage(committedInst);
    const nodeCommitmentHex = nodeCreateHash("sha256").update(preimage).digest("hex");
    const shimCommitmentHex = shimCreateHash("sha256").update(preimage).digest("hex");
    const clientCommitmentHex = Buffer.from(downstreamCommitment(committedInst)).toString("hex");

    assert.equal(shimCommitmentHex, nodeCommitmentHex);
    assert.equal(shimCommitmentHex, clientCommitmentHex);
  });
});
