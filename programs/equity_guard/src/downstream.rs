//! ABI v2 downstream action binding.
//!
//! The guard protects exactly the top-level instruction immediately after
//! itself, read from the Instructions sysvar. Two checks are both required:
//!
//! 1. **Adapter**: the next instruction is a supported action with understood
//!    semantics. Only Token-2022 `TransferChecked` of the protected mint is
//!    supported.
//! 2. **Commitment**: the next instruction is byte-for-byte the instruction
//!    the payload committed to.
//!
//! # Commitment encoding
//!
//! SHA-256 over the concatenation of:
//!
//! | Field | Encoding |
//! | --- | --- |
//! | domain | the 25 ASCII bytes `EQUITYGUARD_DOWNSTREAM_V2` |
//! | program id | 32 bytes |
//! | account count | `u32` LE |
//! | per account, in order | pubkey (32 bytes), `is_signer` (`u8` 0/1), `is_writable` (`u8` 0/1) |
//! | data length | `u32` LE |
//! | data | exact bytes |
//!
//! Account flags are the ones the Instructions sysvar exposes: the
//! transaction-level signer/writable flags of each account, not the flags of
//! the instruction's own account metas. Clients must commit to those.

use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_program_error::ProgramError;
use spl_token_2022_interface::instruction::TokenInstruction;

use crate::{
    error::EquityGuardError,
    instruction::{AssertSafeExecutionV2, DownstreamAdapter},
};

/// Domain separator for downstream commitments.
pub const DOWNSTREAM_COMMITMENT_DOMAIN: &[u8; 25] = b"EQUITYGUARD_DOWNSTREAM_V2";
/// Token-2022 `TransferChecked` data: tag, `u64` amount, `u8` decimals.
const TRANSFER_CHECKED_DATA_LEN: usize = 10;
/// Account index of the mint in `TransferChecked`: source, mint, destination, authority.
const TRANSFER_CHECKED_MINT_INDEX: usize = 1;
const TRANSFER_CHECKED_MIN_ACCOUNTS: usize = 4;

/// One account of a committed instruction, with its transaction-level flags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommittedAccount {
    /// Account address.
    pub pubkey: [u8; 32],
    /// Transaction-level signer flag.
    pub is_signer: bool,
    /// Transaction-level writable flag.
    pub is_writable: bool,
}

/// Computes the downstream commitment (see the module docs for the encoding).
pub fn downstream_commitment(
    program_id: &[u8; 32],
    accounts: &[CommittedAccount],
    data: &[u8],
) -> Result<[u8; 32], EquityGuardError> {
    let account_count =
        u32::try_from(accounts.len()).map_err(|_| EquityGuardError::ArithmeticOverflow)?;
    let data_len = u32::try_from(data.len()).map_err(|_| EquityGuardError::ArithmeticOverflow)?;
    let mut encoded = Vec::with_capacity(
        DOWNSTREAM_COMMITMENT_DOMAIN.len() + 32 + 4 + accounts.len() * 34 + 4 + data.len(),
    );
    encoded.extend_from_slice(DOWNSTREAM_COMMITMENT_DOMAIN);
    encoded.extend_from_slice(program_id);
    encoded.extend_from_slice(&account_count.to_le_bytes());
    for account in accounts {
        encoded.extend_from_slice(&account.pubkey);
        encoded.push(u8::from(account.is_signer));
        encoded.push(u8::from(account.is_writable));
    }
    encoded.extend_from_slice(&data_len.to_le_bytes());
    encoded.extend_from_slice(data);
    Ok(solana_sha256_hasher::hash(&encoded).to_bytes())
}

/// Verifies the guard is the current top-level instruction and that the
/// immediately following top-level instruction is the supported, committed
/// action on `mint_key`.
pub fn verify_downstream(
    program_id: &Address,
    guard_data: &[u8],
    request: &AssertSafeExecutionV2,
    mint_key: &Address,
    instructions_sysvar: &AccountInfo,
) -> Result<(), EquityGuardError> {
    if !solana_instructions_sysvar::check_id(instructions_sysvar.key) {
        return Err(EquityGuardError::InvalidInstructionsSysvar);
    }
    let current = load_current_index_checked(instructions_sysvar)
        .map_err(|_| EquityGuardError::InvalidInstructionsSysvar)?;

    // Invoked via CPI, the current top-level instruction belongs to another
    // program: "the next top-level instruction" would then not follow us.
    let current_instruction =
        load_instruction_at_checked(usize::from(current), instructions_sysvar)
            .map_err(|_| EquityGuardError::GuardNotTopLevel)?;
    if current_instruction.program_id != *program_id || current_instruction.data != guard_data {
        return Err(EquityGuardError::GuardNotTopLevel);
    }

    let next_index = usize::from(current)
        .checked_add(1)
        .ok_or(EquityGuardError::ArithmeticOverflow)?;
    let next =
        load_instruction_at_checked(next_index, instructions_sysvar).map_err(
            |error| match error {
                ProgramError::InvalidArgument => EquityGuardError::MissingDownstreamInstruction,
                _ => EquityGuardError::InvalidInstructionsSysvar,
            },
        )?;

    match request.adapter {
        DownstreamAdapter::Token2022TransferChecked => {
            if next.program_id != spl_token_2022_interface::ID {
                return Err(EquityGuardError::UnsupportedDownstreamProgram);
            }
            let is_transfer_checked = next.data.len() == TRANSFER_CHECKED_DATA_LEN
                && matches!(
                    TokenInstruction::unpack(&next.data),
                    Ok(TokenInstruction::TransferChecked { .. })
                )
                && next.accounts.len() >= TRANSFER_CHECKED_MIN_ACCOUNTS;
            if !is_transfer_checked {
                return Err(EquityGuardError::UnsupportedDownstreamInstruction);
            }
            let mint = next
                .accounts
                .get(TRANSFER_CHECKED_MINT_INDEX)
                .ok_or(EquityGuardError::UnsupportedDownstreamInstruction)?;
            if mint.pubkey != *mint_key {
                return Err(EquityGuardError::DownstreamMintMismatch);
            }
        }
    }

    let accounts: Vec<CommittedAccount> = next
        .accounts
        .iter()
        .map(|meta| CommittedAccount {
            pubkey: meta.pubkey.to_bytes(),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect();
    let actual = downstream_commitment(&next.program_id.to_bytes(), &accounts, &next.data)?;
    if actual != request.downstream_commitment {
        return Err(EquityGuardError::DownstreamCommitmentMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use solana_instruction::{BorrowedAccountMeta, BorrowedInstruction};
    use solana_instructions_sysvar::construct_instructions_data;

    use super::*;
    use crate::{
        instruction::{AssertSafeExecution, ProtectionWindow},
        state::{ActivationPhase, ProtectedState, StoredMultiplier},
    };

    const PROGRAM: Address = Address::new_from_array([7; 32]);
    const OTHER_PROGRAM: Address = Address::new_from_array([8; 32]);
    const MINT: Address = Address::new_from_array([9; 32]);
    const SOURCE: Address = Address::new_from_array([1; 32]);
    const DESTINATION: Address = Address::new_from_array([2; 32]);
    const AUTHORITY: Address = Address::new_from_array([3; 32]);

    fn transfer_data() -> Vec<u8> {
        TokenInstruction::TransferChecked {
            amount: 5,
            decimals: 6,
        }
        .pack()
    }

    fn committed_transfer() -> [u8; 32] {
        let account = |pubkey: Address, is_signer, is_writable| CommittedAccount {
            pubkey: pubkey.to_bytes(),
            is_signer,
            is_writable,
        };
        downstream_commitment(
            &spl_token_2022_interface::ID.to_bytes(),
            &[
                account(SOURCE, false, true),
                account(MINT, false, false),
                account(DESTINATION, false, true),
                account(AUTHORITY, true, true),
            ],
            &transfer_data(),
        )
        .unwrap()
    }

    fn request() -> AssertSafeExecutionV2 {
        let one = StoredMultiplier::new(1.0_f64.to_le_bytes()).unwrap();
        AssertSafeExecutionV2 {
            expected_mint: MINT,
            execution: AssertSafeExecution {
                expected: ProtectedState {
                    multiplier: one,
                    new_multiplier: one,
                    new_multiplier_effective_timestamp: 0,
                },
                expected_phase: ActivationPhase::Activated,
                window: ProtectionWindow {
                    before_secs: 0,
                    after_secs: 0,
                },
            },
            adapter: DownstreamAdapter::Token2022TransferChecked,
            downstream_commitment: committed_transfer(),
        }
    }

    /// Runs `verify_downstream` for a guard whose own data is `our_data`,
    /// against a synthetic Instructions sysvar holding
    /// `[top_level(top_program, top_data), TransferChecked]` with index 0 current.
    fn verify(
        top_program: &Address,
        top_data: &[u8],
        our_data: &[u8],
    ) -> Result<(), EquityGuardError> {
        let token = spl_token_2022_interface::ID;
        let data = transfer_data();
        let meta = |pubkey, is_signer, is_writable| BorrowedAccountMeta {
            pubkey,
            is_signer,
            is_writable,
        };
        let mut sysvar = construct_instructions_data(&[
            BorrowedInstruction {
                program_id: top_program,
                accounts: vec![meta(&MINT, false, false)],
                data: top_data,
            },
            BorrowedInstruction {
                program_id: &token,
                accounts: vec![
                    meta(&SOURCE, false, true),
                    meta(&MINT, false, false),
                    meta(&DESTINATION, false, true),
                    meta(&AUTHORITY, true, true),
                ],
                data: &data,
            },
        ])
        .unwrap();
        let key = solana_instructions_sysvar::ID;
        let owner = Address::default();
        let mut lamports = 0;
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut sysvar,
            &owner,
            false,
        );
        verify_downstream(&PROGRAM, our_data, &request(), &MINT, &info)
    }

    #[test]
    fn top_level_guard_with_committed_next_instruction_passes() {
        let data = request().pack();
        assert_eq!(verify(&PROGRAM, &data, &data), Ok(()));
    }

    #[test]
    fn guard_not_executing_as_the_current_top_level_instruction_is_rejected() {
        let data = request().pack();
        // As seen from a CPI: the current top-level instruction is the caller's.
        assert_eq!(
            verify(&OTHER_PROGRAM, &data, &data),
            Err(EquityGuardError::GuardNotTopLevel)
        );
        // A top-level guard instruction with other data is not this invocation.
        let mut other = data;
        other[98] ^= 1;
        assert_eq!(
            verify(&PROGRAM, &other, &data),
            Err(EquityGuardError::GuardNotTopLevel)
        );
    }

    #[test]
    fn foreign_sysvar_key_is_rejected() {
        let request = request();
        let key = Address::new_from_array([4; 32]);
        let owner = Address::default();
        let mut lamports = 0;
        let mut data = vec![0_u8; 8];
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        assert_eq!(
            verify_downstream(&PROGRAM, &request.pack(), &request, &MINT, &info),
            Err(EquityGuardError::InvalidInstructionsSysvar)
        );
    }

    #[test]
    fn commitment_encoding_is_explicit_and_order_sensitive() {
        let a = CommittedAccount {
            pubkey: [1; 32],
            is_signer: false,
            is_writable: true,
        };
        let b = CommittedAccount {
            pubkey: [2; 32],
            is_signer: true,
            is_writable: false,
        };
        let program = [5; 32];
        let base = downstream_commitment(&program, &[a, b], &[1, 2, 3]).unwrap();
        assert_ne!(
            base,
            downstream_commitment(&program, &[b, a], &[1, 2, 3]).unwrap()
        );
        let writable_b = CommittedAccount {
            is_writable: true,
            ..b
        };
        assert_ne!(
            base,
            downstream_commitment(&program, &[a, writable_b], &[1, 2, 3]).unwrap()
        );
        assert_ne!(
            base,
            downstream_commitment(&program, &[a, b], &[1, 2, 3, 0]).unwrap()
        );
        assert_ne!(
            base,
            downstream_commitment(&[6; 32], &[a, b], &[1, 2, 3]).unwrap()
        );
        // Length prefixes prevent moving bytes between the account list and the data.
        let signer = CommittedAccount {
            pubkey: [1; 32],
            is_signer: true,
            is_writable: true,
        };
        assert_ne!(
            downstream_commitment(&program, &[], &[1; 34]).unwrap(),
            downstream_commitment(&program, &[signer], &[]).unwrap()
        );
    }
}
