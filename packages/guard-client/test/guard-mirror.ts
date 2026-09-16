/**
 * Test-only mirror of the on-chain guard, at the program's error granularity.
 *
 * It is deliberately NOT product surface: the client's job is to build
 * transactions the program accepts, not to adjudicate them. This mirror
 * exists so the shared conformance corpus can be evaluated on both sides.
 *
 * Wherever the client already implements a rule, the mirror calls that code
 * (`decodeProtectedState`, `checkGuardOffline`, `downstreamCommitment`,
 * `checkGuardedJupiterTransaction`) rather than restating it. Only the ABI v2
 * decoder, the account checks and the ordering live here, mirroring
 * `programs/equity_guard/src/processor.rs`.
 */

import {
  ABI_VERSION_V2,
  ASSERT_SAFE_EXECUTION_V2_LEN,
  ActivationPhase,
  DownstreamAdapterKind,
  GuardClientError,
  SYSVAR_INSTRUCTIONS_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  checkGuardOffline,
  checkGuardedJupiterTransaction,
  isDownstreamAdapterKind,
  isJupiterAdapterKind,
  decodeProtectedState,
  downstreamCommitment,
  isValidStoredMultiplier,
  type AssertSafeExecutionRequest,
  type EquityGuardErrorName,
} from "../src/index.ts";

/** Token-2022 `TransferChecked`: tag 12, u64 amount, u8 decimals. */
const TRANSFER_CHECKED_TAG = 12;
const TRANSFER_CHECKED_DATA_LEN = 10;
const TRANSFER_CHECKED_MINT_INDEX = 1;
const TRANSFER_CHECKED_MIN_ACCOUNTS = 4;

export interface MirrorAccount {
  readonly pubkey: string;
  readonly owner: string;
  readonly data: Uint8Array;
}

export interface MirrorAccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface MirrorInstruction {
  readonly programId: string;
  readonly accounts: readonly MirrorAccountMeta[];
  readonly data: Uint8Array;
}

export interface MirrorInvocation {
  readonly programId: string;
  readonly data: Uint8Array;
  readonly accounts: readonly MirrorAccount[];
  /** Top-level instructions exactly as the Instructions sysvar exposes them. */
  readonly instructions: readonly MirrorInstruction[];
  readonly currentInstructionIndex: number;
  readonly clockUnixTimestamp: bigint;
}

/** The decoded ABI v2 payload. */
export interface DecodedV2 {
  readonly expectedMint: string;
  readonly execution: AssertSafeExecutionRequest;
  readonly adapterKind: number;
  readonly downstreamCommitment: Uint8Array;
}

/** Thrown with the program's own error name. */
export class MirrorRejection extends Error {
  readonly guardError: EquityGuardErrorName;

  constructor(guardError: EquityGuardErrorName) {
    super(guardError);
    this.name = "MirrorRejection";
    this.guardError = guardError;
  }
}

/** A function declaration, so TypeScript narrows on the `never` return. */
function reject(error: EquityGuardErrorName): never {
  throw new MirrorRejection(error);
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const base58 = (bytes: Uint8Array): string => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return "1".repeat(leading) + out;
};

/**
 * Mirrors `AssertSafeExecutionV2::unpack`, in its order: version before
 * length, malformed state before an unknown adapter.
 */
export function decodeAssertSafeExecutionV2(data: Uint8Array): DecodedV2 {
  if (data.length === 0) reject("UnsupportedInstruction");
  if (data[0] !== ABI_VERSION_V2) reject("UnsupportedVersion");
  if (data.length !== ASSERT_SAFE_EXECUTION_V2_LEN) reject("InvalidInstructionLength");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expectedMint = base58(data.slice(1, 33));
  const multiplier = data.slice(33, 41);
  const newMultiplier = data.slice(41, 49);
  const newMultiplierEffectiveTimestamp = view.getBigInt64(49, true);
  const phase = data[57];
  const beforeSecs = view.getUint32(58, true);
  const afterSecs = view.getUint32(62, true);
  const adapterKind = data[66] as number;

  if (!isValidStoredMultiplier(multiplier) || !isValidStoredMultiplier(newMultiplier)) reject("InvalidExpectedState");
  if (phase !== ActivationPhase.Pending && phase !== ActivationPhase.Activated) reject("InvalidExpectedState");
  if (!isDownstreamAdapterKind(adapterKind)) reject("UnsupportedAdapter");

  return {
    expectedMint,
    execution: {
      expected: { multiplier, newMultiplier, newMultiplierEffectiveTimestamp },
      expectedPhase: phase as ActivationPhase,
      window: { beforeSecs, afterSecs },
    },
    adapterKind,
    downstreamCommitment: data.slice(67, 99),
  };
}

/** Mirrors `downstream::verify_downstream`. */
async function verifyDownstream(invocation: MirrorInvocation, request: DecodedV2, mintKey: string): Promise<void> {
  const current = invocation.instructions[invocation.currentInstructionIndex];
  if (!current) reject("GuardNotTopLevel");
  if (current.programId !== invocation.programId || !bytesEqual(current.data, invocation.data)) reject("GuardNotTopLevel");

  const { adapterKind } = request;
  if (isJupiterAdapterKind(adapterKind)) {
    const verdict = await checkGuardedJupiterTransaction({
      instructions: invocation.instructions.map((i) => ({
        programAddress: i.programId as never,
        accounts: i.accounts.map((a) => ({ address: a.pubkey as never, isSigner: a.isSigner, isWritable: a.isWritable })),
        data: i.data,
      })),
      guardIndex: invocation.currentInstructionIndex,
      adapterKind,
      protectedMint: mintKey as never,
      commitment: request.downstreamCommitment,
    });
    if (verdict) reject(verdict);
    return;
  }
  verifyTransferChecked(invocation, request, mintKey);
}

/** Mirrors `downstream::verify_transfer_checked` (adapter kind 1). */
function verifyTransferChecked(invocation: MirrorInvocation, request: DecodedV2, mintKey: string): void {
  const next = invocation.instructions[invocation.currentInstructionIndex + 1];
  if (!next) reject("MissingDownstreamInstruction");

  if (next.programId !== TOKEN_2022_PROGRAM_ADDRESS) reject("UnsupportedDownstreamProgram");
  const isTransferChecked =
    next.data.length === TRANSFER_CHECKED_DATA_LEN &&
    next.data[0] === TRANSFER_CHECKED_TAG &&
    next.accounts.length >= TRANSFER_CHECKED_MIN_ACCOUNTS;
  if (!isTransferChecked) reject("UnsupportedDownstreamInstruction");
  if (next.accounts[TRANSFER_CHECKED_MINT_INDEX]?.pubkey !== mintKey) reject("DownstreamMintMismatch");

  const actual = downstreamCommitment({
    programAddress: next.programId as never,
    accounts: next.accounts.map((a) => ({ address: a.pubkey as never, isSigner: a.isSigner, isWritable: a.isWritable })),
    data: next.data,
  });
  if (!bytesEqual(actual, request.downstreamCommitment)) reject("DownstreamCommitmentMismatch");
}

/**
 * Evaluates one guard invocation. Returns the program error name the guard
 * would produce, or `null` when it would pass.
 *
 * Order mirrors `processor.rs`: payload, account count, mint identity,
 * Instructions sysvar identity, mint decoding, downstream binding, then the
 * economic state and clock.
 */
export async function evaluateGuard(invocation: MirrorInvocation): Promise<EquityGuardErrorName | null> {
  try {
    const request = decodeAssertSafeExecutionV2(invocation.data);
    if (invocation.accounts.length !== 2) reject("InvalidAccountCount");
    const [mint, sysvar] = invocation.accounts as readonly [MirrorAccount, MirrorAccount];
    if (mint.pubkey !== request.expectedMint) reject("MintKeyMismatch");
    if (sysvar.pubkey !== SYSVAR_INSTRUCTIONS_ADDRESS) reject("InvalidInstructionsSysvar");

    let actual;
    try {
      actual = decodeProtectedState(mint.owner, mint.data);
    } catch (error) {
      // The client's decoder codes are named after the program's variants.
      if (error instanceof GuardClientError) reject(error.code as EquityGuardErrorName);
      throw error;
    }

    await verifyDownstream(invocation, request, mint.pubkey);
    return checkGuardOffline(request.execution, actual, invocation.clockUnixTimestamp);
  } catch (error) {
    if (error instanceof MirrorRejection) return error.guardError;
    throw error;
  }
}
