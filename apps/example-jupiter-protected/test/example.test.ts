/**
 * The example application, driven over a recorded mainnet Jupiter build and
 * the real mainnet KOx mint account, with a wallet that records what it is
 * asked to sign and sends nothing.
 *
 * It proves the integration works as written, and — the reason the product
 * exists — that the refusal branch never hands the wallet an unprotected
 * transaction for a protected asset.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { address, getAddressEncoder, type Address } from "@solana/kit";

import {
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  distinctAddress,
  fakeRpc,
  legacyMint,
  mainnetMint,
  recordedKoxBuyBuild,
  token2022Account,
} from "../../../packages/jupiter/test/protect-fixtures.ts";
import { DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS } from "../../../packages/jupiter/src/protect.ts";
import { compileUnsignedTransaction, jupiterInstructions } from "../src/jupiter.ts";
import { ordinarySwap, protectedSwap } from "../src/swap.ts";
import { DryRunWallet } from "../src/wallet.ts";

const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const API_KEY = "test-key-not-a-secret";
const PROTECTION_WINDOW = { beforeSecs: 900, afterSecs: 300 };
const koxAccounts = { [KOX_MINT]: token2022Account(mainnetMint("KOx")) };

/** Answers the example's Jupiter call with a recorded build, offline. */
async function withJupiterAnswering<T>(payload: unknown, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

function request(inputMint: Address, outputMint: Address) {
  return { inputMint, outputMint, amount: 5_000_000n, taker: TAKER, slippageBps: 50 };
}

test("the example sends the guarded transaction for a protected swap", async () => {
  const build = recordedKoxBuyBuild();
  const wallet = new DryRunWallet(TAKER);
  const { rpc } = fakeRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP });

  const outcome = await withJupiterAnswering(build, () =>
    protectedSwap(request(USDC, KOX_MINT), wallet, { apiKey: API_KEY, rpc, protectionWindow: PROTECTION_WINDOW }),
  );

  assert.equal(outcome.action, "SENT_PROTECTED");
  assert.match(outcome.detail, /BUY of XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ/);
  assert.equal(wallet.signed.length, 1);

  // What the wallet was given is the guarded transaction, not Jupiter's own.
  const unprotected = compileUnsignedTransaction(build, TAKER, jupiterInstructions(build));
  const guarded = wallet.signed[0] as Uint8Array;
  assert.notDeepEqual(guarded, unprotected);
  assert.ok(guarded.length > unprotected.length, "the guard instruction adds bytes");
  const guardProgram = Buffer.from(getAddressEncoder().encode(DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS));
  assert.ok(Buffer.from(guarded).includes(guardProgram), "the guard program is an account of the signed transaction");
  assert.ok(!Buffer.from(unprotected).includes(guardProgram), "and is absent from the unprotected one");
});

test("the example refuses, and signs nothing, when a protected route is unsupported", async () => {
  const build = { ...recordedKoxBuyBuild(), cleanupInstruction: { programId: "11111111111111111111111111111111", accounts: [], data: "AgAAAA==" } };
  const wallet = new DryRunWallet(TAKER);
  const { rpc } = fakeRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP });

  const outcome = await withJupiterAnswering(build, () =>
    protectedSwap(request(USDC, KOX_MINT), wallet, { apiKey: API_KEY, rpc, protectionWindow: PROTECTION_WINDOW }),
  );

  assert.equal(outcome.action, "REFUSED");
  assert.equal(outcome.signature, null);
  assert.match(outcome.detail, /UNSUPPORTED_ROUTE_SHAPE/);
  assert.deepEqual(wallet.signed, [], "no transaction reached the wallet");

  // The unprotected transaction the ordinary path would have sent is still
  // buildable — the example simply must not send it.
  const ordinaryWallet = new DryRunWallet(TAKER);
  const ordinary = await withJupiterAnswering(build, () => ordinarySwap(request(USDC, KOX_MINT), ordinaryWallet, API_KEY));
  assert.equal(ordinary.action, "SENT_UNPROTECTED");
  assert.equal(ordinaryWallet.signed.length, 1);
});

test("the example keeps its existing path for an ordinary token pair", async () => {
  const other = distinctAddress(51);
  const build = { ...recordedKoxBuyBuild(), outputMint: other };
  const wallet = new DryRunWallet(TAKER);
  const { rpc } = fakeRpc({ accounts: { [other]: legacyMint() }, unixTimestamp: SETTLED_TIMESTAMP });

  const outcome = await withJupiterAnswering(build, () =>
    protectedSwap(request(USDC, other), wallet, { apiKey: API_KEY, rpc, protectionWindow: PROTECTION_WINDOW }),
  );

  assert.equal(outcome.action, "SENT_UNPROTECTED");
  assert.equal(outcome.detail, "NO_TOKEN_2022_MINT");
  assert.equal(wallet.signed.length, 1);
  assert.deepEqual(wallet.signed[0], compileUnsignedTransaction(build, TAKER, jupiterInstructions(build)));
});

test("the example's EquityGuard-specific surface is small and contains no signing", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/swap.ts", import.meta.url), "utf8");
  const equityGuardLines = source
    .split("\n")
    .filter((line) => /@equityguard\/jupiter\/protect|protectJupiterSwap|guarded\./.test(line) && !line.trim().startsWith("*"));
  assert.ok(equityGuardLines.length <= 12, `the integration should stay small, found ${equityGuardLines.length} lines`);
  assert.ok(!/signTransaction|sendTransaction|secretKey/.test(source), "the example never signs inside the swap flow");
});
