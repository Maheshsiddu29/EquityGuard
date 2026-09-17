/**
 * M9D-C1 LOCAL REPLAY: executes EquityGuard (adapter kind 2) and the real
 * Jupiter v6 route_v2 captured from mainnet, in one transaction, on a local
 * `solana-test-validator` started by start-validator.sh.
 *
 * Local validator only: the RPC is fixed to loopback, and `assertLocalValidator`
 * refuses mainnet-beta, devnet and testnet genesis before anything is signed,
 * airdropped or sent. There is deliberately no flag or environment variable
 * to change either. Signs only with the local-only taker keypair.
 *
 * Scenarios, in order:
 *   SAFE      guard from the cloned mint read under the local Clock -> must swap
 *   STALE     guard from the pre-activation view of the same mint (phase
 *             pending), route unchanged -> must fail at instruction 0
 *   MUTATED   guard over the real suffix, then route_v2 slippage changed
 *             before compiling -> must fail at instruction 0
 *
 * Usage:
 *   node scripts/replay/execute-replay.ts [--dir tmp/m9d-c1]
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
  type Instruction,
  type Signature,
} from "@solana/kit";

import {
  ActivationPhase,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  USDC_MINT_ADDRESS,
  canonicalAta,
  checkGuardedJupiterTransaction,
  equityGuardErrorName,
  expectationFromSnapshot,
  fetchGuardSnapshot,
  type AssertSafeExecutionRequest,
  type JupiterAdapterKind,
} from "../../packages/guard-client/src/index.ts";
import { parseBuildResponse, type BuildResponse } from "../../packages/jupiter/src/build-client.ts";
import { compileAndMeasure, composeGuardedJupiterTrade, resolveWireTransaction } from "../../packages/jupiter/src/compose.ts";
import { toJson } from "../devnet/evidence.ts";

const LOCAL_VALIDATOR_RPC_URL = "http://127.0.0.1:8899";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
const EQUITY_GUARD = address(EQUITY_GUARD_DEVNET_PROGRAM_ID);
const EXPECTED_GUARD_SHA256 = "d7d59ccd9e96bb3eb3e16893aca638d8e5fdbfaf5032b4b39737ef16a41e4e46";
const PROGRAMDATA_HEADER = 45;
const ROUTE_V2_SLIPPAGE_OFFSET = 24;
const MUTATED_SLIPPAGE_BPS = 100;
const AIRDROP_LAMPORTS = 10_000_000_000n;
const POLL_MS = 500;
const POLL_LIMIT = 60;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] as string);
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Rpc = ReturnType<typeof createSolanaRpc>;

async function programHash(rpc: Rpc, program: Address, length: number) {
  const account = await rpc.getAccountInfo(program, { encoding: "base64" }).send();
  if (!account.value?.executable) throw new Error(`${program} is not an executable account`);
  // UpgradeableLoaderState::Program { programdata_address }
  const programData = address(getBase58Decoder().decode(Buffer.from(account.value.data[0], "base64").subarray(4, 36)));
  const pd = await rpc.getAccountInfo(programData, { encoding: "base64" }).send();
  if (!pd.value) throw new Error(`programdata for ${program} missing`);
  const bytes = Buffer.from(pd.value.data[0], "base64");
  const elf = bytes.subarray(PROGRAMDATA_HEADER, PROGRAMDATA_HEADER + length);
  const tailIsZero = bytes.subarray(PROGRAMDATA_HEADER + length).every((b) => b === 0);
  return { program, programData, owner: account.value.owner, loadedBytes: elf.length, sha256: sha256(elf), tailIsZero };
}

async function tokenBalance(rpc: Rpc, account: Address): Promise<string | null> {
  const info = await rpc.getAccountInfo(account, { encoding: "base64" }).send();
  if (!info.value) return null;
  return Buffer.from(info.value.data[0], "base64").readBigUInt64LE(64).toString();
}

async function sendAndConfirm(rpc: Rpc, wire: string, signature: Signature) {
  await rpc.sendTransaction(wire as never, { encoding: "base64", skipPreflight: true, preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < POLL_LIMIT; i++) {
    const tx = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
    if (tx) {
      const err = tx.meta?.err ?? null;
      const custom =
        err && typeof err === "object" && "InstructionError" in err
          ? (err.InstructionError as unknown as [number, unknown])
          : null;
      const code = custom && typeof custom[1] === "object" && custom[1] !== null && "Custom" in custom[1] ? Number((custom[1] as { Custom: number }).Custom) : null;
      return {
        signature,
        slot: tx.slot,
        succeeded: err === null,
        err,
        failedInstruction: custom ? custom[0] : null,
        customCode: code,
        guardErrorName: code === null ? null : (equityGuardErrorName(code) ?? null),
        computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
        logs: tx.meta?.logMessages ?? [],
        innerInstructionPrograms: (tx.meta?.innerInstructions ?? []).map((group) => ({
          index: group.index,
          programs: group.instructions.map((ix) => {
            const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
            return keys[ix.programIdIndex];
          }),
        })),
      };
    }
    await sleep(POLL_MS);
  }
  throw new Error(`transaction ${signature} not confirmed`);
}

/** Programs that logged "invoke" in a transaction, with their depth. */
const invoked = (logs: readonly string[]) =>
  [...new Set(logs.map((l) => /^Program (\S+) invoke \[(\d+)\]$/.exec(l)).filter((m) => m !== null).map((m) => `${m[1]}@${m[2]}`))];

/** The cluster-identity gate. Must run before any signing, airdrop or submission. */
async function assertLocalValidator(rpc: Rpc): Promise<string> {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis === MAINNET_GENESIS_HASH) throw new Error("refusing to replay against Solana mainnet-beta");
  if (genesis === DEVNET_GENESIS_HASH) throw new Error("refusing to replay against Solana devnet");
  if (genesis === TESTNET_GENESIS_HASH) throw new Error("refusing to replay against Solana testnet");
  return genesis;
}

async function main(): Promise<void> {
  const dir = arg("--dir", "tmp/m9d-c1");
  const rpc = createSolanaRpc(LOCAL_VALIDATOR_RPC_URL);
  const genesis = await assertLocalValidator(rpc);

  const fixture = JSON.parse(await readFile(join(dir, "route-fixture.json"), "utf8")) as {
    observedAt: string;
    accountsReadSlot: string;
    adapterKind: JupiterAdapterKind;
    taker: string;
    outputMint: string;
    computeUnitLimit: number;
    window: { beforeSecs: number; afterSecs: number };
    build: unknown;
    programs: { program: string; elfBytes: number; elfSha256: string }[];
  };
  const mainnetBuild = parseBuildResponse(fixture.build);
  const protectedMint = address(fixture.outputMint);

  const keyPair = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(await readFile(join(dir, "local-taker.json"), "utf8")) as number[]));
  const taker = await getAddressFromPublicKey(keyPair.publicKey);
  if (taker !== fixture.taker) throw new Error(`local keypair ${taker} is not the fixture taker ${fixture.taker}`);

  // Binary identity: the validator must be running exactly the reviewed / captured bytes.
  const guardSo = await readFile("target/deploy/equity_guard.so");
  const binaries = [await programHash(rpc, EQUITY_GUARD, guardSo.length)];
  const guardBinary = binaries[0]!;
  if (guardBinary.sha256 !== EXPECTED_GUARD_SHA256 || !guardBinary.tailIsZero) throw new Error(`EquityGuard on the validator is ${guardBinary.sha256}, not the reviewed candidate`);
  // Every dumped mainnet program, including the BPFLoader2 ones (ATA, Memo) the validator loads upgradeable.
  for (const file of (await readdir(join(dir, "programs"))).filter((f) => f.endsWith(".so"))) {
    const elf = await readFile(join(dir, "programs", file));
    const loaded = await programHash(rpc, address(file.slice(0, -".so".length)), elf.length);
    if (loaded.sha256 !== sha256(elf) || !loaded.tailIsZero) throw new Error(`${loaded.program} on the validator does not match the mainnet dump`);
    const captured = fixture.programs.find((p) => p.program === loaded.program);
    if (captured && captured.elfSha256 !== loaded.sha256) throw new Error(`${loaded.program} does not match the fixture's programdata hash`);
    binaries.push(loaded);
  }
  console.log(`binaries verified: ${binaries.map((b) => `${b.program.slice(0, 6)}=${b.sha256.slice(0, 12)}`).join(" ")}`);

  const balance = await rpc.getBalance(taker).send();
  if (balance.value < AIRDROP_LAMPORTS / 2n) {
    const sig = await rpc.requestAirdrop(taker, lamports(AIRDROP_LAMPORTS)).send();
    for (let i = 0; i < POLL_LIMIT && (await rpc.getBalance(taker).send()).value === balance.value; i++) await sleep(POLL_MS);
    console.log(`airdropped ${AIRDROP_LAMPORTS} lamports (${sig})`);
  }

  const usdcAta = await canonicalAta(taker, USDC_MINT_ADDRESS, LEGACY_TOKEN_PROGRAM_ADDRESS);
  const stockAta = await canonicalAta(taker, protectedMint, address(TOKEN_2022_PROGRAM_ADDRESS));

  const snapshot = await fetchGuardSnapshot(rpc, protectedMint);
  const safeExpectation = expectationFromSnapshot(snapshot, fixture.window);
  console.log(`local Clock slot ${snapshot.clock.slot} ts ${snapshot.clock.unixTimestamp}; mint phase ${snapshot.phase}`);

  const run = async (label: string, expectation: AssertSafeExecutionRequest, mutate?: (suffixRoute: Instruction) => Instruction) => {
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    // Only the lifetime changes: the blockhash is not part of the committed suffix.
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
    let wireBytes = composed.wireBytes;
    let metrics = composed.metrics;
    if (mutate) {
      const instructions = [...composed.trade.instructions];
      instructions[instructions.length - 1] = mutate(instructions[instructions.length - 1]!);
      ({ wireBytes, metrics } = compileAndMeasure(build, taker, instructions));
    }
    const resolved = resolveWireTransaction(wireBytes, build.addressesByLookupTableAddress);
    const clientVerdict = await checkGuardedJupiterTransaction({
      instructions: resolved,
      guardIndex: 0,
      adapterKind: fixture.adapterKind,
      protectedMint,
      commitment: composed.trade.commitment,
    });

    const signed = await signTransaction([keyPair], getTransactionDecoder().decode(wireBytes));
    const signature = getSignatureFromTransaction(signed);
    const before = { usdc: await tokenBalance(rpc, usdcAta), stock: await tokenBalance(rpc, stockAta), lamports: (await rpc.getBalance(taker).send()).value };
    const outcome = await sendAndConfirm(rpc, getBase64EncodedWireTransaction(signed), signature);
    const after = { usdc: await tokenBalance(rpc, usdcAta), stock: await tokenBalance(rpc, stockAta), lamports: (await rpc.getBalance(taker).send()).value };
    console.log(
      `${label}: ${outcome.succeeded ? "SUCCESS" : `FAILED ix ${String(outcome.failedInstruction)} ${outcome.guardErrorName ?? toJson(outcome.err)}`} ` +
        `usdc ${before.usdc}->${after.usdc} stock ${before.stock}->${after.stock} (${metrics.serializedTransactionBytes} B, client verdict ${clientVerdict ?? "accept"})`,
    );
    return {
      label,
      expectation,
      suffixCommitmentHex: Buffer.from(composed.trade.commitment).toString("hex"),
      guardDataHex: Buffer.from(composed.trade.guard.data ?? []).toString("hex"),
      clientVerdictOnWire: clientVerdict,
      metrics,
      programs: resolved.map((i) => i.programAddress),
      invoked: invoked(outcome.logs),
      before,
      after,
      outcome,
    };
  };

  const results = [];
  results.push(await run("SAFE", safeExpectation));
  // A client that read this mint before its activation timestamp saw the same
  // stored bytes with phase pending. That is the stale view.
  results.push(await run("STALE_PRE_ACTIVATION", { ...safeExpectation, expectedPhase: ActivationPhase.Pending }));
  results.push(
    await run("MUTATED_SLIPPAGE", safeExpectation, (route) => {
      const data = Uint8Array.from(route.data ?? []);
      new DataView(data.buffer).setUint16(ROUTE_V2_SLIPPAGE_OFFSET, MUTATED_SLIPPAGE_BPS, true);
      return { ...route, data };
    }),
  );

  const recordedAt = new Date().toISOString();
  const report = {
    description:
      "M9D-C1 LOCAL REPLAY on solana-test-validator. Real mainnet Jupiter v6 / Whirlpool / SPL Token / Token-2022 / ATA / Memo executable bytes and mainnet route accounts; reviewed EquityGuard candidate at its program ID; local-only taker with a fabricated USDC ATA balance. Not mainnet, not devnet, not a real purchase.",
    recordedAt,
    localGenesisHash: genesis,
    routeObservedAt: fixture.observedAt,
    routeAccountsReadSlot: fixture.accountsReadSlot,
    taker,
    usdcAta,
    stockAta,
    localSnapshot: {
      slot: snapshot.clock.slot,
      unixTimestamp: snapshot.clock.unixTimestamp,
      phase: snapshot.phase,
      newMultiplierEffectiveTimestamp: snapshot.state.newMultiplierEffectiveTimestamp,
    },
    binaries,
    results,
  };
  const path = join(dir, `replay-${recordedAt.replaceAll(":", "")}.json`);
  await writeFile(path, `${toJson(report)}\n`, { flag: "wx" });
  console.log(`report written to ${path}`);
}

main().catch((error: unknown) => {
  console.error(`[execute-replay] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
