import { address, type Address } from "@solana/kit";

import {
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  USDC_MINT_ADDRESS,
  canonicalAta,
  type AssertSafeExecutionRequest,
} from "../../../packages/guard-client/src/index.ts";
import type { ApiAccountMeta, ApiInstruction, BuildResponse } from "../../../packages/jupiter/src/build-client.ts";

export const KOX_MINT = address("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ");
export const ORIGINAL_TAKER = address("6ZuNEkQXE5WZzsmLH21sSmTXfff6iQKr6EtErcxxBxpy");
export const ORIGINAL_USDC_ATA = address("Bze38ZNYkoKZXBWv7hGfqYkH4KBhAAmUkwPMNqNbzCRp");
export const ORIGINAL_KOX_ATA = address("Cv8LSh7Udip71rxXVqyMKx7bY64ED6ToBE1fSeKGXPyv");

export interface RetargetedBuild {
  readonly build: BuildResponse;
  readonly sourceAta: Address;
  readonly destinationAta: Address;
  readonly replacements: {
    readonly authority: number;
    readonly sourceAta: number;
    readonly destinationAta: number;
  };
}

function allInstructions(build: BuildResponse): readonly ApiInstruction[] {
  return [
    ...build.computeBudgetInstructions,
    ...build.setupInstructions,
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...build.otherInstructions,
    ...(build.tipInstruction ? [build.tipInstruction] : []),
  ];
}

export function requiredSignerAddresses(build: BuildResponse): readonly string[] {
  return [...new Set(allInstructions(build).flatMap((instruction) =>
    instruction.accounts.filter((account) => account.isSigner).map((account) => account.pubkey),
  ))];
}

function replaceMeta(
  meta: ApiAccountMeta,
  mapping: ReadonlyMap<string, string>,
  counts: { authority: number; sourceAta: number; destinationAta: number },
): ApiAccountMeta {
  const replacement = mapping.get(meta.pubkey);
  if (!replacement) return meta;
  if (meta.pubkey === ORIGINAL_TAKER) counts.authority += 1;
  else if (meta.pubkey === ORIGINAL_USDC_ATA) counts.sourceAta += 1;
  else if (meta.pubkey === ORIGINAL_KOX_ATA) counts.destinationAta += 1;
  return { ...meta, pubkey: replacement };
}

function replaceInstruction(
  instruction: ApiInstruction,
  mapping: ReadonlyMap<string, string>,
  counts: { authority: number; sourceAta: number; destinationAta: number },
): ApiInstruction {
  return { ...instruction, accounts: instruction.accounts.map((meta) => replaceMeta(meta, mapping, counts)) };
}

/**
 * Retargets only the local user identity and its canonical ATAs. Jupiter data,
 * route plan, venue accounts, mints, programs, amounts and slippage are kept.
 */
export async function retargetBuildForTrader(build: BuildResponse, trader: Address): Promise<RetargetedBuild> {
  if (requiredSignerAddresses(build).join(",") !== ORIGINAL_TAKER) {
    throw new Error("M9D-C1 fixture signer model changed; refusing trader substitution");
  }
  const [originalSource, originalDestination, sourceAta, destinationAta] = await Promise.all([
    canonicalAta(ORIGINAL_TAKER, address(USDC_MINT_ADDRESS), address(LEGACY_TOKEN_PROGRAM_ADDRESS)),
    canonicalAta(ORIGINAL_TAKER, KOX_MINT, address(TOKEN_2022_PROGRAM_ADDRESS)),
    canonicalAta(trader, address(USDC_MINT_ADDRESS), address(LEGACY_TOKEN_PROGRAM_ADDRESS)),
    canonicalAta(trader, KOX_MINT, address(TOKEN_2022_PROGRAM_ADDRESS)),
  ]);
  if (originalSource !== ORIGINAL_USDC_ATA || originalDestination !== ORIGINAL_KOX_ATA) {
    throw new Error("M9D-C1 user token accounts are not the expected canonical ATAs");
  }

  const counts = { authority: 0, sourceAta: 0, destinationAta: 0 };
  const mapping = new Map<string, string>([
    [ORIGINAL_TAKER, trader],
    [ORIGINAL_USDC_ATA, sourceAta],
    [ORIGINAL_KOX_ATA, destinationAta],
  ]);
  const retargeted: BuildResponse = {
    ...build,
    computeBudgetInstructions: build.computeBudgetInstructions.map((instruction) => replaceInstruction(instruction, mapping, counts)),
    setupInstructions: build.setupInstructions.map((instruction) => replaceInstruction(instruction, mapping, counts)),
    swapInstruction: replaceInstruction(build.swapInstruction, mapping, counts),
    cleanupInstruction: build.cleanupInstruction ? replaceInstruction(build.cleanupInstruction, mapping, counts) : null,
    otherInstructions: build.otherInstructions.map((instruction) => replaceInstruction(instruction, mapping, counts)),
    tipInstruction: build.tipInstruction ? replaceInstruction(build.tipInstruction, mapping, counts) : null,
  };
  if (counts.authority !== 4 || counts.sourceAta !== 2 || counts.destinationAta !== 3) {
    throw new Error(
      `M9D-C1 user-account layout changed: authority=${counts.authority}, source=${counts.sourceAta}, destination=${counts.destinationAta}`,
    );
  }
  if (requiredSignerAddresses(retargeted).join(",") !== trader) {
    throw new Error("retargeted route requires a hidden or additional signer");
  }
  return { build: retargeted, sourceAta, destinationAta, replacements: counts };
}

export interface RecordedAuthorization {
  readonly multiplierHex: string;
  readonly newMultiplierHex: string;
  readonly newMultiplierEffectiveTimestamp: string;
  readonly expectedPhase: number;
  readonly window: { readonly beforeSecs: number; readonly afterSecs: number };
}

function bytes8(hex: string, field: string): Uint8Array {
  if (!/^[0-9a-f]{16}$/i.test(hex)) throw new Error(`${field} is not eight bytes`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function expectationFromRecordedAuthorization(value: RecordedAuthorization): AssertSafeExecutionRequest {
  if (value.expectedPhase !== 0 && value.expectedPhase !== 1) throw new Error("recorded expectedPhase is unsupported");
  return {
    expected: {
      multiplier: bytes8(value.multiplierHex, "multiplier"),
      newMultiplier: bytes8(value.newMultiplierHex, "newMultiplier"),
      newMultiplierEffectiveTimestamp: BigInt(value.newMultiplierEffectiveTimestamp),
    },
    expectedPhase: value.expectedPhase,
    window: value.window,
  };
}

export type ReplayStep = "READY_SAFE" | "READY_STALE" | "STALE_REJECTED" | "COMPLETE";
export type ReplayKind = "SAFE" | "STALE" | "REFRESHED";

export function assertReplayApproval(step: ReplayStep, kind: ReplayKind): void {
  const allowed =
    (step === "READY_SAFE" && kind === "SAFE") ||
    (step === "READY_STALE" && kind === "STALE") ||
    (step === "STALE_REJECTED" && kind === "REFRESHED");
  if (!allowed) throw new Error(`${kind} requires a separate approval at the correct replay step`);
}

export function nextReplayStep(step: ReplayStep, kind: ReplayKind): ReplayStep {
  assertReplayApproval(step, kind);
  if (kind === "SAFE") return "READY_STALE";
  if (kind === "STALE") return "STALE_REJECTED";
  return "COMPLETE";
}
