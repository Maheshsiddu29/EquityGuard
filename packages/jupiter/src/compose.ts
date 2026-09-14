/**
 * Composes EquityGuard with Jupiter `/build` instructions into one v0
 * transaction and measures it. Build-only: nothing here signs or submits.
 *
 * Binding: the on-chain guard validates the state of the mint it is given; it
 * cannot see which mint the swap trades. This builder is responsible for
 * binding them, and for the supported flow (buy: X -> tokenized equity) it
 * refuses any guard whose mint differs from Jupiter's `outputMint`.
 */

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
} from "@solana/kit";

import type { ApiInstruction, BuildResponse } from "./build-client.ts";

/** Solana's maximum serialized transaction size (PACKET_DATA_SIZE). */
export const MAX_TRANSACTION_BYTES = 1232;
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = address("ComputeBudget111111111111111111111111111111");
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;
/**
 * Jupiter's guidance is to simulate at this maximum and then set 1.2x the
 * measured units. EquityGuard is not deployed on mainnet, so the guarded
 * transaction cannot be simulated there; both variants use the maximum so the
 * size comparison is like for like.
 */
export const UNSIMULATED_COMPUTE_UNIT_LIMIT = 1_400_000;

export class GuardBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardBindingError";
  }
}

export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/** Converts one `/build` instruction into a Kit instruction. */
export function toKitInstruction(api: ApiInstruction): Instruction {
  return {
    programAddress: address(api.programId),
    accounts: api.accounts.map(
      (meta): AccountMeta => ({
        address: address(meta.pubkey),
        role: meta.isSigner
          ? meta.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : meta.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      }),
    ),
    data: Uint8Array.from(getBase64Encoder().encode(api.data)),
  };
}

/** `SetComputeUnitLimit(units)`: discriminator 2 followed by a u32. */
export function getSetComputeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}

function isSetComputeUnitLimit(instruction: Instruction): boolean {
  return (
    instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS &&
    instruction.data?.[0] === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR
  );
}

/** Refuses a guard that is not bound to the asset the swap buys. */
export function assertGuardBoundToOutput(guardMint: Address, build: BuildResponse): void {
  if (guardMint !== build.outputMint) {
    throw new GuardBindingError(
      `guard mint ${guardMint} does not match Jupiter outputMint ${build.outputMint}; ` +
        "the guard would protect a different asset than the one being bought",
    );
  }
  for (const step of build.routePlan) {
    if (step.swapInfo.outputMint === build.outputMint) return;
  }
  throw new GuardBindingError(`no route step delivers outputMint ${build.outputMint}`);
}

export interface GuardComponent {
  readonly mint: Address;
  readonly instruction: Instruction;
}

/**
 * Instruction order:
 * compute budget (Jupiter price + one limit), [guard], setup, swap, cleanup,
 * other, tip. The guard precedes every Jupiter instruction; atomicity reverts
 * setup too if the guard fails, so earlier placement keeps ordering simple.
 */
export function orderInstructions(build: BuildResponse, guard: GuardComponent | null): Instruction[] {
  if (guard) {
    assertGuardBoundToOutput(guard.mint, build);
    if (guard.instruction.accounts?.[0]?.address !== guard.mint) {
      throw new GuardBindingError("guard instruction does not reference the declared guard mint");
    }
  }
  const computeBudget = build.computeBudgetInstructions.map(toKitInstruction);
  const limits = computeBudget.filter(isSetComputeUnitLimit).length;
  if (limits > 1) throw new CompositionError("Jupiter returned more than one compute unit limit instruction");
  if (limits === 0) computeBudget.push(getSetComputeUnitLimitInstruction(UNSIMULATED_COMPUTE_UNIT_LIMIT));

  return [
    ...computeBudget,
    ...(guard ? [guard.instruction] : []),
    ...build.setupInstructions.map(toKitInstruction),
    toKitInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toKitInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toKitInstruction),
    ...(build.tipInstruction ? [toKitInstruction(build.tipInstruction)] : []),
  ];
}

export interface TransactionMetrics {
  readonly instructionCount: number;
  readonly staticAccountCount: number;
  readonly addressLookupTableCount: number;
  readonly lookedUpAddressCount: number;
  readonly compiledMessageBytes: number;
  /** Includes one zeroed 64-byte signature slot per required signer. */
  readonly serializedTransactionBytes: number;
  readonly requiredSignatures: number;
  readonly fitsSizeLimit: boolean;
}

/** Compiles an unsigned v0 transaction using Jupiter's lookup tables and measures it. */
export function compileAndMeasure(
  build: BuildResponse,
  feePayer: Address,
  instructions: readonly Instruction[],
): { readonly wireBytes: Uint8Array; readonly metrics: TransactionMetrics } {
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
  const lookups = compiled.addressTableLookups ?? [];
  const compiledMessageBytes = getCompiledTransactionMessageEncoder().encode(compiled).length;
  const wireBytes = Uint8Array.from(getTransactionEncoder().encode(compileTransaction(message)));
  return {
    wireBytes,
    metrics: {
      instructionCount: compiled.instructions.length,
      staticAccountCount: compiled.staticAccounts.length,
      addressLookupTableCount: lookups.length,
      lookedUpAddressCount: lookups.reduce((n, l) => n + l.readonlyIndexes.length + l.writableIndexes.length, 0),
      compiledMessageBytes,
      serializedTransactionBytes: wireBytes.length,
      requiredSignatures: compiled.header.numSignerAccounts,
      fitsSizeLimit: wireBytes.length <= MAX_TRANSACTION_BYTES,
    },
  };
}

export interface CompositionResult {
  readonly baseline: TransactionMetrics;
  readonly guarded: TransactionMetrics;
  readonly delta: {
    readonly serializedBytes: number;
    readonly staticAccounts: number;
    readonly instructions: number;
    readonly lookedUpAddresses: number;
  };
}

/** Builds the baseline Jupiter transaction and the guarded one, and compares them. */
export function composeWithGuard(build: BuildResponse, feePayer: Address, guard: GuardComponent): CompositionResult {
  const baseline = compileAndMeasure(build, feePayer, orderInstructions(build, null)).metrics;
  const guarded = compileAndMeasure(build, feePayer, orderInstructions(build, guard)).metrics;
  return {
    baseline,
    guarded,
    delta: {
      serializedBytes: guarded.serializedTransactionBytes - baseline.serializedTransactionBytes,
      staticAccounts: guarded.staticAccountCount - baseline.staticAccountCount,
      instructions: guarded.instructionCount - baseline.instructionCount,
      lookedUpAddresses: guarded.lookedUpAddressCount - baseline.lookedUpAddressCount,
    },
  };
}
