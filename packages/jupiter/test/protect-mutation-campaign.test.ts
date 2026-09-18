/**
 * M11-A step 4, SDK half: start from a PROTECTED result and change one
 * property at a time.
 *
 * - Wire mutations edit the compiled v0 transaction the SDK returned. Each is
 *   checked by `verifyProtectedSwap` as-is (the client fixed the commitment,
 *   then the bytes changed) and, where the guard itself is untouched, again
 *   with a commitment recomputed over the mutated suffix, against the
 *   client's mirror of the program grammar. The on-chain half of the
 *   campaign, over the compiled program, is in
 *   `programs/equity_guard/tests/litesvm_jupiter.rs`.
 * - Build mutations edit the Jupiter `/build` response before protection: a
 *   semantic violation never comes back PROTECTED; a value the ABI leaves to
 *   the signer comes back PROTECTED and bound to the new value.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, getTransactionDecoder } from "@solana/kit";
import { checkGuardedJupiterTransaction, jupiterSuffixCommitment, type EquityGuardErrorName } from "@equityguard/guard-client";

import { resolveWireTransaction, type BuildResponse } from "../src/index.ts";
import { protectJupiterSwap, verifyProtectedSwap, type ProtectJupiterSwapResult, type ProtectedSwap, type VerificationVerdict } from "../src/protect.ts";
import {
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  UNHX_MINT,
  distinctAddress,
  fakeRpc,
  legacyMint,
  mainnetMint,
  recordedBuild,
  recordedKoxBuyBuild,
  token2022Account,
  withMints,
  withSwapAccount,
  withSwapData,
} from "./protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const ACCOUNTS = { [KOX_MINT]: token2022Account(mainnetMint("KOx")), [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) };
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Instruction positions in a PROTECTED transaction. */
const GUARD = 0;
const PRICE = 1;
const LIMIT = 2;
const SETUP = 3;
const ROUTE = 4;

async function protect(build: BuildResponse, taker = TAKER): Promise<ProtectJupiterSwapResult> {
  const accounts = { ...ACCOUNTS, [USDT]: legacyMint() };
  return protectJupiterSwap({ build, userPublicKey: taker, rpc: fakeRpc({ accounts, unixTimestamp: SETTLED_TIMESTAMP }).rpc, protectionWindow: WINDOW });
}

// ------------------------------------------------------- wire mutations

interface Ix {
  programAddressIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}
interface Lookup {
  lookupTableAddress: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}
interface Message {
  version: 0;
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: string[];
  lifetimeToken: string;
  instructions: Ix[];
  addressTableLookups: Lookup[];
}

/** A mutable deep copy of the compiled message in `wire`. */
function decodeMessage(wire: Uint8Array): Message {
  const decoded = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(wire).messageBytes) as unknown as Message;
  return {
    version: 0,
    header: { ...decoded.header },
    staticAccounts: [...decoded.staticAccounts],
    lifetimeToken: decoded.lifetimeToken,
    instructions: decoded.instructions.map((i) => ({ programAddressIndex: i.programAddressIndex, accountIndices: [...(i.accountIndices ?? [])], data: Uint8Array.from(i.data ?? []) })),
    addressTableLookups: (decoded.addressTableLookups ?? []).map((l) => ({ ...l, writableIndexes: [...l.writableIndexes], readonlyIndexes: [...l.readonlyIndexes] })),
  };
}

/** Unsigned wire bytes: one zeroed signature per signer in the header. */
function encodeWire(message: Message): Uint8Array {
  const messageBytes = getCompiledTransactionMessageEncoder().encode(message as never);
  const signers = message.header.numSignerAccounts;
  assert.ok(signers < 0x80);
  const out = new Uint8Array(1 + 64 * signers + messageBytes.length);
  out[0] = signers;
  out.set(messageBytes, 1 + 64 * signers);
  return out;
}

const route = (m: Message) => m.instructions[ROUTE] as Ix;
const xor = (data: Uint8Array, offset: number, mask = 1) => void (data[offset] = (data[offset] ?? 0) ^ mask);

/**
 * `stale`: `verifyProtectedSwap` on the mutated bytes. `recomputed`: the
 * client grammar with a commitment recomputed over the mutated suffix — an
 * error name for a semantic violation, `null` for a value left to the signer,
 * `"SKIP"` where the guard itself or the runtime's own flag rules decide.
 */
interface WireMutation {
  readonly label: string;
  readonly mutate: (m: Message) => void;
  readonly stale: Exclude<VerificationVerdict, null> | "ANY_REJECTION";
  readonly recomputed: EquityGuardErrorName | null | "SKIP";
}

const GUARD_FIELDS: readonly [string, number][] = [
  ["ABI version", 0],
  ["expected mint", 1],
  ["expected multiplier", 33],
  ["expected new multiplier", 41],
  ["T", 49],
  ["phase", 57],
  ["window before", 58],
  ["window after", 62],
  ["adapter kind", 66],
  ["commitment", 67],
];

const wireMutations = (): WireMutation[] => [
  // The guard instruction: its own commitment does not cover it.
  { label: "guard program id", mutate: (m) => void ((m.instructions[GUARD] as Ix).programAddressIndex = m.staticAccounts.indexOf(COMPUTE_BUDGET)), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" },
  ...GUARD_FIELDS.map(([field, offset]): WireMutation => ({ label: `guard payload: ${field}`, mutate: (m) => xor((m.instructions[GUARD] as Ix).data, offset), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" })),
  { label: "guard payload truncated", mutate: (m) => void ((m.instructions[GUARD] as Ix).data = (m.instructions[GUARD] as Ix).data.slice(0, 98)), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" },
  { label: "guard accounts reordered", mutate: (m) => void (m.instructions[GUARD] as Ix).accountIndices.reverse(), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" },
  { label: "guard account removed", mutate: (m) => void (m.instructions[GUARD] as Ix).accountIndices.pop(), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" },
  { label: "guard deleted", mutate: (m) => void m.instructions.shift(), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" },
  { label: "guard moved to index 1", mutate: (m) => void m.instructions.splice(0, 2, m.instructions[1] as Ix, m.instructions[0] as Ix), stale: "GUARD_INSTRUCTION_CHANGED", recomputed: "SKIP" },
  { label: "second guard appended", mutate: (m) => void m.instructions.push(m.instructions[GUARD] as Ix), stale: "UnsupportedTransactionGrammar", recomputed: "UnsupportedTransactionGrammar" },
  // Compute budget
  { label: "CU price value", mutate: (m) => xor((m.instructions[PRICE] as Ix).data, 1), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "CU limit value", mutate: (m) => xor((m.instructions[LIMIT] as Ix).data, 3), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "CU price and limit reordered", mutate: (m) => void m.instructions.splice(PRICE, 2, m.instructions[LIMIT] as Ix, m.instructions[PRICE] as Ix), stale: "InvalidComputeBudgetInstruction", recomputed: "InvalidComputeBudgetInstruction" },
  { label: "CU price deleted", mutate: (m) => void m.instructions.splice(PRICE, 1), stale: "UnsupportedTransactionGrammar", recomputed: "UnsupportedTransactionGrammar" },
  // ATA setup
  { label: "setup deleted", mutate: (m) => void m.instructions.splice(SETUP, 1), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "setup became Create", mutate: (m) => void ((m.instructions[SETUP] as Ix).data = Uint8Array.of(0)), stale: "InvalidAtaSetup", recomputed: "InvalidAtaSetup" },
  { label: "setup payer is not a signer", mutate: (m) => void ((m.instructions[SETUP] as Ix).accountIndices[0] = (m.instructions[SETUP] as Ix).accountIndices[3] as number), stale: "InvalidAtaSetup", recomputed: "InvalidAtaSetup" },
  { label: "setup owner", mutate: (m) => void ((m.instructions[SETUP] as Ix).accountIndices[2] = (m.instructions[SETUP] as Ix).accountIndices[3] as number), stale: "InvalidAtaSetup", recomputed: "InvalidAtaSetup" },
  { label: "setup moved after the trade", mutate: (m) => void m.instructions.splice(SETUP, 2, m.instructions[ROUTE] as Ix, m.instructions[SETUP] as Ix), stale: "UnsupportedTransactionGrammar", recomputed: "UnsupportedTransactionGrammar" },
  // route_v2 data
  { label: "input amount", mutate: (m) => xor(route(m).data, 8), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "quoted output", mutate: (m) => xor(route(m).data, 16), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "slippage", mutate: (m) => xor(route(m).data, 24), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "platform fee", mutate: (m) => void (route(m).data[26] = 1), stale: "UnsupportedJupiterFee", recomputed: "UnsupportedJupiterFee" },
  { label: "positive-slippage fee", mutate: (m) => void (route(m).data[28] = 1), stale: "UnsupportedJupiterFee", recomputed: "UnsupportedJupiterFee" },
  { label: "route leg count zero", mutate: (m) => route(m).data.fill(0, 30, 34), stale: "InvalidJupiterInstruction", recomputed: "InvalidJupiterInstruction" },
  { label: "route leg count", mutate: (m) => xor(route(m).data, 33, 0x40), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "opaque route plan tail", mutate: (m) => xor(route(m).data, route(m).data.length - 1), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "Jupiter discriminator", mutate: (m) => xor(route(m).data, 0), stale: "InvalidJupiterInstruction", recomputed: "InvalidJupiterInstruction" },
  // route_v2 accounts
  { label: "Jupiter program id", mutate: (m) => void (route(m).programAddressIndex = m.staticAccounts.indexOf(COMPUTE_BUDGET)), stale: "InvalidJupiterProgram", recomputed: "InvalidJupiterProgram" },
  { label: "authority is not a signer", mutate: (m) => void (route(m).accountIndices[0] = route(m).accountIndices[3] as number), stale: "InvalidJupiterInstruction", recomputed: "InvalidJupiterInstruction" },
  { label: "event authority", mutate: (m) => void (route(m).accountIndices[8] = route(m).accountIndices[3] as number), stale: "InvalidJupiterInstruction", recomputed: "InvalidJupiterInstruction" },
  { label: "destination override", mutate: (m) => void (route(m).accountIndices[7] = route(m).accountIndices[3] as number), stale: "DestinationOverrideUnsupported", recomputed: "DestinationOverrideUnsupported" },
  { label: "source token account", mutate: (m) => void (route(m).accountIndices[1] = route(m).accountIndices[2] as number), stale: "NonCanonicalSourceAccount", recomputed: "NonCanonicalSourceAccount" },
  { label: "source and destination mints swapped", mutate: (m) => void route(m).accountIndices.splice(3, 2, route(m).accountIndices[4] as number, route(m).accountIndices[3] as number), stale: "InvalidJupiterDirection", recomputed: "InvalidJupiterDirection" },
  { label: "token programs swapped", mutate: (m) => void route(m).accountIndices.splice(5, 2, route(m).accountIndices[6] as number, route(m).accountIndices[5] as number), stale: "InvalidTokenProgram", recomputed: "InvalidTokenProgram" },
  { label: "venue account remapped", mutate: (m) => void (route(m).accountIndices[20] = route(m).accountIndices[21] as number), stale: "DownstreamCommitmentMismatch", recomputed: null },
  { label: "venue account removed", mutate: (m) => void route(m).accountIndices.pop(), stale: "DownstreamCommitmentMismatch", recomputed: null },
  // Instruction set
  { label: "second Jupiter instruction", mutate: (m) => void m.instructions.push(route(m)), stale: "UnsupportedTransactionGrammar", recomputed: "UnsupportedTransactionGrammar" },
  { label: "unknown instruction appended", mutate: (m) => void m.instructions.push({ programAddressIndex: 1, accountIndices: [], data: Uint8Array.of(1) }), stale: "UnsupportedTransactionGrammar", recomputed: "UnsupportedTransactionGrammar" },
  { label: "trade deleted", mutate: (m) => void m.instructions.splice(ROUTE, 1), stale: "InvalidJupiterProgram", recomputed: "InvalidJupiterProgram" },
  // Message metadata: header flags and lookup tables
  { label: "header: one more read-only static account", mutate: (m) => void (m.header.numReadonlyNonSignerAccounts += 1), stale: "ANY_REJECTION", recomputed: "SKIP" },
  { label: "header: one fewer read-only static account", mutate: (m) => void (m.header.numReadonlyNonSignerAccounts -= 1), stale: "ANY_REJECTION", recomputed: "SKIP" },
  { label: "header: one more signer", mutate: (m) => void (m.header.numSignerAccounts += 1), stale: "ANY_REJECTION", recomputed: "SKIP" },
  { label: "lookup: read-only entry made writable", mutate: (m) => void (m.addressTableLookups[0] as Lookup).writableIndexes.push((m.addressTableLookups[0] as Lookup).readonlyIndexes.shift() as number), stale: "ANY_REJECTION", recomputed: "SKIP" },
  { label: "lookup: two entries swapped", mutate: (m) => void (m.addressTableLookups[0] as Lookup).readonlyIndexes.reverse(), stale: "ANY_REJECTION", recomputed: "SKIP" },
  { label: "lookup: index points at another table entry", mutate: (m) => void ((m.addressTableLookups[0] as Lookup).readonlyIndexes[0] = 200), stale: "ANY_REJECTION", recomputed: "SKIP" },
  { label: "lookup: index out of range", mutate: (m) => void ((m.addressTableLookups[0] as Lookup).readonlyIndexes[0] = 255), stale: "UNRESOLVABLE_TRANSACTION", recomputed: "SKIP" },
  { label: "lookup: table substituted", mutate: (m) => void ((m.addressTableLookups[0] as Lookup).lookupTableAddress = distinctAddress(99)), stale: "UNRESOLVABLE_TRANSACTION", recomputed: "SKIP" },
  { label: "static account substituted", mutate: (m) => void (m.staticAccounts[m.staticAccounts.length - 1] = distinctAddress(98)), stale: "ANY_REJECTION", recomputed: "SKIP" },
];

test("M11-A: every single-property wire mutation of a PROTECTED transaction is detected", async () => {
  let generated = 0;
  let rejected = 0;
  let acceptedAsSpecified = 0;
  const unexpectedAccepts: string[] = [];
  const wrong: string[] = [];

  for (const [name, build] of [["KOx BUY", recordedKoxBuyBuild()], ["UNHx SELL", recordedBuild("UNHx", "SELL")]] as const) {
    const result = await protect(build);
    assert.equal(result.status, "PROTECTED", name);
    const protectedSwap = result as ProtectedSwap;
    assert.equal(await verifyProtectedSwap(protectedSwap), null, `${name}: the untouched transaction verifies`);
    assert.equal(await verifyProtectedSwap(protectedSwap, encodeWire(decodeMessage(protectedSwap.transaction))), null, `${name}: re-encoding is not a mutation`);

    for (const mutation of wireMutations()) {
      const message = decodeMessage(protectedSwap.transaction);
      mutation.mutate(message);
      const wire = encodeWire(message);
      const label = `${name} ${mutation.label}`;

      generated += 1;
      const stale = await verifyProtectedSwap(protectedSwap, wire);
      if (stale === null) unexpectedAccepts.push(`${label} [honest commitment]`);
      else rejected += 1;
      if (stale !== null && mutation.stale !== "ANY_REJECTION" && stale !== mutation.stale) wrong.push(`${label} [honest commitment]: expected ${mutation.stale}, got ${stale}`);

      if (mutation.recomputed === "SKIP") continue;
      generated += 1;
      const resolved = resolveWireTransaction(wire, protectedSwap.lookupTables);
      const recomputed = await checkGuardedJupiterTransaction({
        instructions: resolved,
        guardIndex: 0,
        adapterKind: protectedSwap.adapterKind,
        protectedMint: protectedSwap.protectedMint,
        commitment: jupiterSuffixCommitment(resolved.slice(1)),
      });
      if (recomputed === null) {
        if (mutation.recomputed === null) acceptedAsSpecified += 1;
        else unexpectedAccepts.push(`${label} [recomputed commitment]: expected ${mutation.recomputed}`);
      } else {
        rejected += 1;
        if (recomputed !== mutation.recomputed) wrong.push(`${label} [recomputed commitment]: expected ${String(mutation.recomputed)}, got ${recomputed}`);
      }
    }
  }
  console.log(`SDK wire mutation campaign: ${generated} generated, ${rejected} rejected, ${acceptedAsSpecified} accepted as specified, ${unexpectedAccepts.length} unexpected accepts`);
  assert.deepEqual(unexpectedAccepts, [], "UNEXPECTED ACCEPTS");
  assert.deepEqual(wrong, []);
  assert.ok(generated >= 150, String(generated));
});

// ------------------------------------------------------ build mutations

const withData = (build: BuildResponse, offset: number, bytes: number[]) => withSwapData(build, (d) => void d.set(bytes, offset));
const le = (value: bigint, size: number) => Array.from({ length: size }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
const setupOf = (build: BuildResponse) => build.setupInstructions[0]!;
const withSetupAccount = (build: BuildResponse, index: number, meta: Partial<{ pubkey: string; isSigner: boolean; isWritable: boolean }>): BuildResponse => ({
  ...build,
  setupInstructions: [{ ...setupOf(build), accounts: setupOf(build).accounts.map((a, i) => (i === index ? { ...a, ...meta } : a)) }],
});
const cbData = (tag: number, value: bigint, size: number) => Buffer.from([tag, ...le(value, size)]).toString("base64");
const cb = (tag: number, value: bigint, size: number) => ({ programId: COMPUTE_BUDGET, accounts: [], data: cbData(tag, value, size) });
const TRANSFER = { programId: "11111111111111111111111111111111", accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }, { pubkey: distinctAddress(97), isSigner: false, isWritable: true }], data: Buffer.from([2, 0, 0, 0, ...le(1_000_000n, 8)]).toString("base64") };

/** Mutations of the `/build` response that must never come back PROTECTED. */
const refusedBuilds = (b: BuildResponse): [string, BuildResponse][] => {
  const swap = b.swapInstruction;
  const setup = setupOf(b);
  const encoded = Buffer.from(swap.data, "base64");
  const inAmount = encoded.readBigUInt64LE(8);
  const quoted = encoded.readBigUInt64LE(16);
  return [
    ["cleanup instruction", { ...b, cleanupInstruction: setup }],
    ["tip instruction", { ...b, tipInstruction: TRANSFER }],
    ["other instruction", { ...b, otherInstructions: [TRANSFER] }],
    ["system transfer as a setup", { ...b, setupInstructions: [setup, TRANSFER] }],
    ["second setup", { ...b, setupInstructions: [setup, setup] }],
    ["setup program is not ATA", { ...b, setupInstructions: [{ ...setup, programId: "11111111111111111111111111111111" }] }],
    ["setup is Create", { ...b, setupInstructions: [{ ...setup, data: Buffer.from([0]).toString("base64") }] }],
    ["setup payer does not sign", withSetupAccount(b, 0, { pubkey: distinctAddress(96), isSigner: false })],
    ["setup owner", withSetupAccount(b, 2, { pubkey: distinctAddress(95) })],
    ["setup mint", withSetupAccount(b, 3, { pubkey: USDT })],
    ["setup token program", withSetupAccount(b, 5, { pubkey: setup.accounts[5]!.pubkey === swap.accounts[5]!.pubkey ? swap.accounts[6]!.pubkey : swap.accounts[5]!.pubkey })],
    ["extra ComputeBudget variant", { ...b, computeBudgetInstructions: [...b.computeBudgetInstructions, cb(1, 32n * 1024n, 4)] }],
    ["two prices", { ...b, computeBudgetInstructions: [...b.computeBudgetInstructions, ...b.computeBudgetInstructions] }],
    ["no price", { ...b, computeBudgetInstructions: [] }],
    ["two limits", { ...b, computeBudgetInstructions: [...b.computeBudgetInstructions, cb(2, 123n, 4), cb(2, 123n, 4)] }],
    ["swap program is not Jupiter", { ...b, swapInstruction: { ...swap, programId: COMPUTE_BUDGET } }],
    ["another Jupiter entrypoint", withData(b, 0, [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a])],
    ["ExactOut", { ...b, swapMode: "ExactOut" }],
    ["authority is not the taker", withSwapAccount(b, 0, distinctAddress(94))],
    ["source token account", withSwapAccount(b, 1, distinctAddress(93))],
    ["destination token account", withSwapAccount(b, 2, distinctAddress(92))],
    ["source token program", withSwapAccount(b, 5, swap.accounts[6]!.pubkey)],
    ["destination token program", withSwapAccount(b, 6, swap.accounts[5]!.pubkey)],
    ["destination override", withSwapAccount(b, 7, distinctAddress(91))],
    ["event authority", withSwapAccount(b, 8, distinctAddress(90))],
    ["Jupiter program account", withSwapAccount(b, 9, distinctAddress(89))],
    ["platform fee", withData(b, 26, le(1n, 2))],
    ["positive-slippage fee", withData(b, 28, le(1n, 2))],
    ["route leg count zero", withData(b, 30, le(0n, 4))],
    ["input amount zero, reported the same", { ...withData(b, 8, le(0n, 8)), inAmount: "0" }],
    ["reported input differs from the encoded one", { ...b, inAmount: String(inAmount + 1n) }],
    ["reported output differs from the encoded one", { ...b, outAmount: String(quoted + 1n) }],
    ["reported slippage differs from the encoded one", { ...b, slippageBps: b.slippageBps + 1 }],
    ["reported minimum differs from the encoded one", { ...b, otherAmountThreshold: "1" }],
    ["slippage above 100%, reported the same", { ...withData(b, 24, le(10_001n, 2)), slippageBps: 10_001 }],
    ["reported mints hide the protected side", { ...b, inputMint: USDT }],
    ["counter asset is not USDC", withMints(b, b.inputMint === KOX_MINT || b.inputMint === UNHX_MINT ? { outputMint: USDT } : { inputMint: USDT })],
    ["protected mint substituted", withMints(b, b.outputMint === KOX_MINT ? { outputMint: UNHX_MINT } : b.inputMint === UNHX_MINT ? { inputMint: KOX_MINT } : {})],
    ["BUY becomes SELL", withMints(b, { inputMint: b.outputMint, outputMint: b.inputMint })],
  ];
};

test("M11-A: no semantic mutation of a /build response comes back PROTECTED", async () => {
  let generated = 0;
  const unexpected: string[] = [];
  for (const [name, build] of [["KOx BUY", recordedKoxBuyBuild()], ["UNHx SELL", recordedBuild("UNHx", "SELL")]] as const) {
    for (const [label, mutated] of refusedBuilds(build)) {
      generated += 1;
      const result = await protect(mutated);
      if (result.status === "PROTECTED" || "transaction" in result) unexpected.push(`${name} ${label}: ${result.status}`);
      else if (result.status === "NOT_APPLICABLE") unexpected.push(`${name} ${label}: downgraded to NOT_APPLICABLE`);
    }
  }
  console.log(`SDK build mutation campaign: ${generated} generated, ${generated - unexpected.length} refused, ${unexpected.length} unexpected accepts`);
  assert.deepEqual(unexpected, []);
});

test("M11-A: values the ABI leaves to the signer come back PROTECTED and bound to the new value", async () => {
  const base = recordedKoxBuyBuild();
  const baseline = (await protect(base)) as ProtectedSwap;
  const encoded = Buffer.from(base.swapInstruction.data, "base64");
  const inAmount = encoded.readBigUInt64LE(8) + 1n;
  const cases: [string, BuildResponse, (p: ProtectedSwap) => void][] = [
    ["input amount, reported the same", { ...withData(base, 8, le(inAmount, 8)), inAmount: String(inAmount) }, (p) => assert.equal(p.binding.inAmountRaw, inAmount)],
    ["CU price", { ...base, computeBudgetInstructions: [cb(3, 7n, 8)] }, () => {}],
    ["CU limit set by Jupiter", { ...base, computeBudgetInstructions: [...base.computeBudgetInstructions, cb(2, 123n, 4)] }, (p) => assert.equal(Buffer.from(p.instructions[2]?.data ?? []).readUInt32LE(1), 123)],
    ["opaque route plan tail", withSwapData(base, (d) => xor(d, d.length - 1)), () => {}],
    ["venue account", withSwapAccount(base, 20, distinctAddress(88)), () => {}],
  ];
  for (const [label, build, check] of cases) {
    const result = await protect(build);
    assert.equal(result.status, "PROTECTED", label);
    const swap = result as ProtectedSwap;
    assert.notEqual(swap.binding.suffixCommitmentHex, baseline.binding.suffixCommitmentHex, `${label} is committed`);
    assert.equal(await verifyProtectedSwap(swap), null, label);
    // The new transaction does not verify as the old one, nor the old as the new.
    assert.notEqual(await verifyProtectedSwap(baseline, swap.transaction), null, label);
    check(swap);
  }
});
