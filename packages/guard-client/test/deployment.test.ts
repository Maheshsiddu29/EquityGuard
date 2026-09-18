/**
 * Cluster and deployment resolution. There is one EquityGuard deployment, on
 * devnet; no other cluster resolves to a program, and no cluster inherits
 * another cluster's deployment.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  REVIEWED_GUARD_DEPLOYMENTS,
  SOLANA_GENESIS_HASH,
  checkGuardProgramAccount,
  clusterFromGenesisHash,
  deploymentForCluster,
  findReviewedGuardDeployment,
  verifyReviewedGuardDeployment,
  type LoaderAccountView,
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

// ------------------------------------------ M11-A: deployment identity

const REVIEWED = REVIEWED_GUARD_DEPLOYMENTS[0]!;
const ELF = gunzipSync(readFileSync(new URL("./fixtures/equity_guard-devnet-d7d59ccd.so.gz", import.meta.url)));

function programAccount(pointer: string = REVIEWED.programDataAddress, owner: string = BPF_LOADER, tag = 2): LoaderAccountView {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, tag, true);
  data.set(getAddressEncoder().encode(address(pointer)), 4);
  return { executable: true, owner, data };
}

function programDataAccount(elf: Uint8Array = ELF, tail = 5_288, owner: string = BPF_LOADER, tag = 3): LoaderAccountView {
  const data = new Uint8Array(45 + elf.length + tail);
  new DataView(data.buffer).setUint32(0, tag, true);
  data.set(elf, 45);
  return { executable: false, owner, data };
}

test("the reviewed deployment record is the recorded devnet deployment, and only that", async () => {
  assert.equal(REVIEWED_GUARD_DEPLOYMENTS.length, 1, "no mainnet or other deployment is claimed");
  const recorded = JSON.parse(readFileSync(new URL("../../../scripts/devnet/devnet.json", import.meta.url), "utf8")) as {
    cluster: string;
    deployment: { programId: string; programDataAddress: string; sbfSha256: string; abiVersion: number };
  };
  assert.equal(REVIEWED.cluster, recorded.cluster);
  assert.equal(REVIEWED.programAddress, recorded.deployment.programId);
  assert.equal(REVIEWED.programDataAddress, recorded.deployment.programDataAddress);
  assert.equal(REVIEWED.elfSha256, recorded.deployment.sbfSha256);
  assert.equal(recorded.deployment.abiVersion, 2);
  assert.equal(findReviewedGuardDeployment(PROGRAM), REVIEWED);
  assert.equal(findReviewedGuardDeployment("11111111111111111111111111111111"), null);

  // ProgramData is the loader's PDA of the program: the record cannot name another account.
  const [derived] = await getProgramDerivedAddress({ programAddress: address(BPF_LOADER), seeds: [getAddressEncoder().encode(PROGRAM)] });
  assert.equal(REVIEWED.programDataAddress, derived);

  // The committed fixture is the reviewed artifact, at the reviewed length.
  assert.equal(ELF.length, REVIEWED.elfLength);
  assert.equal(createHash("sha256").update(ELF).digest("hex"), REVIEWED.elfSha256);
  assert.equal(Buffer.from(ELF.subarray(0, 4)).toString("hex"), "7f454c46", "an ELF");
});

test("the reviewed binary under the upgradeable loader verifies, with or without a zero tail", () => {
  assert.deepEqual(verifyReviewedGuardDeployment(REVIEWED, programAccount(), programDataAccount()), { ok: true });
  assert.deepEqual(verifyReviewedGuardDeployment(REVIEWED, programAccount(), programDataAccount(ELF, 0)), { ok: true });
});

test("every departure from the reviewed deployment fails closed with its reason", () => {
  const flipped = (offset: number) => {
    const elf = ELF.slice();
    elf[offset] = (elf[offset] ?? 0) ^ 1;
    return elf;
  };
  const withTail = (byte: number, at: number) => {
    const account = programDataAccount();
    account.data[45 + ELF.length + at] = byte;
    return account;
  };
  const other = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  const cases: [string, LoaderAccountView | null, LoaderAccountView | null, string][] = [
    ["no program account", null, programDataAccount(), "MISSING"],
    ["program not executable", { ...programAccount(), executable: false }, programDataAccount(), "NOT_EXECUTABLE"],
    ["program under another loader", programAccount(undefined, "BPFLoader2111111111111111111111111111111111"), programDataAccount(), "UNEXPECTED_LOADER"],
    ["program account is a Buffer", programAccount(undefined, undefined, 1), programDataAccount(), "UNEXPECTED_LOADER"],
    ["program account with trailing bytes", { ...programAccount(), data: new Uint8Array([...programAccount().data, 0]) }, programDataAccount(), "UNEXPECTED_LOADER"],
    ["program points at other ProgramData", programAccount(other), programDataAccount(), "PROGRAM_DATA_MISMATCH"],
    ["ProgramData missing", programAccount(), null, "PROGRAM_DATA_MISMATCH"],
    ["ProgramData under another owner", programAccount(), programDataAccount(ELF, 5_288, "11111111111111111111111111111111"), "PROGRAM_DATA_MISMATCH"],
    ["ProgramData with a Program tag", programAccount(), programDataAccount(ELF, 5_288, BPF_LOADER, 2), "PROGRAM_DATA_MISMATCH"],
    ["ELF one byte short", programAccount(), programDataAccount(ELF.subarray(0, ELF.length - 1), 0), "PROGRAM_DATA_MISMATCH"],
    ["first ELF byte flipped", programAccount(), programDataAccount(flipped(0)), "BINARY_MISMATCH"],
    ["last ELF byte flipped", programAccount(), programDataAccount(flipped(ELF.length - 1)), "BINARY_MISMATCH"],
    ["code byte flipped", programAccount(), programDataAccount(flipped(ELF.length >> 1)), "BINARY_MISMATCH"],
    ["bytes appended after the ELF", programAccount(), withTail(0x90, 0), "BINARY_MISMATCH"],
    ["last byte of the region set", programAccount(), withTail(1, 5_287), "BINARY_MISMATCH"],
    ["ELF shifted by one byte", programAccount(), programDataAccount(Uint8Array.from([0, ...ELF])), "BINARY_MISMATCH"],
  ];
  for (const [label, program, programData, reason] of cases) {
    const check = verifyReviewedGuardDeployment(REVIEWED, program, programData);
    assert.equal(check.ok, false, label);
    assert.equal(check.ok === false && check.reason, reason, label);
  }
});
