/**
 * PROTECTED must mean "built against an EquityGuard program that can execute
 * on the cluster this RPC serves", not "guard bytes were serialized".
 *
 * A mainnet Jupiter build must never be wrapped with the devnet deployment.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EQUITY_GUARD_DEVNET_DEPLOYMENT,
  explainEquityGuardError,
  protectJupiterSwap,
  type ProtectJupiterSwapResult,
} from "../src/protect.ts";
import {
  GENESIS,
  GUARD_PROGRAM,
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  distinctAddress,
  executableProgramAccount,
  fakeRpc,
  legacyMint,
  mainnetMint,
  nonExecutableAccount,
  recordedKoxBuyBuild,
  token2022Account,
  REVIEWED_DEVNET,
  REVIEWED_ELF,
  reviewedProgramAccount,
  reviewedProgramDataAccount,
  withMints,
  type FakeAccount,
} from "./protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const koxAccounts = { [KOX_MINT]: token2022Account(mainnetMint("KOx")) };

function protect(options: {
  readonly genesisHash?: string;
  readonly guardProgram?: FakeAccount | null;
  readonly guardProgramData?: FakeAccount | null;
  readonly programAddress?: Parameters<typeof protectJupiterSwap>[0]["programAddress"];
  readonly accounts?: Readonly<Record<string, FakeAccount>>;
}): Promise<ProtectJupiterSwapResult> {
  const { rpc } = fakeRpc({
    accounts: options.accounts ?? koxAccounts,
    unixTimestamp: SETTLED_TIMESTAMP,
    ...(options.genesisHash === undefined ? {} : { genesisHash: options.genesisHash }),
    ...(options.guardProgram === undefined ? {} : { guardProgram: options.guardProgram }),
    ...(options.guardProgramData === undefined ? {} : { guardProgramData: options.guardProgramData }),
  });
  return protectJupiterSwap({
    build: recordedKoxBuyBuild(),
    userPublicKey: TAKER,
    rpc,
    protectionWindow: WINDOW,
    ...(options.programAddress === undefined ? {} : { programAddress: options.programAddress }),
  });
}

function assertRefused(result: ProtectJupiterSwapResult, code: string, label: string): void {
  assert.equal(result.status, "ERROR", `${label}: ${"message" in result ? result.message : result.status}`);
  assert.equal(result.status === "ERROR" && result.code, code, label);
  assert.ok(!("transaction" in result) && !("instructions" in result), `${label} must carry no transaction`);
  assert.match(explainEquityGuardError(result), /must not be sent in its place/, label);
}

test("devnet with no programAddress resolves the known devnet deployment", async () => {
  const result = await protect({ genesisHash: GENESIS.devnet });
  assert.equal(result.status, "PROTECTED");
  if (result.status !== "PROTECTED") return;
  assert.equal(result.cluster, "devnet");
  assert.equal(result.programAddress, EQUITY_GUARD_DEVNET_DEPLOYMENT);
  assert.equal(result.programAddress, GUARD_PROGRAM);
  assert.equal(result.instructions[0]?.programAddress, GUARD_PROGRAM);
});

test("mainnet with no programAddress cannot return PROTECTED", async () => {
  // The exact regression this guards: a real mainnet Jupiter build, a real
  // mainnet KOx account, and no deployment to run the guard.
  const result = await protect({ genesisHash: GENESIS["mainnet-beta"], guardProgram: null });
  assertRefused(result, "GUARD_DEPLOYMENT_UNAVAILABLE", "mainnet");
  assert.match(result.status === "ERROR" ? result.message : "", /not deployed on mainnet-beta/);
  assert.match(explainEquityGuardError(result), /deployed on devnet only/);
});

test("mainnet cannot borrow the devnet deployment even if that address exists there", async () => {
  // Someone could deploy anything at that address on another cluster; the
  // resolution is by cluster, not by "does the account happen to exist".
  const result = await protect({ genesisHash: GENESIS["mainnet-beta"], guardProgram: executableProgramAccount() });
  assertRefused(result, "GUARD_DEPLOYMENT_UNAVAILABLE", "mainnet with an executable account at the devnet address");
});

test("testnet with no programAddress cannot return PROTECTED", async () => {
  assertRefused(await protect({ genesisHash: GENESIS.testnet, guardProgram: null }), "GUARD_DEPLOYMENT_UNAVAILABLE", "testnet");
});

test("an unknown cluster with no programAddress cannot return PROTECTED", async () => {
  // A local validator: fresh genesis hash, no deployment knowledge.
  const result = await protect({ genesisHash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", guardProgram: null });
  assertRefused(result, "UNSUPPORTED_CLUSTER", "unknown genesis");
  assert.match(explainEquityGuardError(result), /pass an explicit programAddress/i);
});

test("a resolved deployment that does not exist on the cluster cannot return PROTECTED", async () => {
  assertRefused(await protect({ genesisHash: GENESIS.devnet, guardProgram: null }), "GUARD_DEPLOYMENT_UNAVAILABLE", "devnet without the program");
});

test("a resolved deployment that is not executable cannot return PROTECTED", async () => {
  const result = await protect({ genesisHash: GENESIS.devnet, guardProgram: nonExecutableAccount() });
  assertRefused(result, "GUARD_PROGRAM_NOT_EXECUTABLE", "devnet, account present but not a program");
  assert.match(result.status === "ERROR" ? result.message : "", /not executable/);
});

test("an explicit programAddress is still read back and must be executable", async () => {
  const custom = distinctAddress(71);

  const missing = await protect({ programAddress: custom });
  assertRefused(missing, "GUARD_DEPLOYMENT_UNAVAILABLE", "explicit address with no account");

  const inert = await protect({ programAddress: custom, accounts: { ...koxAccounts, [custom]: nonExecutableAccount() } });
  assertRefused(inert, "GUARD_PROGRAM_NOT_EXECUTABLE", "explicit address that is not a program");
});

test("an explicit executable deployment is honoured on any cluster, and reported", async () => {
  const custom = distinctAddress(72);
  const accounts = { ...koxAccounts, [custom]: executableProgramAccount() };

  // A local validator replaying mainnet programs: the caller owns the trust
  // decision, and the SDK still proves the program can execute.
  const local = await protect({ genesisHash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", programAddress: custom, accounts });
  assert.equal(local.status, "PROTECTED");
  assert.equal(local.status === "PROTECTED" && local.cluster, "unknown");
  assert.equal(local.status === "PROTECTED" && local.programAddress, custom);

  // The same is true for a future mainnet deployment: no SDK change needed.
  const mainnet = await protect({ genesisHash: GENESIS["mainnet-beta"], programAddress: custom, accounts });
  assert.equal(mainnet.status, "PROTECTED");
  assert.equal(mainnet.status === "PROTECTED" && mainnet.cluster, "mainnet-beta");
});

test("an unprotected swap costs no genesis or deployment read", async () => {
  const other = distinctAddress(73);
  const { rpc, reads, genesisReads } = fakeRpc({ accounts: { [other]: legacyMint() }, unixTimestamp: SETTLED_TIMESTAMP });
  const result = await protectJupiterSwap({
    build: withMints(recordedKoxBuyBuild(), { outputMint: other }),
    userPublicKey: TAKER,
    rpc,
    protectionWindow: WINDOW,
  });
  assert.equal(result.status, "NOT_APPLICABLE");
  assert.equal(genesisReads(), 0, "no cluster is resolved for a swap EquityGuard does not apply to");
  assert.deepEqual(reads, [[other]]);
});

test("the cluster is resolved once, before any state is read or anything is built", async () => {
  const { rpc, reads, genesisReads } = fakeRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP, genesisHash: GENESIS["mainnet-beta"], guardProgram: null });
  const result = await protectJupiterSwap({ build: recordedKoxBuyBuild(), userPublicKey: TAKER, rpc, protectionWindow: WINDOW });
  assert.equal(result.status, "ERROR");
  assert.equal(genesisReads(), 1);
  // The mint was classified; the Clock was never read, because the refusal
  // happens before any guard state is bound.
  assert.deepEqual(reads, [[KOX_MINT]]);
});

// ------------------------------------------ M11-A: deployment identity

test("the devnet deployment is PROTECTED only as the reviewed binary, read in one call", async () => {
  const { rpc, reads } = fakeRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP });
  const result = await protectJupiterSwap({ build: recordedKoxBuyBuild(), userPublicKey: TAKER, rpc, protectionWindow: WINDOW });
  assert.equal(result.status, "PROTECTED");
  assert.equal(result.status === "PROTECTED" && result.deploymentIdentity, "REVIEWED_BINARY");
  // Program and ProgramData come from one getMultipleAccounts: one slot.
  assert.ok(reads.some((r) => r.length === 2 && r[0] === GUARD_PROGRAM && r[1] === REVIEWED_DEVNET.programDataAddress), JSON.stringify(reads));
});

test("a devnet program that is not the reviewed binary cannot return PROTECTED", async () => {
  const flip = (offset: number) => reviewedProgramDataAccount((d) => void (d[offset] = (d[offset] ?? 0) ^ 0xff));
  const cases: [string, { guardProgram?: FakeAccount | null; guardProgramData?: FakeAccount | null }, string][] = [
    ["an upgrade changed one code byte", { guardProgramData: flip(45 + (REVIEWED_ELF.length >> 1)) }, "GUARD_BINARY_UNVERIFIED"],
    ["an upgrade appended code after the reviewed ELF", { guardProgramData: flip(45 + REVIEWED_ELF.length) }, "GUARD_BINARY_UNVERIFIED"],
    ["ProgramData truncated", { guardProgramData: reviewedProgramDataAccount((d) => d.slice(0, 45 + REVIEWED_ELF.length - 1)) }, "GUARD_BINARY_UNVERIFIED"],
    ["ProgramData missing", { guardProgramData: null }, "GUARD_BINARY_UNVERIFIED"],
    ["ProgramData owned by another program", { guardProgramData: { ...reviewedProgramDataAccount(), owner: "11111111111111111111111111111111" } }, "GUARD_BINARY_UNVERIFIED"],
    ["program points at another ProgramData", { guardProgram: reviewedProgramAccount(distinctAddress(74)) }, "GUARD_BINARY_UNVERIFIED"],
    ["an executable account under another loader", { guardProgram: { ...reviewedProgramAccount(), owner: "BPFLoader2111111111111111111111111111111111" } }, "GUARD_BINARY_UNVERIFIED"],
    ["an executable program with no loader state", { guardProgram: executableProgramAccount() }, "GUARD_BINARY_UNVERIFIED"],
    ["the program account is gone", { guardProgram: null }, "GUARD_DEPLOYMENT_UNAVAILABLE"],
    ["the program account is not executable", { guardProgram: { ...reviewedProgramAccount(), executable: false } }, "GUARD_PROGRAM_NOT_EXECUTABLE"],
  ];
  for (const [label, accounts, code] of cases) {
    const result = await protect({ genesisHash: GENESIS.devnet, ...accounts });
    assertRefused(result, code, label);
  }
});

test("naming the reviewed address explicitly cannot skip its attestation, on any cluster", async () => {
  const tampered = reviewedProgramDataAccount((d) => void (d[100] = (d[100] ?? 0) ^ 1));
  for (const genesisHash of [GENESIS.devnet, GENESIS["mainnet-beta"], "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"]) {
    const refused = await protect({ genesisHash, programAddress: GUARD_PROGRAM, guardProgramData: tampered });
    assertRefused(refused, "GUARD_BINARY_UNVERIFIED", genesisHash);
  }
  // Explicit and honest: attested, and reported as such.
  const honest = await protect({ genesisHash: GENESIS.devnet, programAddress: GUARD_PROGRAM });
  assert.equal(honest.status === "PROTECTED" && honest.deploymentIdentity, "REVIEWED_BINARY");
});

test("a caller-supplied deployment is reported as CALLER_TRUSTED, never as reviewed", async () => {
  const custom = distinctAddress(75);
  const result = await protect({ programAddress: custom, accounts: { ...koxAccounts, [custom]: executableProgramAccount() } });
  assert.equal(result.status, "PROTECTED");
  assert.equal(result.status === "PROTECTED" && result.deploymentIdentity, "CALLER_TRUSTED");
  assert.match(explainEquityGuardError({ status: "ERROR", code: "GUARD_BINARY_UNVERIFIED", message: "m", protectedMint: KOX_MINT, guardError: null, details: [] }), /not the reviewed EquityGuard binary/);
});
