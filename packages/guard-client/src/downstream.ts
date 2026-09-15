/**
 * ABI v2 downstream binding: the commitment to the exact instruction that
 * immediately follows the guard, and the guarded Token-2022 TransferChecked
 * builder. Mirrors `programs/equity_guard/src/downstream.rs`.
 *
 * Commitment: SHA-256 over
 * `"EQUITYGUARD_DOWNSTREAM_V2" || programId(32) || u32le(accountCount) ||
 *  for each account in order: pubkey(32) || isSigner(u8) || isWritable(u8) ||
 *  u32le(dataLength) || data`.
 *
 * The flags are TRANSACTION-level: the program reads the next instruction
 * from the Instructions sysvar, which reports each account's signer/writable
 * flags as compiled into the message (merged across all instructions, with
 * the fee payer a writable signer), not the instruction's own account metas.
 */

import { createHash } from "node:crypto";

import { AccountRole, getAddressEncoder, type Address, type Instruction } from "@solana/kit";

import {
  DownstreamAdapterKind,
  encodeAssertSafeExecutionV2,
  type AssertSafeExecutionRequest,
} from "./abi.ts";
import { GuardClientError } from "./errors.ts";
import { TOKEN_2022_PROGRAM_ADDRESS } from "./mint-state.ts";

export const DOWNSTREAM_COMMITMENT_DOMAIN = "EQUITYGUARD_DOWNSTREAM_V2";
export const SYSVAR_INSTRUCTIONS_ADDRESS = "Sysvar1nstructions1111111111111111111111111" as Address;
/** Token-2022 TransferChecked: tag 12, u64 amount, u8 decimals. */
const TRANSFER_CHECKED_TAG = 12;
const TRANSFER_CHECKED_DATA_LEN = 10;

export interface CommittedAccount {
  readonly address: Address;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface CommittedInstruction {
  readonly programAddress: Address;
  readonly accounts: readonly CommittedAccount[];
  readonly data: Uint8Array;
}

const u32le = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new GuardClientError("InvalidDownstream", "length does not fit u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

/** The canonical commitment encoding (before hashing). */
export function downstreamCommitmentPreimage(instruction: CommittedInstruction): Uint8Array {
  const encoder = getAddressEncoder();
  const parts: Uint8Array[] = [new TextEncoder().encode(DOWNSTREAM_COMMITMENT_DOMAIN), Uint8Array.from(encoder.encode(instruction.programAddress)), u32le(instruction.accounts.length)];
  for (const account of instruction.accounts) {
    parts.push(Uint8Array.from(encoder.encode(account.address)), Uint8Array.of(account.isSigner ? 1 : 0, account.isWritable ? 1 : 0));
  }
  parts.push(u32le(instruction.data.length), instruction.data);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function downstreamCommitment(instruction: CommittedInstruction): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(downstreamCommitmentPreimage(instruction)).digest());
}

const isSigner = (role: AccountRole) => role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;
const isWritable = (role: AccountRole) => role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER;

/**
 * `target` as the Instructions sysvar will expose it inside a transaction
 * made of `instructions` paid by `feePayer`: the same accounts in the same
 * order, with transaction-level (merged) signer and writable flags.
 */
export function asCommittedInstruction(target: Instruction, instructions: readonly Instruction[], feePayer: Address): CommittedInstruction {
  const flags = (address: Address): { isSigner: boolean; isWritable: boolean } => {
    let signer = address === feePayer;
    let writable = address === feePayer;
    for (const instruction of instructions) {
      for (const meta of instruction.accounts ?? []) {
        if (meta.address !== address) continue;
        signer ||= isSigner(meta.role);
        writable ||= isWritable(meta.role);
      }
    }
    return { isSigner: signer, isWritable: writable };
  };
  return {
    programAddress: target.programAddress,
    accounts: (target.accounts ?? []).map((meta) => ({ address: meta.address, ...flags(meta.address) })),
    data: Uint8Array.from(target.data ?? []),
  };
}

/** Client-side mirror of the program's adapter check for Token-2022 TransferChecked of `mint`. */
export function assertSupportedTransferChecked(instruction: Instruction, mint: Address): void {
  if (instruction.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new GuardClientError("InvalidDownstream", `downstream program ${instruction.programAddress} is not Token-2022`);
  }
  const data = instruction.data ?? new Uint8Array();
  if (data.length !== TRANSFER_CHECKED_DATA_LEN || data[0] !== TRANSFER_CHECKED_TAG || (instruction.accounts?.length ?? 0) < 4) {
    throw new GuardClientError("InvalidDownstream", "downstream instruction is not Token-2022 TransferChecked");
  }
  if (instruction.accounts?.[1]?.address !== mint) {
    throw new GuardClientError("InvalidDownstream", "TransferChecked mint is not the protected mint");
  }
}

/** ABI v2 guard instruction: `[mint (read-only), Instructions sysvar (read-only)]`. */
export function getAssertSafeExecutionV2Instruction(input: {
  readonly programAddress: Address;
  readonly mint: Address;
  readonly expectation: AssertSafeExecutionRequest;
  readonly downstreamCommitment: Uint8Array;
}): Instruction {
  return {
    programAddress: input.programAddress,
    accounts: [
      { address: input.mint, role: AccountRole.READONLY },
      { address: SYSVAR_INSTRUCTIONS_ADDRESS, role: AccountRole.READONLY },
    ],
    data: encodeAssertSafeExecutionV2({
      ...input.expectation,
      expectedMint: input.mint,
      adapterKind: DownstreamAdapterKind.TOKEN_2022_TRANSFER_CHECKED,
      downstreamCommitment: input.downstreamCommitment,
    }),
  };
}

export interface GuardedTransferChecked {
  /** `[...before, guard, transferChecked]`: the protected action immediately follows the guard. */
  readonly instructions: readonly Instruction[];
  readonly guard: Instruction;
  readonly transferChecked: Instruction;
  readonly committed: CommittedInstruction;
  readonly commitment: Uint8Array;
}

/**
 * Builds `[...before, guard v2, transferChecked]`. The final TransferChecked
 * is fixed first, its commitment is computed with the flags the whole
 * transaction gives its accounts, and only then is the guard built from it.
 * `before` must not contain anything that has to run after the guard.
 */
export function buildGuardedTransferChecked(input: {
  readonly programAddress: Address;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly expectation: AssertSafeExecutionRequest;
  readonly transferChecked: Instruction;
  readonly before?: readonly Instruction[];
}): GuardedTransferChecked {
  assertSupportedTransferChecked(input.transferChecked, input.mint);
  const before = input.before ?? [];
  // The guard's accounts do not depend on its data, so a placeholder yields the final flags.
  const placeholder = getAssertSafeExecutionV2Instruction({ programAddress: input.programAddress, mint: input.mint, expectation: input.expectation, downstreamCommitment: new Uint8Array(32) });
  const committed = asCommittedInstruction(input.transferChecked, [...before, placeholder, input.transferChecked], input.feePayer);
  const commitment = downstreamCommitment(committed);
  const guard = getAssertSafeExecutionV2Instruction({ programAddress: input.programAddress, mint: input.mint, expectation: input.expectation, downstreamCommitment: commitment });
  return { instructions: [...before, guard, input.transferChecked], guard, transferChecked: input.transferChecked, committed, commitment };
}
