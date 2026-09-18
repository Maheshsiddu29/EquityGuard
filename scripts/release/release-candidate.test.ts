/**
 * Release-candidate sanity checks (M11-C).
 *
 * `release-candidate.json` states what this repository is released as. These
 * checks tie every identity field in it to the code that enforces it, so the
 * manifest cannot drift from the SDK, the program constants or the reviewed
 * binary. They also pin the public package surface as a consumer sees it:
 * the entrypoints resolve by package name, internal and test modules are not
 * importable, and nothing exported can sign, send or hold a key.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));

interface Manifest {
  readonly abiVersion: number;
  readonly program: {
    readonly cluster: string;
    readonly programId: string;
    readonly programData: string;
    readonly upgradeAuthority: string;
    readonly reviewedElfSha256: string;
    readonly reviewedElfLength: number;
    readonly deploymentSlot: number;
  };
  readonly mainnetDeployment: null;
  readonly adapterKinds: Readonly<Record<string, string>>;
  readonly protectedStateModel: string;
  readonly security: { readonly unresolvedCritical: number; readonly unresolvedHigh: number; readonly medium: readonly { readonly id: string }[] };
}
const MANIFEST = JSON.parse(read("release-candidate.json").toString("utf8")) as Manifest;

test("the manifest's program identity is the one the SDK verifies and the program declares", async () => {
  const client = await import("@equityguard/guard-client");
  const [reviewed, ...others] = client.REVIEWED_GUARD_DEPLOYMENTS;
  assert.equal(others.length, 0, "exactly one reviewed deployment");
  assert.ok(reviewed);
  const p = MANIFEST.program;
  assert.equal(p.cluster, "devnet");
  assert.equal(reviewed.cluster, p.cluster);
  assert.equal(reviewed.programAddress, p.programId);
  assert.equal(client.EQUITY_GUARD_DEVNET_PROGRAM_ID, p.programId);
  assert.equal(reviewed.programDataAddress, p.programData);
  assert.equal(reviewed.elfSha256, p.reviewedElfSha256);
  assert.equal(reviewed.elfLength, p.reviewedElfLength);

  // The program's declare_id! and the devnet deployment record.
  assert.match(read("programs/equity_guard/src/lib.rs").toString("utf8"), new RegExp(`declare_id!\\("${p.programId}"\\)`));
  const devnet = JSON.parse(read("scripts/devnet/devnet.json").toString("utf8")) as { deployment: Record<string, unknown> };
  assert.equal(devnet.deployment.programId, p.programId);
  assert.equal(devnet.deployment.programDataAddress, p.programData);
  assert.equal(devnet.deployment.upgradeAuthority, p.upgradeAuthority);
  assert.equal(devnet.deployment.sbfSha256, p.reviewedElfSha256);
  assert.equal(devnet.deployment.deploymentSlot, p.deploymentSlot);
  assert.equal(devnet.deployment.abiVersion, MANIFEST.abiVersion);

  // The committed reviewed ELF is the binary the hash names.
  const elf = gunzipSync(read("packages/guard-client/test/fixtures/equity_guard-devnet-d7d59ccd.so.gz"));
  assert.equal(elf.length, p.reviewedElfLength);
  assert.equal(createHash("sha256").update(elf).digest("hex"), p.reviewedElfSha256);
});

test("no mainnet deployment exists, and mainnet never resolves to the devnet program", async () => {
  const client = await import("@equityguard/guard-client");
  assert.equal(MANIFEST.mainnetDeployment, null);
  assert.equal(client.deploymentForCluster("mainnet-beta"), null);
  assert.equal(client.deploymentForCluster("unknown"), null);
  assert.ok(client.REVIEWED_GUARD_DEPLOYMENTS.every((d) => d.cluster === "devnet"));
});

test("ABI version, adapter kinds and the protected state model match the code", async () => {
  const client = await import("@equityguard/guard-client");
  assert.equal(client.ABI_VERSION_V2, MANIFEST.abiVersion);
  assert.deepEqual(Object.keys(MANIFEST.adapterKinds).map(Number), Object.values(client.DownstreamAdapterKind));
  assert.deepEqual(Object.values(client.PROTECTED_STATE_MODEL), [MANIFEST.protectedStateModel]);
});

test("the security status names no unresolved Critical or High finding", () => {
  assert.equal(MANIFEST.security.unresolvedCritical, 0);
  assert.equal(MANIFEST.security.unresolvedHigh, 0);
  assert.ok(MANIFEST.security.medium.some((m) => m.id === "R-01"), "R-01 stays on record until it is resolved");
});

/** The drop-in integration surface, exactly. A change here is an API change and must be deliberate. */
const PROTECT_EXPORTS = [
  "EQUITY_GUARD_DEVNET_DEPLOYMENT",
  "EquityGuardFailureCode",
  "KNOWN_PROTECTED_ASSETS",
  "SUPPORTED_JUPITER_ROUTES",
  "USDC_MINT_ADDRESS",
  "explainEquityGuardError",
  "protectJupiterSwap",
  "supportsJupiterSwap",
  "verifyProtectedSwap",
];

test("the public entrypoints resolve by package name and expose the intended surface", async () => {
  const protect = await import("@equityguard/jupiter/protect");
  assert.deepEqual(Object.keys(protect).sort(), PROTECT_EXPORTS);
  for (const fn of ["protectJupiterSwap", "supportsJupiterSwap", "verifyProtectedSwap", "explainEquityGuardError"] as const) {
    assert.equal(typeof protect[fn], "function", fn);
  }
  for (const name of ["@equityguard/jupiter", "@equityguard/guard-client", "@equityguard/representation-state"]) {
    const module = (await import(name)) as Record<string, unknown>;
    assert.ok(Object.keys(module).length > 0, name);
  }
});

test("internal and test-only modules cannot be imported through the packages", async () => {
  for (const path of [
    "@equityguard/jupiter/src/compose.ts",
    "@equityguard/jupiter/test/protect-fixtures.ts",
    "@equityguard/guard-client/src/abi.ts",
    "@equityguard/guard-client/test/guard-mirror.ts",
    "@equityguard/representation-state/test/fixtures.ts",
  ]) {
    await assert.rejects(import(path), (error: NodeJS.ErrnoException) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED", path);
  }
});

test("nothing any package exports can sign, send or hold a key", async () => {
  for (const name of ["@equityguard/jupiter/protect", "@equityguard/jupiter", "@equityguard/guard-client", "@equityguard/representation-state"]) {
    const exported = Object.keys((await import(name)) as Record<string, unknown>);
    const risky = exported.filter((key) => /sign|send|submit|keypair|secret|privatekey|wallet/i.test(key));
    assert.deepEqual(risky, [], name);
  }
});
