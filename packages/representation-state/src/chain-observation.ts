/**
 * Read-only decoding of Token-2022 mint accounts into chain observations, and
 * the chain-evidence classification shared by issuer adapters.
 */

import {
  GuardClientError,
  SYSVAR_CLOCK_ADDRESS,
  decodeClock,
  decodeMintMetadata,
  decodeProtectedState,
  hasScheduledChange,
  phaseAt,
} from "@equityguard/guard-client";
import type { Address, Commitment, GetMultipleAccountsApi, Rpc } from "@solana/kit";

import {
  RepresentationState,
  type ChainEvidence,
  type TransitionPolicy,
} from "./types.ts";

export interface RawMintAccount {
  readonly mint: string;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  readonly observedAt: string | null;
  /** Chain time to evaluate the activation phase at; null if unknown. */
  readonly chainUnixTimestamp: bigint | null;
}

/** Decodes one mint account. Decoder rejections become evidence, not exceptions. */
export function observeMintAccount(account: RawMintAccount): ChainEvidence {
  const context = {
    mint: account.mint,
    slot: account.slot,
    blockTime: account.blockTime,
    observedAt: account.observedAt,
  };
  try {
    const protectedState = decodeProtectedState(account.owner, account.data);
    const { decimals, paused } = decodeMintMetadata(account.owner, account.data);
    return {
      kind: "decoded",
      ...context,
      chainUnixTimestamp: account.chainUnixTimestamp,
      decimals,
      paused,
      protectedState,
      hasScheduledChange: hasScheduledChange(protectedState),
      phase: account.chainUnixTimestamp === null ? null : phaseAt(protectedState, account.chainUnixTimestamp),
    };
  } catch (error) {
    if (!(error instanceof GuardClientError)) throw error;
    return { kind: "decode-error", ...context, code: error.code, message: error.message };
  }
}

/** Fetches the mint and Clock at one slot (read-only) and decodes them. */
export async function fetchChainObservation(
  rpc: Rpc<GetMultipleAccountsApi>,
  mint: Address,
  commitment: Commitment = "confirmed",
): Promise<ChainEvidence> {
  const { context, value } = await rpc
    .getMultipleAccounts([mint, SYSVAR_CLOCK_ADDRESS], { encoding: "base64", commitment })
    .send();
  const observedAt = new Date().toISOString();
  const [mintAccount, clockAccount] = value;
  const base = { mint, slot: context.slot, blockTime: null, observedAt };
  if (!mintAccount) return { kind: "decode-error", ...base, code: "AccountNotFound", message: "mint account not found" };

  let chainUnixTimestamp: bigint | null = null;
  if (clockAccount) {
    try {
      chainUnixTimestamp = decodeClock(Uint8Array.from(Buffer.from(clockAccount.data[0], "base64"))).unixTimestamp;
    } catch (error) {
      if (!(error instanceof GuardClientError)) throw error;
    }
  }
  return observeMintAccount({
    ...base,
    owner: mintAccount.owner,
    data: Uint8Array.from(Buffer.from(mintAccount.data[0], "base64")),
    chainUnixTimestamp,
  });
}

export interface Classification {
  readonly state: RepresentationState;
  readonly reason: string;
}

export class TransitionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionPolicyError";
  }
}

export function assertValidPolicy(policy: TransitionPolicy): void {
  if (policy.beforeSecs < 0n || policy.afterSecs < 0n || (policy.immediateUpdateAfterSecs ?? 0n) < 0n) {
    throw new TransitionPolicyError("protection interval bounds must be non-negative");
  }
}

/**
 * Classifies chain evidence under a transition policy:
 * decode failure or missing chain time → UNKNOWN; Pausable flag set → PAUSED;
 * scheduled change with chain time inside the inclusive interval → TRANSITION;
 * otherwise SAFE.
 */
export function classifyChainEvidence(evidence: ChainEvidence, policy: TransitionPolicy): Classification {
  assertValidPolicy(policy);
  if (evidence.kind === "decode-error") {
    return { state: RepresentationState.UNKNOWN, reason: `mint could not be decoded: ${evidence.code}` };
  }
  if (evidence.paused === true) {
    return { state: RepresentationState.PAUSED, reason: "Token-2022 Pausable flag is set" };
  }
  if (!evidence.hasScheduledChange) {
    const after = policy.immediateUpdateAfterSecs;
    const t = evidence.protectedState.newMultiplierEffectiveTimestamp;
    const now = evidence.chainUnixTimestamp;
    // T = 0 is Token-2022's initial value, not an update.
    if (after !== undefined && now !== null && t > 0n && t <= now && now <= t + after) {
      return {
        state: RepresentationState.TRANSITION,
        reason: `immediate multiplier update with stored effective timestamp ${t}; chain time ${now} is inside [${t}, ${t + after}] (policy ${policy.calibration})`,
      };
    }
    return { state: RepresentationState.SAFE, reason: "no scheduled multiplier change" };
  }
  if (evidence.chainUnixTimestamp === null) {
    return { state: RepresentationState.UNKNOWN, reason: "multiplier change scheduled but chain time unavailable" };
  }
  const activation = evidence.protectedState.newMultiplierEffectiveTimestamp;
  const now = evidence.chainUnixTimestamp;
  if (activation - policy.beforeSecs <= now && now <= activation + policy.afterSecs) {
    return {
      state: RepresentationState.TRANSITION,
      reason: `chain time ${now} is inside [${activation - policy.beforeSecs}, ${activation + policy.afterSecs}]`,
    };
  }
  const phase = now >= activation ? "activated" : "pending";
  return {
    state: RepresentationState.SAFE,
    reason: `scheduled change ${phase} and outside the protection interval (policy ${policy.calibration})`,
  };
}
