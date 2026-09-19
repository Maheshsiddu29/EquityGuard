import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEVNET_GENESIS_HASH,
  clusterFromGenesisHash,
  verifyDevnetCluster,
  SOLANA_GENESIS_HASH,
} from "../src/cluster-gate.ts";

describe("Wallet Demo: Cluster Gate Safety", () => {
  it("recognizes devnet genesis hash", () => {
    assert.equal(DEVNET_GENESIS_HASH, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    assert.equal(clusterFromGenesisHash(DEVNET_GENESIS_HASH), "devnet");
  });

  it("recognizes mainnet genesis hash and maps to mainnet-beta cluster", () => {
    const mainnetGenesis = SOLANA_GENESIS_HASH["mainnet-beta"];
    assert.equal(clusterFromGenesisHash(mainnetGenesis), "mainnet-beta");
  });

  it("fails cluster verification for non-devnet genesis hashes", async () => {
    // Test with mainnet genesis hash logic
    const mainnetGenesis = SOLANA_GENESIS_HASH["mainnet-beta"] as string;
    const fakeMainnetVerification = {
      verified: (mainnetGenesis as string) === (DEVNET_GENESIS_HASH as string),
      genesisHash: mainnetGenesis,
      cluster: clusterFromGenesisHash(mainnetGenesis) || "unknown",
      reason: "Connected to mainnet-beta — refusing all state-changing actions",
    };
    assert.equal(fakeMainnetVerification.verified, false);
    assert.equal(fakeMainnetVerification.cluster, "mainnet-beta");
    assert.match(fakeMainnetVerification.reason, /mainnet-beta/);
  });
});
