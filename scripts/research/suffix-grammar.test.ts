/**
 * Offline checks of the M9D-A.1 transaction grammar against the real mainnet
 * builds recorded on 2026-09-16. No network, nothing signed.
 *
 * The first test is the correction this milestone exists for: a commitment
 * computed over a malicious suffix verifies, and only the grammar rejects it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../../packages/guard-client/src/index.ts";
import { decodeRouteV2, type InstructionLike, type ProtectedTrade, type TradeDirection } from "./route-v2.ts";
import { checkTransactionGrammar, suffixCommitmentPreimage } from "./suffix-grammar.ts";

interface Build {
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly taker: string;
  readonly quote: { readonly inAmount: string; readonly outAmount: string; readonly slippageBps: number };
  readonly swapInstruction: InstructionLike;
  readonly jupiterInstructions: readonly InstructionLike[];
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/route-v2-builds-2026-09-16.json", import.meta.url), "utf8")) as { readonly builds: readonly Build[] };
const builds = fixture.builds;
const guard: InstructionLike = { programId: EQUITY_GUARD_DEVNET_PROGRAM_ID, accounts: [], dataHex: "02" };

const SYSTEM_TRANSFER: InstructionLike = {
  programId: "11111111111111111111111111111111",
  accounts: [
    { pubkey: "AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH", isSigner: true, isWritable: true },
    { pubkey: "So11111111111111111111111111111111111111112", isSigner: false, isWritable: true },
  ],
  dataHex: "0200000000ca9a3b00000000",
};

function tradeOf(build: Build): ProtectedTrade {
  const route = decodeRouteV2(build.swapInstruction);
  return {
    protectedMint: build.direction === "BUY" ? build.outputMint : build.inputMint,
    direction: build.direction,
    counterMint: build.direction === "BUY" ? build.inputMint : build.outputMint,
    userAuthority: build.taker,
    userDestinationTokenAccount: route.userDestinationTokenAccount,
    inAmount: BigInt(build.quote.inAmount),
    quotedOutAmount: BigInt(build.quote.outAmount),
    slippageBps: build.quote.slippageBps,
  };
}

/** The transaction a composer would produce: guard first, then Jupiter's own order. */
const transactionFor = (build: Build, extra: readonly InstructionLike[] = []): InstructionLike[] => [guard, ...build.jupiterInstructions, ...extra];

const check = (instructions: readonly InstructionLike[], build: Build) =>
  checkTransactionGrammar(instructions, EQUITY_GUARD_DEVNET_PROGRAM_ID, tradeOf(build));

const supported = builds.filter((b) => ["KOx", "UNHx"].includes(b.symbol));

test("a commitment over a malicious suffix still verifies: only the grammar rejects it", async () => {
  const build = supported[0] as Build;
  const honest = transactionFor(build).slice(1);
  const malicious = [...honest, SYSTEM_TRANSFER];

  // Identity binding, as a builder that writes both would compute it.
  const digest = (suffix: readonly InstructionLike[]) => createHash("sha256").update(suffixCommitmentPreimage(suffix)).digest("hex");
  const committed = digest(malicious);
  assert.equal(digest(malicious), committed, "the malicious suffix matches its own commitment exactly");
  assert.notEqual(digest(honest), committed, "and is distinguishable from the honest one");

  // Semantics: the trade itself is untouched and still valid.
  const trade = await check([guard, ...honest], build);
  assert.deepEqual(trade.failures, []);

  // Only the grammar catches the appended transfer.
  const result = await check([guard, ...malicious], build);
  assert.deepEqual(result.failures, ["TRADE_NOT_LAST"]);
});

test("the real KOx and UNHx builds are accepted, both directions", async () => {
  assert.equal(supported.length, 4);
  for (const build of supported) {
    const result = await check(transactionFor(build), build);
    assert.deepEqual(result.failures, [], `${build.symbol} ${build.direction}`);
    assert.notEqual(result.route, null);
  }
});

test("a compute unit limit the composer adds is accepted in any prefix position", async () => {
  const build = supported[0] as Build;
  const limit: InstructionLike = { programId: "ComputeBudget111111111111111111111111111111", accounts: [], dataHex: "02a0aa1500" };
  const [price, setup, swap] = build.jupiterInstructions as [InstructionLike, InstructionLike, InstructionLike];
  for (const prefix of [
    [price, limit, setup],
    [limit, price, setup],
    [price, setup, limit],
  ]) {
    const result = await check([guard, ...prefix, swap], build);
    assert.deepEqual(result.failures, []);
  }
});

test("wSOL-intermediate routes are rejected: unknown setup and a cleanup instruction", async () => {
  const crmxBuy = builds.find((b) => b.symbol === "CRMx" && b.direction === "BUY") as Build;
  const result = await check(transactionFor(crmxBuy), crmxBuy);
  assert.deepEqual(result.failures, ["TRADE_NOT_LAST"], "the trailing CloseAccount is refused before anything else");

  // Even without the cleanup, the second ATA is not for either side of the trade.
  const withoutCleanup = transactionFor(crmxBuy).slice(0, -1);
  const trimmed = await check(withoutCleanup, crmxBuy);
  assert.deepEqual(trimmed.failures, ["DUPLICATE_SETUP", "SETUP_NOT_FOR_THE_TRADE"]);
});

test("every unsupported suffix element fails closed", async () => {
  const build = supported[0] as Build;
  const [price, setup, swap] = build.jupiterInstructions as [InstructionLike, InstructionLike, InstructionLike];
  const cases: readonly [string, InstructionLike[], readonly string[]][] = [
    // The displaced guard is also an unsupported program inside the suffix.
    ["guard not at index 0", [price, guard, setup, swap], ["GUARD_NOT_AT_INDEX_ZERO", "UNSUPPORTED_PROGRAM"]],
    ["trailing system transfer", [guard, price, setup, swap, SYSTEM_TRANSFER], ["TRADE_NOT_LAST"]],
    ["system transfer before the trade", [guard, price, SYSTEM_TRANSFER, setup, swap], ["UNSUPPORTED_PROGRAM"]],
    ["second Jupiter instruction", [guard, price, swap, setup, swap], ["SECOND_JUPITER_INSTRUCTION"]],
    ["duplicate compute unit price", [guard, price, price, setup, swap], ["DUPLICATE_COMPUTE_UNIT_PRICE"]],
    ["unknown compute budget instruction", [guard, { ...price, dataHex: "0400000000" }, setup, swap], ["UNSUPPORTED_COMPUTE_BUDGET_INSTRUCTION"]],
    ["duplicate setup", [guard, price, setup, setup, swap], ["DUPLICATE_SETUP"]],
    ["no trade at all", [guard, price, setup], ["PROGRAM_NOT_JUPITER"]],
    ["empty suffix", [guard], ["EMPTY_SUFFIX"]],
  ];
  for (const [label, instructions, expected] of cases) {
    const result = await check(instructions, build);
    assert.deepEqual(result.failures, expected, label);
  }
});

test("setup must be for this trade's destination, owned by this trade's authority", async () => {
  const build = supported[0] as Build;
  const other = builds.find((b) => b.symbol !== build.symbol) as Build;
  const [price, setup, swap] = build.jupiterInstructions as [InstructionLike, InstructionLike, InstructionLike];
  const mutate = (index: number, pubkey: string): InstructionLike => ({
    ...setup,
    accounts: setup.accounts.map((a, i) => (i === index ? { ...a, pubkey } : a)),
  });
  const cases: readonly [string, InstructionLike, readonly string[]][] = [
    ["foreign ATA", mutate(1, other.swapInstruction.accounts[2]?.pubkey as string), ["SETUP_NOT_FOR_THE_TRADE"]],
    ["foreign owner", mutate(2, other.swapInstruction.accounts[1]?.pubkey as string), ["SETUP_NOT_FOR_THE_TRADE"]],
    ["foreign mint", mutate(3, other.outputMint), ["SETUP_NOT_FOR_THE_TRADE"]],
    ["wrong system program", mutate(4, "ComputeBudget111111111111111111111111111111"), ["SETUP_NOT_FOR_THE_TRADE"]],
    ["wrong token program", mutate(5, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), ["SETUP_NOT_FOR_THE_TRADE"]],
    ["non-idempotent create", { ...setup, dataHex: "00" }, ["UNSUPPORTED_ASSOCIATED_TOKEN_INSTRUCTION"]],
    ["payer not a signer", { ...setup, accounts: setup.accounts.map((a, i) => (i === 0 ? { ...a, isSigner: false } : a)) }, ["SETUP_PAYER_NOT_SIGNER"]],
  ];
  for (const [label, mutated, expected] of cases) {
    const result = await check([guard, price, mutated, swap], build);
    assert.deepEqual(result.failures, expected, label);
  }
});

test("attacker B: redirecting the trade's own accounts is caught only by ATA derivation", async () => {
  const build = supported[0] as Build;
  const other = builds.find((b) => b.symbol !== build.symbol) as Build;
  const [price, setup, swap] = build.jupiterInstructions as [InstructionLike, InstructionLike, InstructionLike];
  const foreign = other.swapInstruction.accounts[2]?.pubkey as string;
  const redirect = (index: number): InstructionLike => ({
    ...swap,
    accounts: swap.accounts.map((a, i) => (i === index ? { ...a, pubkey: foreign } : a)),
  });

  // Attacker B writes the plan too, so the declared expectation matches the
  // mutated instruction and every comparison against the plan passes. The
  // setup instruction is dropped because it would no longer match either.
  const destination = redirect(2);
  const declared: ProtectedTrade = { ...tradeOf(build), userDestinationTokenAccount: foreign };
  const result = await checkTransactionGrammar([guard, price, destination], EQUITY_GUARD_DEVNET_PROGRAM_ID, declared);
  assert.deepEqual(result.failures, ["DESTINATION_NOT_CANONICAL_ATA"]);

  const source = redirect(1);
  const sourceResult = await checkTransactionGrammar([guard, price, setup, source], EQUITY_GUARD_DEVNET_PROGRAM_ID, tradeOf(build));
  assert.deepEqual(sourceResult.failures, ["SOURCE_NOT_CANONICAL_ATA"]);
});

test("the suffix commitment is order-, flag- and count-sensitive, and distinct from kind 1", () => {
  const build = supported[0] as Build;
  const suffix = build.jupiterInstructions;
  const digest = (s: readonly InstructionLike[]) => createHash("sha256").update(suffixCommitmentPreimage(s)).digest("hex");
  const base = digest(suffix);
  assert.notEqual(base, digest([...suffix].reverse()));
  assert.notEqual(base, digest(suffix.slice(0, -1)));
  assert.notEqual(base, digest([...suffix, SYSTEM_TRANSFER]));
  const flagged = suffix.map((i, n) => (n === 0 ? i : { ...i, accounts: i.accounts.map((a) => ({ ...a, isWritable: !a.isWritable })) }));
  assert.notEqual(base, digest(flagged));
  assert.ok(suffixCommitmentPreimage(suffix).subarray(0, 28).toString("ascii") === "EQUITYGUARD_JUPITER_SUFFIX_V1".slice(0, 28));
  assert.ok(!suffixCommitmentPreimage(suffix).toString("ascii").startsWith("EQUITYGUARD_DOWNSTREAM_V2"));
});
