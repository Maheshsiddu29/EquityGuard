/**
 * Client side of adapter kinds 2 and 3 over the recorded mainnet builds
 * (2026-09-16) and the shared golden vectors. Nothing here signs or sends.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AccountRole, address, getProgramDerivedAddress, type Address, type Instruction } from "@solana/kit";

import {
  ActivationPhase,
  DownstreamAdapterKind,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  GuardClientError,
  JUPITER_EVENT_AUTHORITY,
  JUPITER_SUFFIX_COMMITMENT_DOMAIN,
  JUPITER_V6_PROGRAM_ADDRESS,
  ROUTE_V2_DISCRIMINATOR_HEX,
  buildGuardedJupiterTrade,
  checkGuardedJupiterTransaction,
  checkJupiterSuffix,
  decodeRouteV2Prefix,
  downstreamCommitment,
  getAssertSafeExecutionV2Instruction,
  jupiterSuffixCommitment,
  minimumOutFromQuote,
  sysvarView,
  type AssertSafeExecutionRequest,
  type JupiterAdapterKind,
} from "../src/index.ts";
import { fromHex, hex, readDecodedMints, readGolden } from "./fixtures.ts";

interface RecordedInstruction {
  readonly programId: string;
  readonly accounts: readonly { readonly pubkey: string; readonly isSigner: boolean; readonly isWritable: boolean }[];
  readonly dataHex: string;
}
interface RecordedBuild {
  readonly symbol: string;
  readonly direction: "BUY" | "SELL";
  readonly inputMint: string;
  readonly outputMint: string;
  readonly taker: string;
  readonly quote: { readonly inAmount: string; readonly outAmount: string; readonly otherAmountThreshold: string; readonly slippageBps: number };
  readonly jupiterInstructions: readonly RecordedInstruction[];
}

const BUILDS = (
  JSON.parse(readFileSync(new URL("../../../scripts/research/fixtures/route-v2-builds-2026-09-16.json", import.meta.url), "utf8")) as {
    readonly builds: readonly RecordedBuild[];
  }
).builds;
const golden = readGolden();
const PROGRAM = EQUITY_GUARD_DEVNET_PROGRAM_ID;
/** The limit the composer and the LiteSVM suite add to the replayed builds. */
const LIMIT = 400_000;

function kit(i: RecordedInstruction): Instruction {
  return {
    programAddress: address(i.programId),
    accounts: i.accounts.map((a) => ({
      address: address(a.pubkey),
      role: a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: fromHex(i.dataHex),
  };
}

function limit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data };
}

const build = (symbol: string, direction: "BUY" | "SELL") => BUILDS.find((b) => b.symbol === symbol && b.direction === direction) as RecordedBuild;
const kindOf = (b: RecordedBuild): JupiterAdapterKind => (b.direction === "BUY" ? DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC : DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC);
const mintOf = (b: RecordedBuild) => address(b.direction === "BUY" ? b.outputMint : b.inputMint);
const normalized = (b: RecordedBuild): Instruction[] => {
  const [price, ...rest] = b.jupiterInstructions.map(kit);
  return [price as Instruction, limit(LIMIT), ...rest];
};

function expectationOf(symbol: string): AssertSafeExecutionRequest {
  const decoded = readDecodedMints().find((m) => m.symbol === symbol);
  assert.ok(decoded);
  return {
    expected: {
      multiplier: fromHex(decoded.multiplierHex),
      newMultiplier: fromHex(decoded.newMultiplierHex),
      newMultiplierEffectiveTimestamp: BigInt(decoded.newMultiplierEffectiveTimestamp),
    },
    expectedPhase: ActivationPhase.Activated,
    window: { beforeSecs: 900, afterSecs: 300 },
  };
}

const guarded = (b: RecordedBuild, suffix: readonly Instruction[] = normalized(b), feePayer = address(b.taker)) =>
  buildGuardedJupiterTrade({ programAddress: PROGRAM, feePayer, protectedMint: mintOf(b), adapterKind: kindOf(b), expectation: expectationOf(b.symbol), suffix });

test("pinned constants match their sources", async () => {
  assert.equal(JUPITER_SUFFIX_COMMITMENT_DOMAIN, golden.jupiterSuffixCommitmentDomain);
  assert.equal(createHash("sha256").update("global:route_v2").digest("hex").slice(0, 16), ROUTE_V2_DISCRIMINATOR_HEX);
  const [authority, bump] = await getProgramDerivedAddress({ programAddress: JUPITER_V6_PROGRAM_ADDRESS, seeds: ["__event_authority"] });
  assert.equal(authority, JUPITER_EVENT_AUTHORITY);
  assert.equal(bump, 255);
});

test("suffix commitments match the golden vectors (TypeScript == Rust == independent Python)", () => {
  assert.ok(golden.suffixCommitmentVectors.length >= 8);
  for (const vector of golden.suffixCommitmentVectors) {
    const suffix = vector.instructions.map((i) => ({
      programAddress: address(i.programId),
      accounts: i.accounts.map((a) => ({ address: address(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: fromHex(i.dataHex),
    }));
    assert.equal(hex(jupiterSuffixCommitment(suffix)), vector.commitmentHex, vector.name);
    if (vector.name === "single-instruction-in-the-suffix-domain") {
      assert.notEqual(hex(downstreamCommitment(suffix[0]!)), vector.commitmentHex, "the two domains never agree");
    }
  }
});

test("the real KOx and UNHx trades build, both directions, and hash to the golden commitments", async () => {
  for (const [symbol, direction] of [["KOx", "BUY"], ["KOx", "SELL"], ["UNHx", "BUY"], ["UNHx", "SELL"]] as const) {
    const b = build(symbol, direction);
    const trade = await guarded(b);
    const name = `${symbol.toLowerCase()}-${direction.toLowerCase()}-usdc`;
    assert.equal(hex(trade.commitment), golden.suffixCommitmentVectors.find((v) => v.name === name)?.commitmentHex, name);
    assert.equal(trade.instructions.length, 5);
    assert.equal(trade.instructions[0], trade.guard);
    assert.equal(trade.guard.data?.[66], kindOf(b));
    assert.equal(hex(Uint8Array.from(trade.guard.data ?? []).subarray(67)), hex(trade.commitment));
    assert.equal(trade.route.prefix.inAmount, BigInt(b.quote.inAmount));
    assert.equal(trade.route.prefix.quotedOutAmount, BigInt(b.quote.outAmount));
    assert.equal(minimumOutFromQuote(trade.route.prefix.quotedOutAmount, trade.route.prefix.slippageBps), BigInt(b.quote.otherAmountThreshold));

    // The golden ABI payload for this trade is exactly what the builder emits.
    const payload = golden.vectors.find((v) => v.request.adapterKind === kindOf(b) && v.request.expectedMint === mintOf(b));
    if (payload) assert.equal(hex(Uint8Array.from(trade.guard.data ?? [])), payload.encodedHex);
  }
  // Both golden kind 2/3 payloads were exercised.
  assert.equal(golden.vectors.filter((v) => v.request.adapterKind !== 1).length, 2);
});

test("CRMx SELL fits the grammar; CRMx BUY is refused rather than weakened", async () => {
  await guarded(build("CRMx", "SELL"));
  const crmxBuy = build("CRMx", "BUY");
  await assert.rejects(guarded(crmxBuy), (e) => e instanceof GuardClientError && e.guardError === "UnsupportedTransactionGrammar");
});

test("commitment construction is not circular: the final guard changes nothing the commitment covers", async () => {
  const b = build("KOx", "BUY");
  const trade = await guarded(b);
  const placeholder = getAssertSafeExecutionV2Instruction({
    programAddress: PROGRAM,
    mint: mintOf(b),
    expectation: expectationOf("KOx"),
    downstreamCommitment: new Uint8Array(32),
    adapterKind: kindOf(b),
  });
  assert.deepEqual(placeholder.accounts, trade.guard.accounts);
  const provisional = sysvarView([placeholder, ...trade.instructions.slice(1)], address(b.taker));
  const final = sysvarView(trade.instructions, address(b.taker));
  assert.deepEqual(provisional.slice(1), final.slice(1));
  assert.deepEqual(final.slice(1), trade.committedSuffix);
  assert.equal(hex(jupiterSuffixCommitment(provisional.slice(1))), hex(trade.commitment));
  assert.equal(
    await checkGuardedJupiterTransaction({ instructions: final, guardIndex: 0, adapterKind: kindOf(b), protectedMint: mintOf(b), commitment: trade.commitment }),
    null,
  );
});

test("the builder refuses every trade the program would refuse, naming the program's error", async () => {
  const b = build("UNHx", "BUY");
  const honest = normalized(b);
  const taker = address(b.taker);
  const attacker = address("CKWVz4KqMLfWDu7sVY8pGWpu5qNcDHLbmJdHRrs6eo9Q");
  const transfer: Instruction = {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: taker, role: AccountRole.WRITABLE_SIGNER },
      { address: attacker, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.of(2, 0, 0, 0, 0, 0xca, 0x9a, 0x3b, 0, 0, 0, 0),
  };
  const route = honest[3] as Instruction;
  const withRouteData = (edit: (data: Uint8Array) => void): Instruction[] => {
    const data = Uint8Array.from(route.data ?? []);
    edit(data);
    return [...honest.slice(0, 3), { ...route, data }];
  };
  const withRouteAccount = (index: number, key: Address): Instruction[] => [
    ...honest.slice(0, 3),
    { ...route, accounts: (route.accounts ?? []).map((a, i) => (i === index ? { ...a, address: key } : a)) },
  ];
  const cases: [string, Instruction[], string][] = [
    ["appended transfer", [...honest, transfer], "UnsupportedTransactionGrammar"],
    ["transfer in place of the setup", [honest[0]!, honest[1]!, transfer, route], "UnsupportedTransactionGrammar"],
    ["no limit", [honest[0]!, honest[2]!, route], "UnsupportedTransactionGrammar"],
    ["limit before price", [honest[1]!, honest[0]!, honest[2]!, route], "InvalidComputeBudgetInstruction"],
    ["platform fee", withRouteData((d) => new DataView(d.buffer).setUint16(26, 25, true)), "UnsupportedJupiterFee"],
    ["positive-slippage fee", withRouteData((d) => new DataView(d.buffer).setUint16(28, 25, true)), "UnsupportedJupiterFee"],
    ["other entrypoint", withRouteData((d) => d.set(fromHex("d19853937cfed8e9"), 0)), "InvalidJupiterInstruction"],
    ["destination override", withRouteAccount(7, attacker), "DestinationOverrideUnsupported"],
    ["foreign destination", withRouteAccount(2, attacker), "InvalidAtaSetup"],
    ["foreign source", withRouteAccount(1, attacker), "NonCanonicalSourceAccount"],
    ["non-USDC counter mint", withRouteAccount(3, attacker), "InvalidCounterMint"],
  ];
  for (const [label, suffix, expected] of cases) {
    await assert.rejects(guarded(b, suffix), (e) => e instanceof GuardClientError && e.code === "UnsupportedJupiterTrade" && e.guardError === expected, label);
  }
  // The wrong kind for the route.
  await assert.rejects(
    buildGuardedJupiterTrade({
      programAddress: PROGRAM,
      feePayer: taker,
      protectedMint: mintOf(b),
      adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC,
      expectation: expectationOf("UNHx"),
      suffix: honest,
    }),
    (e) => e instanceof GuardClientError && e.guardError === "InvalidJupiterDirection",
  );
  // Kind 1 is not a Jupiter kind.
  await assert.rejects(
    buildGuardedJupiterTrade({
      programAddress: PROGRAM,
      feePayer: taker,
      protectedMint: mintOf(b),
      adapterKind: DownstreamAdapterKind.TOKEN_2022_TRANSFER_CHECKED as never,
      expectation: expectationOf("UNHx"),
      suffix: honest,
    }),
    (e) => e instanceof GuardClientError && e.code === "InvalidDownstream",
  );
});

test("a relayer may pay, and the commitment follows the flags the relayer changes", async () => {
  const b = build("KOx", "BUY");
  const relayer = address("9UXVJAZr2hJs7rs1yf3EdKyGVkjs14YEtr8sESKoeJYn");
  const suffix = normalized(b);
  const setup = suffix[2] as Instruction;
  suffix[2] = { ...setup, accounts: (setup.accounts ?? []).map((a, i) => (i === 0 ? { ...a, address: relayer } : a)) };
  const relayed = await guarded(b, suffix, relayer);
  const direct = await guarded(b);
  assert.notEqual(hex(relayed.commitment), hex(direct.commitment));
  // The authority is still a signer, but no longer writable.
  const authority = relayed.committedSuffix[3]?.accounts[0];
  assert.deepEqual([authority?.isSigner, authority?.isWritable], [true, false]);
});

test("transaction-level flags merge across instructions and never claim a flag the runtime would drop", () => {
  const payer = address("9UXVJAZr2hJs7rs1yf3EdKyGVkjs14YEtr8sESKoeJYn");
  const other = address("CKWVz4KqMLfWDu7sVY8pGWpu5qNcDHLbmJdHRrs6eo9Q");
  const program = address("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
  const view = sysvarView(
    [
      { programAddress: program, accounts: [{ address: other, role: AccountRole.READONLY }, { address: payer, role: AccountRole.READONLY }] },
      { programAddress: program, accounts: [{ address: other, role: AccountRole.WRITABLE }] },
    ],
    payer,
  );
  assert.deepEqual(view[0]?.accounts, [
    { address: other, isSigner: false, isWritable: true },
    { address: payer, isSigner: true, isWritable: true },
  ]);
  for (const writable of [program, address("SysvarC1ock11111111111111111111111111111111"), address("ComputeBudget111111111111111111111111111111")]) {
    assert.throws(
      () => sysvarView([{ programAddress: program, accounts: [{ address: writable, role: AccountRole.WRITABLE }] }], payer),
      (e) => e instanceof GuardClientError && e.code === "InvalidDownstream",
      writable,
    );
  }
});

test("the route_v2 prefix decodes the documented offsets and refuses anything else", async () => {
  for (const b of BUILDS) {
    const swap = b.jupiterInstructions.find((i) => i.programId === JUPITER_V6_PROGRAM_ADDRESS) as RecordedInstruction;
    const prefix = decodeRouteV2Prefix(fromHex(swap.dataHex));
    assert.ok(prefix);
    assert.equal(prefix.inAmount, BigInt(b.quote.inAmount));
    assert.equal(prefix.slippageBps, b.quote.slippageBps);
    assert.equal(minimumOutFromQuote(prefix.quotedOutAmount, prefix.slippageBps), BigInt(b.quote.otherAmountThreshold), `${b.symbol} ${b.direction}`);
  }
  const data = fromHex(build("KOx", "BUY").jupiterInstructions[2]!.dataHex);
  assert.equal(decodeRouteV2Prefix(data.subarray(0, 33)), null);
  assert.equal(decodeRouteV2Prefix(Uint8Array.from([0, ...data.subarray(1)])), null);
  assert.throws(() => minimumOutFromQuote(1n, 10_001), GuardClientError);
  // The whole checker agrees with itself on a setup-less suffix.
  const b = build("UNHx", "SELL");
  const view = sysvarView(
    [getAssertSafeExecutionV2Instruction({ programAddress: PROGRAM, mint: mintOf(b), expectation: expectationOf("UNHx"), downstreamCommitment: new Uint8Array(32), adapterKind: kindOf(b) }), ...normalized(b).filter((_, i) => i !== 2)],
    address(b.taker),
  );
  assert.equal((await checkJupiterSuffix(view.slice(1), kindOf(b), mintOf(b))).verdict, null);
});
