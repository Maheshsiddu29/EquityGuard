/**
 * Test support for the integration surface: a scripted `getMultipleAccounts`
 * RPC and the recorded mainnet builds, so `protectJupiterSwap` can be
 * exercised end to end without a network, a wallet or a key.
 *
 * Mint bytes are the REAL mainnet accounts owned by the program crate
 * (`programs/equity_guard/tests/fixtures/mainnet/`). Malformed variants are
 * derived from them by explicit mutation, never invented.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getBase58Decoder, type Address, type GetGenesisHashApi, type GetMultipleAccountsApi, type Rpc } from "@solana/kit";
import { EQUITY_GUARD_DEVNET_PROGRAM_ID, SOLANA_GENESIS_HASH, TOKEN_2022_PROGRAM_ADDRESS } from "@equityguard/guard-client";

import { parseBuildResponse, type ApiInstruction, type BuildResponse } from "../src/index.ts";

export const SYSVAR_CLOCK_ADDRESS = "SysvarC1ock11111111111111111111111111111111";
export const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TAKER = "AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH" as Address;
export const KOX_MINT = "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ" as Address;
export const UNHX_MINT = "XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe" as Address;
/** KOx's scheduled activation, from the recorded mainnet account. */
export const KOX_ACTIVATION_TIMESTAMP = 1_781_481_300n;
export const UNHX_ACTIVATION_TIMESTAMP = 1_789_173_000n;
/** Well past both activations: the guard's window is not in play. */
export const SETTLED_TIMESTAMP = 1_800_000_000n;

const MAINNET_FIXTURES = new URL("../../../programs/equity_guard/tests/fixtures/mainnet/", import.meta.url);
const CLOCK_LEN = 40;
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

export const GUARD_PROGRAM = EQUITY_GUARD_DEVNET_PROGRAM_ID;
export const GENESIS = SOLANA_GENESIS_HASH;
const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export interface FakeAccount {
  readonly owner: string;
  readonly data: Uint8Array;
  readonly executable?: boolean;
}

/** A deployed, executable program account, as a cluster running EquityGuard serves it. */
export function executableProgramAccount(): FakeAccount {
  return { owner: BPF_UPGRADEABLE_LOADER, data: new Uint8Array(36), executable: true };
}

/** An account that exists at a program address but cannot execute. */
export function nonExecutableAccount(): FakeAccount {
  return { owner: "11111111111111111111111111111111", data: new Uint8Array(8), executable: false };
}

/** A real mainnet Token-2022 mint account. */
export function mainnetMint(symbol: string): Uint8Array {
  return Uint8Array.from(Buffer.from(readFileSync(new URL(`${symbol}.base64`, MAINNET_FIXTURES), "utf8").trim(), "base64"));
}

export function token2022Account(data: Uint8Array): FakeAccount {
  return { owner: TOKEN_2022_PROGRAM_ADDRESS, data };
}

/** A copy of a mainnet mint with `edit` applied, for fail-closed cases. */
export function mutatedMint(symbol: string, edit: (data: Uint8Array) => Uint8Array | void): Uint8Array {
  const copy = mainnetMint(symbol).slice();
  return edit(copy) ?? copy;
}

/** A minimal legacy SPL mint: 82 initialized bytes, no extensions. */
export function legacyMint(decimals = 6): FakeAccount {
  return { owner: LEGACY_TOKEN_PROGRAM, data: baseMintBytes(decimals) };
}

/** A Token-2022 mint with no extensions at all: nothing for EquityGuard to protect. */
export function plainToken2022Mint(decimals = 6): FakeAccount {
  return token2022Account(baseMintBytes(decimals));
}

function baseMintBytes(decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setUint32(0, 1, true); // mint authority: Some
  data[44] = decimals;
  data[45] = 1; // is_initialized
  return data;
}

/** Deterministic distinct address derived from a seed byte. */
export function distinctAddress(seed: number): Address {
  const bytes = new Uint8Array(32).fill(seed);
  bytes[0] = 2;
  return getBase58Decoder().decode(bytes) as Address;
}

function clockAccount(slot: bigint, unixTimestamp: bigint): FakeAccount {
  const data = new Uint8Array(CLOCK_LEN);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, slot, true);
  view.setBigInt64(CLOCK_UNIX_TIMESTAMP_OFFSET, unixTimestamp, true);
  return { owner: "Sysvar1111111111111111111111111111111111111", data };
}

export interface FakeRpcOptions {
  readonly accounts: Readonly<Record<string, FakeAccount>>;
  readonly unixTimestamp: bigint;
  readonly slot?: bigint;
  /** Omit the Clock account, to exercise the unreadable-state path. */
  readonly withoutClock?: boolean;
  /** Genesis hash this node reports. Defaults to devnet. */
  readonly genesisHash?: string;
  /**
   * The account served at the devnet guard deployment: an executable program
   * by default, `null` for a cluster where nothing is deployed there.
   */
  readonly guardProgram?: FakeAccount | null;
}

export interface FakeRpc {
  readonly rpc: Rpc<GetMultipleAccountsApi & GetGenesisHashApi>;
  /** Address lists passed to `getMultipleAccounts`, in call order. */
  readonly reads: string[][];
  /** How many times the genesis hash was requested. */
  readonly genesisReads: () => number;
}

/**
 * A read-only `getMultipleAccounts` RPC over fixed accounts. Unknown addresses
 * answer `null`, exactly as a real RPC does for a missing account.
 */
export function fakeRpc(options: FakeRpcOptions): FakeRpc {
  const slot = options.slot ?? 100n;
  const reads: string[][] = [];
  let genesisCalls = 0;
  const guardProgram = options.guardProgram === undefined ? executableProgramAccount() : options.guardProgram;
  const accounts: Record<string, FakeAccount> = {
    ...(guardProgram === null ? {} : { [GUARD_PROGRAM]: guardProgram }),
    ...options.accounts,
  };
  const rpc = {
    getGenesisHash() {
      return {
        send: async () => {
          genesisCalls += 1;
          return options.genesisHash ?? GENESIS.devnet;
        },
      };
    },
    getMultipleAccounts(addresses: readonly string[]) {
      reads.push([...addresses]);
      return {
        send: async () => ({
          context: { slot },
          value: addresses.map((key) => {
            const account = key === SYSVAR_CLOCK_ADDRESS && !options.withoutClock ? clockAccount(slot, options.unixTimestamp) : accounts[key];
            if (!account) return null;
            return {
              data: [Buffer.from(account.data).toString("base64"), "base64"],
              executable: account.executable ?? false,
              lamports: 1n,
              owner: account.owner,
              rentEpoch: 0n,
              space: BigInt(account.data.length),
            };
          }),
        }),
      };
    },
  };
  return { rpc: rpc as unknown as Rpc<GetMultipleAccountsApi & GetGenesisHashApi>, reads, genesisReads: () => genesisCalls };
}

// --------------------------------------------------------- recorded builds

interface RecordedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  dataHex: string;
}
interface RecordedBuild {
  symbol: string;
  direction: "BUY" | "SELL";
  inputMint: string;
  outputMint: string;
  quote: { inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode: string; slippageBps: number };
  jupiterInstructions: RecordedInstruction[];
}
interface RecordedTables {
  builds: { symbol: string; direction: string; lookupTables: Record<string, Record<string, string>> }[];
}

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const RECORDED = read<{ builds: RecordedBuild[] }>("../../../scripts/research/fixtures/route-v2-builds-2026-09-16.json").builds;
const TABLES = read<RecordedTables>("./fixtures/route-v2-lookup-tables-2026-09-16.json").builds;

/** The real 2026-09-14 USDC -> KOx `/build` response, in full. */
export function recordedKoxBuyBuild(): BuildResponse {
  return parseBuildResponse(read<{ response: unknown }>("./fixtures/KOx-usdc-build.json").response);
}

/** A distinct, deterministic address for table slots the recording did not use. */
function filler(table: number, index: number): string {
  const bytes = new Uint8Array(32).fill(0xf1);
  bytes[1] = table;
  bytes[2] = index;
  return getBase58Decoder().decode(bytes);
}

/** One of the recorded 2026-09-16 `route_v2` builds, as a `/build` response. */
export function recordedBuild(symbol: string, direction: "BUY" | "SELL"): BuildResponse {
  const b = RECORDED.find((r) => r.symbol === symbol && r.direction === direction);
  const t = TABLES.find((r) => r.symbol === symbol && r.direction === direction);
  assert.ok(b && t, `no recorded ${symbol} ${direction} build`);
  const api = (i: RecordedInstruction): ApiInstruction => ({ programId: i.programId, accounts: i.accounts, data: Buffer.from(i.dataHex, "hex").toString("base64") });
  const swapIndex = b.jupiterInstructions.findIndex((i) => i.programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const [price, ...setups] = b.jupiterInstructions.slice(0, swapIndex);
  const cleanup = b.jupiterInstructions.slice(swapIndex + 1);
  const addressesByLookupTableAddress: Record<string, string[]> = {};
  Object.entries(t.lookupTables).forEach(([table, entries], tableNumber) => {
    const size = Math.max(...Object.keys(entries).map(Number)) + 1;
    addressesByLookupTableAddress[table] = Array.from({ length: size }, (_, i) => entries[String(i)] ?? filler(tableNumber, i));
  });
  return parseBuildResponse({
    inputMint: b.inputMint,
    outputMint: b.outputMint,
    inAmount: b.quote.inAmount,
    outAmount: b.quote.outAmount,
    otherAmountThreshold: b.quote.otherAmountThreshold,
    swapMode: b.quote.swapMode,
    slippageBps: b.quote.slippageBps,
    routePlan: [],
    computeBudgetInstructions: [api(price as RecordedInstruction)],
    setupInstructions: setups.map(api),
    swapInstruction: api(b.jupiterInstructions[swapIndex] as RecordedInstruction),
    cleanupInstruction: cleanup[0] ? api(cleanup[0]) : null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress,
    blockhashWithMetadata: { blockhash: Array.from({ length: 32 }, (_, i) => i + 1), lastValidBlockHeight: 1 },
  });
}

/** Replaces one account of the recorded swap instruction. */
export function withSwapAccount(build: BuildResponse, index: number, pubkey: string): BuildResponse {
  const accounts = build.swapInstruction.accounts.map((meta, i) => (i === index ? { ...meta, pubkey } : meta));
  return { ...build, swapInstruction: { ...build.swapInstruction, accounts } };
}

/** Rewrites the swap instruction's data bytes. */
export function withSwapData(build: BuildResponse, edit: (data: Buffer) => void): BuildResponse {
  const data = Buffer.from(build.swapInstruction.data, "base64");
  edit(data);
  return { ...build, swapInstruction: { ...build.swapInstruction, data: data.toString("base64") } };
}
