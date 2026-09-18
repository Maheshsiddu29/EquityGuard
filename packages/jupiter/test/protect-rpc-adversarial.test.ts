/**
 * M11-A step 6: hostile and inconsistent RPC behaviour.
 *
 * The RPC is semi-trusted: it can make EquityGuard refuse, and a lying RPC
 * can make it build against false state, but the on-chain guard re-reads the
 * mint and the Clock at execution. These tests pin what the SDK does when
 * reads disagree with each other, and show that whatever it binds is
 * rejected at execution if chain state differs from it (checked with the
 * offline mirror of the program's policy, which LiteSVM pins to the
 * compiled program).
 *
 * Out of scope by design: consensus across several RPCs, and a minimum
 * context slot. An RPC that lies consistently about a mint EquityGuard does
 * not know can make it look ordinary; see docs/m11a-security-review.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type GetGenesisHashApi, type GetMultipleAccountsApi, type Rpc } from "@solana/kit";
import { checkGuardOffline, decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS } from "@equityguard/guard-client";

import { protectJupiterSwap, type ProtectJupiterSwapResult } from "../src/protect.ts";
import {
  GENESIS,
  KOX_ACTIVATION_TIMESTAMP,
  KOX_MINT,
  SETTLED_TIMESTAMP,
  SYSVAR_CLOCK_ADDRESS,
  TAKER,
  distinctAddress,
  fakeRpc,
  legacyMint,
  mainnetMint,
  mutatedMint,
  recordedKoxBuyBuild,
  token2022Account,
  withMints,
  type FakeRpcOptions,
} from "./protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
type Account = { data: [string, string]; executable: boolean; lamports: bigint; owner: string; rentEpoch: bigint; space: bigint } | null;
type Response = { context: { slot: bigint }; value: Account[] };

/**
 * `fakeRpc` with a hook over each `getMultipleAccounts` response, by call
 * index (0 = classification, 1 = deployment, 2 = mint + Clock snapshot), and
 * an optional genesis-hash sequence.
 */
function scriptedRpc(
  options: FakeRpcOptions,
  edit: (call: number, addresses: readonly string[], response: Response) => Response | Promise<Response>,
  genesis?: () => string,
): Rpc<GetMultipleAccountsApi & GetGenesisHashApi> {
  const base = fakeRpc(options).rpc as unknown as {
    getMultipleAccounts: (a: readonly string[]) => { send: () => Promise<Response> };
    getGenesisHash: () => { send: () => Promise<string> };
  };
  let calls = 0;
  return {
    getGenesisHash: () => ({ send: async () => (genesis ? genesis() : base.getGenesisHash().send()) }),
    getMultipleAccounts: (addresses: readonly string[]) => ({
      send: async () => {
        const call = calls++;
        return edit(call, addresses, await base.getMultipleAccounts(addresses).send());
      },
    }),
  } as unknown as Rpc<GetMultipleAccountsApi & GetGenesisHashApi>;
}

const accountOf = (owner: string, data: Uint8Array): Account => ({
  data: [Buffer.from(data).toString("base64"), "base64"],
  executable: false,
  lamports: 1n,
  owner,
  rentEpoch: 0n,
  space: BigInt(data.length),
});
const koxAccounts = { [KOX_MINT]: token2022Account(mainnetMint("KOx")) };
const SNAPSHOT = 2;

function run(rpc: Rpc<GetMultipleAccountsApi & GetGenesisHashApi>, build = recordedKoxBuyBuild()): Promise<ProtectJupiterSwapResult> {
  return protectJupiterSwap({ build, userPublicKey: TAKER, rpc, protectionWindow: WINDOW });
}

function assertRefused(result: ProtectJupiterSwapResult, code: string, label: string): void {
  assert.equal(result.status, "ERROR", `${label}: ${result.status}`);
  assert.equal(result.status === "ERROR" && result.code, code, label);
  assert.ok(!("transaction" in result), label);
}

test("M11-A: the mint changing between classification and snapshot binds the snapshot, or refuses", async () => {
  const options = { accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP };
  const replaceMint = (account: Account) => (call: number, addresses: readonly string[], response: Response) =>
    call === SNAPSHOT ? { ...response, value: addresses.map((a, i) => (a === KOX_MINT ? account : (response.value[i] ?? null))) } : response;

  // A corporate action lands between the reads: the guard binds what was read with the Clock.
  const moved = mutatedMint("KOx", (d) => void Buffer.from("73833748164bf03f", "hex").copy(d, 275 + 4 + 32));
  const result = await run(scriptedRpc(options, replaceMint(accountOf(TOKEN_2022_PROGRAM_ADDRESS, moved))));
  assert.equal(result.status, "PROTECTED");
  if (result.status === "PROTECTED") assert.deepEqual(result.snapshot.state, decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, moved));

  for (const [label, account, code] of [
    ["mint vanished", null, "MINT_STATE_UNAVAILABLE"],
    ["owner changed", accountOf("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mainnetMint("KOx")), "MALFORMED_TOKEN_STATE"],
    ["data became garbage", accountOf(TOKEN_2022_PROGRAM_ADDRESS, Uint8Array.of(1, 2, 3)), "MALFORMED_TOKEN_STATE"],
    ["ScaledUiAmount gone", accountOf(TOKEN_2022_PROGRAM_ADDRESS, mainnetMint("KOx").slice(0, 82)), "MALFORMED_TOKEN_STATE"],
  ] as const) {
    assertRefused(await run(scriptedRpc(options, replaceMint(account))), code, label);
  }
});

test("M11-A: partial, malformed or inconsistent RPC responses never produce PROTECTED", async () => {
  const options = { accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP };
  const at = (call: number, edit: (r: Response, addresses: readonly string[]) => Response) => (c: number, a: readonly string[], r: Response) => (c === call ? edit(r, a) : r);
  const cases: [string, Parameters<typeof scriptedRpc>[1], string][] = [
    ["classification response empty", at(0, (r) => ({ ...r, value: [] })), "MINT_STATE_UNAVAILABLE"],
    ["deployment response empty", at(1, (r) => ({ ...r, value: [] })), "GUARD_DEPLOYMENT_UNAVAILABLE"],
    ["ProgramData missing from a partial response", at(1, (r) => ({ ...r, value: r.value.slice(0, 1) })), "GUARD_BINARY_UNVERIFIED"],
    ["program account reported non-executable", at(1, (r) => ({ ...r, value: [{ ...(r.value[0] as NonNullable<Account>), executable: false }, ...r.value.slice(1)] })), "GUARD_PROGRAM_NOT_EXECUTABLE"],
    ["snapshot response empty", at(SNAPSHOT, (r) => ({ ...r, value: [] })), "MINT_STATE_UNAVAILABLE"],
    ["Clock missing", at(SNAPSHOT, (r) => ({ ...r, value: [r.value[0] ?? null, null] })), "MINT_STATE_UNAVAILABLE"],
    ["Clock truncated", at(SNAPSHOT, (r) => ({ ...r, value: [r.value[0] ?? null, accountOf("Sysvar1111111111111111111111111111111111111", new Uint8Array(39))] })), "MINT_STATE_UNAVAILABLE"],
    ["accounts answered in the wrong order", at(SNAPSHOT, (r) => ({ ...r, value: [...r.value].reverse() })), "MINT_STATE_UNAVAILABLE"],
  ];
  for (const [label, edit, code] of cases) {
    assertRefused(await run(scriptedRpc(options, edit)), code, label);
  }

  // A thrown RPC error propagates: it is never read as NOT_APPLICABLE.
  const failing = scriptedRpc(options, () => Promise.reject(new Error("rpc down")));
  await assert.rejects(run(failing), /rpc down/);
});

test("M11-A: the cluster is read once, so a genesis hash that changes mid-build cannot switch deployments", async () => {
  const sequence = [GENESIS.devnet, GENESIS["mainnet-beta"], GENESIS["mainnet-beta"]];
  let reads = 0;
  const rpc = scriptedRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP }, (_c, _a, r) => r, () => sequence[reads++] as string);
  const result = await run(rpc);
  assert.equal(reads, 1);
  assert.equal(result.status === "PROTECTED" && result.cluster, "devnet");

  // Mainnet first: refused, whatever the node says afterwards.
  reads = 0;
  sequence.reverse();
  const refused = await run(scriptedRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP }, (_c, _a, r) => r, () => sequence[reads++] as string));
  assertRefused(refused, "GUARD_DEPLOYMENT_UNAVAILABLE", "mainnet genesis");
});

test("M11-A: state a lying or stale RPC made the SDK bind is rejected at execution", async () => {
  // Stale: the node lags behind the activation, so the guard says Pending.
  const stale = await run(scriptedRpc({ accounts: koxAccounts, unixTimestamp: KOX_ACTIVATION_TIMESTAMP - 5_000n, slot: 10n }, (_c, _a, r) => r));
  assert.equal(stale.status, "PROTECTED");
  if (stale.status !== "PROTECTED") return;
  const expectation = { expected: stale.snapshot.state, expectedPhase: stale.snapshot.phase, window: WINDOW };
  assert.equal(checkGuardOffline(expectation, stale.snapshot.state, KOX_ACTIVATION_TIMESTAMP + 5_000n), "ActivationPhaseChanged");
  assert.equal(checkGuardOffline(expectation, stale.snapshot.state, KOX_ACTIVATION_TIMESTAMP), "InsideTransitionWindow");

  // Lying: the node serves UNHx's bytes under KOx's address. The guard names
  // KOx and expects UNHx's state; the real KOx account fails it.
  const lying = await run(scriptedRpc({ accounts: { [KOX_MINT]: token2022Account(mainnetMint("UNHx")) }, unixTimestamp: SETTLED_TIMESTAMP }, (_c, _a, r) => r));
  assert.equal(lying.status, "PROTECTED");
  if (lying.status !== "PROTECTED") return;
  const real = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, mainnetMint("KOx"));
  assert.equal(checkGuardOffline({ expected: lying.snapshot.state, expectedPhase: lying.snapshot.phase, window: WINDOW }, real, SETTLED_TIMESTAMP), "MultiplierChanged");
});

test("M11-A: a known equity cannot be made to look ordinary; an unknown one can only by a lying RPC", async () => {
  // Known: served as a legacy SPL mint, it fails closed.
  const known = await run(scriptedRpc({ accounts: { [KOX_MINT]: legacyMint() }, unixTimestamp: SETTLED_TIMESTAMP }, (_c, _a, r) => r));
  assert.equal(known.status, "UNSUPPORTED_PROTECTED_ASSET");

  // Unknown ScaledUiAmount mint served as legacy: NOT_APPLICABLE. This is the
  // RPC trust assumption, recorded as a residual risk, not a code path the
  // SDK can distinguish from an honest ordinary token.
  const other = distinctAddress(87);
  const unknown = await run(scriptedRpc({ accounts: { [other]: legacyMint() }, unixTimestamp: SETTLED_TIMESTAMP }, (_c, _a, r) => r), withMints(recordedKoxBuyBuild(), { outputMint: other }));
  assert.equal(unknown.status, "NOT_APPLICABLE");

  // Slots going backwards between reads do not change what is bound: the
  // mint and Clock of the snapshot are one read at one slot.
  const backwards = await run(scriptedRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP }, (c, _a, r) => ({ ...r, context: { slot: 1_000n - BigInt(c) * 400n } })));
  assert.equal(backwards.status, "PROTECTED");
  if (backwards.status === "PROTECTED") assert.equal(backwards.snapshot.contextSlot, 200n);
});

test("M11-A: the Clock sysvar is only ever read together with the mint", async () => {
  const reads: string[][] = [];
  await run(scriptedRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP }, (_c, addresses, r) => (reads.push([...addresses]), r)));
  const withClock = reads.filter((r) => r.includes(SYSVAR_CLOCK_ADDRESS));
  assert.deepEqual(withClock, [[KOX_MINT, SYSVAR_CLOCK_ADDRESS]]);
});
