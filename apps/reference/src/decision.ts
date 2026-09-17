/**
 * UI-facing decision adapter for the reference app.
 *
 * It only normalizes outputs the backend already produces: the guard error
 * name (`checkGuardOffline` / on-chain `EquityGuardError`) and the
 * representation decision engine's `Decision`. It decides nothing itself and
 * has no imports, so it runs unchanged in the browser and under `node --test`.
 *
 * Anything it does not recognise fails closed as BLOCK / UNVERIFIABLE_STATE.
 */

export type BlockReason = "ECONOMIC_STATE_CHANGED" | "INTENT_MISMATCH" | "UNVERIFIABLE_STATE";

export interface ConsentDisclosureView {
  readonly fromSymbol: string;
  readonly fromIssuer: string;
  readonly toSymbol: string;
  readonly toIssuer: string;
  /** Engine value: positive means the alternative costs at least this many bps more. */
  readonly additionalCostBps: string;
  readonly policyMaxAdditionalCostBps: string;
  readonly notice: string;
  readonly disclosureDigest: string;
}

export type GuardDecision =
  | { readonly type: "ALLOW"; readonly guardResult: null }
  | { readonly type: "BLOCK"; readonly reason: BlockReason; readonly guardResult: string }
  | {
      readonly type: "REQUIRES_CONSENT";
      readonly reason: "REPRESENTATION_CHANGE";
      /** Why the original representation cannot proceed as authorized. */
      readonly guardResult: string | null;
      readonly disclosure: ConsentDisclosureView;
    };

/** Guard errors meaning the protected economic state moved after authorization. */
export const ECONOMIC_STATE_ERRORS: readonly string[] = [
  "MultiplierChanged",
  "NewMultiplierChanged",
  "EffectiveTimestampChanged",
  "ActivationPhaseChanged",
  "InsideTransitionWindow",
];

/** Guard errors meaning the transaction no longer matches the action the guard was built for. */
export const INTENT_MISMATCH_ERRORS: readonly string[] = [
  "MintKeyMismatch",
  "MissingDownstreamInstruction",
  "UnsupportedDownstreamProgram",
  "UnsupportedDownstreamInstruction",
  "DownstreamMintMismatch",
  "DownstreamCommitmentMismatch",
  "UnsupportedAdapter",
  "GuardNotTopLevel",
  "GuardNotFirst",
  "UnsupportedTransactionGrammar",
  "InvalidComputeBudgetInstruction",
  "InvalidAtaSetup",
  "InvalidJupiterProgram",
  "InvalidJupiterInstruction",
  "InvalidJupiterDirection",
  "InvalidCounterMint",
  "InvalidTokenProgram",
  "DestinationOverrideUnsupported",
  "UnsupportedJupiterFee",
  "NonCanonicalSourceAccount",
  "NonCanonicalDestinationAccount",
];

export function blockReasonOf(guardError: string): BlockReason {
  if (ECONOMIC_STATE_ERRORS.includes(guardError)) return "ECONOMIC_STATE_CHANGED";
  if (INTENT_MISMATCH_ERRORS.includes(guardError)) return "INTENT_MISMATCH";
  return "UNVERIFIABLE_STATE";
}

/** Normalizes a guard result: `null` is the guard passing, any error name blocks. */
export function fromGuardResult(guardError: string | null): GuardDecision {
  if (guardError === null) return { type: "ALLOW", guardResult: null };
  return { type: "BLOCK", reason: blockReasonOf(guardError), guardResult: guardError };
}

/**
 * Normalizes the representation engine's outcome for a trade whose original
 * representation did not pass. Only `REQUIRES_CONSENT` with a disclosure
 * becomes a consent prompt; everything else stays a block, because the
 * original trade cannot proceed as authorized.
 */
export function fromRepresentationDecision(
  engineDecision: string,
  guardError: string | null,
  disclosure: ConsentDisclosureView | null,
): GuardDecision {
  if (engineDecision === "REQUIRES_CONSENT" && disclosure) {
    return { type: "REQUIRES_CONSENT", reason: "REPRESENTATION_CHANGE", guardResult: guardError, disclosure };
  }
  if (engineDecision === "USE_PREFERRED" && guardError === null) return fromGuardResult(null);
  return { type: "BLOCK", reason: guardError ? blockReasonOf(guardError) : "UNVERIFIABLE_STATE", guardResult: guardError ?? `ENGINE_${engineDecision}` };
}
