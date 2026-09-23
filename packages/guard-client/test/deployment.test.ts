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

import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  REVIEWED_GUARD_DEPLOYMENTS,
  SOLANA_GENESIS_HASH,
  callerTrustedAttestation,
  checkGuardProgramAccount,
  clusterFromGenesisHash,
  decodeProgramDataHeader,
  deploymentAttestationDigest,
  deploymentForCluster,
  findReviewedGuardDeployment,
  sameGuardDeployment,
  verifyReviewedGuardDeployment,
  type GuardDeploymentAttestation,
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

/** Upgrade authority of the real devnet deployment (`docs/devnet.md`). */
const DEVNET_UPGRADE_AUTHORITY = address("JArGaWxrddR7J1XYjsoEU5XCuHffra3gASBjfVK4BuNT");

/**
 * `authority` null encodes `Option::None` (an immutable deployment); an
 * address encodes `Option::Some`. `slot` is the deployment slot.
 */
function programDataAccount(
  elf: Uint8Array = ELF,
  tail = 5_288,
  owner: string = BPF_LOADER,
  tag = 3,
  authority: Address | null = null,
  slot = 0n,
): LoaderAccountView {
  const data = new Uint8Array(45 + elf.length + tail);
  const view = new DataView(data.buffer);
  view.setUint32(0, tag, true);
  view.setBigUint64(4, slot, true);
  if (authority !== null) {
    data[12] = 1;
    data.set(getAddressEncoder().encode(authority), 13);
  }
  data.set(elf, 45);
  return { executable: false, owner, data };
}

function attestationOf(programData: LoaderAccountView): GuardDeploymentAttestation {
  const check = verifyReviewedGuardDeployment(REVIEWED, programAccount(), programData);
  assert.equal(check.ok, true, check.ok === false ? check.message : "");
  if (!check.ok) throw new Error("unreachable");
  return check.attestation;
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
  for (const programData of [programDataAccount(), programDataAccount(ELF, 0)]) {
    const check = verifyReviewedGuardDeployment(REVIEWED, programAccount(), programData);
    assert.equal(check.ok, true);
    assert.equal(check.ok === true && check.attestation.reviewedElfSha256, REVIEWED.elfSha256);
  }
});

test("every departure from the reviewed deployment fails closed with its reason", () => {
  const flipped = (offset: number) => {
    // Buffer#slice returns a view over the same memory, so copy: mutating it
    // in place would corrupt the shared ELF fixture for every later test.
    const elf = Uint8Array.from(ELF);
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

// -------------------------------------- EG-A-02: mutability is part of identity

test("ProgramData decodes an immutable deployment as None, never as an authority", () => {
  const header = decodeProgramDataHeader(programDataAccount(ELF, 0, BPF_LOADER, 3, null, 1234n).data);
  assert.deepEqual(header, { deploymentSlot: 1234n, upgradeAuthority: null, mutability: "IMMUTABLE" });
});

test("ProgramData decodes a live upgrade authority, and reports it as upgradeable", () => {
  const header = decodeProgramDataHeader(programDataAccount(ELF, 0, BPF_LOADER, 3, DEVNET_UPGRADE_AUTHORITY, 99n).data);
  assert.deepEqual(header, {
    deploymentSlot: 99n,
    upgradeAuthority: DEVNET_UPGRADE_AUTHORITY,
    mutability: "UPGRADEABLE",
  });
});

test("an undecodable ProgramData header is null, never a guessed authority", () => {
  const short = programDataAccount(ELF, 0).data.subarray(0, 44);
  assert.equal(decodeProgramDataHeader(short), null, "shorter than the header");
  assert.equal(decodeProgramDataHeader(new Uint8Array(0)), null, "empty");
  // A Program (tag 2) account is not ProgramData.
  assert.equal(decodeProgramDataHeader(programDataAccount(ELF, 0, BPF_LOADER, 2).data), null, "wrong state tag");
  // bincode Option is 0 or 1; anything else is a malformed encoding.
  for (const option of [2, 0xff]) {
    const data = programDataAccount(ELF, 0).data.slice();
    data[12] = option;
    assert.equal(decodeProgramDataHeader(data), null, `option discriminant ${option}`);
  }
});

test("a reviewed deployment with a malformed authority encoding fails closed", () => {
  const programData = programDataAccount();
  programData.data[12] = 7;
  const check = verifyReviewedGuardDeployment(REVIEWED, programAccount(), programData);
  assert.equal(check.ok, false);
  assert.equal(check.ok === false && check.reason, "MALFORMED_PROGRAM_DATA");
});

test("the attestation surfaces the authority and mutability, not just the ELF hash", () => {
  const immutable = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, null, 7n));
  assert.deepEqual(immutable, {
    programId: PROGRAM,
    programDataAddress: REVIEWED.programDataAddress,
    reviewedElfSha256: REVIEWED.elfSha256,
    deploymentSlot: 7n,
    upgradeAuthority: null,
    mutability: "IMMUTABLE",
    identity: "REVIEWED_BINARY",
  });

  const upgradeable = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, DEVNET_UPGRADE_AUTHORITY, 7n));
  assert.equal(upgradeable.mutability, "UPGRADEABLE");
  assert.equal(upgradeable.upgradeAuthority, DEVNET_UPGRADE_AUTHORITY);
  // Same reviewed bytes, different security statement: these must not compare equal.
  assert.equal(sameGuardDeployment(immutable, upgradeable), false);
});

test("an unreviewed program is never reported as immutable", () => {
  const attestation = callerTrustedAttestation(PROGRAM);
  assert.equal(attestation.identity, "CALLER_TRUSTED");
  assert.equal(attestation.mutability, "UNKNOWN");
  assert.equal(attestation.reviewedElfSha256, null);
  assert.equal(attestation.upgradeAuthority, null);
  assert.notEqual(attestation.mutability, "IMMUTABLE");
});

test("the attestation digest covers identity, binary and authority, but not redeploy slot", () => {
  const base = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, null, 1n));
  // Re-deploying identical bytes at a later slot is not a substitution.
  const laterSlot = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, null, 9_999n));
  assert.equal(sameGuardDeployment(base, laterSlot), true);

  const changes: readonly (readonly [string, GuardDeploymentAttestation])[] = [
    ["authority appeared", { ...base, upgradeAuthority: DEVNET_UPGRADE_AUTHORITY, mutability: "UPGRADEABLE" }],
    ["mutability alone", { ...base, mutability: "UNKNOWN" }],
    ["different ELF", { ...base, reviewedElfSha256: "00".repeat(32) }],
    ["different program", { ...base, programId: address("11111111111111111111111111111111") }],
    ["different ProgramData", { ...base, programDataAddress: address("11111111111111111111111111111111") }],
    ["downgraded identity", { ...base, identity: "CALLER_TRUSTED" }],
  ];
  for (const [label, changed] of changes) {
    assert.notEqual(deploymentAttestationDigest(changed), deploymentAttestationDigest(base), label);
    assert.equal(sameGuardDeployment(base, changed), false, label);
  }
});

test("a zero upgrade authority is neither upgradeable nor immutable", () => {
  // `solana-test-validator --upgradeable-program <id> <so> none` writes
  // Some(11111111111111111111111111111111), not None. No signer exists for
  // that address, so the program cannot be upgraded — but it is not the
  // canonical immutable encoding and must never be reported as immutable.
  const zero = address("11111111111111111111111111111111");
  const header = decodeProgramDataHeader(programDataAccount(ELF, 0, BPF_LOADER, 3, zero, 0n).data);
  assert.deepEqual(header, { deploymentSlot: 0n, upgradeAuthority: zero, mutability: "NO_USABLE_AUTHORITY" });

  const attestation = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, zero, 0n));
  assert.equal(attestation.mutability, "NO_USABLE_AUTHORITY");
  assert.notEqual(attestation.mutability, "IMMUTABLE");
  assert.equal(attestation.upgradeAuthority, zero, "the authority is reported, not hidden");

  // It is its own classification: all three differ from one another.
  const immutable = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, null, 0n));
  const upgradeable = attestationOf(programDataAccount(ELF, 0, BPF_LOADER, 3, DEVNET_UPGRADE_AUTHORITY, 0n));
  const digests = [attestation, immutable, upgradeable].map(deploymentAttestationDigest);
  assert.equal(new Set(digests).size, 3, "same reviewed ELF, three distinct deployment statements");
});
