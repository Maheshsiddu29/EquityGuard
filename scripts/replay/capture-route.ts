/**
 * M9D-C1 capture: freezes one real mainnet Jupiter `/swap/v2/build` route and
 * every account it touches, so it can be replayed on a local validator.
 *
 * Read-only against mainnet: holds no keypair, signs nothing, submits
 * nothing. The taker is a LOCAL-only public key whose accounts do not exist on
 * mainnet; its token accounts are created on the local validator only.
 *
 * Output (under --out, default tmp/m9d-c1):
 *   route-fixture.json   build response, snapshot, account inventory
 *   accounts/<pubkey>.json   `solana account --output json` shape, one per account
 *   programs/<id>.so     executable bytes of each upgradeable program, with SHA-256
 *
 * Usage:
 *   node --env-file=.env scripts/replay/capture-route.ts --taker <pubkey> [--symbol KOx] [--out tmp/m9d-c1]
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { address, createSolanaRpc, getBase58Decoder, type Address } from "@solana/kit";

import { DownstreamAdapterKind, USDC_MINT_ADDRESS, expectationFromSnapshot, fetchGuardSnapshot } from "../../packages/guard-client/src/index.ts";
import { fetchBuild, readJupiterApiKey } from "../../packages/jupiter/src/build-client.ts";
import { assertSupportedJupiterBuild } from "../../packages/jupiter/src/compose.ts";
import { findRepresentationBySymbol } from "../../packages/representation-state/src/registry.ts";
import { toJson } from "../devnet/evidence.ts";

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** UpgradeableLoaderState::ProgramData header: tag(4) + slot(8) + Option<Pubkey>(33). */
const PROGRAMDATA_HEADER = 45;
const MAX_ACCOUNTS_PER_CALL = 100;
const AMOUNT = 5_000_000n;
const SLIPPAGE_BPS = 50;
const COMPUTE_UNIT_LIMIT = 400_000;
const WINDOW = { beforeSecs: 900, afterSecs: 300 } as const;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? fallback : process.argv[i + 1];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};
const base58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const b64 = (data: readonly [string, string]) => Buffer.from(data[0], "base64");

async function main(): Promise<void> {
  const taker = address(arg("--taker"));
  const symbol = arg("--symbol", "KOx");
  const outDir = arg("--out", "tmp/m9d-c1");
  const apiKey = readJupiterApiKey(process.env);
  const rpcUrl = process.env.EQUITYGUARD_MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("EQUITYGUARD_MAINNET_RPC_URL is required (read-only mainnet reads)");
  const rpc = createSolanaRpc(rpcUrl);
  if ((await rpc.getGenesisHash().send()) !== MAINNET_GENESIS_HASH) throw new Error("RPC is not mainnet-beta");

  const representation = findRepresentationBySymbol(symbol);
  if (!representation) throw new Error(`${symbol} is not in the registry`);
  const mint: Address = representation.mint;
  const adapterKind = DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC;

  const observedAt = new Date().toISOString();
  const build = await fetchBuild({ inputMint: USDC_MINT_ADDRESS, outputMint: mint, amount: AMOUNT, taker, slippageBps: SLIPPAGE_BPS }, { apiKey });
  assertSupportedJupiterBuild(build, { adapterKind, protectedMint: mint, taker, computeUnitLimit: COMPUTE_UNIT_LIMIT });
  const snapshot = await fetchGuardSnapshot(rpc, mint);

  // Every key the transaction can reference: instruction accounts and programs, plus lookup tables.
  const instructions = [...build.computeBudgetInstructions, ...build.setupInstructions, build.swapInstruction];
  const keys = new Set<string>([mint, USDC_MINT_ADDRESS]);
  for (const i of instructions) {
    keys.add(i.programId);
    for (const m of i.accounts) keys.add(m.pubkey);
  }
  for (const table of Object.keys(build.addressesByLookupTableAddress)) keys.add(table);
  const keyList = [...keys];
  if (keyList.length > MAX_ACCOUNTS_PER_CALL) throw new Error(`${keyList.length} accounts exceed one consistent read`);

  const { context, value } = await rpc.getMultipleAccounts(keyList.map((k) => address(k)), { encoding: "base64", commitment: "confirmed" }).send();
  await mkdir(join(outDir, "accounts"), { recursive: true });
  await mkdir(join(outDir, "programs"), { recursive: true });

  const inventory: unknown[] = [];
  const programDataKeys: { program: string; programData: string }[] = [];
  for (const [i, pubkey] of keyList.entries()) {
    const account = value[i];
    if (!account) {
      inventory.push({ pubkey, exists: false });
      continue;
    }
    const data = b64(account.data);
    inventory.push({ pubkey, exists: true, owner: account.owner, executable: account.executable, lamports: account.lamports, dataLen: data.length });
    if (account.executable && account.owner === BPF_UPGRADEABLE_LOADER) {
      // UpgradeableLoaderState::Program { programdata_address }
      programDataKeys.push({ program: pubkey, programData: base58(data.subarray(4, 36)) });
      continue;
    }
    if (account.executable) continue; // native / builtin programs are provided by the validator
    await writeFile(
      join(outDir, "accounts", `${pubkey}.json`),
      toJson({
        pubkey,
        account: {
          lamports: Number(account.lamports),
          data: [account.data[0], "base64"],
          owner: account.owner,
          executable: false,
          rentEpoch: 0,
          space: data.length,
        },
      }),
    );
  }

  const programs: unknown[] = [];
  for (const { program, programData } of programDataKeys) {
    const pd = await rpc.getAccountInfo(address(programData), { encoding: "base64", commitment: "confirmed" }).send();
    if (!pd.value) throw new Error(`programdata ${programData} for ${program} not found`);
    const bytes = b64(pd.value.data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const deploySlot = view.getBigUint64(4, true);
    const authority = bytes[12] === 1 ? base58(bytes.subarray(13, 45)) : null;
    const elf = trimElf(bytes.subarray(PROGRAMDATA_HEADER));
    await writeFile(join(outDir, "programs", `${program}.so`), elf);
    programs.push({ program, programData, deploySlot, upgradeAuthority: authority, elfBytes: elf.length, elfSha256: sha256(elf), programDataReadSlot: pd.context.slot });
  }

  const expectation = expectationFromSnapshot(snapshot, WINDOW);
  const fixture = {
    description:
      "M9D-C1 replay input: a real mainnet Jupiter /swap/v2/build (USDC -> protected xStock, adapter kind 2) and the mainnet accounts it references, read in one getMultipleAccounts call. Read-only; nothing was signed or submitted on mainnet. The taker is a local-only key.",
    observedAt,
    symbol,
    adapterKind,
    taker,
    inputMint: USDC_MINT_ADDRESS,
    outputMint: mint,
    amount: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
    computeUnitLimit: COMPUTE_UNIT_LIMIT,
    window: WINDOW,
    accountsReadSlot: context.slot,
    snapshot: {
      contextSlot: snapshot.contextSlot,
      clock: snapshot.clock,
      phase: snapshot.phase,
      hasScheduledChange: snapshot.hasScheduledChange,
      multiplierHex: Buffer.from(snapshot.state.multiplier).toString("hex"),
      newMultiplierHex: Buffer.from(snapshot.state.newMultiplier).toString("hex"),
      newMultiplierEffectiveTimestamp: snapshot.state.newMultiplierEffectiveTimestamp,
      expectation,
    },
    build,
    inventory,
    programs,
  };
  await writeFile(join(outDir, "route-fixture.json"), `${toJson(fixture)}\n`);
  console.log(
    `captured ${symbol} BUY at slot ${context.slot}: in ${build.inAmount} out ${build.outAmount} min ${build.otherAmountThreshold}, ` +
      `route ${build.routePlan.map((s) => s.swapInfo.label).join(" > ")}, ${keyList.length} keys, ${programs.length} upgradeable programs`,
  );
}

/** Programdata is zero-padded past the ELF; keep the ELF's own extent (section header table end). */
function trimElf(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46) throw new Error("programdata does not hold an ELF");
  const shoff = Number(view.getBigUint64(0x28, true));
  const shentsize = view.getUint16(0x3a, true);
  const shnum = view.getUint16(0x3c, true);
  let end = shoff + shentsize * shnum;
  // Section contents may follow the header table in some linkers.
  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsize;
    const type = view.getUint32(base + 4, true);
    const offset = Number(view.getBigUint64(base + 0x18, true));
    const size = Number(view.getBigUint64(base + 0x20, true));
    if (type !== 8 /* SHT_NOBITS */) end = Math.max(end, offset + size);
  }
  return bytes.subarray(0, end);
}

main().catch((error: unknown) => {
  console.error(`[capture-route] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
