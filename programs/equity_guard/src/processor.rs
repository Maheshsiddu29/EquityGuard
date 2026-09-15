//! Instruction processing.

use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_clock::Clock;
use solana_get_sysvar::GetSysvar;
use solana_msg::msg;
use solana_program_error::ProgramResult;

use crate::{
    downstream::verify_downstream, error::EquityGuardError, guard,
    instruction::AssertSafeExecutionV2, state::decode_protected_state,
};

/// Program entrypoint handler for `assert_safe_execution` (ABI v2).
///
/// Read-only: writes no accounts and performs no CPI. On failure the error
/// aborts the whole transaction, so no instruction in it settles.
pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    assert_safe_execution(program_id, accounts, instruction_data).map_err(|error| {
        msg!("EquityGuard rejected: {:?}", error);
        error.into()
    })
}

/// Check order: payload, accounts, mint identity, Instructions sysvar
/// identity, mint decoding, downstream action binding, then economic state
/// and clock.
fn assert_safe_execution(
    program_id: &Address,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> Result<(), EquityGuardError> {
    let request = AssertSafeExecutionV2::unpack(instruction_data)?;
    let [mint, instructions_sysvar] = accounts else {
        return Err(EquityGuardError::InvalidAccountCount);
    };
    if *mint.key != request.expected_mint {
        return Err(EquityGuardError::MintKeyMismatch);
    }
    if !solana_instructions_sysvar::check_id(instructions_sysvar.key) {
        return Err(EquityGuardError::InvalidInstructionsSysvar);
    }
    let actual = {
        let data = mint
            .try_borrow_data()
            .map_err(|_| EquityGuardError::InvalidMintData)?;
        decode_protected_state(mint.owner, &data)?
    };
    verify_downstream(
        program_id,
        instruction_data,
        &request,
        mint.key,
        instructions_sysvar,
    )?;
    // Read via the sysvar syscall so clients need not pass the Clock account.
    let now = Clock::get()
        .map_err(|_| EquityGuardError::ClockUnavailable)?
        .unix_timestamp;
    guard::check(&request.execution, &actual, now)?;
    msg!("EquityGuard: safe");
    Ok(())
}

#[cfg(test)]
mod tests {
    use solana_program_error::ProgramError;

    use super::*;
    use crate::{
        instruction::{AssertSafeExecution, DownstreamAdapter, ProtectionWindow},
        state::{ActivationPhase, ProtectedState, StoredMultiplier},
    };

    const PROGRAM_ID: Address = Address::new_from_array([7; 32]);

    fn request() -> AssertSafeExecutionV2 {
        let multiplier = StoredMultiplier::new(1.0_f64.to_le_bytes()).unwrap();
        AssertSafeExecutionV2 {
            expected_mint: Address::new_from_array([9; 32]),
            execution: AssertSafeExecution {
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
            },
            adapter: DownstreamAdapter::Token2022TransferChecked,
            downstream_commitment: [0; 32],
        }
    }

    fn custom(error: EquityGuardError) -> ProgramResult {
        Err(ProgramError::Custom(error as u32))
    }

    #[test]
    fn rejects_bad_data_and_abi_v1_before_touching_accounts() {
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &[]),
            custom(EquityGuardError::UnsupportedInstruction)
        );
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &[2, 0]),
            custom(EquityGuardError::InvalidInstructionLength)
        );
        let mut v1 = request().pack();
        v1[0] = 1;
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &v1[..34]),
            custom(EquityGuardError::UnsupportedVersion)
        );
    }

    #[test]
    fn requires_exactly_two_accounts() {
        assert_eq!(
            process_instruction(&PROGRAM_ID, &[], &request().pack()),
            custom(EquityGuardError::InvalidAccountCount)
        );
    }
}
