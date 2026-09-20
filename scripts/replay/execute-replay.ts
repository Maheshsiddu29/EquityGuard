/**
 * Evidence-linked KOx trade replay on a local solana-test-validator.
 *
 * The stale authorization is derived from the sealed Sep 15 pre-activation
 * KOx observation. The refreshed authorization comes from the adjacent
 * post-activation observation. Both protect the independently captured Sep 17
 * Jupiter/Whirlpool route. The local validator Clock only establishes a post-T
 * execution context; this script never claims historical execution time.
 *
 * Usage:
 *   node scripts/replay/execute-replay.ts [--dir tmp/m9d-c1] [--out path.json]
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  address,
  createKeyPairFromBytes,
  createSolanaRpc,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  signTransaction,
  type Address,
  type Signature,
} from "@solana/kit";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  USDC_MINT_ADDRESS,
  canonicalAta,
  checkGuardedJupiterTransaction,
  equityGuardErrorName,
  fetchGuardSnapshot,
  type AssertSafeExecutionRequest,
  type JupiterAdapterKind,
} from "../../packages/guard-client/src/index.ts";
import { parseBuildResponse, type BuildResponse } from "../../packages/jupiter/src/build-client.ts";
import { composeGuardedJupiterTrade, resolveWireTransaction } from "../../packages/jupiter/src/compose.ts";
import { toJson } from "../devnet/evidence.ts";
import { expectationView, loadKoxTradeEvidence, sha256File } from "../demo/kox-trade-evidence.ts";

const LOCAL_VALIDATOR_RPC_URL = "http://127.0.0.1:8899";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
const EQUITY_GUARD = address(EQUITY_GUARD_DEVNET_PROGRAM_ID);
const EXPECTED_GUARD_SHA256 = "d7d59ccd9e96bb3eb3e16893aca638d8e5fdbfaf5032b4b39737ef16a41e4e46";
const PROGRAMDATA_HEADER = 45;
const AIRDROP_LAMPORTS = 10_000_000_000n;
const POLL_MS = 500;
const POLL_LIMIT = 60;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] as string);
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const delta = (before: string | null, after: string | null) => (BigInt(after ?? "0") - BigInt(before ?? "0")).toString();
const fixedAmount = (raw: string, decimals: number) => {
  const value = raw.padStart(decimals + 1, "0");
  const whole = value.slice(0, -decimals);
  const fraction = value.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
};

type Rpc = ReturnType<typeof createSolanaRpc>;

async function programHash(rpc: Rpc, program: Address, length: number) {
  const account = await rpc.getAccountInfo(program, { encoding: "base64" }).send();
  if (!account.value?.executable) throw new Error(`${program} is not an executable account`);
  const programData = address(getBase58Decoder().decode(Buffer.from(account.value.data[0], "base64").subarray(4, 36)));
  const pd = await rpc.getAccountInfo(programData, { encoding: "base64" }).send();
  if (!pd.value) throw new Error(`programdata for ${program} missing`);
  const bytes = Buffer.from(pd.value.data[0], "base64");
  const elf = bytes.subarray(PROGRAMDATA_HEADER, PROGRAMDATA_HEADER + length);
  return {
    program,
    programData,
    owner: account.value.owner,
    loadedBytes: elf.length,
    sha256: sha256(elf),
    tailIsZero: bytes.subarray(PROGRAMDATA_HEADER + length).every((b) => b === 0),
  };
}

async function tokenBalance(rpc: Rpc, account: Address): Promise<string | null> {
  const info = await rpc.getAccountInfo(account, { encoding: "base64" }).send();
  return info.value ? Buffer.from(info.value.data[0], "base64").readBigUInt64LE(64).toString() : null;
}

async function sendAndConfirm(rpc: Rpc, wire: string, signature: Signature) {
  await rpc.sendTransaction(wire as never, { encoding: "base64", skipPreflight: true, preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < POLL_LIMIT; i++) {
    const tx = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
    if (tx) {
      const err = tx.meta?.err ?? null;
      const custom = err && typeof err === "object" && "InstructionError" in err ? (err.InstructionError as unknown as [number, unknown]) : null;
      const code = custom && typeof custom[1] === "object" && custom[1] !== null && "Custom" in custom[1] ? Number((custom[1] as { Custom: number }).Custom) : null;
      return {
        signature,
        slot: tx.slot,
        succeeded: err === null,
        err,
        failedInstruction: custom ? Number(custom[0]) : null,
        customCode: code,
        guardErrorName: code === null ? null : (equityGuardErrorName(code) ?? null),
        computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
        logs: tx.meta?.logMessages ?? [],
      };
    }
    await sleep(POLL_MS);
  }
  throw new Error(`transaction ${signature} not confirmed`);
}

const invoked = (logs: readonly string[]) =>
  [...new Set(logs.map((line) => /^Program (\S+) invoke \[(\d+)\]$/.exec(line)).filter((match) => match !== null).map((match) => `${match[1]}@${match[2]}`))];

async function assertLocalValidator(rpc: Rpc): Promise<string> {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis === MAINNET_GENESIS_HASH) throw new Error("refusing to replay against Solana mainnet-beta");
  if (genesis === DEVNET_GENESIS_HASH) throw new Error("refusing to replay against Solana devnet");
  if (genesis === TESTNET_GENESIS_HASH) throw new Error("refusing to replay against Solana testnet");
  return genesis;
}

const sameProtectedState = (a: AssertSafeExecutionRequest["expected"], b: AssertSafeExecutionRequest["expected"]) =>
  Buffer.from(a.multiplier).equals(Buffer.from(b.multiplier)) &&
  Buffer.from(a.newMultiplier).equals(Buffer.from(b.newMultiplier)) &&
  a.newMultiplierEffectiveTimestamp === b.newMultiplierEffectiveTimestamp;

async function main(): Promise<void> {
  const dir = arg("--dir", "tmp/m9d-c1");
  const outputPath = arg("--out", "");
  const rpc = createSolanaRpc(LOCAL_VALIDATOR_RPC_URL);
  const genesis = await assertLocalValidator(rpc);
  const market = loadKoxTradeEvidence();

  const fixture = JSON.parse(await readFile(join(dir, "route-fixture.json"), "utf8")) as {
    observedAt: string;
    accountsReadSlot: string;
    adapterKind: JupiterAdapterKind;
    taker: string;
    outputMint: string;
    computeUnitLimit: number;
    build: unknown;
    programs: { program: string; elfBytes: number; elfSha256: string }[];
  };
  const mainnetBuild = parseBuildResponse(fixture.build);
  const protectedMint = address(fixture.outputMint);
  if (protectedMint !== market.asset.mint) throw new Error("Sep 17 route output mint is not the sealed KOx mint");

  const keyPair = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(await readFile(join(dir, "local-taker.json"), "utf8")) as number[]));
  const taker = await getAddressFromPublicKey(keyPair.publicKey);
  if (taker !== fixture.taker) throw new Error(`local keypair ${taker} is not fixture taker ${fixture.taker}`);

  const guardSo = await readFile("target/deploy/equity_guard.so");
  const binaries = [await programHash(rpc, EQUITY_GUARD, guardSo.length)];
  if (binaries[0]?.sha256 !== EXPECTED_GUARD_SHA256 || !binaries[0].tailIsZero) throw new Error("validator EquityGuard is not the reviewed candidate");
  for (const file of (await readdir(join(dir, "programs"))).filter((name) => name.endsWith(".so"))) {
    const elf = await readFile(join(dir, "programs", file));
    const loaded = await programHash(rpc, address(file.slice(0, -3)), elf.length);
    if (loaded.sha256 !== sha256(elf) || !loaded.tailIsZero) throw new Error(`${loaded.program} does not match the captured binary`);
    const captured = fixture.programs.find((program) => program.program === loaded.program);
    if (captured && captured.elfSha256 !== loaded.sha256) throw new Error(`${loaded.program} does not match fixture metadata`);
    binaries.push(loaded);
  }
  console.log(`binaries verified: ${binaries.map((binary) => `${binary.program.slice(0, 6)}=${binary.sha256.slice(0, 12)}`).join(" ")}`);

  const balance = await rpc.getBalance(taker).send();
  if (balance.value < AIRDROP_LAMPORTS / 2n) {
    await rpc.requestAirdrop(taker, lamports(AIRDROP_LAMPORTS)).send();
    for (let i = 0; i < POLL_LIMIT && (await rpc.getBalance(taker).send()).value === balance.value; i++) await sleep(POLL_MS);
  }

  const usdcAta = await canonicalAta(taker, USDC_MINT_ADDRESS, LEGACY_TOKEN_PROGRAM_ADDRESS);
  const stockAta = await canonicalAta(taker, protectedMint, address(TOKEN_2022_PROGRAM_ADDRESS));
  const snapshot = await fetchGuardSnapshot(rpc, protectedMint);
  if (!sameProtectedState(snapshot.state, market.post.expectation.expected)) throw new Error("local route mint does not match sealed KOx protected fields");
  if (snapshot.phase !== market.post.expectation.expectedPhase || snapshot.clock.unixTimestamp <= snapshot.state.newMultiplierEffectiveTimestamp) {
    throw new Error("local validator is not in the required post-activation context");
  }
  console.log(`local Clock slot ${snapshot.clock.slot} ts ${snapshot.clock.unixTimestamp}; mint phase ${snapshot.phase}`);

  const run = async (label: "STALE" | "REFRESHED", expectation: AssertSafeExecutionRequest) => {
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const build: BuildResponse = {
      ...mainnetBuild,
      blockhashWithMetadata: { blockhash: [...getBase58Encoder().encode(latest.blockhash)], lastValidBlockHeight: Number(latest.lastValidBlockHeight) },
    };
    const composed = await composeGuardedJupiterTrade({
      build,
      programAddress: EQUITY_GUARD,
      feePayer: taker,
      taker,
      protectedMint,
      adapterKind: fixture.adapterKind,
      expectation,
      computeUnitLimit: fixture.computeUnitLimit,
    });
    const resolved = resolveWireTransaction(composed.wireBytes, build.addressesByLookupTableAddress);
    const derivedGuardDataHex = Buffer.from(composed.trade.guard.data ?? []).toString("hex");
    const submittedGuardDataHex = Buffer.from(resolved[0]?.data ?? []).toString("hex");
    if (submittedGuardDataHex !== derivedGuardDataHex) throw new Error(`${label} guard data changed before submission`);
    const clientVerdict = await checkGuardedJupiterTransaction({
      instructions: resolved,
      guardIndex: 0,
      adapterKind: fixture.adapterKind,
      protectedMint,
      commitment: composed.trade.commitment,
    });

    const signed = await signTransaction([keyPair], getTransactionDecoder().decode(composed.wireBytes));
    const signature = getSignatureFromTransaction(signed);
    const before = { usdc: await tokenBalance(rpc, usdcAta), kox: await tokenBalance(rpc, stockAta), lamports: (await rpc.getBalance(taker).send()).value };
    const outcome = await sendAndConfirm(rpc, getBase64EncodedWireTransaction(signed), signature);
    const after = { usdc: await tokenBalance(rpc, usdcAta), kox: await tokenBalance(rpc, stockAta), lamports: (await rpc.getBalance(taker).send()).value };
    const deltas = { usdc: delta(before.usdc, after.usdc), kox: delta(before.kox, after.kox) };
    console.log(`${label}: ${outcome.succeeded ? "SUCCESS" : `FAILED ix ${String(outcome.failedInstruction)} ${outcome.guardErrorName ?? toJson(outcome.err)}`} usdc ${before.usdc}->${after.usdc} kox ${before.kox}->${after.kox}`);
    return {
      label,
      authorization: expectationView(expectation),
      suffixCommitmentHex: Buffer.from(composed.trade.commitment).toString("hex"),
      derivedGuardDataHex,
      submittedGuardDataHex,
      guardDataUnchanged: true,
      clientVerdictOnWire: clientVerdict,
      transactionBytes: composed.metrics.serializedTransactionBytes,
      programs: resolved.map((instruction) => instruction.programAddress),
      invoked: invoked(outcome.logs),
      before,
      after,
      deltas,
      outcome,
    };
  };

  const stale = await run("STALE", market.pre.expectation);
  if (stale.outcome.succeeded || stale.outcome.failedInstruction !== 0 || stale.outcome.guardErrorName !== "ActivationPhaseChanged" || stale.invoked.some((program) => program.startsWith("JUP6Lkb")) || stale.deltas.usdc !== "0" || stale.deltas.kox !== "0") {
    throw new Error("stale execution did not produce the required fail-closed proof");
  }
  const refreshed = await run("REFRESHED", market.post.expectation);
  if (!refreshed.outcome.succeeded || !refreshed.invoked.some((program) => program.startsWith("JUP6Lkb")) || !refreshed.invoked.some((program) => program.startsWith("whirLb")) || BigInt(refreshed.deltas.usdc) >= 0n || BigInt(refreshed.deltas.kox) <= 0n) {
    throw new Error("refreshed execution did not produce the required guarded Jupiter proof");
  }
  if (stale.suffixCommitmentHex !== refreshed.suffixCommitmentHex) throw new Error("stale and refreshed executions did not bind the same route commitment");

  const recordedAt = new Date().toISOString();
  const report = {
    kind: "equityguard-kox-trade-replay",
    schemaVersion: 1,
    description: "Authorization derived from recorded Sep 15 KOx mainnet state; protected action from an independent Sep 17 mainnet-derived Jupiter fixture; execution on local solana-test-validator. This is not a mainnet transaction or purchase.",
    recordedAt,
    marketEvidence: {
      asset: market.asset,
      environment: "SOLANA_MAINNET_READ_ONLY_CAPTURE",
      sourceCapture: market.capture,
      preparedObservation: { blockTime: market.pre.source.blockTime, observedAt: market.pre.source.wallclock, slot: String(market.pre.source.slot) },
      scheduledActivation: market.pre.expectation.expected.newMultiplierEffectiveTimestamp.toString(),
      postActivationObservation: { blockTime: market.post.source.blockTime, observedAt: market.post.source.wallclock, slot: String(market.post.source.slot) },
      rawProtectedFields: expectationView(market.pre.expectation),
      accountBytesIdenticalAcrossBoundary: true,
    },
    routeEvidence: {
      environment: "MAINNET_DERIVED_FIXTURE",
      captureTimestamp: fixture.observedAt,
      accountsReadSlot: fixture.accountsReadSlot,
      fixtureSha256: await sha256File(join(dir, "route-fixture.json")),
      inputMint: mainnetBuild.inputMint,
      outputMint: mainnetBuild.outputMint,
      inputAmountRaw: mainnetBuild.inAmount,
      inputAmount: fixedAmount(mainnetBuild.inAmount, 6),
      outputAmountRaw: mainnetBuild.outAmount,
      outputAmount: fixedAmount(mainnetBuild.outAmount, market.asset.decimals),
      minimumOutputRaw: mainnetBuild.otherAmountThreshold,
      venue: mainnetBuild.routePlan.map((step) => step.swapInfo.label).join(" + "),
      pool: mainnetBuild.routePlan.map((step) => step.swapInfo.ammKey).join(" + "),
      commitmentHex: stale.suffixCommitmentHex,
    },
    localExecution: {
      environment: "solana-test-validator",
      executionDidNotOccurOnMainnet: true,
      genesisHash: genesis,
      clock: { slot: snapshot.clock.slot.toString(), unixTimestamp: snapshot.clock.unixTimestamp.toString(), phase: snapshot.phase },
      taker,
      accounts: { usdc: usdcAta, kox: stockAta },
      binaries,
    },
    staleExecution: { authorizationSource: "SEALED_SEP_15_PRE_ACTIVATION_OBSERVATION", ...stale },
    refreshedExecution: { authorizationSource: "SEALED_SEP_15_POST_ACTIVATION_OBSERVATION", ...refreshed },
  };
  const path = outputPath || join(dir, `kox-trade-replay-${recordedAt.replaceAll(":", "")}.json`);
  await writeFile(path, `${toJson(report)}\n`, { flag: "wx" });
  console.log(`report written to ${path}`);
}

main().catch((error: unknown) => {
  console.error(`[execute-replay] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
