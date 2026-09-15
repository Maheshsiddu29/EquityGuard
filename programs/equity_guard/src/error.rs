//! Program error codes.

use solana_program_error::ProgramError;

/// Errors returned by the EquityGuard program.
///
/// Discriminants are part of the on-chain interface: clients decode
/// `ProgramError::Custom(code)`. Never renumber existing variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EquityGuardError {
    /// Instruction data is empty.
    UnsupportedInstruction = 0,
    /// Instruction data length does not match the ABI version.
    InvalidInstructionLength = 1,
    /// Expected state in the instruction is malformed (invalid multiplier
    /// encoding or unknown activation phase).
    InvalidExpectedState = 2,
    /// Instruction was not given exactly one account.
    InvalidAccountCount = 3,
    /// Mint account is not owned by the Token-2022 program.
    InvalidMintOwner = 4,
    /// Mint account data is not a valid, initialized Token-2022 mint with
    /// well-formed extension data.
    InvalidMintData = 5,
    /// Mint has no ScaledUiAmount extension.
    MissingScaledUiAmount = 6,
    /// Mint carries an extension set Token-2022 forbids (e.g. ScaledUiAmount
    /// together with InterestBearingConfig).
    InvalidExtensionCombination = 7,
    /// A stored multiplier is not positive and normal.
    InvalidMultiplier = 8,
    /// Stored `multiplier` differs from the expected bytes.
    MultiplierChanged = 9,
    /// Stored `new_multiplier` differs from the expected bytes.
    NewMultiplierChanged = 10,
    /// Stored `new_multiplier_effective_timestamp` differs from expected.
    EffectiveTimestampChanged = 11,
    /// The clock crossed the effective timestamp relative to what the client
    /// observed, so a different multiplier is now effective.
    ActivationPhaseChanged = 12,
    /// Execution falls inside the protection window around a scheduled
    /// multiplier activation.
    InsideTransitionWindow = 13,
    /// Protection window bounds overflow `i64`.
    ArithmeticOverflow = 14,
    /// The Clock sysvar could not be read.
    ClockUnavailable = 15,
    /// Instruction data names an ABI version other than v2 (ABI v1 included).
    UnsupportedVersion = 16,
    /// The expected mint pubkey in the payload is not the mint account passed.
    MintKeyMismatch = 17,
    /// Account 1 is not the Instructions sysvar.
    InvalidInstructionsSysvar = 18,
    /// No top-level instruction immediately follows the guard.
    MissingDownstreamInstruction = 19,
    /// The next instruction's program is not a supported downstream program.
    UnsupportedDownstreamProgram = 20,
    /// The next instruction is not the supported downstream instruction.
    UnsupportedDownstreamInstruction = 21,
    /// The downstream action's mint is not the protected mint.
    DownstreamMintMismatch = 22,
    /// The next instruction is not the exact instruction the payload commits to.
    DownstreamCommitmentMismatch = 23,
    /// The payload names an unknown downstream adapter.
    UnsupportedAdapter = 24,
    /// The guard is not executing as the current top-level instruction.
    GuardNotTopLevel = 25,
}

impl From<EquityGuardError> for ProgramError {
    fn from(error: EquityGuardError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
