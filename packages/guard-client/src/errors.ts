/**
 * Client-side failure reasons. Names that also exist on-chain match the
 * program's `EquityGuardError` variants so logs read the same on both sides.
 */
export type GuardClientErrorCode =
  | "AccountNotFound"
  | "InvalidClockData"
  | "InvalidDownstream"
  | "InvalidExpectedState"
  | "InvalidExtensionCombination"
  | "InvalidMintData"
  | "InvalidMintOwner"
  | "InvalidMultiplier"
  | "InvalidProtectionWindow"
  | "MissingScaledUiAmount"
  | "UnsupportedJupiterTrade";

/** Structured error thrown by the guard client. */
export class GuardClientError extends Error {
  readonly code: GuardClientErrorCode;
  /** For a refused Jupiter trade: the error the program would return. */
  readonly guardError: EquityGuardErrorName | null;

  constructor(code: GuardClientErrorCode, message: string, guardError: EquityGuardErrorName | null = null) {
    super(`${code}: ${message}`);
    this.name = "GuardClientError";
    this.code = code;
    this.guardError = guardError;
  }
}

/**
 * On-chain `EquityGuardError` codes (`ProgramError::Custom(code)`).
 * Cross-checked against the Rust enum by the shared golden fixture.
 */
export const EQUITY_GUARD_ERROR_CODES = {
  UnsupportedInstruction: 0,
  InvalidInstructionLength: 1,
  InvalidExpectedState: 2,
  InvalidAccountCount: 3,
  InvalidMintOwner: 4,
  InvalidMintData: 5,
  MissingScaledUiAmount: 6,
  InvalidExtensionCombination: 7,
  InvalidMultiplier: 8,
  MultiplierChanged: 9,
  NewMultiplierChanged: 10,
  EffectiveTimestampChanged: 11,
  ActivationPhaseChanged: 12,
  InsideTransitionWindow: 13,
  ArithmeticOverflow: 14,
  ClockUnavailable: 15,
  UnsupportedVersion: 16,
  MintKeyMismatch: 17,
  InvalidInstructionsSysvar: 18,
  MissingDownstreamInstruction: 19,
  UnsupportedDownstreamProgram: 20,
  UnsupportedDownstreamInstruction: 21,
  DownstreamMintMismatch: 22,
  DownstreamCommitmentMismatch: 23,
  UnsupportedAdapter: 24,
  GuardNotTopLevel: 25,
  // Adapter kinds 2 and 3 (Jupiter route_v2, USDC only).
  GuardNotFirst: 26,
  UnsupportedTransactionGrammar: 27,
  InvalidComputeBudgetInstruction: 28,
  InvalidAtaSetup: 29,
  InvalidJupiterProgram: 30,
  InvalidJupiterInstruction: 31,
  InvalidJupiterDirection: 32,
  InvalidCounterMint: 33,
  InvalidTokenProgram: 34,
  DestinationOverrideUnsupported: 35,
  UnsupportedJupiterFee: 36,
  NonCanonicalSourceAccount: 37,
  NonCanonicalDestinationAccount: 38,
} as const;

export type EquityGuardErrorName = keyof typeof EQUITY_GUARD_ERROR_CODES;

/** Maps an on-chain custom error code back to its name. */
export function equityGuardErrorName(code: number): EquityGuardErrorName | undefined {
  const entry = Object.entries(EQUITY_GUARD_ERROR_CODES).find(([, value]) => value === code);
  return entry?.[0] as EquityGuardErrorName | undefined;
}
