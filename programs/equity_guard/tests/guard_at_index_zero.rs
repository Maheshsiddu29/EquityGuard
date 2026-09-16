//! Does the guard-at-index-zero layout the Jupiter adapter needs actually work?
//!
//! The M9D-A.1 target layout is
//!
//! ```text
//! 0 EquityGuard
//! 1 ComputeBudget SetComputeUnitPrice
//! 2 ComputeBudget SetComputeUnitLimit
//! 3 setup
//! 4 Jupiter
//! ```
//!
//! which assumes two things that are convention, not proof: that the guard
//! reads the Instructions sysvar correctly at index 0, and that a
//! `SetComputeUnitLimit` is honoured when it is not the first instruction.
//! Both are measured here against the compiled program rather than assumed.
//!
//! What this cannot yet test is the target layout end to end: adapter kind 1
//! requires the instruction after the guard to be `TransferChecked`, so
//! anything between the guard and the trade is rejected by the adapter. The
//! last test pins exactly that, showing the obstacle is the adapter's
//! semantics and not the runtime — which is what adapter kinds 2 and 3 exist
//! to change.
//!
//! Requires the program artifact: run `cargo build-sbf` first.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use std::path::PathBuf;

use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount},
    error::EquityGuardError,
    instruction::{
        AssertSafeExecution, AssertSafeExecutionV2, DownstreamAdapter, ProtectionWindow,
    },
    state::{decode_protected_state, ActivationPhase, ProtectedState},
};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction::create_account;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::{
    extension::{scaled_ui_amount, ExtensionType},
    instruction::{initialize_mint2, mint_to, transfer_checked},
    state::Mint,
};

const PROGRAM_ID: Address = equity_guard::ID;
const TOKEN_2022: Address = spl_token_2022_interface::ID;
const ATA_PROGRAM: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
const COMPUTE_BUDGET: Address =
    Address::from_str_const("ComputeBudget111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Address = solana_instructions_sysvar::ID;
const DECIMALS: u8 = 6;
const MINTED: u64 = 1_000_000_000;
const AMOUNT: u64 = 1_000;
const NOW: i64 = 1_789_400_000;
const WINDOW: ProtectionWindow = ProtectionWindow {
    before_secs: 900,
    after_secs: 300,
};
/// Below the guard's own ~4.7k CU, so the limit must bite.
const TIGHT_COMPUTE_UNIT_LIMIT: u32 = 3_000;
/// Comfortably above guard plus transfer.
const GENEROUS_COMPUTE_UNIT_LIMIT: u32 = 60_000;

fn program_path() -> PathBuf {
    let dir = std::env::var_os("SBF_OUT_DIR").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy"),
        PathBuf::from,
    );
    let path = dir.join("equity_guard.so");
    assert!(
        path.exists(),
        "{} not found: run `cargo build-sbf` before these tests",
        path.display()
    );
    path
}

fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

fn create_ata(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![1],
    }
}

fn set_compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data,
    }
}

fn set_compute_unit_price(micro_lamports: u64) -> Instruction {
    let mut data = vec![3];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data,
    }
}

/// Transaction-level signer/writable flags, as the Instructions sysvar exposes them.
fn committed_accounts(
    instructions: &[Instruction],
    payer: &Address,
    target: &Instruction,
) -> Vec<CommittedAccount> {
    target
        .accounts
        .iter()
        .map(|meta| {
            let metas = instructions
                .iter()
                .flat_map(|i| i.accounts.iter())
                .filter(|m| m.pubkey == meta.pubkey);
            let (mut is_signer, mut is_writable) = (meta.pubkey == *payer, meta.pubkey == *payer);
            for m in metas {
                is_signer |= m.is_signer;
                is_writable |= m.is_writable;
            }
            CommittedAccount {
                pubkey: meta.pubkey.to_bytes(),
                is_signer,
                is_writable,
            }
        })
        .collect()
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    mint: Address,
    recipient: Address,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_path())
            .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let mint = Keypair::new();
        let space =
            ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::ScaledUiAmount])
                .unwrap();
        let rent = svm.minimum_balance_for_rent_exemption(space);
        let owner = payer.pubkey();
        let tx = Transaction::new_signed_with_payer(
            &[
                create_account(&owner, &mint.pubkey(), rent, space as u64, &TOKEN_2022),
                scaled_ui_amount::instruction::initialize(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    Some(owner),
                    1.0,
                )
                .unwrap(),
                initialize_mint2(&TOKEN_2022, &mint.pubkey(), &owner, None, DECIMALS).unwrap(),
            ],
            Some(&owner),
            &[&payer, &mint],
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx).unwrap();

        let recipient = Keypair::new().pubkey();
        let mut env = Self {
            svm,
            payer,
            mint: mint.pubkey(),
            recipient,
        };
        let payer = env.payer.pubkey();
        let mint = env.mint;
        env.send(vec![
            create_ata(&payer, &payer, &mint),
            mint_to(&TOKEN_2022, &mint, &ata(&payer, &mint), &payer, &[], MINTED).unwrap(),
            create_ata(&payer, &recipient, &mint),
        ])
        .unwrap();
        env
    }

    fn state(&self) -> ProtectedState {
        let account = self.svm.get_account(&self.mint).unwrap();
        decode_protected_state(&account.owner, &account.data).unwrap()
    }

    fn transfer(&self) -> Instruction {
        let payer = self.payer.pubkey();
        transfer_checked(
            &TOKEN_2022,
            &ata(&payer, &self.mint),
            &self.mint,
            &ata(&self.recipient, &self.mint),
            &payer,
            &[],
            AMOUNT,
            DECIMALS,
        )
        .unwrap()
    }

    fn guard(&self, downstream: &Instruction, layout: &[Instruction]) -> Instruction {
        let request = AssertSafeExecutionV2 {
            expected_mint: self.mint,
            execution: AssertSafeExecution {
                expected: self.state(),
                expected_phase: ActivationPhase::Activated,
                window: WINDOW,
            },
            adapter: DownstreamAdapter::Token2022TransferChecked,
            downstream_commitment: downstream_commitment(
                &downstream.program_id.to_bytes(),
                &committed_accounts(layout, &self.payer.pubkey(), downstream),
                &downstream.data,
            )
            .unwrap(),
        };
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
            ],
            data: request.pack().to_vec(),
        }
    }

    /// Builds `layout`, substituting a guard committed to `downstream` wherever
    /// the layout has `None`, then sends it.
    fn run(
        &mut self,
        layout: &[Option<Instruction>],
        downstream: &Instruction,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let placeholder = self.guard(downstream, std::slice::from_ref(downstream));
        let concrete: Vec<Instruction> = layout
            .iter()
            .map(|i| i.clone().unwrap_or_else(|| placeholder.clone()))
            .collect();
        let guard = self.guard(downstream, &concrete);
        let instructions: Vec<Instruction> = layout
            .iter()
            .map(|i| i.clone().unwrap_or_else(|| guard.clone()))
            .collect();
        self.send(instructions)
    }

    fn send(
        &mut self,
        instructions: Vec<Instruction>,
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        self.svm.expire_blockhash();
        let payer = self.payer.pubkey();
        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&payer),
            &[&self.payer],
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }

    fn token_balance(&self, account: &Address) -> Option<u64> {
        let account = self.svm.get_account(account).filter(|a| a.lamports > 0)?;
        Some(u64::from_le_bytes(account.data[64..72].try_into().unwrap()))
    }

    fn delivered(&self) -> Option<u64> {
        self.token_balance(&ata(&self.recipient, &self.mint))
    }
}

#[test]
fn guard_at_index_zero_reads_the_sysvar_and_protects_the_next_instruction() {
    let mut env = Env::new();
    let transfer = env.transfer();
    let before = env.delivered();
    let meta = env
        .run(&[None, Some(transfer.clone())], &transfer)
        .expect("guard at index 0 must pass");
    assert!(meta.logs.iter().any(|l| l.contains("EquityGuard: safe")));
    assert_eq!(env.delivered(), before.map(|b| b + AMOUNT));

    // And still binds: a guard at index 0 committed to a different amount fails.
    let other = env.transfer();
    let mut wrong = other.clone();
    wrong.data = spl_token_2022_interface::instruction::TokenInstruction::TransferChecked {
        amount: AMOUNT + 1,
        decimals: DECIMALS,
    }
    .pack();
    let before = env.delivered();
    let error = env.run(&[None, Some(transfer)], &wrong).unwrap_err().err;
    assert_eq!(
        error,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(EquityGuardError::DownstreamCommitmentMismatch as u32)
        )
    );
    assert_eq!(
        env.delivered(),
        before,
        "nothing settles when the guard fails"
    );
}

#[test]
fn a_compute_unit_limit_is_honoured_wherever_it_sits() {
    let mut env = Env::new();
    let transfer = env.transfer();
    let price = set_compute_unit_price(1_000);

    // Layout A: today's shape, budget first. Layout B: the guard at index 0
    // with the budget instructions after it.
    let layouts: [(&str, Vec<Option<Instruction>>); 2] = [
        (
            "budget first",
            vec![
                Some(price.clone()),
                Some(set_compute_unit_limit(GENEROUS_COMPUTE_UNIT_LIMIT)),
                None,
                Some(transfer.clone()),
            ],
        ),
        (
            "guard first",
            vec![
                None,
                Some(transfer.clone()),
                Some(price.clone()),
                Some(set_compute_unit_limit(GENEROUS_COMPUTE_UNIT_LIMIT)),
            ],
        ),
    ];
    for (label, layout) in layouts {
        let before = env.delivered();
        let meta = env
            .run(&layout, &transfer)
            .unwrap_or_else(|failed| panic!("{label} must pass: {:?}", failed.err));
        assert_eq!(env.delivered(), before.map(|b| b + AMOUNT), "{label}");
        assert!(
            meta.compute_units_consumed < u64::from(GENEROUS_COMPUTE_UNIT_LIMIT),
            "{label}"
        );

        // The same layout with a limit below the guard's own cost must fail,
        // which is what proves the limit was applied rather than ignored.
        let tight: Vec<Option<Instruction>> = layout
            .iter()
            .map(|i| match i {
                Some(instruction)
                    if instruction.program_id == COMPUTE_BUDGET && instruction.data[0] == 2 =>
                {
                    Some(set_compute_unit_limit(TIGHT_COMPUTE_UNIT_LIMIT))
                }
                other => other.clone(),
            })
            .collect();
        let before = env.delivered();
        let guard_index = u8::try_from(tight.iter().position(Option::is_none).unwrap()).unwrap();
        let error = env.run(&tight, &transfer).unwrap_err().err;
        // Exhausting the budget inside the program surfaces as
        // `ProgramFailedToComplete`; exhausting it at the boundary surfaces as
        // `ComputationalBudgetExceeded`. Either proves the limit was applied.
        assert!(
            matches!(
                error,
                TransactionError::InstructionError(
                    index,
                    InstructionError::ComputationalBudgetExceeded
                        | InstructionError::ProgramFailedToComplete
                ) if index == guard_index
            ),
            "{label} must run out of compute at the guard, got {error:?}"
        );
        assert_eq!(env.delivered(), before, "{label}: nothing settles");
    }
}

#[test]
fn adapter_kind_one_is_what_forbids_the_jupiter_layout_not_the_runtime() {
    let mut env = Env::new();
    let transfer = env.transfer();
    // The M9D-B target shape: guard, budget, setup, trade.
    let layout = vec![
        None,
        Some(set_compute_unit_price(1_000)),
        Some(set_compute_unit_limit(GENEROUS_COMPUTE_UNIT_LIMIT)),
        Some(transfer.clone()),
    ];
    let error = env.run(&layout, &transfer).unwrap_err().err;
    assert_eq!(
        error,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(EquityGuardError::UnsupportedDownstreamProgram as u32)
        ),
        "kind 1 refuses because the next instruction is ComputeBudget, not because the \
         runtime objects to the ordering"
    );
}
