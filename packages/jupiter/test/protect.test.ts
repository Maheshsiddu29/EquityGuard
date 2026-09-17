/**
 * `protectJupiterSwap` over REAL recorded mainnet Jupiter builds and REAL
 * mainnet Token-2022 mint accounts, with a scripted read-only RPC.
 *
 * The central property under test is that a protected asset never degrades to
 * an unprotected path: every refusal is typed, and no refusal carries a
 * transaction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { address } from "@solana/kit";
import { DownstreamAdapterKind, USDC_MINT_ADDRESS, decodeProtectedState } from "@equityguard/guard-client";

import { MAX_TRANSACTION_BYTES } from "../src/index.ts";
import {
  DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS,
  explainEquityGuardError,
  protectJupiterSwap,
  supportsJupiterSwap,
  verifyProtectedSwap,
  type ProtectJupiterSwapResult,
  type ProtectedSwap,
} from "../src/protect.ts";
import {
  KOX_ACTIVATION_TIMESTAMP,
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  UNHX_ACTIVATION_TIMESTAMP,
  UNHX_MINT,
  distinctAddress,
  fakeRpc,
  legacyMint,
  mainnetMint,
  mutatedMint,
  plainToken2022Mint,
  recordedBuild,
  recordedKoxBuyBuild,
  token2022Account,
  withSwapAccount,
  withSwapData,
  type FakeAccount,
} from "./protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const ROUTE_V2_SLIPPAGE_OFFSET = 24;

function protect(
  build: Parameters<typeof protectJupiterSwap>[0]["build"],
  accounts: Readonly<Record<string, FakeAccount>>,
  overrides: Partial<Parameters<typeof protectJupiterSwap>[0]> & { readonly unixTimestamp?: bigint; readonly withoutClock?: boolean } = {},
): Promise<ProtectJupiterSwapResult> {
  const { rpc } = fakeRpc({
    accounts,
    unixTimestamp: overrides.unixTimestamp ?? SETTLED_TIMESTAMP,
    ...(overrides.withoutClock === undefined ? {} : { withoutClock: overrides.withoutClock }),
  });
  const { unixTimestamp: _t, withoutClock: _c, ...rest } = overrides;
  return protectJupiterSwap({ build, userPublicKey: TAKER, rpc, protectionWindow: WINDOW, ...rest });
}

const koxAccounts = { [KOX_MINT]: token2022Account(mainnetMint("KOx")) };

function assertProtected(result: ProtectJupiterSwapResult): ProtectedSwap {
  assert.equal(result.status, "PROTECTED", `expected PROTECTED, got ${result.status}: ${"message" in result ? result.message : ""}`);
  return result as ProtectedSwap;
}

/** No refusal may ever hand back something a wallet could sign. */
function assertNoTransaction(result: ProtectJupiterSwapResult): void {
  assert.notEqual(result.status, "PROTECTED");
  assert.ok(!("transaction" in result), "a refusal must not carry a transaction");
  assert.ok(!("transactionBase64" in result));
  assert.ok(!("instructions" in result));
}

// ------------------------------------------------------------------ A: BUY

test("A: a supported protected BUY returns an unsigned guarded transaction", async () => {
  const build = recordedKoxBuyBuild();
  const result = assertProtected(await protect(build, koxAccounts));

  assert.equal(result.protectedMint, KOX_MINT);
  assert.equal(result.direction, "BUY");
  assert.equal(result.adapterKind, DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC);
  assert.equal(result.programAddress, DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS);
  assert.equal(result.instructions[0]?.programAddress, DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS, "the guard executes as instruction 0");
  assert.equal(result.instructions.length, 5);
  assert.equal(result.binding.adapterKind, "JUPITER_ROUTE_V2_BUY_USDC");
  assert.equal(result.binding.counterMint, USDC_MINT_ADDRESS);
  assert.equal(result.binding.protectedMint, KOX_MINT);
  assert.equal(result.binding.inAmountRaw, BigInt(build.inAmount));
  assert.equal(result.binding.minOutRaw, BigInt(build.otherAmountThreshold));
  assert.ok(result.metrics.fitsSizeLimit && result.metrics.serializedTransactionBytes <= MAX_TRANSACTION_BYTES);
  assert.equal(result.metrics.requiredSignatures, 1);

  // The guard is bound to the state the RPC served, read at chain time.
  assert.deepEqual(result.snapshot.state, decodeProtectedState(token2022Account(mainnetMint("KOx")).owner, mainnetMint("KOx")));
  assert.equal(result.snapshot.clock.unixTimestamp, SETTLED_TIMESTAMP);

  // The bytes are unsigned and self-consistent.
  assert.deepEqual(Uint8Array.from(Buffer.from(result.transactionBase64, "base64")), result.transaction);
  assert.deepEqual(result.transaction.subarray(1, 65), new Uint8Array(64), "the signature slot is left empty");
  assert.equal(await verifyProtectedSwap(result), null);
  assert.match(explainEquityGuardError(result), /protecting this buy/);
});

test("A: the same build composes for a caller-chosen program, limit and commitment", async () => {
  const program = distinctAddress(7);
  const result = assertProtected(
    await protect(recordedKoxBuyBuild(), koxAccounts, { programAddress: program, computeUnitLimit: 300_000, commitment: "finalized" }),
  );
  assert.equal(result.programAddress, program);
  assert.equal(result.instructions[0]?.programAddress, program);
  assert.equal(new DataView(Uint8Array.from(result.instructions[2]?.data ?? []).buffer).getUint32(1, true), 300_000);
});

// ----------------------------------------------------------------- B: SELL

test("B: a supported protected SELL returns an unsigned guarded transaction", async () => {
  const result = assertProtected(await protect(recordedBuild("KOx", "SELL"), koxAccounts));
  assert.equal(result.direction, "SELL");
  assert.equal(result.adapterKind, DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC);
  assert.equal(result.binding.adapterKind, "JUPITER_ROUTE_V2_SELL_USDC");
  assert.equal(result.binding.protectedMintRole, "SOURCE");
  assert.equal(result.binding.sourceMint, KOX_MINT);
  assert.equal(result.binding.destinationMint, USDC_MINT_ADDRESS);
  assert.equal(await verifyProtectedSwap(result), null);
});

test("B: UNHx BUY and SELL both compose against their own mainnet state", async () => {
  const accounts = { [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) };
  for (const direction of ["BUY", "SELL"] as const) {
    const result = assertProtected(await protect(recordedBuild("UNHx", direction), accounts));
    assert.equal(result.protectedMint, UNHX_MINT);
    assert.equal(result.direction, direction);
    assert.equal(result.snapshot.state.newMultiplierEffectiveTimestamp, UNHX_ACTIVATION_TIMESTAMP);
  }
});

// -------------------------------------------------------- C: not applicable

test("C: an ordinary token pair is NOT_APPLICABLE and reads no protected state", async () => {
  const a = distinctAddress(31);
  const b = distinctAddress(32);
  const build = { ...recordedKoxBuyBuild(), inputMint: a, outputMint: b };
  const result = await protect(build, { [a]: legacyMint(), [b]: legacyMint(9) });

  assert.equal(result.status, "NOT_APPLICABLE");
  assert.equal(result.status === "NOT_APPLICABLE" && result.reason, "NO_TOKEN_2022_MINT");
  assertNoTransaction(result);
  assert.match(explainEquityGuardError(result), /Continue with your existing Jupiter flow/);
});

test("C: a Token-2022 mint with no ScaledUiAmount state is NOT_APPLICABLE", async () => {
  const other = distinctAddress(33);
  const build = { ...recordedKoxBuyBuild(), outputMint: other };
  const result = await protect(build, { [other]: plainToken2022Mint() });
  assert.equal(result.status, "NOT_APPLICABLE");
  assert.equal(result.status === "NOT_APPLICABLE" && result.reason, "NO_PROTECTED_STATE");
  assertNoTransaction(result);
});

test("C: supportsJupiterSwap answers the same question without building", async () => {
  const { rpc, reads } = fakeRpc({ accounts: koxAccounts, unixTimestamp: SETTLED_TIMESTAMP });
  const support = await supportsJupiterSwap({ build: recordedKoxBuyBuild(), rpc });
  assert.deepEqual(support, { supported: true, protectedMint: KOX_MINT, direction: "BUY", adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC });
  assert.deepEqual(reads, [[KOX_MINT]], "only the non-USDC side is read, and the Clock is not");

  const plain = distinctAddress(34);
  const unprotected = await supportsJupiterSwap({
    build: { ...recordedKoxBuyBuild(), outputMint: plain },
    rpc: fakeRpc({ accounts: { [plain]: legacyMint() }, unixTimestamp: SETTLED_TIMESTAMP }).rpc,
  });
  assert.equal(unprotected.supported, false);
  assert.equal(unprotected.supported === false && unprotected.status, "NOT_APPLICABLE");
});

// ------------------------------------------- D: protected, unsupported shape

test("D: a protected asset on an unsupported route shape fails closed", async () => {
  const base = recordedBuild("UNHx", "BUY");
  const accounts = { [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) };
  const transfer = { programId: "11111111111111111111111111111111", accounts: [], data: "AgAAAA==" };
  const cases: [string, Parameters<typeof protectJupiterSwap>[0]["build"], RegExp][] = [
    ["cleanup (wSOL-intermediate)", { ...base, cleanupInstruction: transfer }, /cleanupInstruction/],
    ["tip", { ...base, tipInstruction: transfer }, /tipInstruction/],
    ["other instructions", { ...base, otherInstructions: [transfer] }, /otherInstructions/],
    ["ExactOut", { ...base, swapMode: "ExactOut" }, /swapMode/],
    ["two setups", { ...base, setupInstructions: [...base.setupInstructions, ...base.setupInstructions] }, /setup instructions/],
    ["another entrypoint", withSwapData(base, (d) => Buffer.from("d19853937cfed8e9", "hex").copy(d, 0)), /route_v2/],
    ["a foreign swap program", { ...base, swapInstruction: { ...base.swapInstruction, programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" } }, /Jupiter v6/],
  ];

  for (const [label, build, reason] of cases) {
    const result = await protect(build, accounts);
    assert.equal(result.status, "UNSUPPORTED_PROTECTED_ROUTE", label);
    assert.equal(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.code, "UNSUPPORTED_ROUTE_SHAPE", label);
    assert.equal(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.protectedMint, UNHX_MINT, label);
    assert.ok(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.details.some((d) => reason.test(d)), `${label}: ${JSON.stringify("details" in result ? result.details : [])}`);
    assertNoTransaction(result);
    assert.match(explainEquityGuardError(result), /must not be sent in its place/);
  }
});

test("D: the recorded CRMx BUY, which Jupiter builds with a cleanup, is refused with every reason", async () => {
  const crmx = address("XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN");
  const result = await protect(recordedBuild("CRMx", "BUY"), { [crmx]: token2022Account(mainnetMint("CRMx")) });
  assert.equal(result.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.deepEqual(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.details, [
    "cleanupInstruction is unsupported",
    "2 setup instructions; at most one is supported",
  ]);
  assertNoTransaction(result);
});

test("D: a protected asset traded against a non-USDC counter asset fails closed", async () => {
  const usdt = address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
  const build = { ...recordedKoxBuyBuild(), inputMint: usdt };
  const result = await protect(build, { ...koxAccounts, [usdt]: legacyMint() });
  assert.equal(result.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.code, "UNSUPPORTED_COUNTER_ASSET");
  assertNoTransaction(result);
});

test("D: an equity-for-equity route fails closed rather than protecting one leg", async () => {
  const build = { ...recordedKoxBuyBuild(), inputMint: UNHX_MINT };
  const result = await protect(build, { ...koxAccounts, [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) });
  assert.equal(result.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.code, "UNSUPPORTED_COUNTER_ASSET");
  assertNoTransaction(result);
});

// ------------------------------------------------------ E: economic state

test("E: state that moved since the quote is refused, not silently rebound", async () => {
  const quoted = decodeProtectedState(TOKEN_2022_OWNER, mainnetMint("KOx"));
  const stale = { ...quoted, multiplier: Uint8Array.from(Buffer.from("9e0dd41d115ef03f", "hex")) };

  const result = await protect(recordedKoxBuyBuild(), koxAccounts, { expectedState: stale });
  assert.equal(result.status, "ERROR");
  assert.equal(result.status === "ERROR" && result.code, "ECONOMIC_STATE_CHANGED");
  assert.equal(result.status === "ERROR" && result.guardError, "MultiplierChanged");
  assertNoTransaction(result);
  assert.match(explainEquityGuardError(result), /exactly the event EquityGuard exists to catch/);

  // The unchanged state still composes.
  assert.equal((await protect(recordedKoxBuyBuild(), koxAccounts, { expectedState: quoted })).status, "PROTECTED");
});

test("E: rebuilding after the mint changes binds the new state, never the old one", async () => {
  const before = assertProtected(await protect(recordedKoxBuyBuild(), koxAccounts));
  const changed = mutatedMint("KOx", (data) => {
    // A new multiplier activated at a new timestamp: an immediate corporate-action update.
    Buffer.from("73833748164bf03f", "hex").copy(data, 275 + 4 + 32);
  });
  const after = assertProtected(await protect(recordedKoxBuyBuild(), { [KOX_MINT]: token2022Account(changed) }));

  assert.notDeepEqual(after.snapshot.state.multiplier, before.snapshot.state.multiplier);
  assert.notDeepEqual(Uint8Array.from(after.instructions[0]?.data ?? []), Uint8Array.from(before.instructions[0]?.data ?? []));
  assert.notDeepEqual(after.transaction, before.transaction);
});

test("E: a swap inside the protection window is refused before it can be signed", async () => {
  for (const unixTimestamp of [KOX_ACTIVATION_TIMESTAMP - 900n, KOX_ACTIVATION_TIMESTAMP, KOX_ACTIVATION_TIMESTAMP + 300n]) {
    const result = await protect(recordedKoxBuyBuild(), koxAccounts, { unixTimestamp });
    assert.equal(result.status, "ERROR", String(unixTimestamp));
    assert.equal(result.status === "ERROR" && result.code, "INSIDE_TRANSITION_WINDOW");
    assert.equal(result.status === "ERROR" && result.guardError, "InsideTransitionWindow");
    assertNoTransaction(result);
  }
  // One second outside the window on either side composes again.
  for (const unixTimestamp of [KOX_ACTIVATION_TIMESTAMP - 901n, KOX_ACTIVATION_TIMESTAMP + 301n]) {
    assert.equal((await protect(recordedKoxBuyBuild(), koxAccounts, { unixTimestamp })).status, "PROTECTED", String(unixTimestamp));
  }
});

// --------------------------------------------------- F/G: unreadable state

test("F: a malformed Token-2022 mint fails closed, never NOT_APPLICABLE", async () => {
  const cases: [string, Uint8Array][] = [
    ["uninitialized mint", mutatedMint("KOx", (d) => void (d[45] = 0))],
    ["invalid COption tag", mutatedMint("KOx", (d) => void new DataView(d.buffer).setUint32(0, 2, true))],
    ["truncated account", mutatedMint("KOx", (d) => d.slice(0, 200))],
    ["subnormal multiplier", mutatedMint("KOx", (d) => void Buffer.alloc(8).copy(d, 275 + 4 + 32))],
    ["dirty padding", mutatedMint("KOx", (d) => void (d[100] = 1))],
  ];
  for (const [label, data] of cases) {
    const result = await protect(recordedKoxBuyBuild(), { [KOX_MINT]: token2022Account(data) });
    assert.equal(result.status, "ERROR", label);
    assert.equal(result.status === "ERROR" && result.code, "MALFORMED_TOKEN_STATE", label);
    assert.equal(result.status === "ERROR" && result.protectedMint, KOX_MINT, label);
    assertNoTransaction(result);
  }
});

test("G: a duplicate or unknown extension fails closed, as the decoder does", async () => {
  const appendTlv = (type: number, length: number) =>
    mutatedMint("KOx", (data) => {
      const extra = new Uint8Array(data.length + 4 + length);
      extra.set(data);
      new DataView(extra.buffer).setUint16(data.length, type, true);
      new DataView(extra.buffer).setUint16(data.length + 2, length, true);
      return extra;
    });
  for (const [label, data, code] of [
    ["duplicate ScaledUiAmount", appendTlv(25, 56), "MALFORMED_TOKEN_STATE"],
    ["unknown extension", appendTlv(99, 0), "MALFORMED_TOKEN_STATE"],
    ["ScaledUiAmount + InterestBearingConfig", appendTlv(10, 52), "UNSUPPORTED_TOKEN_STATE"],
  ] as const) {
    const result = await protect(recordedKoxBuyBuild(), { [KOX_MINT]: token2022Account(data) });
    assert.equal(result.status, "ERROR", label);
    assert.equal(result.status === "ERROR" && result.code, code, label);
    assertNoTransaction(result);
  }
});

test("F: state that cannot be read at all fails closed", async () => {
  const missingMint = await protect(recordedKoxBuyBuild(), {});
  assert.equal(missingMint.status, "ERROR");
  assert.equal(missingMint.status === "ERROR" && missingMint.code, "MINT_STATE_UNAVAILABLE");

  const missingClock = await protect(recordedKoxBuyBuild(), koxAccounts, { withoutClock: true });
  assert.equal(missingClock.status, "ERROR");
  assert.equal(missingClock.status === "ERROR" && missingClock.code, "MINT_STATE_UNAVAILABLE");
  assertNoTransaction(missingClock);
});

test("an unparseable /build payload is rejected before any state is read", async () => {
  const result = await protect({ notA: "build" }, koxAccounts);
  assert.equal(result.status, "ERROR");
  assert.equal(result.status === "ERROR" && result.code, "INVALID_JUPITER_BUILD");
  assert.equal(result.status === "ERROR" && result.protectedMint, null);
  assertNoTransaction(result);
});

// ------------------------------------------- H: downstream mutation detected

test("H: mutating the trade after protection is detected by the commitment", async () => {
  const result = assertProtected(await protect(recordedKoxBuyBuild(), koxAccounts));
  assert.equal(await verifyProtectedSwap(result), null);

  const routeData = Buffer.from(Uint8Array.from(result.instructions.at(-1)?.data ?? []));
  const wire = Buffer.from(result.transaction);
  const offset = wire.indexOf(routeData);
  assert.ok(offset > 0, "the route_v2 data is carried verbatim in the message");

  const worseSlippage = Uint8Array.from(wire);
  new DataView(worseSlippage.buffer).setUint16(offset + ROUTE_V2_SLIPPAGE_OFFSET, 1_000, true);
  assert.equal(await verifyProtectedSwap(result, worseSlippage), "DownstreamCommitmentMismatch");

  const largerAmount = Uint8Array.from(wire);
  new DataView(largerAmount.buffer).setBigUint64(offset + 8, 999_999_999n, true);
  assert.equal(await verifyProtectedSwap(result, largerAmount), "DownstreamCommitmentMismatch");

  assert.equal(await verifyProtectedSwap(result, Uint8Array.from(wire)), null, "an untouched copy still verifies");
});

// ------------------------------- I: wrong destination, mint or direction

test("I: a trade for another wallet, mint or destination is rejected", async () => {
  const accounts = { ...koxAccounts, [UNHX_MINT]: token2022Account(mainnetMint("UNHx")) };
  const base = recordedKoxBuyBuild();

  const otherWallet = await protect(base, accounts, { userPublicKey: distinctAddress(41) });
  assert.equal(otherWallet.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.ok(otherWallet.status === "UNSUPPORTED_PROTECTED_ROUTE" && otherWallet.details.some((d) => /taker/.test(d)));
  assertNoTransaction(otherWallet);

  // The quote claims UNHx, the encoded route buys KOx.
  const wrongMint = await protect({ ...base, outputMint: UNHX_MINT }, accounts);
  assert.equal(wrongMint.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(wrongMint.status === "UNSUPPORTED_PROTECTED_ROUTE" && wrongMint.guardError, "InvalidJupiterDirection");
  assertNoTransaction(wrongMint);

  // A destination that is not the taker's canonical associated token account.
  const wrongDestination = await protect(withSwapAccount(base, 2, distinctAddress(42)), accounts);
  assert.equal(wrongDestination.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(wrongDestination.status === "UNSUPPORTED_PROTECTED_ROUTE" && wrongDestination.guardError, "InvalidAtaSetup");
  assertNoTransaction(wrongDestination);

  // A destination override, which the adapter refuses outright.
  const override = await protect(withSwapAccount(base, 7, distinctAddress(43)), accounts);
  assert.equal(override.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(override.status === "UNSUPPORTED_PROTECTED_ROUTE" && override.guardError, "DestinationOverrideUnsupported");
  assertNoTransaction(override);
});

test("I: a route carrying a platform fee is refused with the program's own error", async () => {
  const withFee = withSwapData(recordedKoxBuyBuild(), (d) => void d.writeUInt16LE(25, 26));
  const result = await protect(withFee, koxAccounts);
  assert.equal(result.status, "UNSUPPORTED_PROTECTED_ROUTE");
  assert.equal(result.status === "UNSUPPORTED_PROTECTED_ROUTE" && result.guardError, "UnsupportedJupiterFee");
  assertNoTransaction(result);
});

const TOKEN_2022_OWNER = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
