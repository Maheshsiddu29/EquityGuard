//! Program error codes.

use solana_program_error::ProgramError;

/// Errors returned by the EquityGuard program.
///
/// Discriminants are part of the on-chain interface: clients decode
/// `ProgramError::Custom(code)`. Never renumber existing variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EquityGuardError {
    /// Instruction data does not name a supported instruction.
    UnsupportedInstruction = 0,
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
}

impl From<EquityGuardError> for ProgramError {
    fn from(error: EquityGuardError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
