/**
 * EG-A-02, demo side: the coordinator attests the guard program it is about
 * to have a user sign against, and re-attests it before submission.
 *
 * The local validator loads the reviewed ELF with `--upgradeable-program …
 * none`. Read back from a running validator, that writes
 * `Some(11111111111111111111111111111111)` rather than `None`, so the local
 * deployment is NO_USABLE_AUTHORITY while the devnet one at the same address
 * is UPGRADEABLE and a finalised one is IMMUTABLE. All three are covered,
 * because the whole point of surfacing mutability is that the same reviewed
 * bytes make three different security statements.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { address, getAddressEncoder, type Address } from "@solana/kit";

import { REVIEWED_GUARD_DEPLOYMENTS, type LoaderAccountView } from "../../../packages/guard-client/src/index.ts";
import {
  DeploymentAttestationError,
  attestGuardDeployment,
  reattestGuardDeployment,
  type AccountReader,
} from "../server/deployment-attestation.ts";

const REVIEWED = REVIEWED_GUARD_DEPLOYMENTS[0]!;
const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const DEVNET_UPGRADE_AUTHORITY = address("JArGaWxrddR7J1XYjsoEU5XCuHffra3gASBjfVK4BuNT");
const ELF = gunzipSync(readFileSync(new URL("../../../packages/guard-client/test/fixtures/equity_guard-devnet-d7d59ccd.so.gz", import.meta.url)));

function programAccount(): LoaderAccountView {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(getAddressEncoder().encode(REVIEWED.programDataAddress), 4);
  return { executable: true, owner: BPF_LOADER, data };
}

function programDataAccount(authority: Address | null, elf: Uint8Array = ELF): LoaderAccountView {
  const data = new Uint8Array(45 + elf.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 499_547_040n, true);
  if (authority !== null) {
    data[12] = 1;
    data.set(getAddressEncoder().encode(authority), 13);
  }
  data.set(elf, 45);
  return { executable: false, owner: BPF_LOADER, data };
}

/** A reader over a fixed pair of loader accounts, counting its calls. */
function reader(accounts: readonly (LoaderAccountView | null)[]): AccountReader & { calls: string[][] } {
  const calls: string[][] = [];
  const read: AccountReader = async (addresses) => {
    calls.push([...addresses]);
    return { contextSlot: 777n, accounts };
  };
  return Object.assign(read, { calls });
}

/**
 * The local validator as it actually is: `--upgradeable-program … none`
 * writes `Some(11111111111111111111111111111111)`, not `None`. Verified
 * against a running validator, so the fixture matches reality rather than the
 * flag's name.
 */
const ZERO_AUTHORITY = address("11111111111111111111111111111111");
const localValidator = () => reader([programAccount(), programDataAccount(ZERO_AUTHORITY)]);
/** A program finalised with `set-upgrade-authority --final`. */
const finalised = () => reader([programAccount(), programDataAccount(null)]);
/** Devnet: the same reviewed ELF under a live upgrade authority. */
const devnet = () => reader([programAccount(), programDataAccount(DEVNET_UPGRADE_AUTHORITY)]);

test("the local validator's guard is the reviewed binary with no usable authority", async () => {
  const read = localValidator();
  const attested = await attestGuardDeployment(read);
  assert.equal(attested.attestation.identity, "REVIEWED_BINARY");
  // Not IMMUTABLE: the authority slot is set, it just names an address nobody
  // can sign for. Reporting it as immutable would overstate the local setup.
  assert.equal(attested.attestation.mutability, "NO_USABLE_AUTHORITY");
  assert.equal(attested.attestation.upgradeAuthority, ZERO_AUTHORITY);
  assert.equal(attested.attestation.reviewedElfSha256, REVIEWED.elfSha256);
  assert.equal(attested.readAtSlot, "777");
  // The Program and its ProgramData come from one read, so from one slot.
  assert.deepEqual(read.calls, [[REVIEWED.programAddress, REVIEWED.programDataAddress]]);
});

test("the devnet deployment is the same binary but reported upgradeable", async () => {
  const attested = await attestGuardDeployment(devnet());
  assert.equal(attested.attestation.identity, "REVIEWED_BINARY");
  assert.equal(attested.attestation.mutability, "UPGRADEABLE");
  assert.equal(attested.attestation.upgradeAuthority, DEVNET_UPGRADE_AUTHORITY);
  assert.equal(attested.attestation.reviewedElfSha256, REVIEWED.elfSha256);
  // Same bytes, different security statement: the digests must differ.
  assert.notEqual(attested.digest, (await attestGuardDeployment(localValidator())).digest);
});

test("an unattestable deployment throws rather than degrading", async () => {
  const flipped = Uint8Array.from(ELF);
  flipped.set([(flipped[0] ?? 0) ^ 1], 0);
  const cases: readonly (readonly [string, AccountReader, string])[] = [
    ["missing program", reader([null, programDataAccount(null)]), "MISSING"],
    ["not executable", reader([{ ...programAccount(), executable: false }, programDataAccount(null)]), "NOT_EXECUTABLE"],
    ["wrong loader", reader([{ ...programAccount(), owner: "11111111111111111111111111111111" }, programDataAccount(null)]), "UNEXPECTED_LOADER"],
    ["missing ProgramData", reader([programAccount(), null]), "PROGRAM_DATA_MISMATCH"],
    ["another binary", reader([programAccount(), programDataAccount(ZERO_AUTHORITY, flipped)]), "BINARY_MISMATCH"],
  ];
  for (const [label, read, reason] of cases) {
    await assert.rejects(attestGuardDeployment(read), (error: DeploymentAttestationError) => {
      assert.equal(error.reason, reason, label);
      return true;
    }, label);
  }
});

test("a finalised deployment is the only one reported as immutable", async () => {
  const attested = await attestGuardDeployment(finalised());
  assert.equal(attested.attestation.mutability, "IMMUTABLE");
  assert.equal(attested.attestation.upgradeAuthority, null);
  // Three distinct statements over the same reviewed bytes.
  const digests = await Promise.all([finalised(), localValidator(), devnet()].map(async (read) => (await attestGuardDeployment(read)).digest));
  assert.equal(new Set(digests).size, 3);
});

test("re-attestation passes while the deployment is unchanged", async () => {
  const expected = (await attestGuardDeployment(localValidator())).digest;
  const again = await reattestGuardDeployment(localValidator(), expected);
  assert.equal(again.digest, expected);
  assert.equal(again.attestation.mutability, "NO_USABLE_AUTHORITY");
});

test("a program replaced between the two reads is refused, and names the change", async () => {
  const expected = (await attestGuardDeployment(localValidator())).digest;
  // The authority acted: the address and loader are the same, the bytes are not.
  const flipped = Uint8Array.from(ELF);
  flipped.set([(flipped.at(-1) ?? 0) ^ 1], flipped.length - 1);
  await assert.rejects(
    reattestGuardDeployment(reader([programAccount(), programDataAccount(ZERO_AUTHORITY, flipped)]), expected),
    (error: DeploymentAttestationError) => error.reason === "BINARY_MISMATCH",
  );
  // Same reviewed bytes, but the deployment became upgradeable: still a change.
  await assert.rejects(
    reattestGuardDeployment(devnet(), expected),
    (error: DeploymentAttestationError) => {
      assert.equal(error.reason, "DEPLOYMENT_CHANGED");
      assert.match(error.message, /expected .*, found /);
      return true;
    },
  );
});

test("re-attestation is a read: it takes no transaction and returns no bytes", async () => {
  const read = localValidator();
  const expected = (await attestGuardDeployment(localValidator())).digest;
  const result = await reattestGuardDeployment(read, expected);
  // The whole surface is the attestation; there is nothing here that could
  // rebuild, re-sign or re-encode a transaction.
  assert.deepEqual(Object.keys(result).sort(), ["attestation", "digest", "readAtSlot"]);
  assert.deepEqual(read.calls, [[REVIEWED.programAddress, REVIEWED.programDataAddress]], "one read, no writes");
});
