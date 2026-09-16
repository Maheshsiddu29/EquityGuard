/**
 * M9D-A.1 research tooling: the supported transaction grammar for a guarded
 * Jupiter trade.
 *
 * Why this exists. The downstream SHA-256 commitment proves only that the
 * executed instructions are the committed ones. A builder that constructs the
 * malicious transaction AND its commitment together satisfies it perfectly:
 *
 *     guard -> valid route_v2 -> SystemProgram::transfer(user -> attacker)
 *
 * hashes exactly as well as an honest suffix. Identity binding is therefore
 * not semantic validation, and the adapter must additionally enforce that
 * every committed instruction is one it understands and has checked.
 *
 * This module is the host-side model of that grammar, derived from the
 * narrowest shape covering the real KOx and UNHx mainnet builds. Everything
 * not explicitly supported fails closed.
 */

import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { address, type Address } from "@solana/kit";

import { decodeRouteV2, checkSemanticBinding, JUPITER_V6_PROGRAM_ID, type InstructionLike, type ProtectedTrade, type RouteV2, type SemanticFailure } from "./route-v2.ts";

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** `SetComputeUnitLimit(u32)` and `SetComputeUnitPrice(u64)`. */
const SET_COMPUTE_UNIT_LIMIT = { tag: 2, len: 5 } as const;
const SET_COMPUTE_UNIT_PRICE = { tag: 3, len: 9 } as const;
/** `AssociatedTokenAccountInstruction::CreateIdempotent`, one byte, six accounts. */
const CREATE_IDEMPOTENT = { data: "01", accounts: 6 } as const;
const ATA_ACCOUNTS = { payer: 0, ata: 1, owner: 2, mint: 3, system: 4, tokenProgram: 5 } as const;

export type GrammarFailure =
  | "EMPTY_SUFFIX"
  | "GUARD_NOT_AT_INDEX_ZERO"
  | "TRADE_NOT_LAST"
  | "UNSUPPORTED_PROGRAM"
  | "UNSUPPORTED_COMPUTE_BUDGET_INSTRUCTION"
  | "DUPLICATE_COMPUTE_UNIT_PRICE"
  | "DUPLICATE_COMPUTE_UNIT_LIMIT"
  | "UNSUPPORTED_ASSOCIATED_TOKEN_INSTRUCTION"
  | "DUPLICATE_SETUP"
  | "SETUP_NOT_FOR_THE_TRADE"
  | "SETUP_PAYER_NOT_SIGNER"
  | "SECOND_JUPITER_INSTRUCTION"
  | "SOURCE_NOT_CANONICAL_ATA"
  | "DESTINATION_NOT_CANONICAL_ATA"
  | SemanticFailure;

export interface GrammarResult {
  readonly failures: readonly GrammarFailure[];
  /** Present when the last instruction decoded as `route_v2`. */
  readonly route: RouteV2 | null;
}

async function canonicalAta(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const [pda] = await findAssociatedTokenPda({
    owner: address(owner) as Address,
    mint: address(mint) as Address,
    tokenProgram: address(tokenProgram) as Address,
  });
  return String(pda);
}

/**
 * Validates one `CreateIdempotent` against the trade it is meant to prepare.
 *
 * Every account is pinned to a `route_v2` account or a fixed program id, so a
 * setup instruction can only ever create the destination token account of this
 * trade, owned by this trade's authority. The payer is required to be a signer
 * but not to be the authority: a third party funding the user's own ATA is
 * harmless, and forbidding it would break relayer-paid flows for nothing.
 */
function checkSetup(instruction: InstructionLike, route: RouteV2): GrammarFailure[] {
  const failures: GrammarFailure[] = [];
  if (instruction.dataHex !== CREATE_IDEMPOTENT.data || instruction.accounts.length !== CREATE_IDEMPOTENT.accounts) {
    return ["UNSUPPORTED_ASSOCIATED_TOKEN_INSTRUCTION"];
  }
  const account = (index: number): { pubkey: string; isSigner: boolean } => instruction.accounts[index] as { pubkey: string; isSigner: boolean };
  if (!account(ATA_ACCOUNTS.payer).isSigner) failures.push("SETUP_PAYER_NOT_SIGNER");
  const matches =
    account(ATA_ACCOUNTS.ata).pubkey === route.userDestinationTokenAccount &&
    account(ATA_ACCOUNTS.owner).pubkey === route.userTransferAuthority &&
    account(ATA_ACCOUNTS.mint).pubkey === route.destinationMint &&
    account(ATA_ACCOUNTS.system).pubkey === SYSTEM_PROGRAM_ID &&
    account(ATA_ACCOUNTS.tokenProgram).pubkey === route.destinationTokenProgram;
  if (!matches) failures.push("SETUP_NOT_FOR_THE_TRADE");
  return failures;
}

/**
 * Checks the whole guarded transaction.
 *
 * `instructions` is the full top-level sequence, guard included, so the
 * guard's position is part of what is checked. The suffix is everything after
 * index 0.
 */
export async function checkTransactionGrammar(
  instructions: readonly InstructionLike[],
  guardProgramId: string,
  expected: ProtectedTrade,
): Promise<GrammarResult> {
  const failures: GrammarFailure[] = [];
  if (instructions[0]?.programId !== guardProgramId) failures.push("GUARD_NOT_AT_INDEX_ZERO");
  const suffix = instructions.slice(1);
  if (suffix.length === 0) return { failures: [...failures, "EMPTY_SUFFIX"], route: null };

  const last = suffix[suffix.length - 1] as InstructionLike;
  if (last.programId !== JUPITER_V6_PROGRAM_ID) {
    // Locate the trade only to report the precise reason.
    failures.push(suffix.some((i) => i.programId === JUPITER_V6_PROGRAM_ID) ? "TRADE_NOT_LAST" : "PROGRAM_NOT_JUPITER");
    return { failures, route: null };
  }
  // Decoding must succeed before anything else can be judged; every other
  // check then runs, so the report never hides a failure behind an earlier one.
  let route: RouteV2;
  try {
    route = decodeRouteV2(last);
  } catch {
    return { failures: [...failures, "UNSUPPORTED_JUPITER_INSTRUCTION"], route: null };
  }
  failures.push(...checkSemanticBinding(last, expected));

  let prices = 0;
  let limits = 0;
  let setups = 0;
  for (const instruction of suffix.slice(0, -1)) {
    switch (instruction.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        const data = Buffer.from(instruction.dataHex, "hex");
        if (data[0] === SET_COMPUTE_UNIT_PRICE.tag && data.length === SET_COMPUTE_UNIT_PRICE.len) {
          prices += 1;
          if (prices > 1) failures.push("DUPLICATE_COMPUTE_UNIT_PRICE");
        } else if (data[0] === SET_COMPUTE_UNIT_LIMIT.tag && data.length === SET_COMPUTE_UNIT_LIMIT.len) {
          limits += 1;
          if (limits > 1) failures.push("DUPLICATE_COMPUTE_UNIT_LIMIT");
        } else {
          failures.push("UNSUPPORTED_COMPUTE_BUDGET_INSTRUCTION");
        }
        break;
      }
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        setups += 1;
        if (setups > 1) failures.push("DUPLICATE_SETUP");
        failures.push(...checkSetup(instruction, route));
        break;
      }
      case JUPITER_V6_PROGRAM_ID:
        failures.push("SECOND_JUPITER_INSTRUCTION");
        break;
      default:
        failures.push("UNSUPPORTED_PROGRAM");
    }
  }

  // The only independent proof that value moves between accounts the signing
  // authority controls: canonical ATA derivation, checked without reading the
  // token accounts. It is what stops a builder that writes the commitment too.
  const [source, destination] = await Promise.all([
    canonicalAta(route.userTransferAuthority, route.sourceMint, route.sourceTokenProgram),
    canonicalAta(route.userTransferAuthority, route.destinationMint, route.destinationTokenProgram),
  ]);
  if (route.userSourceTokenAccount !== source) failures.push("SOURCE_NOT_CANONICAL_ATA");
  if (route.userDestinationTokenAccount !== destination) failures.push("DESTINATION_NOT_CANONICAL_ATA");

  return { failures, route };
}

/** Domain separator for the adapter-kind 2/3 suffix commitment. */
export const SUFFIX_COMMITMENT_DOMAIN = "EQUITYGUARD_JUPITER_SUFFIX_V1";

/**
 * Suffix commitment preimage: a distinct domain, an explicit instruction
 * count, and each instruction length-prefixed exactly as ABI v2 encodes a
 * single one. Kind 1's `EQUITYGUARD_DOWNSTREAM_V2` encoding is untouched, so
 * no digest can be replayed across adapter kinds.
 */
export function suffixCommitmentPreimage(suffix: readonly InstructionLike[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SUFFIX_COMMITMENT_DOMAIN, "ascii")];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(suffix.length);
  parts.push(count);
  for (const instruction of suffix) {
    parts.push(Buffer.from(bs58Decode(instruction.programId)));
    const accounts = Buffer.alloc(4);
    accounts.writeUInt32LE(instruction.accounts.length);
    parts.push(accounts);
    for (const meta of instruction.accounts) {
      parts.push(Buffer.from(bs58Decode(meta.pubkey)), Buffer.from([meta.isSigner ? 1 : 0, meta.isWritable ? 1 : 0]));
    }
    const data = Buffer.from(instruction.dataHex, "hex");
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(data.length);
    parts.push(dataLen, data);
  }
  return Buffer.concat(parts);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 decode; addresses here are already validated elsewhere. */
function bs58Decode(value: string): Uint8Array {
  let n = 0n;
  for (const character of value) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw new Error(`invalid base58 in ${value}`);
    n = n * 58n + BigInt(index);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const body = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const character of value) {
    if (character !== "1") break;
    zeros += 1;
  }
  return Uint8Array.from(Buffer.concat([Buffer.alloc(zeros), body]));
}
