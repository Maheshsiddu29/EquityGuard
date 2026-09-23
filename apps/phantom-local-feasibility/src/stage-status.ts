/**
 * The trader-facing status line for each stage of one Buy or Confirm click.
 *
 * Extracted from `app.ts` unchanged so the apps/web live demo shows the same
 * words as the proven feasibility app. Pure: no DOM, no globals.
 */
import type { BuyStage } from "./buy-error.ts";

const STATUS: Partial<Record<BuyStage, string>> = {
  ENVIRONMENT_CHECK: "Preparing local reproduction…",
  TRANSACTION_BUILD: "Building authorization from local state…",
  PRE_SIGN_SIMULATION: "Checking the complete trade before signing…",
  SIGN_REQUEST: "Pre-sign simulation passed. Approve in Phantom.",
  SIGNED_BYTES_RETURNED: "Phantom returned signed bytes. Verifying signing time…",
  BLOCKHASH_VALIDATION: "Checking the original blockhash and exact signed bytes…",
  SUBMISSION: "Submitting to the local validator…",
  CONFIRMATION: "Waiting for local confirmation…",
  BALANCE_VERIFICATION: "Verifying execution and token balances…",
};

/**
 * `clock` and `localT` are present only while the signed stale transaction is
 * held: the hold is the one stage whose message counts down.
 */
export function stageStatus(
  stage: BuyStage,
  clock?: { readonly unixTimestamp: bigint } | undefined,
  localT?: bigint | null,
): string {
  if (stage === "WAITING_FOR_ACTIVATION" && clock && localT !== null && localT !== undefined) {
    const remaining = localT - clock.unixTimestamp;
    return remaining > 0n
      ? "Authorization signed ✓\nTransaction held\nEconomic state changes in: " + remaining + "…"
      : "State changed\nSubmitting the exact signed transaction once the validator Clock is past local T.";
  }
  return STATUS[stage] ?? "Connecting Phantom…";
}
