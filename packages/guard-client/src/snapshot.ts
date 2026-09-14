/**
 * Chain-consistent snapshot of a mint's protected state and Solana time.
 *
 * The phase placed in the instruction must come from chain time, never the
 * local wall clock: the program compares against `Clock::unix_timestamp`,
 * which can differ from any laptop clock. The mint and the Clock sysvar are
 * read in one `getMultipleAccounts` call so both reflect the same slot.
 */

import type { Address, Base64EncodedDataResponse, Commitment, GetMultipleAccountsApi, Rpc } from "@solana/kit";

import { hasScheduledChange, phaseAt, type ActivationPhase, type ProtectedState } from "./abi.ts";
import { GuardClientError } from "./errors.ts";
import { decodeProtectedState } from "./mint-state.ts";

export const SYSVAR_CLOCK_ADDRESS = "SysvarC1ock11111111111111111111111111111111" as Address;
/** slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp. */
const CLOCK_LEN = 40;
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

/** The subset of the Clock sysvar the client needs. */
export interface ChainClock {
  readonly slot: bigint;
  readonly unixTimestamp: bigint;
}

export interface GuardSnapshot {
  readonly mint: Address;
  /** RPC context slot at which both accounts were read. */
  readonly contextSlot: bigint;
  readonly clock: ChainClock;
  readonly state: ProtectedState;
  /** Phase at `clock.unixTimestamp`. */
  readonly phase: ActivationPhase;
  readonly hasScheduledChange: boolean;
}

/** Decodes Clock sysvar account data. */
export function decodeClock(data: Uint8Array): ChainClock {
  if (data.length !== CLOCK_LEN) {
    throw new GuardClientError("InvalidClockData", `expected ${CLOCK_LEN} bytes, got ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    slot: view.getBigUint64(0, true),
    unixTimestamp: view.getBigInt64(CLOCK_UNIX_TIMESTAMP_OFFSET, true),
  };
}

/** Reads the mint and Clock at one slot and derives the guard snapshot. */
export async function fetchGuardSnapshot(
  rpc: Rpc<GetMultipleAccountsApi>,
  mint: Address,
  commitment: Commitment = "confirmed",
): Promise<GuardSnapshot> {
  const { context, value } = await rpc
    .getMultipleAccounts([mint, SYSVAR_CLOCK_ADDRESS], { encoding: "base64", commitment })
    .send();
  const [mintAccount, clockAccount] = value;
  if (!mintAccount) throw new GuardClientError("AccountNotFound", `mint ${mint} not found`);
  if (!clockAccount) throw new GuardClientError("AccountNotFound", "Clock sysvar not returned");

  const clock = decodeClock(base64Data(clockAccount.data));
  const state = decodeProtectedState(mintAccount.owner, base64Data(mintAccount.data));
  return {
    mint,
    contextSlot: context.slot,
    clock,
    state,
    phase: phaseAt(state, clock.unixTimestamp),
    hasScheduledChange: hasScheduledChange(state),
  };
}

function base64Data([encoded]: Base64EncodedDataResponse): Uint8Array {
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}
