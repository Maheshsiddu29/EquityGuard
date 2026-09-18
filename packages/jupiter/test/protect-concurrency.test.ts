/**
 * `protectJupiterSwap` must be request-local: a result may depend only on its
 * own input and its own RPC's answers, however calls interleave.
 *
 * Each request below gets its own scripted RPC, which delays every answer by
 * a seeded amount so hundreds of in-flight calls interleave at every await.
 * Every concurrent result must equal the result the same input produces when
 * run alone, byte for byte, and must carry its own mint, direction, adapter,
 * program, cluster, state and commitment — never another request's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { address, type Address, type GetGenesisHashApi, type GetMultipleAccountsApi, type Rpc } from "@solana/kit";
import { ActivationPhase, EQUITY_GUARD_DEVNET_PROGRAM_ID, TOKEN_2022_PROGRAM_ADDRESS, decodeProtectedState, type ProtectedState } from "@equityguard/guard-client";

import { resolveWireTransaction, type BuildResponse } from "../src/index.ts";
import { protectJupiterSwap, verifyProtectedSwap, type ProtectJupiterSwapResult } from "../src/protect.ts";
import {
  GENESIS,
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  UNHX_ACTIVATION_TIMESTAMP,
  UNHX_MINT,
  distinctAddress,
  executableProgramAccount,
  fakeRpc,
  legacyMint,
  mainnetMint,
  mutatedMint,
  plainToken2022Mint,
  recordedBuild,
  recordedKoxBuyBuild,
  token2022Account,
  withMints,
  type FakeAccount,
} from "./protect-fixtures.ts";
import { Prng } from "../../representation-state/test/prng.ts";

type Commitment = "processed" | "confirmed" | "finalized";
type AnyRpc = Rpc<GetMultipleAccountsApi & GetGenesisHashApi>;

const CRMX_MINT = address("XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN");
const CALLER_PROGRAM = distinctAddress(77);
/** KOx with its current multiplier moved by one ulp: a different, valid economic state. */
const KOX_OTHER_STATE = mutatedMint("KOx", (d) => void (d[275 + 4 + 32] = (d[275 + 4 + 32] ?? 0) ^ 1));

interface Spec {
  readonly name: string;
  readonly build: () => BuildResponse;
  readonly accounts: Readonly<Record<string, FakeAccount>>;
  readonly unixTimestamp: bigint;
  readonly window: { readonly beforeSecs: number; readonly afterSecs: number };
  readonly commitment: Commitment;
  readonly genesis: string;
  readonly programAddress?: Address;
  readonly guardProgram?: FakeAccount | null;
  readonly expectedState?: ProtectedState;
  readonly expectedPhase?: ActivationPhase;
  /** What this input must produce, whoever else is running. */
  readonly expect: { readonly status: ProjectedStatus; readonly program?: Address; readonly cluster?: string; readonly mint?: Address; readonly direction?: string };
}
type ProjectedStatus = ProtectJupiterSwapResult["status"];

const koxState = (data: Uint8Array): ProtectedState => decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, data);

const kox = token2022Account(mainnetMint("KOx"));
const SPECS: readonly Spec[] = [
  { name: "KOx BUY", build: () => recordedBuild("KOx", "BUY"), accounts: { [KOX_MINT]: kox }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "confirmed", genesis: GENESIS.devnet, expect: { status: "PROTECTED", mint: KOX_MINT, direction: "BUY", program: EQUITY_GUARD_DEVNET_PROGRAM_ID, cluster: "devnet" } },
  { name: "KOx SELL", build: () => recordedBuild("KOx", "SELL"), accounts: { [KOX_MINT]: kox }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 0, afterSecs: 0 }, commitment: "processed", genesis: GENESIS.devnet, expect: { status: "PROTECTED", mint: KOX_MINT, direction: "SELL", program: EQUITY_GUARD_DEVNET_PROGRAM_ID, cluster: "devnet" } },
  { name: "UNHx BUY", build: () => recordedBuild("UNHx", "BUY"), accounts: { [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 86_400, afterSecs: 86_400 }, commitment: "finalized", genesis: GENESIS.devnet, expect: { status: "PROTECTED", mint: UNHX_MINT, direction: "BUY", program: EQUITY_GUARD_DEVNET_PROGRAM_ID, cluster: "devnet" } },
  { name: "UNHx SELL inside its window", build: () => recordedBuild("UNHx", "SELL"), accounts: { [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) }, unixTimestamp: UNHX_ACTIVATION_TIMESTAMP + 10n, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "confirmed", genesis: GENESIS.devnet, expect: { status: "ERROR", mint: UNHX_MINT } },
  { name: "CRMx SELL", build: () => recordedBuild("CRMx", "SELL"), accounts: { [CRMX_MINT]: token2022Account(mainnetMint("CRMx")) }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "confirmed", genesis: GENESIS.devnet, expect: { status: "PROTECTED", mint: CRMX_MINT, direction: "SELL", program: EQUITY_GUARD_DEVNET_PROGRAM_ID, cluster: "devnet" } },
  { name: "CRMx BUY (refused shape)", build: () => recordedBuild("CRMx", "BUY"), accounts: { [CRMX_MINT]: token2022Account(mainnetMint("CRMx")) }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "processed", genesis: GENESIS.devnet, expect: { status: "UNSUPPORTED_PROTECTED_ROUTE", mint: CRMX_MINT } },
  { name: "KOx BUY 2026-09-14, caller-trusted program, unknown cluster", build: recordedKoxBuyBuild, accounts: { [KOX_MINT]: kox, [CALLER_PROGRAM]: executableProgramAccount() }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "finalized", genesis: "LocalGenesis1111111111111111111111111111111", programAddress: CALLER_PROGRAM, guardProgram: null, expect: { status: "PROTECTED", mint: KOX_MINT, direction: "BUY", program: CALLER_PROGRAM, cluster: "unknown" } },
  { name: "KOx BUY on mainnet (no deployment)", build: () => recordedBuild("KOx", "BUY"), accounts: { [KOX_MINT]: kox }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "confirmed", genesis: GENESIS["mainnet-beta"], guardProgram: null, expect: { status: "ERROR", mint: KOX_MINT } },
  { name: "KOx BUY, quote on another state", build: () => recordedBuild("KOx", "BUY"), accounts: { [KOX_MINT]: kox }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "confirmed", genesis: GENESIS.devnet, expectedState: koxState(KOX_OTHER_STATE), expectedPhase: ActivationPhase.Activated, expect: { status: "ERROR", mint: KOX_MINT } },
  { name: "KOx BUY against another economic state", build: () => recordedBuild("KOx", "BUY"), accounts: { [KOX_MINT]: token2022Account(KOX_OTHER_STATE) }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "processed", genesis: GENESIS.devnet, expect: { status: "PROTECTED", mint: KOX_MINT, direction: "BUY", program: EQUITY_GUARD_DEVNET_PROGRAM_ID, cluster: "devnet" } },
  { name: "KOx BUY, u32::MAX-before window", build: () => recordedBuild("KOx", "BUY"), accounts: { [KOX_MINT]: kox }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 0xffff_ffff, afterSecs: 0 }, commitment: "finalized", genesis: GENESIS.devnet, expect: { status: "PROTECTED", mint: KOX_MINT, direction: "BUY", program: EQUITY_GUARD_DEVNET_PROGRAM_ID, cluster: "devnet" } },
  { name: "ordinary legacy token", build: () => withMints(recordedKoxBuyBuild(), { outputMint: distinctAddress(55) }), accounts: { [distinctAddress(55)]: legacyMint() }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "confirmed", genesis: GENESIS.devnet, expect: { status: "NOT_APPLICABLE" } },
  { name: "known equity without ScaledUiAmount", build: () => withMints(recordedKoxBuyBuild(), { outputMint: KOX_MINT }), accounts: { [KOX_MINT]: plainToken2022Mint() }, unixTimestamp: SETTLED_TIMESTAMP, window: { beforeSecs: 900, afterSecs: 300 }, commitment: "processed", genesis: GENESIS.devnet, expect: { status: "UNSUPPORTED_PROTECTED_ASSET", mint: KOX_MINT } },
];

/** Global order of RPC answers across all requests, to prove they interleaved. */
let answerSequence = 0;

interface RpcCall {
  readonly seq: number;
  readonly method: string;
  readonly commitment?: string | undefined;
  readonly addresses?: readonly string[];
}

/** The spec's scripted RPC, answering after a seeded delay and logging each call. */
function rpcFor(spec: Spec, seed: bigint | null): { rpc: AnyRpc; calls: RpcCall[] } {
  const base = fakeRpc({
    accounts: spec.accounts,
    unixTimestamp: spec.unixTimestamp,
    genesisHash: spec.genesis,
    ...(spec.guardProgram === undefined ? {} : { guardProgram: spec.guardProgram, guardProgramData: spec.guardProgram }),
  }).rpc as unknown as {
    getGenesisHash(): { send(): Promise<string> };
    getMultipleAccounts(addresses: readonly string[], config?: { commitment?: string }): { send(): Promise<unknown> };
  };
  const prng = seed === null ? null : new Prng(seed);
  const pause = () =>
    new Promise<void>((resolve) => {
      const r = prng?.below(5) ?? -1;
      if (r < 0) resolve();
      else if (r === 0) setImmediate(resolve);
      else setTimeout(resolve, r - 1);
    });
  const calls: RpcCall[] = [];
  const rpc = {
    getGenesisHash: () => ({
      send: async () => {
        await pause();
        calls.push({ seq: answerSequence++, method: "getGenesisHash" });
        return base.getGenesisHash().send();
      },
    }),
    getMultipleAccounts: (addresses: readonly string[], config?: { commitment?: string }) => ({
      send: async () => {
        await pause();
        calls.push({ seq: answerSequence++, method: "getMultipleAccounts", commitment: config?.commitment, addresses: [...addresses] });
        return base.getMultipleAccounts(addresses, config).send();
      },
    }),
  };
  return { rpc: rpc as unknown as AnyRpc, calls };
}

function run(spec: Spec, seed: bigint | null): Promise<{ result: ProtectJupiterSwapResult; calls: RpcCall[] }> {
  const { rpc, calls } = rpcFor(spec, seed);
  return protectJupiterSwap({
    build: spec.build(),
    userPublicKey: TAKER,
    rpc,
    protectionWindow: spec.window,
    commitment: spec.commitment,
    ...(spec.programAddress ? { programAddress: spec.programAddress } : {}),
    ...(spec.expectedState ? { expectedState: spec.expectedState, expectedPhase: spec.expectedPhase } : {}),
  }).then((result) => ({ result, calls }));
}

/** Everything a result says, in a comparable form: bytes as hex, bigints as strings, the registry entry by symbol. */
function canonical(result: ProtectJupiterSwapResult): string {
  return JSON.stringify(result, (key, value: unknown) => {
    if (typeof value === "bigint") return `${value}n`;
    if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
    if (key === "knownAsset" && value && typeof value === "object") return (value as { symbol: string }).symbol;
    return value;
  });
}

test("concurrent protected builds never borrow another request's state", async () => {
  // Reference: every input alone, with no interleaving at all.
  const reference = new Map<string, string>();
  for (const spec of SPECS) {
    const { result } = await run(spec, null);
    assert.equal(result.status, spec.expect.status, `${spec.name}: ${canonical(result)}`);
    reference.set(spec.name, canonical(result));
  }

  // Twelve copies of every input, shuffled, each with its own delays.
  const order = new Prng(0x4d11b5n);
  const jobs = SPECS.flatMap((spec) => Array.from({ length: 12 }, (_, copy) => ({ spec, seed: BigInt(1 + copy * 97 + SPECS.indexOf(spec)) })));
  for (let i = jobs.length - 1; i > 0; i -= 1) {
    const j = order.below(i + 1);
    [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!];
  }
  const outcomes = await Promise.all(jobs.map(async ({ spec, seed }) => ({ spec, ...(await run(spec, seed)) })));

  // Not vacuous: most requests had another request answered in the middle of their own calls.
  const spans = outcomes.map(({ calls }) => [calls[0]?.seq ?? 0, calls.at(-1)?.seq ?? 0] as const);
  const interleaved = spans.filter(([first, last]) => spans.some(([f, l]) => (f > first && f < last) || (l > first && l < last))).length;
  assert.ok(interleaved >= outcomes.length * 0.8, `only ${interleaved} of ${outcomes.length} requests interleaved`);

  for (const { spec, result, calls } of outcomes) {
    assert.equal(canonical(result), reference.get(spec.name), `${spec.name} changed under concurrency`);
    // Commitment: every state read used this request's own commitment.
    const reads = calls.filter((c) => c.method === "getMultipleAccounts");
    assert.ok(reads.length > 0, spec.name);
    for (const read of reads) assert.equal(read.commitment, spec.commitment, `${spec.name}: read at ${read.commitment}`);
    assert.ok(calls.filter((c) => c.method === "getGenesisHash").length <= 1, spec.name);

    if (spec.expect.mint && "protectedMint" in result) assert.equal(result.protectedMint, spec.expect.mint, spec.name);
    if (result.status !== "PROTECTED") continue;
    assert.equal(result.direction, spec.expect.direction, spec.name);
    assert.equal(result.adapterKind, spec.expect.direction === "BUY" ? 2 : 3, spec.name);
    assert.equal(result.programAddress, spec.expect.program, spec.name);
    assert.equal(result.cluster, spec.expect.cluster, spec.name);
    assert.equal(result.deploymentIdentity, spec.programAddress ? "CALLER_TRUSTED" : "REVIEWED_BINARY", spec.name);
    assert.equal(result.snapshot.mint, spec.expect.mint, spec.name);
    // The state bound into the guard is this request's mint bytes.
    const own = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, spec.accounts[spec.expect.mint!]!.data);
    assert.deepEqual(result.snapshot.state, own, spec.name);
    // The compiled transaction: guard first, addressed to this program, over this mint.
    const [guard] = resolveWireTransaction(result.transaction, result.lookupTables);
    assert.equal(guard?.programAddress, spec.expect.program, spec.name);
    assert.equal(guard?.accounts[0]?.address, spec.expect.mint, spec.name);
    assert.equal(await verifyProtectedSwap(result), null, spec.name);
  }
});

test("identical inputs produce identical transactions, concurrently and in sequence", async () => {
  for (const spec of SPECS.filter((s) => s.expect.status === "PROTECTED")) {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => run(spec, BigInt(1000 + i))));
    const bytes = new Set(results.map(({ result }) => (result.status === "PROTECTED" ? result.transactionBase64 : "")));
    assert.equal(bytes.size, 1, spec.name);
    const { result: again } = await run(spec, null);
    assert.ok(again.status === "PROTECTED" && bytes.has(again.transactionBase64), spec.name);
  }
});

test("different economic states of the same mint yield different guards, never a shared one", async () => {
  const [a, b] = await Promise.all([run(SPECS[0]!, 1n), run(SPECS.find((s) => s.name === "KOx BUY against another economic state")!, 2n)]);
  assert.ok(a.result.status === "PROTECTED" && b.result.status === "PROTECTED");
  if (a.result.status !== "PROTECTED" || b.result.status !== "PROTECTED") return;
  assert.notEqual(a.result.transactionBase64, b.result.transactionBase64);
  assert.notDeepEqual(Buffer.from(a.result.snapshot.state.multiplier), Buffer.from(b.result.snapshot.state.multiplier));
  // Same route, same suffix: the difference is only the guard's expected state.
  assert.equal(a.result.binding.suffixCommitmentHex, b.result.binding.suffixCommitmentHex);
});
