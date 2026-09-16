//! How the ABI v2 downstream binding's cost scales with the size of the
//! instruction it protects.
//!
//! The Token-2022 `TransferChecked` the guard protects today carries 4
//! accounts and 10 bytes of data. A Jupiter `route_v2` instruction carries 26
//! to 38 accounts and 39 to 53 bytes (observed on mainnet, 2026-09-16). The
//! guard's per-invocation work — loading the next instruction from the
//! Instructions sysvar and hashing it — grows with that size regardless of
//! which adapter validates the semantics, so this measures the growth against
//! the compiled program before any Jupiter adapter is designed around it.
//!
//! Extra accounts are appended to a real `TransferChecked`: SPL Token treats
//! accounts past the first four as multisig signers and ignores them for a
//! single-signer authority, so the transfer still settles and the guard still
//! hashes the full account list.
//!
//! Requires the program artifact: run `cargo build-sbf` first.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use std::path::PathBuf;

use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount},
    instruction::{
        AssertSafeExecution, AssertSafeExecutionV2, DownstreamAdapter, ProtectionWindow,
    },
    state::{decode_protected_state, ActivationPhase, ProtectedState},
};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction::create_account;
use solana_transaction::Transaction;
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
const INSTRUCTIONS_SYSVAR: Address = solana_instructions_sysvar::ID;
const DECIMALS: u8 = 6;
const MINTED: u64 = 1_000_000_000;
const AMOUNT: u64 = 1_000;
const NOW: i64 = 1_789_400_000;
const WINDOW: ProtectionWindow = ProtectionWindow {
    before_secs: 900,
    after_secs: 300,
};
/// Account counts of interest: the `TransferChecked` minimum, the observed
/// single-leg `route_v2` shape, and the observed two-leg one.
const ACCOUNT_COUNTS: [usize; 4] = [4, 10, 26, 38];
/// A guarded 38-account downstream instruction must stay far below the
/// per-instruction ceiling, since Jupiter itself needs the rest of the budget.
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

    /// A `TransferChecked` padded to `accounts` total accounts.
    fn padded_transfer(&self, accounts: usize) -> Instruction {
        let payer = self.payer.pubkey();
        let mut instruction = transfer_checked(
            &TOKEN_2022,
            &ata(&payer, &self.mint),
            &self.mint,
            &ata(&self.recipient, &self.mint),
            &payer,
            &[],
            AMOUNT,
            DECIMALS,
        )
        .unwrap();
        // Deterministic filler accounts, distinct from every real one.
        for i in instruction.accounts.len()..accounts {
            let mut bytes = [0_u8; 32];
            bytes[0] = 0xf0;
            bytes[1] = u8::try_from(i).unwrap();
            instruction.accounts.push(AccountMeta::new_readonly(
                Address::new_from_array(bytes),
                false,
            ));
        }
        instruction
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
}

#[test]
fn commitment_cost_grows_with_the_protected_instruction_and_stays_practical() {
    let mut env = Env::new();
    let mut measured: Vec<(usize, u64, usize)> = Vec::new();

    for accounts in ACCOUNT_COUNTS {
        let transfer = env.padded_transfer(accounts);
        // The guard's own data is fixed-length, so a placeholder guard gives
        // the same transaction-level flags as the real one.
        let placeholder = env.guard(&transfer, std::slice::from_ref(&transfer));
        let guard = env.guard(&transfer, &[placeholder, transfer.clone()]);
        // SHA-256 preimage: domain(25) + program(32) + count(4) + 34/account + len(4) + data.
        let preimage = 25 + 32 + 4 + 34 * accounts + 4 + transfer.data.len();
        let meta = env
            .send(vec![guard, transfer])
            .expect("padded transfer must still settle");
        let units = guard_units(&meta.logs);
        measured.push((accounts, units, preimage));
        assert!(
            units <= MAX_GUARD_COMPUTE_UNITS,
            "guard used {units} CU for a {accounts}-account downstream instruction"
        );
    }

    for (accounts, units, preimage) in &measured {
        println!(
            "downstream accounts {accounts:>3}  preimage {preimage:>5} B  guard {units:>6} CU"
        );
    }
    let (first_accounts, first_units, _) = measured[0];
    let (last_accounts, last_units, _) = measured[measured.len() - 1];
    let per_account = (last_units - first_units) as f64 / (last_accounts - first_accounts) as f64;
    println!("marginal cost: {per_account:.1} CU per downstream account");
    assert!(
        last_units > first_units,
        "cost must grow with the protected instruction"
    );
}
