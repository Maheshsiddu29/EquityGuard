//! M11-B differential evaluator: the Rust host model and, for a sample, the
//! compiled SBF program, over a stream of guard cases.
//!
//! Reads length-prefixed case records (`scripts/m11b/guard-cases.ts`) on
//! stdin and writes one result byte per case (0 = allowed, otherwise the
//! program error code + 1) to `--results`. Every `--litesvm-every`-th case is
//! also executed as a real transaction against `target/deploy/equity_guard.so`
//! in LiteSVM, and the program's verdict is compared with the host model's.
//!
//! A JSON summary goes to stdout: case count, SHA-256 of the input stream and
//! of the results, expectation violations, and the LiteSVM leg's agreement
//! and guard compute units per verdict.
//!
//! Local evidence tooling: nothing here signs for or talks to any cluster.
//!
//!   cargo build-sbf && cargo build --example m11b_differential
//!   node scripts/m11b/differential.ts ...   # spawns this binary

// Evidence harness, not program code: a panic is the correct way to fail.
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::result_large_err
)]

#[path = "../tests/common/mod.rs"]
mod common;

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::time::Instant;

use common::{error_name, evaluate, GuardAccount, GuardInvocation};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_sha256_hasher::Hasher;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

const PROGRAM_ID: Address = equity_guard::ID;
/// Must match `PAYER_SEED` in `scripts/m11b/guard-cases.ts`.
const PAYER_SEED: [u8; 32] = [7; 32];

const EXPECT_ALLOW: u8 = 0;
const EXPECT_EXACT: u8 = 1;
const EXPECT_ANY: u8 = 2;

struct Case {
    index: u32,
    category: u8,
    expect_kind: u8,
    expect_code: u8,
    invocation: GuardInvocation,
    mint_owner: Address,
}

struct Cursor<'a>(&'a [u8]);

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> &[u8] {
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        head
    }
    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take(2).try_into().unwrap())
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take(8).try_into().unwrap())
    }
    fn address(&mut self) -> Address {
        Address::new_from_array(self.take(32).try_into().unwrap())
    }
}

fn parse(record: &[u8]) -> Case {
    let mut c = Cursor(record);
    let index = c.u32();
    let category = c.u8();
    let expect_kind = c.u8();
    let expect_code = c.u8();
    let mint_key = c.address();
    let mint_owner = c.address();
    let mint_len = usize::from(c.u16());
    let mint_data = c.take(mint_len).to_vec();
    let guard_len = usize::from(c.u8());
    let guard_data = c.take(guard_len).to_vec();
    let clock = c.i64();
    let count = c.u8();
    let instructions = (0..count)
        .map(|_| {
            let program_id = c.address();
            let accounts = (0..c.u8())
                .map(|_| {
                    let pubkey = c.address();
                    let is_signer = c.u8() == 1;
                    let is_writable = c.u8() == 1;
                    AccountMeta {
                        pubkey,
                        is_signer,
                        is_writable,
                    }
                })
                .collect();
            let len = usize::from(c.u16());
            Instruction {
                program_id,
                accounts,
                data: c.take(len).to_vec(),
            }
        })
        .collect();
    let current_index = c.u16();
    assert!(c.0.is_empty(), "case {index}: trailing bytes");
    Case {
        index,
        category,
        expect_kind,
        expect_code,
        mint_owner,
        invocation: GuardInvocation {
            program_id: PROGRAM_ID,
            guard_data,
            accounts: vec![
                GuardAccount {
                    pubkey: mint_key,
                    owner: mint_owner,
                    data: mint_data,
                },
                GuardAccount {
                    pubkey: solana_instructions_sysvar::ID,
                    owner: Address::default(),
                    data: Vec::new(),
                },
            ],
            instructions,
            current_index,
            clock,
        },
    }
}

fn result_byte(result: &Result<(), equity_guard::EquityGuardError>) -> u8 {
    match result {
        Ok(()) => 0,
        Err(error) => u8::try_from(*error as u32 + 1).unwrap(),
    }
}

fn result_label(byte: u8) -> String {
    if byte == 0 {
        "ok".to_owned()
    } else {
        error_name(u32::from(byte) - 1)
    }
}

fn program_path() -> PathBuf {
    let dir = std::env::var_os("SBF_OUT_DIR").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy"),
        PathBuf::from,
    );
    dir.join("equity_guard.so")
}

/// The compiled program, executing each sampled case as a real transaction.
struct Chain {
    svm: LiteSVM,
    payer: Keypair,
}

impl Chain {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let path = program_path();
        assert!(
            path.exists(),
            "{} not found: run `cargo build-sbf` first",
            path.display()
        );
        svm.add_program_from_file(PROGRAM_ID, path).unwrap();
        let payer = Keypair::new_from_array(PAYER_SEED);
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        Self { svm, payer }
    }

    /// The program's verdict and, when the guard ran, its compute units.
    fn run(&mut self, case: &Case) -> (u8, Option<u64>) {
        let mint = &case.invocation.accounts[0];
        self.svm
            .set_account(
                mint.pubkey,
                Account {
                    lamports: 1_000_000_000,
                    data: mint.data.clone(),
                    owner: case.mint_owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = case.invocation.clock;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &case.invocation.instructions,
            Some(&self.payer.pubkey()),
            &[&self.payer],
            self.svm.latest_blockhash(),
        );
        let guard_index = usize::from(case.invocation.current_index);
        let (result, logs) = match self.svm.send_transaction(tx) {
            Ok(meta) => (Ok(()), meta.logs),
            Err(failed) => (Err(failed.err), failed.meta.logs),
        };
        let byte = match result {
            Err(TransactionError::InstructionError(index, InstructionError::Custom(code)))
                if usize::from(index) == guard_index =>
            {
                u8::try_from(code + 1).unwrap()
            }
            // A failure elsewhere means the guard itself allowed execution.
            _ => 0,
        };
        (byte, guard_units(&logs))
    }
}

/// The guard program's own compute units, from the runtime log line.
fn guard_units(logs: &[String]) -> Option<u64> {
    let prefix = format!("Program {PROGRAM_ID} consumed ");
    logs.iter()
        .find_map(|line| line.strip_prefix(&prefix)?.split(' ').next()?.parse().ok())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn percentile(sorted: &[u64], p: usize) -> u64 {
    sorted[(sorted.len() - 1) * p / 100]
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let results_path = arg("--results").expect("--results <path> is required");
    let litesvm_every: u32 = arg("--litesvm-every").map_or(0, |v| v.parse().unwrap());
    let mut input = BufReader::with_capacity(1 << 20, io::stdin().lock());
    let mut results = BufWriter::new(File::create(&results_path).unwrap());
    let mut chain = (litesvm_every > 0).then(Chain::new);

    let mut input_digest = Hasher::default();
    let mut results_digest = Hasher::default();
    let mut cases: u64 = 0;
    let mut verdicts: BTreeMap<String, u64> = BTreeMap::new();
    let mut unexpected_allows: Vec<String> = Vec::new();
    let mut unexpected_blocks: Vec<String> = Vec::new();
    let mut exact_mismatches: Vec<String> = Vec::new();
    let mut chain_cases: u64 = 0;
    let mut chain_disagreements: Vec<String> = Vec::new();
    let mut units: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    let started = Instant::now();
    let mut model_secs = 0.0_f64;

    let mut length = [0_u8; 4];
    loop {
        match input.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => panic!("{error}"),
        }
        let mut record = vec![0_u8; u32::from_le_bytes(length) as usize];
        input.read_exact(&mut record).unwrap();
        input_digest.hash(&length);
        input_digest.hash(&record);
        let case = parse(&record);

        let t = Instant::now();
        let model = result_byte(&evaluate(&case.invocation));
        model_secs += t.elapsed().as_secs_f64();
        results.write_all(&[model]).unwrap();
        results_digest.hash(&[model]);
        cases += 1;
        *verdicts.entry(result_label(model)).or_default() += 1;

        let tag = || format!("case {} (category {})", case.index, case.category);
        match case.expect_kind {
            EXPECT_ALLOW if model != 0 => {
                unexpected_blocks.push(format!("{}: {}", tag(), result_label(model)));
            }
            EXPECT_EXACT | EXPECT_ANY if model == 0 => unexpected_allows.push(tag()),
            EXPECT_EXACT if model != case.expect_code + 1 => exact_mismatches.push(format!(
                "{}: expected {}, got {}",
                tag(),
                result_label(case.expect_code + 1),
                result_label(model)
            )),
            _ => {}
        }

        if let Some(chain) = chain.as_mut() {
            if case.index.is_multiple_of(litesvm_every) {
                let (program, cu) = chain.run(&case);
                chain_cases += 1;
                if program != model {
                    chain_disagreements.push(format!(
                        "{}: model {}, program {}",
                        tag(),
                        result_label(model),
                        result_label(program)
                    ));
                }
                if let Some(cu) = cu {
                    units.entry(result_label(program)).or_default().push(cu);
                }
            }
        }
    }
    results.flush().unwrap();

    let unit_stats: Vec<String> = units
        .iter_mut()
        .map(|(verdict, values)| {
            values.sort_unstable();
            format!(
                "\"{verdict}\":{{\"n\":{},\"min\":{},\"p50\":{},\"max\":{}}}",
                values.len(),
                values[0],
                percentile(values, 50),
                values[values.len() - 1]
            )
        })
        .collect();
    let list = |items: &[String]| {
        let shown: Vec<String> = items.iter().take(20).map(|s| format!("{s:?}")).collect();
        format!("[{}]", shown.join(","))
    };
    let verdict_json: Vec<String> = verdicts
        .iter()
        .map(|(k, v)| format!("\"{k}\":{v}"))
        .collect();
    println!(
        "{{\"implementation\":\"rust-host-model\",\"cases\":{cases},\"inputSha256\":\"{}\",\"resultsSha256\":\"{}\",\
\"elapsedSecs\":{:.3},\"modelSecs\":{model_secs:.3},\"verdicts\":{{{}}},\
\"unexpectedAllows\":{},\"unexpectedAllowExamples\":{},\"unexpectedBlocks\":{},\"unexpectedBlockExamples\":{},\
\"exactMismatches\":{},\"exactMismatchExamples\":{},\
\"litesvm\":{{\"every\":{litesvm_every},\"cases\":{chain_cases},\"disagreements\":{},\"examples\":{},\"guardUnits\":{{{}}}}}}}",
        hex(input_digest.result().as_ref()),
        hex(results_digest.result().as_ref()),
        started.elapsed().as_secs_f64(),
        verdict_json.join(","),
        unexpected_allows.len(),
        list(&unexpected_allows),
        unexpected_blocks.len(),
        list(&unexpected_blocks),
        exact_mismatches.len(),
        list(&exact_mismatches),
        chain_disagreements.len(),
        list(&chain_disagreements),
        unit_stats.join(",")
    );
}
