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
}

impl From<EquityGuardError> for ProgramError {
    fn from(error: EquityGuardError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
