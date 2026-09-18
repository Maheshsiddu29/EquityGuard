/**
 * One guard invocation as a self-contained binary record, so the same case
 * can be evaluated by every implementation that exists:
 *
 * - the TypeScript mirror (`packages/guard-client/test/guard-mirror.ts`),
 * - the Rust host model (`programs/equity_guard/tests/common/mod.rs`),
 * - the compiled SBF program inside LiteSVM,
 *
 * all through `programs/equity_guard/examples/m11b_differential.rs`, which
 * reads this format. Nothing here decides a verdict; it only carries inputs
 * and the generator's expectation.
 *
 * Record layout (little endian), prefixed by its u32 length:
 *
 *   u32 index | u8 category | u8 expectKind | u8 expectCode
 *   32 mintKey | 32 mintOwner | u16 mintLen | mint
 *   u8 guardLen | guard | i64 clock
 *   u8 instructionCount | instruction* | u16 currentIndex
 *
 *   instruction := 32 program | u8 accountCount
 *                  | (32 pubkey | u8 isSigner | u8 isWritable)* | u16 dataLen | data
 *
 * Instructions carry TRANSACTION-level flags (the Instructions sysvar view).
 * The generator only emits layouts whose raw metas already equal that view
 * (the fee payer is the only signer), so LiteSVM can execute them verbatim.
 */

import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";
import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  EQUITY_GUARD_ERROR_CODES,
  SYSVAR_INSTRUCTIONS_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  type EquityGuardErrorName,
} from "@equityguard/guard-client";

import type { MirrorInstruction, MirrorInvocation } from "../../packages/guard-client/test/guard-mirror.ts";

/** What the generator knows about a case before any implementation runs. */
export const ExpectKind = {
  ALLOW: 0,
  /** Must be rejected with exactly `expectCode`. */
  BLOCK_EXACT: 1,
  /** Must be rejected; the error depends on semantics the generator does not restate. */
  BLOCK_ANY: 2,
  /** Either outcome is legal; only implementation agreement is checked. */
  UNSPECIFIED: 3,
} as const;
export type ExpectKind = (typeof ExpectKind)[keyof typeof ExpectKind];

export interface GuardCase {
  readonly index: number;
  readonly category: number;
  readonly expectKind: ExpectKind;
  /** Program error code when `expectKind` is BLOCK_EXACT, else 255. */
  readonly expectCode: number;
  readonly mintKey: Address;
  readonly mintOwner: Address;
  readonly mintData: Uint8Array;
  readonly guardData: Uint8Array;
  readonly clock: bigint;
  readonly instructions: readonly MirrorInstruction[];
  readonly currentIndex: number;
}

export const PROGRAM_ID = EQUITY_GUARD_DEVNET_PROGRAM_ID;
export const NO_CODE = 255;

/** Result byte: 0 = allowed, otherwise program error code + 1. */
export const resultByte = (verdict: EquityGuardErrorName | null): number => (verdict === null ? 0 : EQUITY_GUARD_ERROR_CODES[verdict] + 1);
export const codeOf = (name: EquityGuardErrorName): number => EQUITY_GUARD_ERROR_CODES[name];
const NAMES = Object.entries(EQUITY_GUARD_ERROR_CODES) as [EquityGuardErrorName, number][];
export const resultName = (byte: number): string => (byte === 0 ? "ok" : (NAMES.find(([, code]) => code === byte - 1)?.[0] ?? `code${byte - 1}`));

/**
 * The fee payer and transfer authority: a fixed ed25519 seed, so the Rust
 * side can sign with the same key (`Keypair::new_from_array([7; 32])`) and
 * the commitment computed here matches the transaction it executes.
 */
export const PAYER_SEED = new Uint8Array(32).fill(7);
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export const PAYER: Address = (() => {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, PAYER_SEED]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return getAddressDecoder().decode(spki.subarray(spki.length - 32));
})();

/** Deterministic, distinct, off-curve-irrelevant addresses for token accounts. */
export function fixedAddress(tag: number): Address {
  const bytes = new Uint8Array(32).fill(tag);
  bytes[0] = 0x4d;
  return getAddressDecoder().decode(bytes);
}
export const SOURCE_ACCOUNT = fixedAddress(0xb1);
export const DESTINATION_ACCOUNT = fixedAddress(0xb2);

/** The six real mainnet mint accounts committed with the program crate (slot 446827429). */
export const FIXTURE_SYMBOLS = ["KOx", "KOon", "UNHx", "UNHon", "CRMx", "CRMon"] as const;
const FIXTURES = new URL("../../programs/equity_guard/tests/fixtures/mainnet/", import.meta.url);
export function fixtureMint(symbol: string): Uint8Array {
  return Uint8Array.from(Buffer.from(readFileSync(new URL(`${symbol}.base64`, FIXTURES), "utf8").trim(), "base64"));
}

// ------------------------------------------------------------- encoding

class Writer {
  private chunks: Uint8Array[] = [];
  private length = 0;
  bytes(value: Uint8Array): this {
    this.chunks.push(value);
    this.length += value.length;
    return this;
  }
  u8(value: number): this {
    return this.bytes(Uint8Array.of(value));
  }
  u16(value: number): this {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    return this.bytes(out);
  }
  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return this.bytes(out);
  }
  i64(value: bigint): this {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, value, true);
    return this.bytes(out);
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const encoder = getAddressEncoder();
const key = (address: string) => Uint8Array.from(encoder.encode(address as Address));

/** The length-prefixed binary record for one case. */
export function encodeCase(c: GuardCase): Uint8Array {
  if (c.mintData.length > 0xffff || c.guardData.length > 0xff || c.instructions.length > 0xff) {
    throw new RangeError(`case ${c.index} does not fit the record format`);
  }
  const body = new Writer()
    .u32(c.index)
    .u8(c.category)
    .u8(c.expectKind)
    .u8(c.expectCode)
    .bytes(key(c.mintKey))
    .bytes(key(c.mintOwner))
    .u16(c.mintData.length)
    .bytes(c.mintData)
    .u8(c.guardData.length)
    .bytes(c.guardData)
    .i64(c.clock)
    .u8(c.instructions.length);
  for (const instruction of c.instructions) {
    body.bytes(key(instruction.programId)).u8(instruction.accounts.length);
    for (const meta of instruction.accounts) body.bytes(key(meta.pubkey)).u8(meta.isSigner ? 1 : 0).u8(meta.isWritable ? 1 : 0);
    body.u16(instruction.data.length).bytes(instruction.data);
  }
  body.u16(c.currentIndex);
  const record = body.finish();
  return new Writer().u32(record.length).bytes(record).finish();
}

/** The TypeScript mirror's view of a case. */
export function mirrorInvocation(c: GuardCase): MirrorInvocation {
  return {
    programId: PROGRAM_ID,
    data: c.guardData,
    accounts: [
      { pubkey: c.mintKey, owner: c.mintOwner, data: c.mintData },
      { pubkey: SYSVAR_INSTRUCTIONS_ADDRESS, owner: "Sysvar1111111111111111111111111111111111111", data: new Uint8Array() },
    ],
    instructions: c.instructions,
    currentInstructionIndex: c.currentIndex,
    clockUnixTimestamp: c.clock,
  };
}

// ------------------------------------------------ the kind 1 downstream

const TRANSFER_CHECKED_TAG = 12;

/** Token-2022 TransferChecked of `mint`, signed by the fee payer, with sysvar-level flags. */
export function transferCheckedOf(mint: Address, amount: bigint, decimals: number): MirrorInstruction {
  const data = new Uint8Array(10);
  const view = new DataView(data.buffer);
  data[0] = TRANSFER_CHECKED_TAG;
  view.setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programId: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [
      { pubkey: SOURCE_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: DESTINATION_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: PAYER, isSigner: true, isWritable: true },
    ],
    data,
  };
}

/** The guard instruction as the sysvar exposes it: `[mint (ro), Instructions sysvar (ro)]`. */
export function guardInstructionOf(mint: Address, data: Uint8Array): MirrorInstruction {
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_ADDRESS, isSigner: false, isWritable: false },
    ],
    data,
  };
}

// ------------------------------------------------ the Rust evaluator

export interface RustEvaluation {
  /** The evaluator's JSON summary (see `m11b_differential.rs`). */
  readonly summary: Record<string, unknown>;
  /** One result byte per case, in input order. */
  readonly results: Uint8Array;
}

/**
 * Streams `cases` through the Rust host model (and, every `litesvmEvery`
 * cases, the compiled program). Requires `cargo build --example
 * m11b_differential` and, for the LiteSVM leg, `cargo build-sbf`.
 */
export async function evaluateWithRust(cases: Iterable<GuardCase>, options: { readonly resultsPath: string; readonly litesvmEvery: number }): Promise<RustEvaluation> {
  const binary = new URL("../../target/debug/examples/m11b_differential", import.meta.url).pathname;
  const child = spawn(binary, ["--results", options.resultsPath, "--litesvm-every", String(options.litesvmEvery)], { stdio: ["pipe", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  const exited = once(child, "exit");
  for (const c of cases) {
    if (!child.stdin.write(encodeCase(c))) await once(child.stdin, "drain");
  }
  child.stdin.end();
  const [code] = await exited;
  if (code !== 0) throw new Error(`m11b_differential exited with ${String(code)}`);
  return { summary: JSON.parse(stdout) as Record<string, unknown>, results: Uint8Array.from(readFileSync(options.resultsPath)) };
}
