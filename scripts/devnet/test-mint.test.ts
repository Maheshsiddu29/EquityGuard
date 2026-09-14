import assert from "node:assert/strict";
import { test } from "node:test";

import { generateKeyPairSigner } from "@solana/kit";
import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "@equityguard/guard-client";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  Token2022Instruction,
  extension,
  getMintSize,
  identifyToken2022Instruction,
} from "@solana-program/token-2022";

import {
  DevnetConfigError,
  PUBLIC_DEVNET_RPC_URL,
  isLoopbackRpcUrl,
  parseKeypairFile,
  readDevnetConfig,
} from "./config.ts";
import { DevnetStateError, TEST_ASSET_DISCLOSURE, parseDevnetState, requireDeployment } from "./devnet-state.ts";
import { parseCustomError } from "./send.ts";
import {
  InvalidTestMintExtensionsError,
  assertValidTestMintExtensions,
  getCreateTestMintInstructions,
  testMintSpace,
  type TestMintSpec,
} from "./test-mint.ts";

const SPEC: TestMintSpec = { label: "EQ-A", decimals: 6, initialMultiplier: 1 };
/** Base mint (82) + padding (83) + account type (1) + TLV header (4) + ScaledUiAmountConfig (56). */
const SCALED_UI_MINT_SIZE = 226;

test("rejects ScaledUiAmount combined with InterestBearingConfig with a clear error", async () => {
  const payer = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const invalid: TestMintSpec = { ...SPEC, extraExtensions: ["InterestBearingConfig"] };

  const expectRejected = (fn: () => unknown) =>
    assert.throws(
      fn,
      (e) =>
        e instanceof InvalidTestMintExtensionsError &&
        e.message.includes("ScaledUiAmount cannot be combined with InterestBearingConfig"),
    );
  expectRejected(() => assertValidTestMintExtensions(invalid));
  expectRejected(() => testMintSpace(invalid, payer.address));
  expectRejected(() => getCreateTestMintInstructions({ spec: invalid, payer, mint, rentLamports: 1n }));
});

test("Token-2022's own client does not prevent the forbidden pair", async () => {
  // Why the explicit check exists: sizing both extensions succeeds client-side,
  // so without it the failure would only surface on-chain.
  const authority = (await generateKeyPairSigner()).address;
  const size = getMintSize([
    extension("ScaledUiAmountConfig", { authority, multiplier: 1, newMultiplierEffectiveTimestamp: 0n, newMultiplier: 1 }),
    extension("InterestBearingConfig", {
      rateAuthority: authority,
      initializationTimestamp: 0n,
      preUpdateAverageRate: 0,
      lastUpdateTimestamp: 0n,
      currentRate: 0,
    }),
  ]);
  assert.ok(size > SCALED_UI_MINT_SIZE);
});

test("rejects non-positive or non-finite initial multipliers", () => {
  for (const initialMultiplier of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => assertValidTestMintExtensions({ ...SPEC, initialMultiplier }), InvalidTestMintExtensionsError);
  }
});

test("builds create, ScaledUiAmount init, then mint init", async () => {
  const payer = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  assert.equal(testMintSpace(SPEC, payer.address), SCALED_UI_MINT_SIZE);

  const instructions = getCreateTestMintInstructions({ spec: SPEC, payer, mint, rentLamports: 42n });
  const [create, initScaledUi, initMint] = instructions;
  assert.equal(instructions.length, 3);
  assert.equal(create?.programAddress, SYSTEM_PROGRAM_ADDRESS);
  assert.equal(initScaledUi?.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
  assert.equal(initMint?.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
  // Extension initialization must precede InitializeMint2 or Token-2022 rejects it.
  const kind = (ix: typeof create) => identifyToken2022Instruction(ix?.data ?? new Uint8Array());
  assert.equal(kind(initScaledUi), Token2022Instruction.InitializeScaledUiAmountMint);
  assert.equal(kind(initMint), Token2022Instruction.InitializeMint2);
  assert.ok(instructions.every((ix) => ix.accounts?.some((meta) => meta.address === mint.address)));
});

test("keypair files are validated", () => {
  const path = "/tmp/wallet.json";
  assert.equal(parseKeypairFile(JSON.stringify(Array(64).fill(7)), path).length, 64);
  for (const contents of ["not json", "[]", JSON.stringify(Array(64).fill(256)), JSON.stringify({})]) {
    assert.throws(() => parseKeypairFile(contents, path), DevnetConfigError);
  }
});

test("config defaults to the public devnet endpoint", () => {
  assert.equal(readDevnetConfig({}).rpcUrl, PUBLIC_DEVNET_RPC_URL);
  assert.equal(readDevnetConfig({ EQUITYGUARD_DEVNET_RPC_URL: "http://x" }).rpcUrl, "http://x");
});

test("only loopback URLs bypass the devnet genesis check", () => {
  assert.ok(isLoopbackRpcUrl("http://127.0.0.1:8899"));
  assert.ok(isLoopbackRpcUrl("http://localhost:8899"));
  assert.ok(!isLoopbackRpcUrl("https://api.mainnet-beta.solana.com"));
  assert.ok(!isLoopbackRpcUrl("http://127.0.0.1.example.com:8899"));
});

test("devnet state requires the test-asset disclosure", () => {
  const asset = {
    label: "EQ-A",
    mint: "11111111111111111111111111111111",
    decimals: 6,
    conceptualStock: "DEMO",
    disclosure: TEST_ASSET_DISCLOSURE,
  };
  assert.equal(parseDevnetState({ cluster: "devnet", deployment: null, assets: [asset] }).assets.length, 1);
  assert.throws(
    () => parseDevnetState({ cluster: "devnet", deployment: null, assets: [{ ...asset, disclosure: "xStocks" }] }),
    DevnetStateError,
  );
  assert.throws(() => parseDevnetState({ cluster: "mainnet-beta", deployment: null, assets: [] }), DevnetStateError);
});

test("parses custom instruction errors from RPC transaction errors", () => {
  assert.deepEqual(parseCustomError({ InstructionError: [0, { Custom: 13 }] }), { instructionIndex: 0, code: 13 });
  assert.deepEqual(parseCustomError({ InstructionError: [1n, { Custom: 9n }] }), { instructionIndex: 1, code: 9 });
  assert.equal(parseCustomError({ InstructionError: [0, "InvalidAccountData"] }), null);
  assert.equal(parseCustomError(null), null);
});

test("devnet tooling refuses a deployment record that diverges from the pinned program ID", () => {
  const deployment = (programId: string) =>
    parseDevnetState({
      cluster: "devnet",
      deployment: { programId, deploySignature: "sig", upgradeAuthority: "11111111111111111111111111111111" },
      assets: [],
    });
  assert.equal(requireDeployment(deployment(EQUITY_GUARD_DEVNET_PROGRAM_ID)).programId, EQUITY_GUARD_DEVNET_PROGRAM_ID);
  assert.throws(() => requireDeployment(deployment("11111111111111111111111111111112")), DevnetStateError);
  assert.throws(() => requireDeployment({ cluster: "devnet", deployment: null, assets: [] }), DevnetStateError);
});
