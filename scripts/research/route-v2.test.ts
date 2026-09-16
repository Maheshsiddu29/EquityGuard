/**
 * Offline checks of the M9D-A `route_v2` model against real mainnet builds
 * recorded read-only on 2026-09-16. No network, nothing signed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  JUPITER_V6_PROGRAM_ID,
  OTHER_V6_DISCRIMINATORS,
  ROUTE_V2_DISCRIMINATOR,
  checkSemanticBinding,
  decodeRouteV2,
  minimumOutFromQuote,
  type InstructionLike,
  type ProtectedTrade,
  type TradeDirection,
} from "./route-v2.ts";

interface Build {
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly taker: string;
  readonly quote: { readonly inAmount: string; readonly outAmount: string; readonly otherAmountThreshold: string; readonly swapMode: string; readonly slippageBps: number };
  readonly routeLegs: readonly { readonly label: string }[];
  readonly swapInstruction: InstructionLike & { readonly accounts: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/route-v2-builds-2026-09-16.json", import.meta.url), "utf8")) as { readonly builds: readonly Build[] };
const builds = fixture.builds;

/** The protected mint is the equity leg: the output when buying, the input when selling. */
function protectedTrade(build: Build, route: ReturnType<typeof decodeRouteV2>): ProtectedTrade {
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

test("every recorded build is the same Jupiter entrypoint", () => {
  assert.ok(builds.length >= 6, "fixture must cover both directions of all routable representations");
  for (const build of builds) {
    assert.equal(build.swapInstruction.programId, JUPITER_V6_PROGRAM_ID, build.symbol);
    assert.equal(build.swapInstruction.dataHex.slice(0, 16), ROUTE_V2_DISCRIMINATOR, build.symbol);
  }
});

test("the fixed prefix decodes to the quoted trade in both directions and both route shapes", () => {
  const shapes = new Set<string>();
  for (const build of builds) {
    const route = decodeRouteV2(build.swapInstruction);
    shapes.add(`${String(build.swapInstruction.accounts.length)}/${String(route.routePlanSteps)}`);
    assert.equal(route.inAmount, BigInt(build.quote.inAmount), `${build.symbol} ${build.direction} in`);
    assert.equal(route.quotedOutAmount, BigInt(build.quote.outAmount), `${build.symbol} ${build.direction} out`);
    assert.equal(route.slippageBps, build.quote.slippageBps, `${build.symbol} ${build.direction} slippage`);
    assert.equal(route.sourceMint, build.inputMint);
    assert.equal(route.destinationMint, build.outputMint);
    assert.equal(route.userTransferAuthority, build.taker);
    assert.equal(route.destinationTokenAccountOverride, null, "no destination override was observed");
    assert.equal(route.routePlanSteps, build.routeLegs.length, `${build.symbol} ${build.direction} legs`);
    assert.equal(route.platformFeeBps, 0);
  }
  assert.ok(shapes.size >= 3, `expected several route shapes, saw ${[...shapes].join(", ")}`);
});

test("Jupiter's reported threshold is reproducible from the two encoded fields", () => {
  for (const build of builds) {
    const route = decodeRouteV2(build.swapInstruction);
    assert.equal(
      minimumOutFromQuote(route.quotedOutAmount, route.slippageBps),
      BigInt(build.quote.otherAmountThreshold),
      `${build.symbol} ${build.direction}`,
    );
  }
});

test("semantic binding accepts the real trade", () => {
  for (const build of builds) {
    const route = decodeRouteV2(build.swapInstruction);
    assert.deepEqual(checkSemanticBinding(build.swapInstruction, protectedTrade(build, route)), [], `${build.symbol} ${build.direction}`);
  }
});

test("semantic binding rejects each substitution independently", () => {
  const build = builds.find((b) => b.direction === "BUY") as Build;
  const route = decodeRouteV2(build.swapInstruction);
  const expected = protectedTrade(build, route);
  const other = builds.find((b) => b.symbol !== build.symbol && b.direction === "BUY") as Build;

  // A flipped direction swaps both roles at once, so it reports both.
  const cases: readonly [string, ProtectedTrade, readonly string[]][] = [
    ["protected mint substituted", { ...expected, protectedMint: other.outputMint }, ["PROTECTED_MINT_NOT_IN_EXPECTED_ROLE"]],
    ["direction flipped", { ...expected, direction: "SELL" }, ["PROTECTED_MINT_NOT_IN_EXPECTED_ROLE", "COUNTER_MINT_MISMATCH"]],
    ["counter mint substituted", { ...expected, counterMint: other.outputMint }, ["COUNTER_MINT_MISMATCH"]],
    ["authority substituted", { ...expected, userAuthority: other.swapInstruction.accounts[1]?.pubkey as string }, ["AUTHORITY_MISMATCH"]],
    ["destination substituted", { ...expected, userDestinationTokenAccount: other.swapInstruction.accounts[2]?.pubkey as string }, ["DESTINATION_MISMATCH"]],
    ["amount substituted", { ...expected, inAmount: expected.inAmount + 1n }, ["IN_AMOUNT_MISMATCH"]],
    ["quoted output substituted", { ...expected, quotedOutAmount: expected.quotedOutAmount + 1n }, ["QUOTED_OUT_MISMATCH"]],
    ["slippage substituted", { ...expected, slippageBps: expected.slippageBps + 1 }, ["SLIPPAGE_MISMATCH"]],
  ];
  for (const [label, mutated, codes] of cases) {
    assert.deepEqual(checkSemanticBinding(build.swapInstruction, mutated), codes, label);
  }
});

test("a different Jupiter entrypoint or program is refused rather than mis-parsed", () => {
  const build = builds[0] as Build;
  const route = decodeRouteV2(build.swapInstruction);
  const expected = protectedTrade(build, route);
  for (const discriminator of Object.keys(OTHER_V6_DISCRIMINATORS)) {
    const swapped: InstructionLike = { ...build.swapInstruction, dataHex: discriminator + build.swapInstruction.dataHex.slice(16) };
    assert.deepEqual(checkSemanticBinding(swapped, expected), ["UNSUPPORTED_JUPITER_INSTRUCTION"], discriminator);
  }
  const foreign: InstructionLike = { ...build.swapInstruction, programId: "11111111111111111111111111111111" };
  assert.deepEqual(checkSemanticBinding(foreign, expected), ["PROGRAM_NOT_JUPITER"]);
});

test("a destination override is treated as a substitution", () => {
  const build = builds[0] as Build;
  const route = decodeRouteV2(build.swapInstruction);
  const accounts = build.swapInstruction.accounts.map((a, i) => (i === 7 ? { ...a, pubkey: build.taker } : a));
  const overridden: InstructionLike = { ...build.swapInstruction, accounts };
  assert.deepEqual(checkSemanticBinding(overridden, protectedTrade(build, route)), ["DESTINATION_OVERRIDDEN"]);
});
