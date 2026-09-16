//! Adapter kinds 2 and 3 (Jupiter `route_v2`, USDC only) against the compiled
//! SBF program in LiteSVM.
//!
//! # What runs here, and what does not
//!
//! Jupiter is not deployed in LiteSVM. So that transactions addressed to it
//! can load at all, the SPL Memo program's bytes are placed at the Jupiter
//! address. That stand-in is **not** a DEX and executes no trade: it rejects
//! every `route_v2` it is given (Memo requires every account to sign). A
//! passing guard is therefore observed as
//!
//! - `EquityGuard: safe` and `Program <guard> success` in the logs, and
//! - the transaction failing at the **trade's** index, never the guard's.
//!
//! Nothing here claims a Jupiter trade executed.
//!
//! The recorded mainnet builds (`scripts/research/fixtures/…2026-09-16.json`)
//! are replayed byte-for-byte, with the recorded mainnet mint accounts of the
//! equities and a legacy-Token mint at the canonical USDC address. The build
//! taker's key does not exist anywhere, so signature verification is off; the
//! signer flags the guard reads come from the message header, which that does
//! not change.
//!
//! Every case is also evaluated by the host model (`common::evaluate`), and
//! the program's verdict must equal it.
//!
//! Requires the program artifact: run `cargo build-sbf` first.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount},
    error::EquityGuardError,
    instruction::{
        AssertSafeExecution, AssertSafeExecutionV2, DownstreamAdapter, ProtectionWindow,
    },
    jupiter::{
        check_suffix, jupiter_suffix_commitment, ProtectedRole, ASSOCIATED_TOKEN_PROGRAM_ID,
        COMPUTE_BUDGET_PROGRAM_ID, JUPITER_PROGRAM_ID, LEGACY_TOKEN_PROGRAM_ID, USDC_MINT,
    },
    state::{decode_protected_state, ActivationPhase, ProtectedState},
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use serde_json::Value;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::extension::scaled_ui_amount::PodF64;

mod common;
use common::{error_name, evaluate, outcome, GuardAccount, GuardInvocation};

const FIXTURE: &str =
    include_str!("../../../scripts/research/fixtures/route-v2-builds-2026-09-16.json");

const PROGRAM_ID: Address = equity_guard::ID;
const TOKEN_2022: Address = spl_token_2022_interface::ID;
const INSTRUCTIONS_SYSVAR: Address = solana_instructions_sysvar::ID;
/// SPL Memo v3, bundled with LiteSVM. Its bytes are the Jupiter stand-in.
const MEMO_PROGRAM: Address =
    Address::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/// A second legacy-Token stablecoin (USDT), used only as a wrong counter mint.
const NOT_USDC: Address = Address::from_str_const("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const WRAPPED_SOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
/// A key nobody in these transactions controls.
const ATTACKER: Address = Address::new_from_array([0xa7; 32]);
/// A third party that pays fees and rent for the user.
const RELAYER: Address = Address::new_from_array([0x7e; 32]);

/// After every recorded mint's scheduled activation plus the window below.
const NOW: i64 = 1_789_400_000;
const WINDOW: ProtectionWindow = ProtectionWindow {
    before_secs: 900,
    after_secs: 300,
};
/// Composer-chosen limit for the replayed builds.
const COMPUTE_UNIT_LIMIT: u32 = 400_000;
/// M9D-A.1 budgeted 15–20k CU for the whole guard; this is the hard ceiling
/// for the recorded fixtures.
const MAX_GUARD_COMPUTE_UNITS: u64 = 20_000;
/// Measured pass cost when both canonical ATAs resolve at bump 255 (UNHx), as
/// a regression baseline rather than a target.
const GUARD_PASS_ONE_ATTEMPT_EACH: u64 = 10_743;
/// Each extra bump attempt of `find_program_address` costs one
/// `create_program_address` syscall.
const DERIVATION_ATTEMPT_UNITS: u64 = 1_500;
/// Room for toolchain drift, as in the kind 1 suite.
const COMPUTE_UNIT_TOLERANCE: u64 = 400;

/// Positions in the normalized suffix with a setup instruction.
const PRICE: usize = 0;
const LIMIT: usize = 1;
const SETUP: usize = 2;
const ROUTE: usize = 3;

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

// ------------------------------------------------------------- fixtures

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Buy,
    Sell,
}

#[derive(Clone, Debug)]
struct Build {
    symbol: String,
    direction: Direction,
    input_mint: Address,
    output_mint: Address,
    taker: Address,
    /// Jupiter's own order: compute budget, setup, swap, cleanup.
    recorded: Vec<Instruction>,
}

impl Build {
    fn protected_mint(&self) -> Address {
        match self.direction {
            Direction::Buy => self.output_mint,
            Direction::Sell => self.input_mint,
        }
    }

    fn adapter(&self) -> DownstreamAdapter {
        match self.direction {
            Direction::Buy => DownstreamAdapter::JupiterRouteV2BuyUsdc,
            Direction::Sell => DownstreamAdapter::JupiterRouteV2SellUsdc,
        }
    }

    fn swap_index(&self) -> usize {
        self.recorded
            .iter()
            .position(|i| i.program_id == JUPITER_PROGRAM_ID)
            .unwrap()
    }

    /// The composer's normalized order: price, limit, setup(s), swap, cleanup.
    fn normalized(&self) -> Vec<Instruction> {
        let swap = self.swap_index();
        let price = self.recorded[0].clone();
        assert_eq!(price.program_id, COMPUTE_BUDGET_PROGRAM_ID);
        let mut out = vec![
            price,
            ComputeBudgetInstruction::set_compute_unit_limit(COMPUTE_UNIT_LIMIT),
        ];
        out.extend(self.recorded[1..].iter().cloned());
        assert_eq!(out[swap + 1].program_id, JUPITER_PROGRAM_ID);
        out
    }
}

fn address(value: &Value) -> Address {
    value.as_str().unwrap().parse().unwrap()
}

fn hex_bytes(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn builds() -> Vec<Build> {
    let document: Value = serde_json::from_str(FIXTURE).unwrap();
    document["builds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| Build {
            symbol: b["symbol"].as_str().unwrap().to_owned(),
            direction: match b["direction"].as_str().unwrap() {
                "BUY" => Direction::Buy,
                "SELL" => Direction::Sell,
                other => panic!("direction {other}"),
            },
            input_mint: address(&b["inputMint"]),
            output_mint: address(&b["outputMint"]),
            taker: address(&b["taker"]),
            recorded: b["jupiterInstructions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| Instruction {
                    program_id: address(&i["programId"]),
                    accounts: i["accounts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| AccountMeta {
                            pubkey: address(&m["pubkey"]),
                            is_signer: m["isSigner"].as_bool().unwrap(),
                            is_writable: m["isWritable"].as_bool().unwrap(),
                        })
                        .collect(),
                    data: hex_bytes(i["dataHex"].as_str().unwrap()),
                })
                .collect(),
        })
        .collect()
}

fn build(symbol: &str, direction: Direction) -> Build {
    builds()
        .into_iter()
        .find(|b| b.symbol == symbol && b.direction == direction)
        .unwrap()
}

fn mainnet_mint_data(symbol: &str) -> Vec<u8> {
    let encoded = match symbol {
        "KOx" => include_str!("fixtures/mainnet/KOx.base64"),
        "UNHx" => include_str!("fixtures/mainnet/UNHx.base64"),
        "CRMx" => include_str!("fixtures/mainnet/CRMx.base64"),
        other => panic!("no mint fixture for {other}"),
    };
    STANDARD.decode(encoded.trim()).unwrap()
}

/// A minimal initialized legacy SPL Token mint: no authorities, 6 decimals.
fn legacy_mint_data() -> Vec<u8> {
    let mut data = vec![0_u8; 82];
    data[44] = 6;
    data[45] = 1;
    data
}

fn ata(owner: &Address, mint: &Address, token_program: &Address) -> Address {
    ata_with_bump(owner, mint, token_program).0
}

fn ata_with_bump(owner: &Address, mint: &Address, token_program: &Address) -> (Address, u8) {
    Address::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
}

// ---------------------------------------------------------- environment

struct Env {
    svm: LiteSVM,
    /// Protected mint address by symbol.
    mints: Vec<(String, Address)>,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new()
            .with_sigverify(false)
            .with_transaction_history(0);
        svm.add_program_from_file(PROGRAM_ID, program_path())
            .unwrap();
        // Test-only stand-in; see the module docs.
        let memo = svm.get_account(&MEMO_PROGRAM).unwrap();
        assert!(memo.executable);
        svm.add_program(JUPITER_PROGRAM_ID, &memo.data).unwrap();

        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let mut env = Self {
            svm,
            mints: Vec::new(),
        };
        for b in builds() {
            let mint = b.protected_mint();
            if !env.mints.iter().any(|(_, m)| *m == mint) {
                env.mints.push((b.symbol.clone(), mint));
                env.set_mint(mint, TOKEN_2022, mainnet_mint_data(&b.symbol));
            }
        }
        for stable in [USDC_MINT, NOT_USDC, WRAPPED_SOL] {
            env.set_mint(stable, LEGACY_TOKEN_PROGRAM_ID, legacy_mint_data());
        }
        let taker = builds()[0].taker;
        for payer in [taker, RELAYER] {
            env.svm.airdrop(&payer, 100_000_000_000).unwrap();
        }
        env
    }

    fn mint(&self, symbol: &str) -> Address {
        self.mints.iter().find(|(s, _)| s == symbol).unwrap().1
    }

    fn set_mint(&mut self, key: Address, owner: Address, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                key,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    fn state(&self, mint: &Address) -> ProtectedState {
        let account = self.svm.get_account(mint).unwrap();
        decode_protected_state(&account.owner, &account.data).unwrap()
    }

    fn guard_account(&self, key: &Address) -> GuardAccount {
        let account = self.svm.get_account(key).unwrap_or_default();
        GuardAccount {
            pubkey: *key,
            owner: account.owner,
            data: account.data,
        }
    }

    fn send(
        &mut self,
        instructions: &[Instruction],
        payer: &Address,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let mut tx = Transaction::new_with_payer(instructions, Some(payer));
        tx.message.recent_blockhash = self.svm.latest_blockhash();
        self.svm.send_transaction(tx)
    }
}

// ------------------------------------------------------------- building

/// Transaction-level flags, as the Instructions sysvar exposes them.
fn sysvar_view(instructions: &[Instruction], payer: &Address) -> Vec<Instruction> {
    let flags = |key: &Address| {
        let mut signer = key == payer;
        let mut writable = key == payer;
        for meta in instructions.iter().flat_map(|i| &i.accounts) {
            if meta.pubkey == *key {
                signer |= meta.is_signer;
                writable |= meta.is_writable;
            }
        }
        (signer, writable)
    };
    instructions
        .iter()
        .map(|i| Instruction {
            program_id: i.program_id,
            accounts: i
                .accounts
                .iter()
                .map(|m| {
                    let (is_signer, is_writable) = flags(&m.pubkey);
                    AccountMeta {
                        pubkey: m.pubkey,
                        is_signer,
                        is_writable,
                    }
                })
                .collect(),
            data: i.data.clone(),
        })
        .collect()
}

/// The commitment the program computes for `instructions` with a guard at 0.
fn suffix_commitment_of(instructions: &[Instruction], payer: &Address) -> [u8; 32] {
    jupiter_suffix_commitment(&sysvar_view(instructions, payer)[1..]).unwrap()
}

/// One transaction to send, with the guard's expectations.
#[derive(Clone, Debug)]
struct Case {
    /// Everything but the guard, in order.
    suffix: Vec<Instruction>,
    guard_index: usize,
    guard_mint: Address,
    adapter: DownstreamAdapter,
    payer: Address,
}

impl Case {
    fn honest(build: &Build) -> Self {
        Self {
            suffix: build.normalized(),
            guard_index: 0,
            guard_mint: build.protected_mint(),
            adapter: build.adapter(),
            payer: build.taker,
        }
    }

    fn route(&mut self) -> &mut Instruction {
        self.suffix.last_mut().unwrap()
    }
}

fn guard_instruction(
    mint: &Address,
    expected: ProtectedState,
    adapter: DownstreamAdapter,
    commitment: [u8; 32],
) -> Instruction {
    let request = AssertSafeExecutionV2 {
        expected_mint: *mint,
        execution: AssertSafeExecution {
            expected,
            expected_phase: ActivationPhase::Activated,
            window: WINDOW,
        },
        adapter,
        downstream_commitment: commitment,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
        ],
        data: request.pack().to_vec(),
    }
}

fn with_guard(case: &Case, guard: Instruction) -> Vec<Instruction> {
    let mut instructions = case.suffix.clone();
    instructions.insert(case.guard_index, guard);
    instructions
}

/// The transaction with a guard whose commitment is recomputed over exactly
/// these instructions — what a builder that also writes the commitment does.
/// The guard's own accounts are read-only and change no flags, so a
/// zero-commitment placeholder yields the final view.
fn build_with_matching_commitment(env: &Env, case: &Case) -> (Vec<Instruction>, [u8; 32]) {
    let expected = env.state(&case.guard_mint);
    let placeholder = guard_instruction(&case.guard_mint, expected, case.adapter, [0; 32]);
    let provisional = with_guard(case, placeholder);
    let commitment = suffix_commitment_of(&provisional, &case.payer);
    let guard = guard_instruction(&case.guard_mint, expected, case.adapter, commitment);
    let instructions = with_guard(case, guard);
    // Changing only the guard's data changed nothing the commitment covers.
    if case.guard_index == 0 {
        assert_eq!(suffix_commitment_of(&instructions, &case.payer), commitment);
    }
    (instructions, commitment)
}

// ------------------------------------------------------------- verdicts

struct Outcome {
    /// `ok` when the guard passed, else the guard's error name.
    verdict: String,
    guard_units: Option<u64>,
    result: Result<TransactionMetadata, FailedTransactionMetadata>,
}

fn guard_units(logs: &[String]) -> Option<u64> {
    let prefix = format!("Program {PROGRAM_ID} consumed ");
    logs.iter().find_map(|line| {
        line.strip_prefix(&prefix)?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

/// Sends `instructions` and returns the guard's verdict, after checking it
/// against the host model.
fn run(env: &mut Env, instructions: &[Instruction], case: &Case) -> Outcome {
    let result = env.send(instructions, &case.payer);
    let logs = match &result {
        Ok(meta) => &meta.logs,
        Err(failed) => &failed.meta.logs,
    };
    let verdict = match &result {
        Ok(_) => "ok".to_owned(),
        Err(failed) => match failed.err {
            TransactionError::InstructionError(index, InstructionError::Custom(code))
                if usize::from(index) == case.guard_index =>
            {
                error_name(code)
            }
            // Anything else after the guard ran means the guard passed.
            TransactionError::InstructionError(index, _)
                if usize::from(index) > case.guard_index =>
            {
                "ok".to_owned()
            }
            ref other => format!("runtime:{other:?}"),
        },
    };
    let passed_in_logs = logs.iter().any(|l| l == "Program log: EquityGuard: safe")
        && logs
            .iter()
            .any(|l| l == &format!("Program {PROGRAM_ID} success"));
    assert_eq!(verdict == "ok", passed_in_logs, "logs disagree: {logs:#?}");

    if !verdict.starts_with("runtime:") {
        let invocation = GuardInvocation {
            program_id: PROGRAM_ID,
            guard_data: instructions[case.guard_index].data.clone(),
            accounts: vec![
                env.guard_account(&case.guard_mint),
                env.guard_account(&INSTRUCTIONS_SYSVAR),
            ],
            instructions: sysvar_view(instructions, &case.payer),
            current_index: u16::try_from(case.guard_index).unwrap(),
            clock: NOW,
        };
        assert_eq!(
            outcome(&evaluate(&invocation)),
            verdict,
            "host model and compiled program disagree"
        );
    }
    Outcome {
        verdict,
        guard_units: guard_units(logs),
        result,
    }
}

fn name(error: EquityGuardError) -> String {
    format!("{error:?}")
}

/// Asserts the guard passed and the only failure is the stand-in refusing
/// the trade at the last index.
fn assert_guard_passed_and_trade_reached(outcome: &Outcome, instructions: &[Instruction]) {
    assert_eq!(outcome.verdict, "ok");
    let last = u8::try_from(instructions.len() - 1).unwrap();
    match &outcome.result {
        Err(failed) => assert!(
            matches!(failed.err, TransactionError::InstructionError(index, _) if index == last),
            "expected the stand-in to refuse the trade at {last}, got {:?}\n{:#?}",
            failed.err,
            failed.meta.logs
        ),
        Ok(_) => panic!("the Jupiter stand-in never accepts a trade"),
    }
}

// ---------------------------------------------------------------- tests

#[test]
fn real_kox_and_unhx_trades_pass_the_guard_in_both_directions() {
    let mut env = Env::new();
    for symbol in ["KOx", "UNHx"] {
        for direction in [Direction::Buy, Direction::Sell] {
            let b = build(symbol, direction);
            let case = Case::honest(&b);
            assert_eq!(case.suffix.len(), 4, "{symbol} {direction:?}");
            let (instructions, _) = build_with_matching_commitment(&env, &case);
            let outcome = run(&mut env, &instructions, &case);
            assert_guard_passed_and_trade_reached(&outcome, &instructions);
            let units = outcome.guard_units.unwrap();
            println!("{symbol} {direction:?}: guard passed, {units} CU");
            assert!(units <= MAX_GUARD_COMPUTE_UNITS, "{units} CU");

            // The three-instruction shape: the destination already exists.
            let mut without_setup = case.clone();
            without_setup.suffix.remove(SETUP);
            let (instructions, _) = build_with_matching_commitment(&env, &without_setup);
            let outcome = run(&mut env, &instructions, &without_setup);
            assert_guard_passed_and_trade_reached(&outcome, &instructions);
        }
    }
}

#[test]
fn crmx_sell_is_supported_and_crmx_buy_is_not() {
    let mut env = Env::new();
    let sell = build("CRMx", Direction::Sell);
    let case = Case::honest(&sell);
    let (instructions, _) = build_with_matching_commitment(&env, &case);
    let outcome = run(&mut env, &instructions, &case);
    assert_guard_passed_and_trade_reached(&outcome, &instructions);
    println!(
        "CRMx SELL: guard passed, {} CU",
        outcome.guard_units.unwrap()
    );

    // CRMx BUY hops through wSOL: two setups and a trailing CloseAccount.
    let buy = build("CRMx", Direction::Buy);
    let case = Case::honest(&buy);
    assert_eq!(case.suffix.len(), 6);
    let (instructions, _) = build_with_matching_commitment(&env, &case);
    assert_eq!(
        run(&mut env, &instructions, &case).verdict,
        name(EquityGuardError::UnsupportedTransactionGrammar)
    );
    // Dropping the cleanup still leaves a second setup.
    let mut trimmed = case.clone();
    trimmed.suffix.pop();
    let (instructions, _) = build_with_matching_commitment(&env, &trimmed);
    assert_eq!(
        run(&mut env, &instructions, &trimmed).verdict,
        name(EquityGuardError::UnsupportedTransactionGrammar)
    );
    // Keeping only the wSOL setup: it is not this trade's destination.
    let mut wsol_only = trimmed.clone();
    let wsol_setup = wsol_only
        .suffix
        .iter()
        .position(|i| {
            i.program_id == ASSOCIATED_TOKEN_PROGRAM_ID && i.accounts[3].pubkey == WRAPPED_SOL
        })
        .unwrap();
    let destination_setup = 5 - wsol_setup;
    wsol_only.suffix.remove(destination_setup);
    let (instructions, _) = build_with_matching_commitment(&env, &wsol_only);
    assert_eq!(
        run(&mut env, &instructions, &wsol_only).verdict,
        name(EquityGuardError::InvalidAtaSetup)
    );
}

#[test]
fn a_third_party_may_pay_for_the_users_own_destination() {
    let mut env = Env::new();
    let mut case = Case::honest(&build("KOx", Direction::Buy));
    case.payer = RELAYER;
    case.suffix[SETUP].accounts[0].pubkey = RELAYER;
    let (instructions, _) = build_with_matching_commitment(&env, &case);
    let outcome = run(&mut env, &instructions, &case);
    assert_guard_passed_and_trade_reached(&outcome, &instructions);
}

fn set_u64(data: &mut [u8], offset: usize, value: u64) {
    data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn set_u16(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn set_u32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn system_transfer(from: &Address, to: &Address) -> Instruction {
    solana_system_interface::instruction::transfer(from, to, 1_000_000_000)
}

fn memo(signer: &Address) -> Instruction {
    Instruction {
        program_id: MEMO_PROGRAM,
        accounts: vec![AccountMeta::new_readonly(*signer, true)],
        data: b"hi".to_vec(),
    }
}

/// Legacy Token `CloseAccount(account -> destination, authority)`.
fn close_account(account: &Address, destination: &Address, authority: &Address) -> Instruction {
    Instruction {
        program_id: LEGACY_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: vec![9],
    }
}

/// Points the trade's (and setup's) destination at `mint` under
/// `token_program`, keeping every account canonical and consistent.
fn retarget_destination_mint(case: &mut Case, mint: Address, token_program: Address) {
    let authority = case.route().accounts[0].pubkey;
    let destination = ata(&authority, &mint, &token_program);
    let route = case.route();
    route.accounts[2].pubkey = destination;
    route.accounts[4].pubkey = mint;
    route.accounts[6].pubkey = token_program;
    let setup = &mut case.suffix[SETUP];
    setup.accounts[1].pubkey = destination;
    setup.accounts[3].pubkey = mint;
    setup.accounts[5].pubkey = token_program;
}

fn retarget_source_mint(case: &mut Case, mint: Address, token_program: Address) {
    let route = case.route();
    let authority = route.accounts[0].pubkey;
    route.accounts[1].pubkey = ata(&authority, &mint, &token_program);
    route.accounts[3].pubkey = mint;
    route.accounts[5].pubkey = token_program;
}

type Mutation = Box<dyn Fn(&Env, &mut Case)>;

/// Section 15: each malicious transaction carries a commitment recomputed
/// over its own bytes, so the commitment matches and only semantic
/// validation can reject it.
fn malicious_builders() -> Vec<(&'static str, Direction, EquityGuardError, Mutation)> {
    use Direction::{Buy, Sell};
    use EquityGuardError as E;
    let taker = builds()[0].taker;
    vec![
        (
            "A system transfer appended after the trade",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix.push(system_transfer(&taker, &ATTACKER))),
        ),
        (
            "A system transfer appended after a setup-less trade",
            Sell,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| {
                c.suffix.remove(SETUP);
                c.suffix.push(system_transfer(&taker, &ATTACKER));
            }),
        ),
        (
            "B system transfer in place of the setup",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix[SETUP] = system_transfer(&taker, &ATTACKER)),
        ),
        (
            "B system transfer inserted before the trade",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix.insert(ROUTE, system_transfer(&taker, &ATTACKER))),
        ),
        (
            "C token cleanup appended",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| {
                let destination = c.route().accounts[2].pubkey;
                c.suffix
                    .push(close_account(&destination, &ATTACKER, &taker));
            }),
        ),
        (
            "C token cleanup in place of the setup",
            Sell,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| {
                let source = c.route().accounts[1].pubkey;
                c.suffix[SETUP] = close_account(&source, &ATTACKER, &taker);
            }),
        ),
        (
            "D second Jupiter trade in place of the setup",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(|_, c| c.suffix[SETUP] = c.suffix[ROUTE].clone()),
        ),
        (
            "D second Jupiter trade appended",
            Sell,
            E::UnsupportedTransactionGrammar,
            Box::new(|_, c| c.suffix.push(c.suffix[ROUTE].clone())),
        ),
        (
            "E tip transfer appended",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix.push(system_transfer(&taker, &RELAYER))),
        ),
        (
            "E tip transfer in place of the setup",
            Sell,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix[SETUP] = system_transfer(&taker, &RELAYER)),
        ),
        (
            "F arbitrary program in place of the setup",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix[SETUP] = memo(&taker)),
        ),
        (
            "F arbitrary program in place of the price",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(move |_, c| c.suffix[PRICE] = memo(&taker)),
        ),
        (
            "F arbitrary program in place of the trade",
            Buy,
            E::InvalidJupiterProgram,
            Box::new(move |_, c| c.suffix[ROUTE] = memo(&taker)),
        ),
        (
            "G RequestHeapFrame in the price position",
            Buy,
            E::InvalidComputeBudgetInstruction,
            Box::new(|_, c| {
                c.suffix[PRICE] = ComputeBudgetInstruction::request_heap_frame(64 * 1024);
            }),
        ),
        (
            "G SetLoadedAccountsDataSizeLimit in the limit position",
            Sell,
            E::InvalidComputeBudgetInstruction,
            Box::new(|_, c| {
                c.suffix[LIMIT] =
                    ComputeBudgetInstruction::set_loaded_accounts_data_size_limit(1_000_000);
            }),
        ),
        (
            "G price instruction carrying an account",
            Buy,
            E::InvalidComputeBudgetInstruction,
            Box::new(move |_, c| {
                c.suffix[PRICE]
                    .accounts
                    .push(AccountMeta::new_readonly(ATTACKER, false));
            }),
        ),
        (
            "J limit before price",
            Buy,
            E::InvalidComputeBudgetInstruction,
            Box::new(|_, c| c.suffix.swap(PRICE, LIMIT)),
        ),
        (
            "J setup after the trade",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(|_, c| c.suffix.swap(SETUP, ROUTE)),
        ),
        (
            "J setup before the compute budget",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(|_, c| {
                let setup = c.suffix.remove(SETUP);
                c.suffix.insert(0, setup);
            }),
        ),
        (
            "K setup creates an attacker-owned account",
            Buy,
            E::InvalidAtaSetup,
            Box::new(|_, c| {
                let mint = c.suffix[SETUP].accounts[3].pubkey;
                c.suffix[SETUP].accounts[1].pubkey = ata(&ATTACKER, &mint, &TOKEN_2022);
                c.suffix[SETUP].accounts[2].pubkey = ATTACKER;
            }),
        ),
        (
            "K setup creates the user's account for an unrelated mint",
            Buy,
            E::InvalidAtaSetup,
            Box::new(move |env, c| {
                let other = env.mint("UNHx");
                c.suffix[SETUP].accounts[1].pubkey = ata(&taker, &other, &TOKEN_2022);
                c.suffix[SETUP].accounts[3].pubkey = other;
            }),
        ),
        (
            "K setup is plain Create",
            Buy,
            E::InvalidAtaSetup,
            Box::new(|_, c| c.suffix[SETUP].data = vec![0]),
        ),
        (
            "K setup is RecoverNested",
            Sell,
            E::InvalidAtaSetup,
            Box::new(|_, c| c.suffix[SETUP].data = vec![2]),
        ),
        (
            "K setup payer does not sign",
            Buy,
            E::InvalidAtaSetup,
            Box::new(|_, c| c.suffix[SETUP].accounts[0] = AccountMeta::new(ATTACKER, false)),
        ),
        (
            "K setup with a seventh account",
            Buy,
            E::InvalidAtaSetup,
            Box::new(|_, c| {
                c.suffix[SETUP]
                    .accounts
                    .push(AccountMeta::new_readonly(ATTACKER, false));
            }),
        ),
        (
            "K setup names a foreign system program",
            Buy,
            E::InvalidAtaSetup,
            Box::new(|_, c| c.suffix[SETUP].accounts[4].pubkey = ATTACKER),
        ),
        (
            "K setup names the wrong token program",
            Buy,
            E::InvalidAtaSetup,
            Box::new(|_, c| c.suffix[SETUP].accounts[5].pubkey = LEGACY_TOKEN_PROGRAM_ID),
        ),
        (
            "L destination redirected together with its setup",
            Buy,
            E::NonCanonicalDestinationAccount,
            Box::new(|_, c| {
                c.route().accounts[2].pubkey = ATTACKER;
                c.suffix[SETUP].accounts[1].pubkey = ATTACKER;
            }),
        ),
        (
            "L destination redirected without a setup",
            Sell,
            E::NonCanonicalDestinationAccount,
            Box::new(|_, c| {
                c.suffix.remove(SETUP);
                c.route().accounts[2].pubkey = ATTACKER;
            }),
        ),
        (
            "L destination is the attacker's canonical account",
            Buy,
            E::NonCanonicalDestinationAccount,
            Box::new(|_, c| {
                let mint = c.route().accounts[4].pubkey;
                let foreign = ata(&ATTACKER, &mint, &TOKEN_2022);
                c.route().accounts[2].pubkey = foreign;
                c.suffix[SETUP].accounts[1].pubkey = foreign;
            }),
        ),
        (
            "M source is not the authority's account",
            Sell,
            E::NonCanonicalSourceAccount,
            Box::new(|_, c| c.route().accounts[1].pubkey = ATTACKER),
        ),
        (
            "N destination override set",
            Buy,
            E::DestinationOverrideUnsupported,
            Box::new(|_, c| c.route().accounts[7] = AccountMeta::new(ATTACKER, false)),
        ),
        (
            "O platform fee",
            Buy,
            E::UnsupportedJupiterFee,
            Box::new(|_, c| set_u16(&mut c.route().data, 26, 50)),
        ),
        (
            "P positive-slippage fee",
            Sell,
            E::UnsupportedJupiterFee,
            Box::new(|_, c| set_u16(&mut c.route().data, 28, 1)),
        ),
        (
            "Q shared_accounts_route_v2 entrypoint",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| {
                c.route().data[..8]
                    .copy_from_slice(&[0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9]);
            }),
        ),
        (
            "Q legacy route entrypoint",
            Sell,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| {
                c.route().data[..8]
                    .copy_from_slice(&[0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]);
            }),
        ),
        (
            "R route_v2 bytes addressed to another program",
            Buy,
            E::InvalidJupiterProgram,
            Box::new(|_, c| c.route().program_id = MEMO_PROGRAM),
        ),
        (
            "R route_v2 program account is not Jupiter",
            Buy,
            E::InvalidJupiterProgram,
            Box::new(|_, c| c.route().accounts[9].pubkey = ATTACKER),
        ),
        (
            "S BUY paid with a non-USDC mint",
            Buy,
            E::InvalidCounterMint,
            Box::new(|_, c| retarget_source_mint(c, NOT_USDC, LEGACY_TOKEN_PROGRAM_ID)),
        ),
        (
            "T SELL proceeds in a non-USDC mint",
            Sell,
            E::InvalidCounterMint,
            Box::new(|_, c| retarget_destination_mint(c, NOT_USDC, LEGACY_TOKEN_PROGRAM_ID)),
        ),
        (
            "U SELL route under a BUY guard",
            Sell,
            E::InvalidJupiterDirection,
            Box::new(|_, c| c.adapter = DownstreamAdapter::JupiterRouteV2BuyUsdc),
        ),
        (
            "U BUY route under a SELL guard",
            Buy,
            E::InvalidJupiterDirection,
            Box::new(|_, c| c.adapter = DownstreamAdapter::JupiterRouteV2SellUsdc),
        ),
        (
            "V guard protects a different equity than the trade buys",
            Buy,
            E::InvalidJupiterDirection,
            Box::new(|env, c| c.guard_mint = env.mint("UNHx")),
        ),
        (
            "V trade buys a different equity than the guard protects",
            Buy,
            E::InvalidJupiterDirection,
            Box::new(|env, c| retarget_destination_mint(c, env.mint("UNHx"), TOKEN_2022)),
        ),
        (
            "V trade sells a different equity than the guard protects",
            Sell,
            E::InvalidJupiterDirection,
            Box::new(|env, c| retarget_source_mint(c, env.mint("UNHx"), TOKEN_2022)),
        ),
        (
            "USDC under Token-2022",
            Buy,
            E::InvalidTokenProgram,
            Box::new(|_, c| retarget_source_mint(c, USDC_MINT, TOKEN_2022)),
        ),
        (
            "protected mint under legacy Token",
            Buy,
            E::InvalidTokenProgram,
            Box::new(|_, c| {
                let mint = c.route().accounts[4].pubkey;
                retarget_destination_mint(c, mint, LEGACY_TOKEN_PROGRAM_ID);
            }),
        ),
        (
            "guard at index 1",
            Buy,
            E::GuardNotFirst,
            Box::new(|_, c| c.guard_index = 1),
        ),
        (
            "guard immediately before the trade",
            Sell,
            E::GuardNotFirst,
            Box::new(|_, c| c.guard_index = ROUTE),
        ),
        (
            "authority does not sign",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| {
                c.payer = RELAYER;
                c.suffix[SETUP].accounts[0].pubkey = RELAYER;
                c.route().accounts[0].is_signer = false;
            }),
        ),
        (
            "event authority substituted",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| c.route().accounts[8].pubkey = ATTACKER),
        ),
        (
            "zero input amount",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| set_u64(&mut c.route().data, 8, 0)),
        ),
        (
            "zero quoted output",
            Sell,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| set_u64(&mut c.route().data, 16, 0)),
        ),
        (
            "slippage above 100%",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| set_u16(&mut c.route().data, 24, 10_001)),
        ),
        (
            "empty route plan",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| set_u32(&mut c.route().data, 30, 0)),
        ),
        (
            "truncated route_v2 prefix",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| c.route().data.truncate(33)),
        ),
        (
            "route_v2 with nine accounts",
            Buy,
            E::InvalidJupiterInstruction,
            Box::new(|_, c| {
                c.suffix.remove(SETUP);
                c.route().accounts.truncate(9);
            }),
        ),
        (
            "no suffix at all",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(|_, c| c.suffix.clear()),
        ),
        (
            "trade alone",
            Buy,
            E::UnsupportedTransactionGrammar,
            Box::new(|_, c| c.suffix.drain(..ROUTE).for_each(drop)),
        ),
    ]
}

#[test]
fn malicious_builders_are_rejected_by_semantics_even_with_a_matching_commitment() {
    let mut env = Env::new();
    let mut failures = Vec::new();
    for (label, direction, expected, mutate) in malicious_builders() {
        let b = build("KOx", direction);
        let mut case = Case::honest(&b);
        mutate(&env, &mut case);
        let (instructions, commitment) = build_with_matching_commitment(&env, &case);
        // The commitment verifies: it is exactly the program's digest of the
        // submitted suffix. Any rejection below is therefore semantic.
        if case.guard_index == 0 {
            assert_eq!(
                suffix_commitment_of(&instructions, &case.payer),
                commitment,
                "{label}"
            );
        }
        let outcome = run(&mut env, &instructions, &case);
        if outcome.verdict != name(expected) {
            failures.push(format!(
                "  {label}: expected {expected:?}, got {}",
                outcome.verdict
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn every_other_jupiter_entrypoint_is_refused() {
    // The nine other v6 entrypoints in the published IDL.
    const OTHERS: [[u8; 8]; 9] = [
        [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a],
        [0x96, 0x56, 0x47, 0x74, 0xa7, 0x5d, 0x0e, 0x68],
        [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81],
        [0xe6, 0x79, 0x8f, 0x50, 0x77, 0x9f, 0x6a, 0xaa],
        [0xd0, 0x33, 0xef, 0x97, 0x7b, 0x2b, 0xed, 0x5c],
        [0xb0, 0xd1, 0x69, 0xa8, 0x9a, 0x7d, 0x45, 0x3e],
        [0x9d, 0x8a, 0xb8, 0x52, 0x15, 0xf4, 0xf3, 0x24],
        [0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9],
        [0x35, 0x60, 0xe5, 0xca, 0xd8, 0xbb, 0xfa, 0x18],
    ];
    let mut env = Env::new();
    for discriminator in OTHERS {
        let mut case = Case::honest(&build("UNHx", Direction::Sell));
        case.route().data[..8].copy_from_slice(&discriminator);
        let (instructions, _) = build_with_matching_commitment(&env, &case);
        assert_eq!(
            run(&mut env, &instructions, &case).verdict,
            name(EquityGuardError::InvalidJupiterInstruction),
            "{discriminator:02x?}"
        );
    }
}

#[test]
fn compute_budget_shapes_the_runtime_rejects_never_reach_the_guard() {
    // Duplicate ComputeBudget variants are refused by the runtime while it
    // sanitizes the transaction, before any instruction executes. The guard's
    // own verdict on them is pinned on the host (`check_suffix`) and in the
    // shared conformance corpus.
    let mut env = Env::new();
    type Edit = Box<dyn Fn(&mut Case)>;
    let cases: [(&str, Edit, EquityGuardError); 3] = [
        (
            "H duplicate price",
            Box::new(|c| c.suffix[LIMIT] = c.suffix[PRICE].clone()),
            EquityGuardError::InvalidComputeBudgetInstruction,
        ),
        (
            "H duplicate price in the setup position",
            Box::new(|c| c.suffix[SETUP] = c.suffix[PRICE].clone()),
            EquityGuardError::UnsupportedTransactionGrammar,
        ),
        (
            "I duplicate limit",
            Box::new(|c| c.suffix[SETUP] = c.suffix[LIMIT].clone()),
            EquityGuardError::UnsupportedTransactionGrammar,
        ),
    ];
    for (label, mutate, guard_error) in cases {
        let mut case = Case::honest(&build("KOx", Direction::Buy));
        mutate(&mut case);
        let (instructions, _) = build_with_matching_commitment(&env, &case);
        let outcome = run(&mut env, &instructions, &case);
        assert!(
            matches!(
                outcome.result,
                Err(FailedTransactionMetadata {
                    err: TransactionError::DuplicateInstruction(_),
                    ..
                })
            ),
            "{label}: {}",
            outcome.verdict
        );
        assert!(outcome.guard_units.is_none(), "{label}: the guard ran");

        let view = sysvar_view(&instructions, &case.payer);
        let mint = case.guard_mint;
        assert_eq!(
            check_suffix(&view[1..], ProtectedRole::Destination, &mint),
            Err(guard_error),
            "{label}"
        );
    }
}

/// Section 16: an honest guard, then the transaction is changed WITHOUT
/// recomputing the commitment. Every change keeps the grammar and the
/// `route_v2` semantics valid, so only identity binding can catch it.
#[test]
fn post_commitment_mutations_are_caught_by_the_commitment() {
    type Edit = Box<dyn Fn(&mut Case)>;
    let taker = builds()[0].taker;
    let other_user = Address::new_from_array([0x44; 32]);
    let mutations: Vec<(&str, Edit)> = vec![
        (
            "amount",
            Box::new(|c| {
                let amount = u64::from_le_bytes(c.route().data[8..16].try_into().unwrap());
                set_u64(&mut c.route().data, 8, amount + 1);
            }),
        ),
        (
            "quoted output",
            Box::new(|c| set_u64(&mut c.route().data, 16, 1)),
        ),
        (
            "slippage",
            Box::new(|c| set_u16(&mut c.route().data, 24, 51)),
        ),
        (
            "route plan bytes",
            Box::new(|c| {
                let last = c.route().data.len() - 1;
                c.route().data[last] ^= 1;
            }),
        ),
        (
            "venue account",
            Box::new(|c| c.route().accounts[15].pubkey = ATTACKER),
        ),
        (
            "venue account flag",
            Box::new(|c| {
                let meta = &mut c.route().accounts[15];
                meta.is_writable = !meta.is_writable;
            }),
        ),
        (
            "CU price",
            Box::new(|c| {
                c.suffix[PRICE] = ComputeBudgetInstruction::set_compute_unit_price(999_999);
            }),
        ),
        (
            "CU limit",
            Box::new(|c| {
                c.suffix[LIMIT] = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
            }),
        ),
        (
            "setup payer",
            Box::new(|c| c.suffix[SETUP].accounts[0].pubkey = RELAYER),
        ),
        ("setup removed", Box::new(|c| drop(c.suffix.remove(SETUP)))),
        (
            // Authority, source, destination and setup moved together to
            // another user, so every canonical-account check still holds.
            "authority with its source and destination",
            Box::new(move |c| {
                let route = c.route();
                let (source_mint, source_program) =
                    (route.accounts[3].pubkey, route.accounts[5].pubkey);
                let (destination_mint, destination_program) =
                    (route.accounts[4].pubkey, route.accounts[6].pubkey);
                let source = ata(&other_user, &source_mint, &source_program);
                let destination = ata(&other_user, &destination_mint, &destination_program);
                for meta in &mut route.accounts {
                    if meta.pubkey == taker {
                        meta.pubkey = other_user;
                    }
                }
                route.accounts[1].pubkey = source;
                route.accounts[2].pubkey = destination;
                let setup = &mut c.suffix[SETUP];
                setup.accounts[1].pubkey = destination;
                setup.accounts[2].pubkey = other_user;
            }),
        ),
    ];

    let mut env = Env::new();
    for direction in [Direction::Buy, Direction::Sell] {
        let honest = Case::honest(&build("UNHx", direction));
        let (instructions, _) = build_with_matching_commitment(&env, &honest);
        let guard = instructions[0].clone();
        for (label, edit) in &mutations {
            let mut mutated = honest.clone();
            edit(&mut mutated);
            let view = sysvar_view(&with_guard(&mutated, guard.clone()), &mutated.payer);
            let role = match direction {
                Direction::Buy => ProtectedRole::Destination,
                Direction::Sell => ProtectedRole::Source,
            };
            assert_eq!(
                check_suffix(&view[1..], role, &mutated.guard_mint),
                Ok(()),
                "{label}: the mutation must stay semantically valid"
            );
            let outcome = run(&mut env, &with_guard(&mutated, guard.clone()), &mutated);
            assert_eq!(
                outcome.verdict,
                name(EquityGuardError::DownstreamCommitmentMismatch),
                "{direction:?} {label}"
            );
        }

        // Source or destination alone cannot be substituted and stay
        // canonical, so the semantic check reports them first; the
        // commitment would have caught them as well.
        for (label, index, error) in [
            ("source", 1, EquityGuardError::NonCanonicalSourceAccount),
            (
                "destination",
                2,
                EquityGuardError::NonCanonicalDestinationAccount,
            ),
        ] {
            let mut mutated = honest.clone();
            mutated.route().accounts[index].pubkey = ATTACKER;
            if index == 2 {
                mutated.suffix[SETUP].accounts[1].pubkey = ATTACKER;
            }
            let instructions = with_guard(&mutated, guard.clone());
            assert_ne!(
                suffix_commitment_of(&instructions, &mutated.payer),
                suffix_commitment_of(&with_guard(&honest, guard.clone()), &honest.payer),
                "{label}"
            );
            assert_eq!(
                run(&mut env, &instructions, &mutated).verdict,
                name(error),
                "{direction:?} {label}"
            );
        }
    }
}

#[test]
fn protected_state_changes_after_the_plan_are_rejected_on_chain() {
    let mut env = Env::new();
    let case = Case::honest(&build("KOx", Direction::Buy));
    let (instructions, _) = build_with_matching_commitment(&env, &case);
    let mint = case.guard_mint;
    let original = env.svm.get_account(&mint).unwrap().data;

    type Edit =
        fn(&mut spl_token_2022_interface::extension::scaled_ui_amount::ScaledUiAmountConfig);
    let edits: [(&str, Edit, EquityGuardError); 3] = [
        (
            "multiplier moved",
            |c| c.multiplier = PodF64((f64::from(c.multiplier) * 2.0).to_le_bytes()),
            EquityGuardError::MultiplierChanged,
        ),
        (
            "a new change was scheduled",
            |c| c.new_multiplier = PodF64(3.0_f64.to_le_bytes()),
            EquityGuardError::NewMultiplierChanged,
        ),
        (
            "the activation was rescheduled",
            |c| {
                let t = i64::from(c.new_multiplier_effective_timestamp);
                c.new_multiplier_effective_timestamp = (t + 1).into();
            },
            EquityGuardError::EffectiveTimestampChanged,
        ),
    ];
    for (label, edit, expected) in edits {
        let mut data = original.clone();
        {
            use spl_token_2022_interface::{
                extension::{BaseStateWithExtensionsMut, StateWithExtensionsMut},
                state::Mint,
            };
            let mut state = StateWithExtensionsMut::<Mint>::unpack(&mut data).unwrap();
            edit(state.get_extension_mut().unwrap());
        }
        env.set_mint(mint, TOKEN_2022, data);
        assert_eq!(
            run(&mut env, &instructions, &case).verdict,
            name(expected),
            "{label}"
        );
    }
    env.set_mint(mint, TOKEN_2022, original);
    let outcome = run(&mut env, &instructions, &case);
    assert_guard_passed_and_trade_reached(&outcome, &instructions);
}

#[test]
fn a_rerouted_alternative_is_guarded_by_its_own_state_in_its_own_role() {
    // A reroute buys the alternative (here UNHx) through exactly the same
    // adapter; the guard names the alternative's mint and state.
    let mut env = Env::new();
    let case = Case::honest(&build("UNHx", Direction::Buy));
    assert_eq!(case.guard_mint, env.mint("UNHx"));
    let (instructions, _) = build_with_matching_commitment(&env, &case);
    assert_guard_passed_and_trade_reached(&run(&mut env, &instructions, &case), &instructions);

    // The alternative enters its transition window after consent: rejected.
    let mut data = env.svm.get_account(&case.guard_mint).unwrap().data;
    {
        use spl_token_2022_interface::{
            extension::{
                scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensionsMut,
                StateWithExtensionsMut,
            },
            state::Mint,
        };
        let mut state = StateWithExtensionsMut::<Mint>::unpack(&mut data).unwrap();
        let config = state.get_extension_mut::<ScaledUiAmountConfig>().unwrap();
        config.new_multiplier = PodF64(2.0_f64.to_le_bytes());
        config.new_multiplier_effective_timestamp = (NOW + 60).into();
    }
    let stale_state = env.state(&case.guard_mint);
    env.set_mint(case.guard_mint, TOKEN_2022, data);
    assert_eq!(
        run(&mut env, &instructions, &case).verdict,
        name(EquityGuardError::NewMultiplierChanged)
    );
    // Rebuilt against the new state, it is refused for being in the window.
    assert_ne!(env.state(&case.guard_mint), stale_state);
    let (instructions, _) = build_with_matching_commitment(&env, &case);
    let mut pending_guard = AssertSafeExecutionV2::unpack(&instructions[0].data).unwrap();
    pending_guard.execution.expected_phase = ActivationPhase::Pending;
    let mut rebuilt = instructions.clone();
    rebuilt[0].data = pending_guard.pack().to_vec();
    assert_eq!(
        run(&mut env, &rebuilt, &case).verdict,
        name(EquityGuardError::InsideTransitionWindow)
    );
}

#[test]
fn adapter_kind_one_is_unchanged_and_refuses_jupiter() {
    let mut env = Env::new();
    let b = build("KOx", Direction::Buy);
    let honest = Case::honest(&b);
    let expected = env.state(&honest.guard_mint);

    // Kind 1 commits to the single next instruction in its own domain.
    let kind_one = |instructions: &[Instruction], payer: &Address, target: usize| {
        let view = sysvar_view(instructions, payer);
        let next = &view[target];
        let accounts: Vec<CommittedAccount> = next
            .accounts
            .iter()
            .map(|m| CommittedAccount {
                pubkey: m.pubkey.to_bytes(),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect();
        downstream_commitment(&next.program_id.to_bytes(), &accounts, &next.data).unwrap()
    };
    for (label, suffix) in [
        (
            "route_v2 right after the guard",
            vec![b.normalized()[ROUTE].clone()],
        ),
        ("the normalized Jupiter suffix", b.normalized()),
    ] {
        let case = Case {
            suffix,
            adapter: DownstreamAdapter::Token2022TransferChecked,
            ..honest.clone()
        };
        let placeholder = guard_instruction(
            &case.guard_mint,
            expected,
            DownstreamAdapter::Token2022TransferChecked,
            [0; 32],
        );
        let commitment = kind_one(&with_guard(&case, placeholder), &case.payer, 1);
        let guard = guard_instruction(
            &case.guard_mint,
            expected,
            DownstreamAdapter::Token2022TransferChecked,
            commitment,
        );
        assert_eq!(
            run(&mut env, &with_guard(&case, guard), &case).verdict,
            name(EquityGuardError::UnsupportedDownstreamProgram),
            "{label}"
        );
    }

    // A valid kind-2 digest is worthless under kind 1, and vice versa.
    let (instructions, suffix_digest) = build_with_matching_commitment(&env, &honest);
    let mut as_kind_one = AssertSafeExecutionV2::unpack(&instructions[0].data).unwrap();
    as_kind_one.adapter = DownstreamAdapter::Token2022TransferChecked;
    let mut replayed = instructions.clone();
    replayed[0].data = as_kind_one.pack().to_vec();
    assert_eq!(
        run(&mut env, &replayed, &honest).verdict,
        name(EquityGuardError::UnsupportedDownstreamProgram)
    );
    assert_ne!(
        suffix_digest,
        kind_one(&instructions, &honest.payer, ROUTE + 1)
    );
}

/// Section 26. The program is not instrumented, so the phases are read off
/// reject paths that stop at successive checks; each reject also pays for its
/// own error log, so the differences are approximations.
#[test]
fn compute_units_are_measured_per_phase() {
    fn measure(env: &mut Env, case: &Case, expected: &str) -> u64 {
        let (instructions, _) = build_with_matching_commitment(env, case);
        let outcome = run(env, &instructions, case);
        assert_eq!(outcome.verdict, expected);
        outcome.guard_units.unwrap()
    }
    let mut env = Env::new();
    let mut report = Vec::new();
    for (symbol, direction) in [
        ("KOx", Direction::Buy),
        ("KOx", Direction::Sell),
        ("UNHx", Direction::Buy),
        ("UNHx", Direction::Sell),
        ("CRMx", Direction::Sell),
    ] {
        let honest = Case::honest(&build(symbol, direction));
        let mut not_first = honest.clone();
        not_first.guard_index = 1;
        let mut bad_setup = honest.clone();
        bad_setup.suffix[SETUP].data = vec![0];
        let mut bad_source = honest.clone();
        bad_source.route().accounts[1].pubkey = ATTACKER;
        let mut bad_destination = honest.clone();
        bad_destination.route().accounts[2].pubkey = ATTACKER;
        bad_destination.suffix[SETUP].accounts[1].pubkey = ATTACKER;

        let state_and_position = measure(&mut env, &not_first, "GuardNotFirst");
        let grammar = measure(&mut env, &bad_setup, "InvalidAtaSetup");
        let one_derivation = measure(&mut env, &bad_source, "NonCanonicalSourceAccount");
        let two_derivations = measure(&mut env, &bad_destination, "NonCanonicalDestinationAccount");
        let (instructions, digest) = build_with_matching_commitment(&env, &honest);
        let mut wrong = AssertSafeExecutionV2::unpack(&instructions[0].data).unwrap();
        wrong.downstream_commitment = [!digest[0]; 32];
        let mut mismatched = instructions.clone();
        mismatched[0].data = wrong.pack().to_vec();
        let hashed = run(&mut env, &mismatched, &honest).guard_units.unwrap();
        let total = measure(&mut env, &honest, "ok");

        let accounts: usize = honest.suffix.iter().map(|i| i.accounts.len()).sum();
        let route = honest.suffix.last().unwrap();
        let attempts = |owner: usize, mint: usize, program: usize| {
            let (_, bump) = ata_with_bump(
                &route.accounts[owner].pubkey,
                &route.accounts[mint].pubkey,
                &route.accounts[program].pubkey,
            );
            256 - u64::from(bump)
        };
        let extra_attempts = attempts(0, 3, 5) + attempts(0, 4, 6) - 2;
        // The only variable part is the number of bump attempts.
        let expected = GUARD_PASS_ONE_ATTEMPT_EACH + extra_attempts * DERIVATION_ATTEMPT_UNITS;
        assert!(
            total.abs_diff(expected) <= COMPUTE_UNIT_TOLERANCE,
            "{symbol} {direction:?}: {total} CU, expected about {expected} for \
             {extra_attempts} extra derivation attempts. If intended, update the baseline."
        );
        report.push(format!(
            "{symbol:>4} {:<4} | {accounts:>2} accts | ATA attempts {}+{} | state+position {state_and_position:>5} | \
             +suffix load & grammar {:>5} | +source ATA {:>5} | +destination ATA {:>5} | \
             +suffix hash {:>5} | total pass {total:>6}",
            format!("{direction:?}"),
            attempts(0, 3, 5),
            attempts(0, 4, 6),
            grammar - state_and_position,
            one_derivation - grammar,
            two_derivations - one_derivation,
            hashed - two_derivations,
        ));
        assert!(
            total <= MAX_GUARD_COMPUTE_UNITS,
            "{symbol} {direction:?}: {total} CU"
        );
    }
    println!("guard compute units (kinds 2/3):\n{}", report.join("\n"));
}
