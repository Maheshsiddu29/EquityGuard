/**
 * M9D-A research tooling: read-only decoding of a Jupiter `/build` response.
 *
 * Nothing here signs, submits, or mutates anything. It compiles the same
 * unsigned v0 transaction the composer would, resolves every address lookup
 * table entry, and reports the exact top-level instruction sequence so the
 * Jupiter trade instruction can be identified by inspection rather than by
 * assumption.
 */

import {
  address,
  compileTransaction,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
} from "@solana/kit";

import type { BuildResponse } from "../../packages/jupiter/src/build-client.ts";
import { OTHER_V6_DISCRIMINATORS, ROUTE_V2_DISCRIMINATOR } from "./route-v2.ts";

/** Anchor global instruction discriminators of the Jupiter v6 aggregator. */
export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const INSTRUCTIONS_SYSVAR_ID = "Sysvar1nstructions1111111111111111111111111";

/**
 * Anchor discriminators from the IDL the Jupiter aggregator publishes on
 * mainnet, not from an interface this repository controls. Unknown
 * discriminators are reported as unknown rather than guessed.
 */
const JUPITER_V6_DISCRIMINATORS: Readonly<Record<string, string>> = {
  ...OTHER_V6_DISCRIMINATORS,
  [ROUTE_V2_DISCRIMINATOR]: "route_v2",
};

export interface ResolvedAccount {
  readonly index: number;
  readonly address: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
  /** "static" when carried in the message, otherwise the lookup table it came from. */
  readonly source: string;
}

export interface DecodedInstruction {
  readonly index: number;
  readonly programId: string;
  readonly programSource: string;
  readonly accounts: readonly ResolvedAccount[];
  readonly dataHex: string;
  readonly dataLen: number;
  readonly discriminatorHex: string | null;
  readonly interpretation: string;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Interprets an instruction's data by program, documenting only what is documented. */
export function interpret(programId: string, data: Uint8Array): { discriminatorHex: string | null; interpretation: string } {
  if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
    const tag = data[0];
    if (tag === 2 && data.length === 5) {
      return { discriminatorHex: "02", interpretation: `SetComputeUnitLimit(${new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true)})` };
    }
    if (tag === 3 && data.length === 9) {
      return { discriminatorHex: "03", interpretation: `SetComputeUnitPrice(${new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true)} microLamports)` };
    }
    return { discriminatorHex: tag === undefined ? null : tag.toString(16).padStart(2, "0"), interpretation: "ComputeBudget (other)" };
  }
  if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
    const tag = data.length === 0 ? 0 : data[0];
    const names: Record<number, string> = { 0: "Create", 1: "CreateIdempotent", 2: "RecoverNested" };
    return { discriminatorHex: data.length === 0 ? "" : hex(data.slice(0, 1)), interpretation: `AssociatedToken::${names[tag as number] ?? "unknown"}` };
  }
  if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) {
    const names: Record<number, string> = { 3: "Transfer", 9: "CloseAccount", 12: "TransferChecked", 17: "SyncNative" };
    const tag = data[0];
    return { discriminatorHex: tag === undefined ? null : hex(data.slice(0, 1)), interpretation: `Token::${names[tag as number] ?? `tag ${String(tag)}`}` };
  }
  if (programId === SYSTEM_PROGRAM_ID) {
    return { discriminatorHex: hex(data.slice(0, 4)), interpretation: "System program instruction" };
  }
  if (data.length >= 8) {
    const disc = hex(data.slice(0, 8));
    const known = JUPITER_V6_DISCRIMINATORS[disc];
    return { discriminatorHex: disc, interpretation: known ? `Jupiter ${known}` : "Anchor-style instruction, discriminator not in the recorded table" };
  }
  return { discriminatorHex: null, interpretation: "unrecognised" };
}

export function labelProgram(programId: string): string {
  const known: Record<string, string> = {
    [JUPITER_V6_PROGRAM_ID]: "Jupiter Aggregator v6",
    [COMPUTE_BUDGET_PROGRAM_ID]: "ComputeBudget",
    [ASSOCIATED_TOKEN_PROGRAM_ID]: "AssociatedTokenAccount",
    [TOKEN_PROGRAM_ID]: "Token",
    [TOKEN_2022_PROGRAM_ID]: "Token-2022",
    [SYSTEM_PROGRAM_ID]: "System",
  };
  return known[programId] ?? "unknown program";
}

/**
 * Compiles instructions into a v0 message with Jupiter's lookup tables and
 * decodes it back into fully resolved top-level instructions.
 */
export function compileAndDecode(
  build: BuildResponse,
  feePayer: Address,
  instructions: readonly Instruction[],
): { readonly decoded: readonly DecodedInstruction[]; readonly serializedBytes: number; readonly compiledMessageBytes: number; readonly staticAccounts: readonly string[]; readonly lookupTables: readonly string[] } {
  const lookupTables: AddressesByLookupTableAddress = {};
  for (const [table, addresses] of Object.entries(build.addressesByLookupTableAddress)) {
    lookupTables[address(table)] = addresses.map((a) => address(a));
  }
  const message = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: getBase58Decoder().decode(Uint8Array.from(build.blockhashWithMetadata.blockhash)) as Blockhash,
            lastValidBlockHeight: BigInt(build.blockhashWithMetadata.lastValidBlockHeight),
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
    lookupTables,
  );
  const compiled = compileTransactionMessage(message);
  const statics = compiled.staticAccounts.map(String);
  const lookups = compiled.addressTableLookups ?? [];

  // Runtime ordering: static accounts, then every table's writable entries in
  // table order, then every table's readonly entries.
  const resolved: { address: string; isSigner: boolean; isWritable: boolean; source: string }[] = [];
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = compiled.header;
  statics.forEach((addr, i) => {
    const isSigner = i < numSignerAccounts;
    const isWritable = isSigner
      ? i < numSignerAccounts - numReadonlySignerAccounts
      : i < statics.length - numReadonlyNonSignerAccounts;
    resolved.push({ address: addr, isSigner, isWritable, source: "static" });
  });
  for (const lookup of lookups) {
    const table = String(lookup.lookupTableAddress);
    const addresses = build.addressesByLookupTableAddress[table] ?? [];
    for (const i of lookup.writableIndexes) {
      resolved.push({ address: addresses[i] ?? `<unresolved ${table}#${i}>`, isSigner: false, isWritable: true, source: `ALT ${table}#${i}` });
    }
  }
  for (const lookup of lookups) {
    const table = String(lookup.lookupTableAddress);
    const addresses = build.addressesByLookupTableAddress[table] ?? [];
    for (const i of lookup.readonlyIndexes) {
      resolved.push({ address: addresses[i] ?? `<unresolved ${table}#${i}>`, isSigner: false, isWritable: false, source: `ALT ${table}#${i}` });
    }
  }

  const decoded = compiled.instructions.map((ix, index): DecodedInstruction => {
    const programId = resolved[ix.programAddressIndex]?.address ?? "<unresolved>";
    const data = Uint8Array.from(ix.data ?? []);
    const { discriminatorHex, interpretation } = interpret(programId, data);
    return {
      index,
      programId,
      programSource: resolved[ix.programAddressIndex]?.source ?? "<unresolved>",
      accounts: [...(ix.accountIndices ?? [])].map((accountIndex, position): ResolvedAccount => {
        const account = resolved[accountIndex];
        return {
          index: position,
          address: account?.address ?? `<unresolved ${accountIndex}>`,
          isSigner: account?.isSigner ?? false,
          isWritable: account?.isWritable ?? false,
          source: account?.source ?? "<unresolved>",
        };
      }),
      dataHex: hex(data),
      dataLen: data.length,
      discriminatorHex,
      interpretation: `${labelProgram(programId)}: ${interpretation}`,
    };
  });

  return {
    decoded,
    serializedBytes: getTransactionEncoder().encode(compileTransaction(message)).length,
    compiledMessageBytes: getCompiledTransactionMessageEncoder().encode(compiled).length,
    staticAccounts: statics,
    lookupTables: lookups.map((l) => String(l.lookupTableAddress)),
  };
}

/** Decodes a `/build` API instruction without compiling, keeping Jupiter's own metas. */
export function decodeApiInstruction(index: number, api: { programId: string; accounts: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }): DecodedInstruction {
  const data = Uint8Array.from(getBase64Encoder().encode(api.data));
  const { discriminatorHex, interpretation } = interpret(api.programId, data);
  return {
    index,
    programId: api.programId,
    programSource: "jupiter /build",
    accounts: api.accounts.map((meta, i): ResolvedAccount => ({ index: i, address: meta.pubkey, isSigner: meta.isSigner, isWritable: meta.isWritable, source: "jupiter /build" })),
    dataHex: hex(data),
    dataLen: data.length,
    discriminatorHex,
    interpretation: `${labelProgram(api.programId)}: ${interpretation}`,
  };
}
