//! Instruction processing.

use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_clock::Clock;
use solana_get_sysvar::GetSysvar;
use solana_msg::msg;
use solana_program_error::ProgramResult;

use crate::{
    error::EquityGuardError, guard, instruction::AssertSafeExecution, state::decode_protected_state,
};

/// Program entrypoint handler for `assert_safe_execution`.
///
/// Read-only: writes no accounts and performs no CPI. On failure the error
/// aborts the whole transaction, so instructions after the guard never settle.
pub fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    assert_safe_execution(accounts, instruction_data).map_err(|error| {
        msg!("EquityGuard rejected: {:?}", error);
        error.into()
    })
}

fn assert_safe_execution(
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> Result<(), EquityGuardError> {
    let request = AssertSafeExecution::unpack(instruction_data)?;
    let [mint] = accounts else {
        return Err(EquityGuardError::InvalidAccountCount);
    };
    let actual = {
        let data = mint
            .try_borrow_data()
            .map_err(|_| EquityGuardError::InvalidMintData)?;
        decode_protected_state(mint.owner, &data)?
    };
    // Read via the sysvar syscall so clients need not pass the Clock account.
    let now = Clock::get()
        .map_err(|_| EquityGuardError::ClockUnavailable)?
        .unix_timestamp;
    guard::check(&request, &actual, now)?;
    msg!("EquityGuard: safe");
    Ok(())
}

#[cfg(test)]
mod tests {
    use solana_program_error::ProgramError;

    use super::*;
    use crate::{
        instruction::ProtectionWindow,
        state::{ActivationPhase, ProtectedState, StoredMultiplier},
    };

    const PROGRAM_ID: Address = Address::new_from_array([7; 32]);

    #[test]
    fn rejects_bad_data_before_touching_accounts() {
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &[]),
            Err(ProgramError::Custom(
                EquityGuardError::UnsupportedInstruction as u32
            ))
        );
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &[1, 0]),
            Err(ProgramError::Custom(
                EquityGuardError::InvalidInstructionLength as u32
            ))
        );
    }

    #[test]
    fn requires_exactly_one_account() {
        let multiplier = StoredMultiplier::new(1.0_f64.to_le_bytes()).unwrap();
        let data = AssertSafeExecution {
            expected: ProtectedState {
                multiplier,
                new_multiplier: multiplier,
                new_multiplier_effective_timestamp: 0,
            },
            expected_phase: ActivationPhase::Activated,
            window: ProtectionWindow {
                before_secs: 0,
                after_secs: 0,
            },
        }
        .pack();
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &data),
            Err(ProgramError::Custom(
                EquityGuardError::InvalidAccountCount as u32
            ))
        );
    }
}
