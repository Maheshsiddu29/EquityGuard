//! Randomized differential: the host model versus the compiled SBF program.
//!
//! `common::evaluate` restates `processor.rs`'s ordering so the shared
//! conformance corpus can be evaluated off-runtime. This test is what stops
//! that restatement from drifting: for every generated case, the model's
//! verdict must equal the verdict the real program reaches inside LiteSVM,
//! with the real Token-2022 and Associated Token Account programs.
//!
//! The corpus is a deterministic product of a fixed seed, so a failing index
//! reproduces exactly. Requires the program artifact: run `cargo build-sbf`
//! first (or `cargo test-sbf`, which sets `SBF_OUT_DIR`).

// Test harness code: a panic is the correct way to fail a test, and LiteSVM's
// failure metadata is returned as-is.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use std::path::PathBuf;
use std::time::Instant;

use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount},
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
use solana_system_interface::instruction::transfer as system_transfer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::{
    extension::{scaled_ui_amount, ExtensionType},
    instruction::{initialize_mint2, mint_to, transfer_checked},
    state::Mint,
};

mod common;
use common::{error_name, evaluate, outcome, GuardAccount, GuardInvocation, Prng};

const PROGRAM_ID: Address = equity_guard::ID;
const TOKEN_2022: Address = spl_token_2022_interface::ID;
const LEGACY_TOKEN: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Address = solana_instructions_sysvar::ID;
const CLOCK_SYSVAR: Address =
    Address::from_str_const("SysvarC1ock11111111111111111111111111111111");

const DECIMALS: u8 = 6;
const MINTED: u64 = 1_000_000_000;
const AMOUNT: u64 = 5_990_000;
const BASE_MULTIPLIER: f64 = 1.018_331_796_738_689_8;
const NEW_MULTIPLIER: f64 = 1.022_560_124_624_923_8;
/// Chain time the environment starts at.
const NOW: i64 = 1_789_400_000;
/// Scheduled activation on mint X, comfortably after `NOW`.
const ACTIVATION: i64 = NOW + 100_000;

/// Fixed seed: the corpus must be identical on every machine and in CI.
const SEED: u64 = 0x9C_0D_1F_FE;

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

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    /// Mint X carries a scheduled multiplier change; mint Y is stable.
    mint_x: Address,
    mint_y: Address,
    recipient: Address,
    decoy: Address,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_path())
            .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let mut env = Self {
            svm,
            payer,
            mint_x: Address::default(),
            mint_y: Address::default(),
            recipient: Keypair::new().pubkey(),
            decoy: Keypair::new().pubkey(),
        };
        env.set_time(NOW);
        env.mint_x = env.create_mint();
        env.mint_y = env.create_mint();

        let payer = env.payer.pubkey();
        let (recipient, decoy) = (env.recipient, env.decoy);
        for mint in [env.mint_x, env.mint_y] {
            env.send(vec![
                create_ata(&payer, &payer, &mint),
                mint_to(&TOKEN_2022, &mint, &ata(&payer, &mint), &payer, &[], MINTED).unwrap(),
                create_ata(&payer, &recipient, &mint),
                create_ata(&payer, &decoy, &mint),
            ])
            .unwrap();
        }
        // Only mint X gets a scheduled change, so the clock cases have
        // something to cross and the stable cases stay stable.
        let mint_x = env.mint_x;
        env.send(vec![scaled_ui_amount::instruction::update_multiplier(
            &TOKEN_2022,
            &mint_x,
            &payer,
            &[],
            NEW_MULTIPLIER,
            ACTIVATION,
        )
        .unwrap()])
            .unwrap();
        env
    }

    fn create_mint(&mut self) -> Address {
        let mint = Keypair::new();
        let space =
            ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::ScaledUiAmount])
                .unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(space);
        let payer = self.payer.pubkey();
        let instructions = vec![
            solana_system_interface::instruction::create_account(
                &payer,
                &mint.pubkey(),
                rent,
                space as u64,
                &TOKEN_2022,
            ),
            scaled_ui_amount::instruction::initialize(
                &TOKEN_2022,
                &mint.pubkey(),
                Some(payer),
                BASE_MULTIPLIER,
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

    fn account(&self, key: &Address) -> GuardAccount {
        let account = self.svm.get_account(key).unwrap_or_default();
        GuardAccount {
            pubkey: *key,
            owner: account.owner,
            data: account.data,
        }
    }

    fn state(&self, mint: &Address) -> ProtectedState {
        let account = self.svm.get_account(mint).unwrap();
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
}

/// Transaction-level signer/writable flags, as the Instructions sysvar reports
/// them: merged across the whole message, with the fee payer writable and signing.
fn committed_accounts(
    instructions: &[Instruction],
    payer: &Address,
    target: &Instruction,
) -> Vec<CommittedAccount> {
    target
        .accounts
        .iter()
        .map(|meta| {
            let (mut is_signer, mut is_writable) = (meta.pubkey == *payer, meta.pubkey == *payer);
            for other in instructions.iter().flat_map(|i| i.accounts.iter()) {
                if other.pubkey != meta.pubkey {
                    continue;
                }
                is_signer |= other.is_signer;
                is_writable |= other.is_writable;
            }
            CommittedAccount {
                pubkey: meta.pubkey.to_bytes(),
                is_signer,
                is_writable,
            }
        })
        .collect()
}

/// The instruction list as the Instructions sysvar will expose it: the same
/// programs, accounts and data, but with transaction-level flags.
fn sysvar_view(instructions: &[Instruction], payer: &Address) -> Vec<Instruction> {
    instructions
        .iter()
        .map(|instruction| Instruction {
            program_id: instruction.program_id,
            accounts: committed_accounts(instructions, payer, instruction)
                .into_iter()
                .zip(&instruction.accounts)
                .map(|(committed, meta)| AccountMeta {
                    pubkey: meta.pubkey,
                    is_signer: committed.is_signer,
                    is_writable: committed.is_writable,
                })
                .collect(),
            data: instruction.data.clone(),
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

/// One generated case: what to build and what the model says about it.
struct Case {
    index: usize,
    label: String,
    instructions: Vec<Instruction>,
    guard_index: usize,
    invocation: GuardInvocation,
}

fn perturbed(bytes: [u8; 8]) -> StoredMultiplier {
    // Flip the lowest mantissa bit: still a positive normal f64, but not the
    // stored value, so the byte-identity check must catch it.
    let mut out = bytes;
    out[0] ^= 1;
    StoredMultiplier::new(out).unwrap()
}

#[allow(clippy::too_many_lines)]
fn generate(env: &Env, prng: &mut Prng, index: usize) -> Case {
    let payer = env.payer.pubkey();
    let mut label = Vec::new();

    // Which mint the payload claims to protect, and which account is passed.
    let protected = *prng.pick(&[env.mint_x, env.mint_y]);
    let account0 = match prng.below(8) {
        0 => {
            label.push("account0=other-mint");
            if protected == env.mint_x {
                env.mint_y
            } else {
                env.mint_x
            }
        }
        1 => {
            label.push("account0=clock-sysvar");
            CLOCK_SYSVAR
        }
        _ => protected,
    };
    let sysvar = match prng.below(10) {
        0 => {
            label.push("sysvar=clock");
            CLOCK_SYSVAR
        }
        1 => {
            label.push("sysvar=token2022");
            TOKEN_2022
        }
        _ => INSTRUCTIONS_SYSVAR,
    };

    // The economic expectation, relative to the mint's real state.
    let real = env.state(&protected);
    let mut expected = real;
    match prng.below(8) {
        0 => {
            label.push("state=multiplier-perturbed");
            expected.multiplier = perturbed(real.multiplier.to_bytes());
        }
        1 => {
            label.push("state=new-multiplier-perturbed");
            expected.new_multiplier = perturbed(real.new_multiplier.to_bytes());
        }
        2 => {
            label.push("state=timestamp-perturbed");
            expected.new_multiplier_effective_timestamp =
                real.new_multiplier_effective_timestamp.wrapping_add(1);
        }
        _ => {}
    }

    let clock = *prng.pick(&[
        NOW,
        ACTIVATION - 901,
        ACTIVATION - 900,
        ACTIVATION - 1,
        ACTIVATION,
        ACTIVATION + 1,
        ACTIVATION + 300,
        ACTIVATION + 301,
        ACTIVATION + 100_000,
    ]);
    let window = *prng.pick(&[
        ProtectionWindow {
            before_secs: 900,
            after_secs: 300,
        },
        ProtectionWindow {
            before_secs: 0,
            after_secs: 0,
        },
        ProtectionWindow {
            before_secs: u32::MAX,
            after_secs: 0,
        },
    ]);
    let real_phase = real.phase_at(clock);
    let phase = if prng.chance(4) {
        label.push("phase=flipped");
        match real_phase {
            ActivationPhase::Pending => ActivationPhase::Activated,
            ActivationPhase::Activated => ActivationPhase::Pending,
        }
    } else {
        real_phase
    };

    // The downstream action, and what the payload commits to.
    let source = ata(&payer, &protected);
    let honest = transfer_checked(
        &TOKEN_2022,
        &source,
        &protected,
        &ata(&env.recipient, &protected),
        &payer,
        &[],
        AMOUNT,
        DECIMALS,
    )
    .unwrap();
    let other_mint = if protected == env.mint_x {
        env.mint_y
    } else {
        env.mint_x
    };
    let submitted = match prng.below(9) {
        0 => {
            label.push("action=wrong-mint");
            transfer_checked(
                &TOKEN_2022,
                &ata(&payer, &other_mint),
                &other_mint,
                &ata(&env.recipient, &other_mint),
                &payer,
                &[],
                AMOUNT,
                DECIMALS,
            )
            .unwrap()
        }
        1 => {
            label.push("action=wrong-amount");
            transfer_checked(
                &TOKEN_2022,
                &source,
                &protected,
                &ata(&env.recipient, &protected),
                &payer,
                &[],
                AMOUNT + 1,
                DECIMALS,
            )
            .unwrap()
        }
        2 => {
            label.push("action=wrong-destination");
            transfer_checked(
                &TOKEN_2022,
                &source,
                &protected,
                &ata(&env.decoy, &protected),
                &payer,
                &[],
                AMOUNT,
                DECIMALS,
            )
            .unwrap()
        }
        3 => {
            label.push("action=system-transfer");
            system_transfer(&payer, &env.recipient, 1_000)
        }
        4 => {
            label.push("action=legacy-token");
            let mut legacy = honest.clone();
            legacy.program_id = LEGACY_TOKEN;
            legacy
        }
        5 => {
            label.push("action=create-ata");
            create_ata(&payer, &env.decoy, &protected)
        }
        _ => honest.clone(),
    };

    // Where the guard sits, and whether anything follows it.
    let mut before: Vec<Instruction> = Vec::new();
    if prng.chance(4) {
        label.push("guard-at-index-1");
        before.push(system_transfer(&payer, &env.recipient, 1));
    }
    let trailing = if prng.chance(10) {
        label.push("action=missing");
        None
    } else {
        Some(submitted.clone())
    };

    // Payload bytes: mostly well formed, occasionally tampered.
    let placeholder_guard = |commitment: [u8; 32]| AssertSafeExecutionV2 {
        expected_mint: protected,
        execution: AssertSafeExecution {
            expected,
            expected_phase: phase,
            window,
        },
        adapter: DownstreamAdapter::Token2022TransferChecked,
        downstream_commitment: commitment,
    };
    let guard_instruction = |data: Vec<u8>| Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(account0, false),
            AccountMeta::new_readonly(sysvar, false),
        ],
        data,
    };

    // The commitment is computed over the final layout, so the guard's own
    // placeholder data must already have the right shape.
    let mut layout: Vec<Instruction> = before.clone();
    layout.push(guard_instruction(
        placeholder_guard([0; 32]).pack().to_vec(),
    ));
    if let Some(action) = &trailing {
        layout.push(action.clone());
    }
    let commit_target = if prng.chance(4) {
        label.push("commitment=stale");
        &honest
    } else {
        trailing.as_ref().unwrap_or(&honest)
    };
    let commitment = commitment_of(&layout, &payer, commit_target);

    let mut data = placeholder_guard(commitment).pack().to_vec();
    match prng.below(12) {
        0 => {
            label.push("payload=v1-version-byte");
            data[0] = 1;
        }
        1 => {
            label.push("payload=truncated");
            data.truncate(98);
        }
        2 => {
            label.push("payload=trailing-byte");
            data.push(0);
        }
        3 => {
            label.push("payload=unknown-adapter");
            data[66] = 2;
        }
        4 => {
            label.push("payload=invalid-phase");
            data[57] = 7;
        }
        _ => {}
    }

    let guard_index = before.len();
    let mut instructions = before;
    instructions.push(guard_instruction(data.clone()));
    if let Some(action) = trailing {
        instructions.push(action);
    }

    Case {
        index,
        label: if label.is_empty() {
            "baseline".to_owned()
        } else {
            label.join(",")
        },
        invocation: GuardInvocation {
            program_id: PROGRAM_ID,
            guard_data: data,
            accounts: vec![env.account(&account0), env.account(&sysvar)],
            instructions: sysvar_view(&instructions, &payer),
            current_index: guard_index as u16,
            clock,
        },
        instructions,
        guard_index,
    }
}

/// The program's verdict, read off the landed transaction: an error attributed
/// to the guard's own index is the guard's; anything else means it passed.
fn program_verdict(result: Result<(), TransactionError>, guard_index: usize) -> String {
    match result {
        Ok(()) => "ok".to_owned(),
        Err(TransactionError::InstructionError(index, InstructionError::Custom(code)))
            if usize::from(index) == guard_index =>
        {
            error_name(code)
        }
        // A failure elsewhere in the transaction means the guard itself allowed it.
        Err(_) => "ok".to_owned(),
    }
}

/// Bounded corpus: large enough to cross every branch combination that
/// matters, small enough to stay in a normal `cargo test` run.
const CORPUS_SIZE: usize = 1_200;

#[test]
fn the_host_model_agrees_with_the_compiled_program() {
    let mut env = Env::new();
    let mut prng = Prng::new(SEED);
    let started = Instant::now();
    let mut failures = Vec::new();
    let mut verdicts: Vec<String> = Vec::new();

    for index in 0..CORPUS_SIZE {
        let case = generate(&env, &mut prng, index);
        let expected = outcome(&evaluate(&case.invocation));
        env.set_time(case.invocation.clock);
        let actual = program_verdict(
            env.send(case.instructions.clone())
                .map(|_| ())
                .map_err(|failed| failed.err),
            case.guard_index,
        );
        if actual != expected {
            failures.push(format!(
                "  case {} [{}]: model says {expected}, program says {actual}",
                case.index, case.label
            ));
        }
        verdicts.push(expected);
    }

    let elapsed = started.elapsed();
    let mut distinct: Vec<&String> = verdicts.iter().collect();
    distinct.sort_unstable();
    distinct.dedup();
    println!(
        "LiteSVM differential: {CORPUS_SIZE} cases in {:.2}s (seed {SEED:#x}), {} distinct verdicts: {}",
        elapsed.as_secs_f64(),
        distinct.len(),
        distinct
            .iter()
            .map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );

    assert!(
        failures.is_empty(),
        "{} of {CORPUS_SIZE} cases disagree between the model and the program:\n{}",
        failures.len(),
        failures.join("\n")
    );
    // A corpus that only ever produced one verdict would prove nothing.
    assert!(
        distinct.len() >= 8,
        "the corpus only reached {} verdicts: {distinct:?}",
        distinct.len()
    );
    assert!(
        verdicts.iter().any(|v| v == "ok"),
        "no generated case was allowed to execute"
    );
}
