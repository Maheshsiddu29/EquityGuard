/**
 * Client-side failure reasons. Names that also exist on-chain match the
 * program's `EquityGuardError` variants so logs read the same on both sides.
 */
export type GuardClientErrorCode =
  | "AccountNotFound"
  | "InvalidClockData"
  | "InvalidExpectedState"
  | "InvalidExtensionCombination"
  | "InvalidMintData"
  | "InvalidMintOwner"
  | "InvalidMultiplier"
  | "InvalidProtectionWindow"
  | "MissingScaledUiAmount";

/** Structured error thrown by the guard client. */
export class GuardClientError extends Error {
  readonly code: GuardClientErrorCode;

  constructor(code: GuardClientErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "GuardClientError";
    this.code = code;
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
} as const;

export type EquityGuardErrorName = keyof typeof EQUITY_GUARD_ERROR_CODES;

/** Maps an on-chain custom error code back to its name. */
export function equityGuardErrorName(code: number): EquityGuardErrorName | undefined {
  const entry = Object.entries(EQUITY_GUARD_ERROR_CODES).find(([, value]) => value === code);
  return entry?.[0] as EquityGuardErrorName | undefined;
}
