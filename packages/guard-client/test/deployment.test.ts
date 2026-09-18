/**
 * Cluster and deployment resolution. There is one EquityGuard deployment, on
 * devnet; no other cluster resolves to a program, and no cluster inherits
 * another cluster's deployment.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  SOLANA_GENESIS_HASH,
  checkGuardProgramAccount,
  clusterFromGenesisHash,
  deploymentForCluster,
} from "../src/index.ts";

const PROGRAM = EQUITY_GUARD_DEVNET_PROGRAM_ID;
const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

test("public genesis hashes map to their clusters, everything else is unknown", () => {
  assert.equal(clusterFromGenesisHash(SOLANA_GENESIS_HASH["mainnet-beta"]), "mainnet-beta");
  assert.equal(clusterFromGenesisHash(SOLANA_GENESIS_HASH.devnet), "devnet");
  assert.equal(clusterFromGenesisHash(SOLANA_GENESIS_HASH.testnet), "testnet");
  // A local validator generates a fresh genesis hash on every start.
  assert.equal(clusterFromGenesisHash("11111111111111111111111111111111"), "unknown");
  assert.equal(clusterFromGenesisHash(""), "unknown");
});

test("only devnet has a deployment, and it is never lent to another cluster", () => {
  assert.equal(deploymentForCluster("devnet"), PROGRAM);
  for (const cluster of ["mainnet-beta", "testnet", "unknown"] as const) {
    assert.equal(deploymentForCluster(cluster), null, cluster);
  }
});

test("a guard program must exist and be executable", () => {
  assert.deepEqual(checkGuardProgramAccount(PROGRAM, { executable: true, owner: BPF_LOADER }), { ok: true });

  const missing = checkGuardProgramAccount(PROGRAM, null);
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "MISSING");

  const notExecutable = checkGuardProgramAccount(PROGRAM, { executable: false, owner: "11111111111111111111111111111111" });
  assert.equal(notExecutable.ok, false);
  assert.equal(notExecutable.ok === false && notExecutable.reason, "NOT_EXECUTABLE");
});
