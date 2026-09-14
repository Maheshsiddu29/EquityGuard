//! Atomicity tests against the compiled SBF program in LiteSVM.
//!
//! Each transaction is `[assert_safe_execution, system transfer]`. The
//! transfer is the observable downstream effect: it must settle only when the
//! guard passes.
//!
//! Requires the program artifact: run `cargo build-sbf` first (or
//! `cargo test-sbf`, which sets `SBF_OUT_DIR`).

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use equity_guard::{
    error::EquityGuardError,
    instruction::{AssertSafeExecution, ProtectionWindow},
    state::{decode_protected_state, ActivationPhase, ProtectedState},
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction::transfer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::extension::{
    scaled_ui_amount::{PodF64, ScaledUiAmountConfig},
    BaseStateWithExtensionsMut, StateWithExtensionsMut,
};

/// Load at the declared program ID, as on devnet.
const PROGRAM_ID: Address = equity_guard::ID;
/// Real UNHx mint address; its account bytes come from the mainnet fixture.
const MINT: Address = Address::from_str_const("XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe");
const LEGACY_TOKEN_PROGRAM: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PAYER_LAMPORTS: u64 = 10_000_000_000;
const TRANSFER_LAMPORTS: u64 = 1_000_000;
/// Wallclock of the fixture capture (slot 446827429).
const FIXTURE_CAPTURE_TIME: i64 = 1_789_335_689;
/// Example window for tests only; not an issuer policy.
const WINDOW: ProtectionWindow = ProtectionWindow {
    before_secs: 900,
    after_secs: 900,
};
/// Upper bound on guard compute usage, enforcing the minimal-overhead
/// invariant (docs/invariants.md I-5). Measured usage is well below this.
const MAX_GUARD_COMPUTE_UNITS: u64 = 20_000;

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

fn unhx_fixture() -> Vec<u8> {
    let encoded = include_str!("fixtures/mainnet/UNHx.base64");
    STANDARD.decode(encoded.trim()).unwrap()
}

fn edit_config(mut data: Vec<u8>, edit: impl FnOnce(&mut ScaledUiAmountConfig)) -> Vec<u8> {
    let mut mint =
        StateWithExtensionsMut::<spl_token_2022_interface::state::Mint>::unpack(&mut data).unwrap();
    edit(mint.get_extension_mut::<ScaledUiAmountConfig>().unwrap());
    data
}

fn decode(data: &[u8]) -> ProtectedState {
    decode_protected_state(&spl_token_2022_interface::ID, data).unwrap()
}

fn custom(error: EquityGuardError) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(error as u32))
}

struct Harness {
    svm: LiteSVM,
    payer: Keypair,
    recipient: Address,
}

impl Harness {
    fn new(mint_data: Vec<u8>) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_path())
            .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), PAYER_LAMPORTS).unwrap();
        let mut harness = Self {
            svm,
            payer,
            recipient: Address::new_from_array([0x42; 32]),
        };
        harness.set_mint(mint_data, spl_token_2022_interface::ID);
        harness
    }

    fn set_mint(&mut self, data: Vec<u8>, owner: Address) {
        let account = Account {
            lamports: PAYER_LAMPORTS,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(MINT, account).unwrap();
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn recipient_balance(&self) -> u64 {
        self.svm.get_balance(&self.recipient).unwrap_or(0)
    }

    /// Sends `[guard, transfer]` and returns the transaction outcome plus the
    /// compute units consumed.
    fn execute_with_accounts(
        &mut self,
        request: &AssertSafeExecution,
        guard_accounts: Vec<AccountMeta>,
    ) -> Result<u64, TransactionError> {
        // Fresh blockhash so repeated identical transactions are not deduplicated.
        self.svm.expire_blockhash();
        let guard = Instruction {
            program_id: PROGRAM_ID,
            accounts: guard_accounts,
            data: request.pack().to_vec(),
        };
        let downstream = transfer(&self.payer.pubkey(), &self.recipient, TRANSFER_LAMPORTS);
        let tx = Transaction::new_signed_with_payer(
            &[guard, downstream],
            Some(&self.payer.pubkey()),
            &[&self.payer],
            self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(tx)
            .map(|meta| meta.compute_units_consumed)
            .map_err(|failed| failed.err)
    }

    fn execute(&mut self, request: &AssertSafeExecution) -> Result<u64, TransactionError> {
        self.execute_with_accounts(request, vec![AccountMeta::new_readonly(MINT, false)])
    }

    /// Asserts the transaction fails with `error` and nothing downstream settles.
    fn assert_rejected(&mut self, request: &AssertSafeExecution, error: EquityGuardError) {
        let before = self.recipient_balance();
        assert_eq!(self.execute(request), Err(custom(error)));
        assert_eq!(
            self.recipient_balance(),
            before,
            "transfer settled despite {error:?}"
        );
    }
}

#[test]
fn case_a_safe_state_executes_downstream() {
    let data = unhx_fixture();
    let request = AssertSafeExecution {
        expected: decode(&data),
        expected_phase: ActivationPhase::Activated,
        window: WINDOW,
    };
    let mut harness = Harness::new(data);
    harness.set_time(FIXTURE_CAPTURE_TIME);

    assert_eq!(harness.recipient_balance(), 0);
    let compute_units = harness.execute(&request).unwrap();
    assert_eq!(harness.recipient_balance(), TRANSFER_LAMPORTS);
    // Includes the system transfer, so it over-counts the guard alone.
    assert!(
        compute_units <= MAX_GUARD_COMPUTE_UNITS,
        "consumed {compute_units} compute units"
    );
}

#[test]
fn case_b_guard_failure_reverts_entire_transaction() {
    let original = unhx_fixture();
    let request = AssertSafeExecution {
        expected: decode(&original),
        expected_phase: ActivationPhase::Activated,
        window: WINDOW,
    };
    let mut harness = Harness::new(original.clone());
    harness.set_time(FIXTURE_CAPTURE_TIME);

    let bump = |bytes: [u8; 8]| f64::from_bits(u64::from_le_bytes(bytes) + 1).to_le_bytes();
    type Edit = Box<dyn Fn(&mut ScaledUiAmountConfig)>;
    let state_changes: [(Edit, EquityGuardError); 3] = [
        (
            Box::new(move |c| c.multiplier = PodF64(bump(c.multiplier.0))),
            EquityGuardError::MultiplierChanged,
        ),
        (
            Box::new(move |c| c.new_multiplier = PodF64(bump(c.new_multiplier.0))),
            EquityGuardError::NewMultiplierChanged,
        ),
        (
            Box::new(|c| {
                let t = i64::from(c.new_multiplier_effective_timestamp);
                c.new_multiplier_effective_timestamp = (t + 60).into();
            }),
            EquityGuardError::EffectiveTimestampChanged,
        ),
    ];
    for (edit, error) in state_changes {
        harness.set_mint(
            edit_config(original.clone(), edit),
            spl_token_2022_interface::ID,
        );
        harness.assert_rejected(&request, error);
    }

    harness.set_mint(original.clone(), LEGACY_TOKEN_PROGRAM);
    harness.assert_rejected(&request, EquityGuardError::InvalidMintOwner);

    harness.set_mint(original, spl_token_2022_interface::ID);
    let before = harness.recipient_balance();
    assert_eq!(
        harness.execute_with_accounts(
            &request,
            vec![
                AccountMeta::new_readonly(MINT, false),
                AccountMeta::new_readonly(harness.recipient, false),
            ],
        ),
        Err(custom(EquityGuardError::InvalidAccountCount))
    );
    assert_eq!(harness.recipient_balance(), before);

    // Restored state executes again: failures were caused by the guard alone.
    assert!(harness.execute(&request).is_ok());
    assert_eq!(harness.recipient_balance(), before + TRANSFER_LAMPORTS);
}

#[test]
fn case_c_clock_crossing_fails_with_identical_mint_bytes() {
    let data = unhx_fixture();
    let state = decode(&data);
    let activation = state.new_multiplier_effective_timestamp;
    // Built before the protection window, while `multiplier` was effective.
    let request = AssertSafeExecution {
        expected: state,
        expected_phase: ActivationPhase::Pending,
        window: WINDOW,
    };
    let mut harness = Harness::new(data.clone());
    let before_window = activation - i64::from(WINDOW.before_secs) - 1;

    harness.set_time(before_window);
    assert!(harness.execute(&request).is_ok());
    assert_eq!(harness.recipient_balance(), TRANSFER_LAMPORTS);

    harness.set_time(activation - i64::from(WINDOW.before_secs));
    harness.assert_rejected(&request, EquityGuardError::InsideTransitionWindow);

    harness.set_time(activation);
    harness.assert_rejected(&request, EquityGuardError::InsideTransitionWindow);

    // Past the window the multiplier in effect is `new_multiplier`, which the
    // client never priced against.
    harness.set_time(activation + i64::from(WINDOW.after_secs) + 1);
    harness.assert_rejected(&request, EquityGuardError::ActivationPhaseChanged);

    let mint = harness.svm.get_account(&MINT).unwrap();
    assert_eq!(mint.data, data, "mint bytes must be unchanged throughout");
    assert_eq!(harness.recipient_balance(), TRANSFER_LAMPORTS);
}
