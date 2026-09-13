//! Instruction dispatch.

use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_program_error::ProgramResult;

use crate::error::EquityGuardError;

/// Program entrypoint handler.
///
/// Fails closed: any instruction that is not explicitly supported is rejected,
/// so a transaction relying on the guard can never pass by accident.
pub fn process_instruction(
    _program_id: &Address,
    _accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    Err(EquityGuardError::UnsupportedInstruction.into())
}

#[cfg(test)]
mod tests {
    use solana_program_error::ProgramError;

    use super::*;

    #[test]
    fn rejects_every_instruction_until_implemented() {
        let program_id = Address::new_from_array([7; 32]);
        for data in [&[][..], &[0u8][..], &[0xff; 64][..]] {
            assert_eq!(
                process_instruction(&program_id, &[], data),
                Err(ProgramError::Custom(0)),
            );
        }
    }
}
