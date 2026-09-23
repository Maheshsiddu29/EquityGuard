import { address } from "@solana/kit";

import type { ReplayKind } from "./replay-model.ts";

export const EXPECTED_PHANTOM = address("CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X");
export const EXPECTED_PHANTOM_USDC_ATA = address("7xd18PpPsvi8CmmP5Xr6rVQ63jUeQ2CqJ7i4yqZzmok9");
export const EXPECTED_PHANTOM_KOX_ATA = address("AnrbNfooXzzthu4kndCspVEEMo14wn8VQYJC6kFqonVj");

export const USDC_DECIMALS = 6;
export const KOX_DECIMALS = 8;
export const EXPECTED_IN_AMOUNT = 5_000_000n;
export const EXPECTED_OUT_AMOUNT = 5_504_261n;
export const EXPECTED_USDC_BASELINE = 5_000_000n;
export const EXPECTED_KOX_BASELINE = 0n;

export const STALE_AUTHORIZATION_SOURCE = "SEALED_SEP_15_PRE_ACTIVATION_OBSERVATION";
export const REFRESHED_AUTHORIZATION_SOURCE = "SEALED_SEP_15_POST_ACTIVATION_OBSERVATION";

/** skipPreflight is allowed only so a deliberately failing stale tx can land. */
export function skipPreflightAllowed(kind: ReplayKind): boolean {
  return kind === "STALE";
}

export function formatRawAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function formatUsdc(raw: bigint): string {
  const [whole, fraction = ""] = formatRawAmount(raw, USDC_DECIMALS).split(".");
  return `${whole}.${(fraction ?? "").padEnd(2, "0").slice(0, 2)}`;
}

export function formatKox(raw: bigint): string {
  if (KOX_DECIMALS !== 8) throw new Error("KOx display requires 8 decimals");
  return formatRawAmount(raw, KOX_DECIMALS);
}
