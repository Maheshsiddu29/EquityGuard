//! ABI v2 adversarial and atomicity tests against the compiled SBF program in
//! LiteSVM, with the real Token-2022 and Associated Token Account programs.
//!
//! Every mint and token account is created through real Token-2022
//! instructions. The guarded delivery is
//! `[optional create ATA] -> guard v2 -> TransferChecked`.
//!
//! Requires the program artifact: run `cargo build-sbf` first (or
//! `cargo test-sbf`, which sets `SBF_OUT_DIR`).

// Test harness code: a panic is the correct way to fail a test, and LiteSVM's
// failure metadata is returned as-is.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use std::path::PathBuf;

use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount},
    error::EquityGuardError,
    instruction::{
        AssertSafeExecution, AssertSafeExecutionV2, DownstreamAdapter, ProtectionWindow,
    },
    state::{decode_protected_state, ActivationPhase, ProtectedState, StoredMultiplier},
};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction::{create_account, transfer as system_transfer};
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::{
    extension::{scaled_ui_amount, ExtensionType},
    instruction::{approve, initialize_mint2, mint_to, transfer_checked},
    state::Mint,
};

const PROGRAM_ID: Address = equity_guard::ID;
const TOKEN_2022: Address = spl_token_2022_interface::ID;
const LEGACY_TOKEN: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Address = solana_instructions_sysvar::ID;
const DECIMALS: u8 = 6;
const MINTED: u64 = 1_000_000_000;
const AMOUNT: u64 = 5_990_000;
/// KOx's real ScaledUiAmount values (mainnet fixture, slot 446827429).
const KOX_MULTIPLIER: f64 = 1.018_331_796_738_689_8;
const KOX_NEW_MULTIPLIER: f64 = 1.022_560_124_624_923_8;
const NOW: i64 = 1_789_400_000;
const WINDOW: ProtectionWindow = ProtectionWindow {
    before_secs: 900,
    after_secs: 300,
};
/// Upper bound on the whole guard + transfer transaction's compute units.
const MAX_TRANSACTION_COMPUTE_UNITS: u64 = 40_000;

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
        // CreateIdempotent
        data: vec![1],
    }
}

fn custom(index: u8, error: EquityGuardError) -> TransactionError {
    TransactionError::InstructionError(index, InstructionError::Custom(error as u32))
}

/// Transaction-level signer/writable flags, as exposed by the Instructions sysvar.
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

fn commitment_of(instructions: &[Instruction], payer: &Address, target: &Instruction) -> [u8; 32] {
    downstream_commitment(
        &target.program_id.to_bytes(),
        &committed_accounts(instructions, payer, target),
        &target.data,
    )
    .unwrap()
}

struct Guard {
    expected_mint: Address,
    account0: Address,
    sysvar: Address,
    expected: ProtectedState,
    phase: ActivationPhase,
    window: ProtectionWindow,
    commitment: [u8; 32],
}

impl Guard {
    fn instruction(&self) -> Instruction {
        let request = AssertSafeExecutionV2 {
            expected_mint: self.expected_mint,
            execution: AssertSafeExecution {
                expected: self.expected,
                expected_phase: self.phase,
                window: self.window,
            },
            adapter: DownstreamAdapter::Token2022TransferChecked,
            downstream_commitment: self.commitment,
        };
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.account0, false),
                AccountMeta::new_readonly(self.sysvar, false),
            ],
            data: request.pack().to_vec(),
        }
    }
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    /// Protected mint X, and a second mint Y with identical economic state.
    mint_x: Address,
    mint_y: Address,
    recipient: Address,
}

impl Env {
    fn new(multiplier: f64) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_path())
            .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let mut env = Self {
            svm,
            payer,
            mint_x: Address::default(),
            mint_y: Address::default(),
            recipient: Keypair::new().pubkey(),
        };
        env.set_time(NOW);
        env.mint_x = env.create_mint(multiplier);
        env.mint_y = env.create_mint(multiplier);
        let payer = env.payer.pubkey();
        let recipient = env.recipient;
        for mint in [env.mint_x, env.mint_y] {
            env.send(vec![
                create_ata(&payer, &payer, &mint),
                mint_to(&TOKEN_2022, &mint, &ata(&payer, &mint), &payer, &[], MINTED).unwrap(),
                create_ata(&payer, &recipient, &mint),
            ])
            .unwrap();
        }
        env
    }

    fn create_mint(&mut self, multiplier: f64) -> Address {
        let mint = Keypair::new();
        let space =
            ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::ScaledUiAmount])
                .unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(space);
        let payer = self.payer.pubkey();
        let instructions = vec![
            create_account(&payer, &mint.pubkey(), rent, space as u64, &TOKEN_2022),
            scaled_ui_amount::instruction::initialize(
                &TOKEN_2022,
                &mint.pubkey(),
                Some(payer),
                multiplier,
            )
            .unwrap(),
            initialize_mint2(&TOKEN_2022, &mint.pubkey(), &payer, None, DECIMALS).unwrap(),
        ];
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&payer),
            &[&self.payer, &mint],
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).unwrap();
        mint.pubkey()
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn state(&self, mint: &Address) -> ProtectedState {
        let account = self.svm.get_account(mint).unwrap();
        decode_protected_state(&account.owner, &account.data).unwrap()
    }

    fn token_balance(&self, account: &Address) -> Option<u64> {
        let account = self.svm.get_account(account).filter(|a| a.lamports > 0)?;
        Some(u64::from_le_bytes(account.data[64..72].try_into().unwrap()))
    }

    fn transfer(
        &self,
        mint: &Address,
        source: &Address,
        destination: &Address,
        amount: u64,
    ) -> Instruction {
        let payer = self.payer.pubkey();
        transfer_checked(
            &TOKEN_2022,
            source,
            mint,
            destination,
            &payer,
            &[],
            amount,
            DECIMALS,
        )
        .unwrap()
    }

    fn standard_transfer(&self) -> Instruction {
        let payer = self.payer.pubkey();
        self.transfer(
            &self.mint_x,
            &ata(&payer, &self.mint_x),
            &ata(&self.recipient, &self.mint_x),
            AMOUNT,
        )
    }

    /// A guard for mint X at its current state, committing to `commit_to`
    /// placed in `layout` (the guard itself is `None` in the layout).
    fn guard_for(&self, layout: &[Option<Instruction>], commit_to: &Instruction) -> Guard {
        let placeholder = Guard {
            expected_mint: self.mint_x,
            account0: self.mint_x,
            sysvar: INSTRUCTIONS_SYSVAR,
            expected: self.state(&self.mint_x),
            phase: ActivationPhase::Activated,
            window: WINDOW,
            commitment: [0; 32],
        };
        let concrete: Vec<Instruction> = layout
            .iter()
            .map(|i| i.clone().unwrap_or_else(|| placeholder.instruction()))
            .collect();
        Guard {
            commitment: commitment_of(&concrete, &self.payer.pubkey(), commit_to),
            ..placeholder
        }
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

    /// Sends `layout` with `guard` in its `None` slot; returns the error, if any.
    fn run(
        &mut self,
        layout: Vec<Option<Instruction>>,
        guard: &Guard,
    ) -> Result<(), TransactionError> {
        let instructions = layout
            .into_iter()
            .map(|i| i.unwrap_or_else(|| guard.instruction()))
            .collect();
        self.send(instructions)
            .map(|_| ())
            .map_err(|failed| failed.err)
    }

    fn balances(&self) -> (Option<u64>, Option<u64>) {
        let payer = self.payer.pubkey();
        (
            self.token_balance(&ata(&payer, &self.mint_x)),
            self.token_balance(&ata(&self.recipient, &self.mint_x)),
        )
    }
}

/// Guard program compute units from the transaction logs.
fn guard_units(logs: &[String]) -> u64 {
    let prefix = format!("Program {PROGRAM_ID} consumed ");
    logs.iter()
        .find_map(|line| {
            line.strip_prefix(&prefix)?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        })
        .unwrap()
}

#[test]
fn q_valid_exact_guarded_transfer_passes_and_delivers() {
    let mut env = Env::new(1.0);
    let transfer = env.standard_transfer();
    let guard = env.guard_for(&[None, Some(transfer.clone())], &transfer);
    let before = env.balances();
    let meta = env.send(vec![guard.instruction(), transfer]).unwrap();
    assert_eq!(
        env.balances(),
        (before.0.map(|b| b - AMOUNT), before.1.map(|b| b + AMOUNT))
    );
    assert!(meta.logs.iter().any(|l| l.contains("EquityGuard: safe")));
    let units = guard_units(&meta.logs);
    println!(
        "ABI v2 guard pass compute units: {units} (transaction total {})",
        meta.compute_units_consumed
    );
    assert!(meta.compute_units_consumed <= MAX_TRANSACTION_COMPUTE_UNITS);
}

/// Asserts `layout` with `guard` fails with `error` at the guard's index and moves no tokens.
fn assert_rejected(
    env: &mut Env,
    layout: Vec<Option<Instruction>>,
    guard: &Guard,
    error: EquityGuardError,
) {
    let index = u8::try_from(layout.iter().position(Option::is_none).unwrap()).unwrap();
    let before = env.balances();
    assert_eq!(env.run(layout, guard), Err(custom(index, error)));
    assert_eq!(env.balances(), before, "tokens moved despite {error:?}");
}

#[test]
fn a_mint_identity_is_bound() {
    let mut env = Env::new(1.0);
    assert_eq!(
        env.state(&env.mint_x),
        env.state(&env.mint_y),
        "precondition: identical economic state"
    );
    let transfer = env.standard_transfer();
    let guard = Guard {
        account0: env.mint_y,
        ..env.guard_for(&[None, Some(transfer.clone())], &transfer)
    };
    assert_rejected(
        &mut env,
        vec![None, Some(transfer)],
        &guard,
        EquityGuardError::MintKeyMismatch,
    );
}

#[test]
fn b_action_mint_must_be_the_protected_mint() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let transfer_y = env.transfer(
        &env.mint_y,
        &ata(&payer, &env.mint_y),
        &ata(&env.recipient, &env.mint_y),
        AMOUNT,
    );
    // The commitment matches the actual Y transfer: only the mint binding catches it.
    let guard = env.guard_for(&[None, Some(transfer_y.clone())], &transfer_y);
    let before_y = env.token_balance(&ata(&env.recipient, &env.mint_y));
    assert_eq!(
        env.run(vec![None, Some(transfer_y)], &guard),
        Err(custom(0, EquityGuardError::DownstreamMintMismatch))
    );
    assert_eq!(
        env.token_balance(&ata(&env.recipient, &env.mint_y)),
        before_y
    );
}

#[test]
fn c_action_before_the_guard_is_not_protected_and_reverts() {
    let mut env = Env::new(1.0);
    let transfer = env.standard_transfer();
    let guard = env.guard_for(&[Some(transfer.clone()), None], &transfer);
    assert_rejected(
        &mut env,
        vec![Some(transfer), None],
        &guard,
        EquityGuardError::MissingDownstreamInstruction,
    );
}

#[test]
fn d_unrelated_next_instruction_is_rejected() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let lamports = system_transfer(&payer, &env.recipient, 1_000);
    let guard = env.guard_for(&[None, Some(lamports.clone())], &lamports);
    assert_rejected(
        &mut env,
        vec![None, Some(lamports)],
        &guard,
        EquityGuardError::UnsupportedDownstreamProgram,
    );
}

#[test]
fn e_instruction_inserted_between_guard_and_transfer_is_rejected() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let transfer = env.standard_transfer();
    let inserted = system_transfer(&payer, &env.recipient, 1_000);
    let layout = vec![None, Some(inserted), Some(transfer.clone())];
    let guard = env.guard_for(&layout, &transfer);
    assert_rejected(
        &mut env,
        layout,
        &guard,
        EquityGuardError::UnsupportedDownstreamProgram,
    );
    // Inserting another Token-2022 TransferChecked of the same mint fails the commitment instead.
    let small = env.transfer(
        &env.mint_x,
        &ata(&payer, &env.mint_x),
        &ata(&env.recipient, &env.mint_x),
        1,
    );
    let layout = vec![None, Some(small), Some(transfer.clone())];
    let guard = env.guard_for(&layout, &transfer);
    assert_rejected(
        &mut env,
        layout,
        &guard,
        EquityGuardError::DownstreamCommitmentMismatch,
    );
}

#[test]
fn f_to_k_any_substitution_in_the_committed_transfer_is_rejected() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let alt = Keypair::new();
    // A second destination and a second payer-owned source for X.
    env.send(vec![create_ata(&payer, &alt.pubkey(), &env.mint_x)])
        .unwrap();
    let committed = env.standard_transfer();
    let guard = env.guard_for(&[None, Some(committed.clone())], &committed);
    let source = ata(&payer, &env.mint_x);
    let destination = ata(&env.recipient, &env.mint_x);

    let mut authority_substituted = committed.clone();
    authority_substituted.accounts[3] = AccountMeta::new_readonly(alt.pubkey(), false);
    let mut swapped = committed.clone();
    swapped.accounts.swap(0, 2);

    let cases: Vec<(&str, Instruction)> = vec![
        (
            "F amount",
            env.transfer(&env.mint_x, &source, &destination, AMOUNT + 1),
        ),
        (
            "F decimals",
            transfer_checked(
                &TOKEN_2022,
                &source,
                &env.mint_x,
                &destination,
                &payer,
                &[],
                AMOUNT,
                DECIMALS + 1,
            )
            .unwrap(),
        ),
        (
            "G destination",
            env.transfer(
                &env.mint_x,
                &source,
                &ata(&alt.pubkey(), &env.mint_x),
                AMOUNT,
            ),
        ),
        (
            "H source",
            env.transfer(&env.mint_x, &destination, &destination, AMOUNT),
        ),
        ("I authority", authority_substituted),
        ("K account order", swapped),
    ];
    for (label, actual) in cases {
        let before = env.balances();
        assert_eq!(
            env.run(vec![None, Some(actual)], &guard),
            Err(custom(0, EquityGuardError::DownstreamCommitmentMismatch)),
            "{label}"
        );
        assert_eq!(env.balances(), before, "{label}");
    }

    // J: a commitment made with different account flags does not match the real instruction.
    let mut flags = committed_accounts(
        &[guard.instruction(), committed.clone()],
        &payer,
        &committed,
    );
    flags[2].is_writable = false;
    let wrong_flags = Guard {
        commitment: downstream_commitment(&TOKEN_2022.to_bytes(), &flags, &committed.data).unwrap(),
        ..env.guard_for(&[None, Some(committed.clone())], &committed)
    };
    assert_rejected(
        &mut env,
        vec![None, Some(committed.clone())],
        &wrong_flags,
        EquityGuardError::DownstreamCommitmentMismatch,
    );
    let mut signer_flags = committed_accounts(
        &[guard.instruction(), committed.clone()],
        &payer,
        &committed,
    );
    signer_flags[3].is_signer = false;
    let wrong_signer = Guard {
        commitment: downstream_commitment(&TOKEN_2022.to_bytes(), &signer_flags, &committed.data)
            .unwrap(),
        ..wrong_flags
    };
    assert_rejected(
        &mut env,
        vec![None, Some(committed)],
        &wrong_signer,
        EquityGuardError::DownstreamCommitmentMismatch,
    );
}

#[test]
fn l_wrong_token_program_and_unsupported_token_instructions_are_rejected() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let source = ata(&payer, &env.mint_x);
    let destination = ata(&env.recipient, &env.mint_x);
    let mut legacy = env.standard_transfer();
    legacy.program_id = LEGACY_TOKEN;
    let guard = env.guard_for(&[None, Some(legacy.clone())], &legacy);
    assert_rejected(
        &mut env,
        vec![None, Some(legacy)],
        &guard,
        EquityGuardError::UnsupportedDownstreamProgram,
    );

    #[allow(deprecated)]
    let plain = spl_token_2022_interface::instruction::transfer(
        &TOKEN_2022,
        &source,
        &destination,
        &payer,
        &[],
        AMOUNT,
    )
    .unwrap();
    let approval = approve(&TOKEN_2022, &source, &env.recipient, &payer, &[], AMOUNT).unwrap();
    let mut trailing = env.standard_transfer();
    trailing.data.push(0);
    for (label, instruction) in [
        ("Transfer", plain),
        ("Approve", approval),
        ("TransferChecked with trailing data", trailing),
    ] {
        let guard = env.guard_for(&[None, Some(instruction.clone())], &instruction);
        assert_eq!(
            env.run(vec![None, Some(instruction)], &guard),
            Err(custom(
                0,
                EquityGuardError::UnsupportedDownstreamInstruction
            )),
            "{label}"
        );
    }
}

#[test]
fn m_n_o_missing_next_instruction_foreign_sysvar_bad_accounts_and_abi_v1() {
    let mut env = Env::new(1.0);
    let transfer = env.standard_transfer();
    let guard = env.guard_for(&[None], &transfer);
    assert_rejected(
        &mut env,
        vec![None],
        &guard,
        EquityGuardError::MissingDownstreamInstruction,
    );

    let valid = env.guard_for(&[None, Some(transfer.clone())], &transfer);
    let foreign = Guard {
        sysvar: Keypair::new().pubkey(),
        ..valid
    };
    assert_rejected(
        &mut env,
        vec![None, Some(transfer.clone())],
        &foreign,
        EquityGuardError::InvalidInstructionsSysvar,
    );

    let valid = env.guard_for(&[None, Some(transfer.clone())], &transfer);
    for accounts in [
        vec![AccountMeta::new_readonly(env.mint_x, false)],
        vec![
            AccountMeta::new_readonly(env.mint_x, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
            AccountMeta::new_readonly(env.recipient, false),
        ],
    ] {
        let mut instruction = valid.instruction();
        instruction.accounts = accounts;
        let before = env.balances();
        assert_eq!(
            env.send(vec![instruction, transfer.clone()])
                .map(|_| ())
                .map_err(|f| f.err),
            Err(custom(0, EquityGuardError::InvalidAccountCount))
        );
        assert_eq!(env.balances(), before);
    }

    // O: a complete ABI v1 payload for the same state.
    let state = env.state(&env.mint_x);
    let mut v1 = vec![1_u8];
    v1.extend(state.multiplier.to_bytes());
    v1.extend(state.new_multiplier.to_bytes());
    v1.extend(state.new_multiplier_effective_timestamp.to_le_bytes());
    v1.push(ActivationPhase::Activated as u8);
    v1.extend(900_u32.to_le_bytes());
    v1.extend(900_u32.to_le_bytes());
    for accounts in [
        vec![AccountMeta::new_readonly(env.mint_x, false)],
        valid.instruction().accounts,
    ] {
        let before = env.balances();
        let instruction = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: v1.clone(),
        };
        assert_eq!(
            env.send(vec![instruction, transfer.clone()])
                .map(|_| ())
                .map_err(|f| f.err),
            Err(custom(0, EquityGuardError::UnsupportedVersion))
        );
        assert_eq!(env.balances(), before);
    }
}

#[test]
fn p_duplicate_scaled_ui_amount_extension_is_rejected() {
    let mut env = Env::new(1.0);
    let transfer = env.standard_transfer();
    let guard = env.guard_for(&[None, Some(transfer.clone())], &transfer);
    let mut account = env.svm.get_account(&env.mint_x).unwrap();
    // The mint's only TLV entry starts after the account-type byte; append a copy with other multipliers.
    let entry_start = 166;
    let mut entry = account.data[entry_start..entry_start + 60].to_vec();
    assert_eq!(
        u16::from_le_bytes([entry[0], entry[1]]),
        u16::from(ExtensionType::ScaledUiAmount)
    );
    entry[4 + 32..4 + 40].copy_from_slice(&9.0_f64.to_le_bytes());
    entry[4 + 48..4 + 56].copy_from_slice(&9.0_f64.to_le_bytes());
    account.data.extend_from_slice(&entry);
    env.svm.set_account(env.mint_x, account).unwrap();
    assert_rejected(
        &mut env,
        vec![None, Some(transfer)],
        &guard,
        EquityGuardError::InvalidMintData,
    );
}

#[test]
fn stale_state_and_owner_still_fail_under_v2() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let transfer = env.standard_transfer();
    let guard = env.guard_for(&[None, Some(transfer.clone())], &transfer);
    // Immediate issuer update after the payload was built.
    env.send(vec![scaled_ui_amount::instruction::update_multiplier(
        &TOKEN_2022,
        &env.mint_x,
        &payer,
        &[],
        1.25,
        0,
    )
    .unwrap()])
        .unwrap();
    assert_rejected(
        &mut env,
        vec![None, Some(transfer.clone())],
        &guard,
        EquityGuardError::MultiplierChanged,
    );

    // Same bytes, but the account is no longer owned by Token-2022.
    let fresh = env.guard_for(&[None, Some(transfer.clone())], &transfer);
    let mut account = env.svm.get_account(&env.mint_x).unwrap();
    account.owner = LEGACY_TOKEN;
    env.svm.set_account(env.mint_x, account).unwrap();
    assert_rejected(
        &mut env,
        vec![None, Some(transfer)],
        &fresh,
        EquityGuardError::InvalidMintOwner,
    );
}

#[test]
fn atomicity_rejected_guard_rolls_back_ata_creation_and_transfer() {
    let mut env = Env::new(1.0);
    let payer = env.payer.pubkey();
    let fresh_recipient = Keypair::new().pubkey();
    let destination = ata(&fresh_recipient, &env.mint_x);
    let source = ata(&payer, &env.mint_x);
    let create = create_ata(&payer, &fresh_recipient, &env.mint_x);
    let transfer = env.transfer(&env.mint_x, &source, &destination, AMOUNT);
    let layout = vec![Some(create.clone()), None, Some(transfer.clone())];
    let valid = env.guard_for(&layout, &transfer);

    // Stale expectation (a multiplier the mint no longer has): the guard rejects
    // at index 1, after the ATA creation instruction ran.
    let stale = Guard {
        expected: ProtectedState {
            multiplier: StoredMultiplier::new(2.0_f64.to_le_bytes()).unwrap(),
            ..valid.expected
        },
        ..env.guard_for(&layout, &transfer)
    };
    let source_before = env.token_balance(&source);
    assert_eq!(
        env.run(layout.clone(), &stale),
        Err(custom(1, EquityGuardError::MultiplierChanged))
    );
    assert_eq!(
        env.token_balance(&destination),
        None,
        "ATA creation must roll back"
    );
    assert!(env
        .svm
        .get_account(&destination)
        .is_none_or(|a| a.lamports == 0));
    assert_eq!(env.token_balance(&source), source_before);

    // The same layout with a valid guard creates the ATA and delivers exactly the committed amount.
    let meta = env
        .send(vec![create, valid.instruction(), transfer])
        .unwrap();
    assert_eq!(env.token_balance(&destination), Some(AMOUNT));
    assert_eq!(
        env.token_balance(&source),
        source_before.map(|b| b - AMOUNT)
    );
    println!(
        "ABI v2 guard compute units with ATA creation: {} (transaction total {})",
        guard_units(&meta.logs),
        meta.compute_units_consumed
    );
}

#[test]
fn kox_clock_crossing_with_identical_mint_bytes_is_still_rejected() {
    let mut env = Env::new(KOX_MULTIPLIER);
    let payer = env.payer.pubkey();
    let activation = NOW + 3_600;
    env.send(vec![scaled_ui_amount::instruction::update_multiplier(
        &TOKEN_2022,
        &env.mint_x,
        &payer,
        &[],
        KOX_NEW_MULTIPLIER,
        activation,
    )
    .unwrap()])
        .unwrap();
    let state = env.state(&env.mint_x);
    assert!(state.has_scheduled_change());
    assert_eq!(state.multiplier.to_bytes(), KOX_MULTIPLIER.to_le_bytes());
    assert_eq!(
        state.new_multiplier.to_bytes(),
        KOX_NEW_MULTIPLIER.to_le_bytes()
    );
    let bytes_before = env.svm.get_account(&env.mint_x).unwrap().data;

    let transfer = env.standard_transfer();
    // Built before the window while `multiplier` is effective.
    let pending = Guard {
        phase: ActivationPhase::Pending,
        ..env.guard_for(&[None, Some(transfer.clone())], &transfer)
    };

    env.set_time(activation - i64::from(WINDOW.before_secs) - 1);
    let before = env.balances();
    env.run(vec![None, Some(transfer.clone())], &pending)
        .unwrap();
    assert_eq!(env.balances().1, before.1.map(|b| b + AMOUNT));

    env.set_time(activation - i64::from(WINDOW.before_secs));
    assert_rejected(
        &mut env,
        vec![None, Some(transfer.clone())],
        &pending,
        EquityGuardError::InsideTransitionWindow,
    );
    env.set_time(activation);
    assert_rejected(
        &mut env,
        vec![None, Some(transfer.clone())],
        &pending,
        EquityGuardError::InsideTransitionWindow,
    );
    env.set_time(activation + i64::from(WINDOW.after_secs) + 1);
    let meta_err = {
        let before = env.balances();
        let result = env.send(vec![pending.instruction(), transfer.clone()]);
        assert_eq!(env.balances(), before);
        result.err().unwrap()
    };
    assert_eq!(
        meta_err.err,
        custom(0, EquityGuardError::ActivationPhaseChanged)
    );
    println!(
        "ABI v2 guard reject compute units: {}",
        guard_units(&meta_err.meta.logs)
    );

    assert_eq!(
        env.svm.get_account(&env.mint_x).unwrap().data,
        bytes_before,
        "mint bytes must be unchanged throughout"
    );
    // A fresh activated payload for the same bytes passes after the window.
    let activated = Guard {
        phase: ActivationPhase::Activated,
        ..pending
    };
    env.run(vec![None, Some(transfer)], &activated).unwrap();
}
