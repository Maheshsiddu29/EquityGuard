//! Shared guard conformance corpus, evaluated against the program's own
//! decoders composed in `processor.rs` order.
//!
//! The corpus (`fixtures/guard_conformance_v1.json`) is generated from the
//! specification by `scripts/fixtures/generate_guard_conformance.py` and is
//! also asserted by the TypeScript client in
//! `packages/guard-client/test/guard-conformance.test.ts`. Each vector stores
//! its expected result exactly once; neither implementation derives it.
//!
//! The model here composes the real decoders — it does not reimplement them —
//! but it does restate `processor.rs`'s ORDER. `litesvm_differential.rs`
//! pins that order against the compiled program.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use equity_guard::{
    downstream::verify_downstream,
    error::EquityGuardError,
    guard,
    instruction::AssertSafeExecutionV2,
    state::{decode_protected_state, ProtectedState},
};
use serde_json::Value;
use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_instruction::{BorrowedAccountMeta, BorrowedInstruction};
use solana_instructions_sysvar::construct_instructions_data;

const CORPUS: &str = include_str!("fixtures/guard_conformance_v1.json");

// ---------------------------------------------------------------- parsing

fn hex_bytes(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd-length hex: {text}");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn address(text: &str) -> Address {
    text.parse().unwrap()
}

/// One account as the guard receives it.
struct GuardAccount {
    pubkey: Address,
    owner: Address,
    data: Vec<u8>,
}

/// One top-level instruction as the Instructions sysvar exposes it.
struct TopLevel {
    program_id: Address,
    accounts: Vec<(Address, bool, bool)>,
    data: Vec<u8>,
}

struct Vector {
    id: String,
    group: String,
    description: String,
    program_id: Address,
    guard_data: Vec<u8>,
    accounts: Vec<GuardAccount>,
    instructions: Vec<TopLevel>,
    current_index: u16,
    clock: i64,
    /// `None` means the vector expects the guard to pass.
    expected: Option<String>,
}

fn parse() -> Vec<Vector> {
    let document: Value = serde_json::from_str(CORPUS).unwrap();
    assert_eq!(document["formatVersion"], 1);
    let vectors = document["vectors"].as_array().unwrap();
    assert_eq!(
        vectors.len(),
        document["vectorCount"].as_u64().unwrap() as usize
    );

    vectors
        .iter()
        .map(|v| {
            let invocation = &v["invocation"];
            let transaction = &v["transaction"];
            let expected = &v["expected"];
            Vector {
                id: v["id"].as_str().unwrap().to_owned(),
                group: v["group"].as_str().unwrap().to_owned(),
                description: v["description"].as_str().unwrap().to_owned(),
                program_id: address(invocation["programId"].as_str().unwrap()),
                guard_data: hex_bytes(invocation["dataHex"].as_str().unwrap()),
                accounts: invocation["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| GuardAccount {
                        pubkey: address(a["pubkey"].as_str().unwrap()),
                        owner: address(a["owner"].as_str().unwrap()),
                        data: hex_bytes(a["dataHex"].as_str().unwrap()),
                    })
                    .collect(),
                instructions: transaction["instructions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|i| TopLevel {
                        program_id: address(i["programId"].as_str().unwrap()),
                        accounts: i["accounts"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|m| {
                                (
                                    address(m["pubkey"].as_str().unwrap()),
                                    m["isSigner"].as_bool().unwrap(),
                                    m["isWritable"].as_bool().unwrap(),
                                )
                            })
                            .collect(),
                        data: hex_bytes(i["dataHex"].as_str().unwrap()),
                    })
                    .collect(),
                current_index: transaction["currentInstructionIndex"].as_u64().unwrap() as u16,
                clock: v["clockUnixTimestamp"].as_str().unwrap().parse().unwrap(),
                expected: match expected["result"].as_str().unwrap() {
                    "ok" => None,
                    "error" => Some(expected["error"].as_str().unwrap().to_owned()),
                    other => panic!("unknown expected result {other}"),
                },
            }
        })
        .collect()
}

// ------------------------------------------------------------ evaluation

/// The Instructions sysvar account data for `vector`, with its current index.
fn sysvar_data(vector: &Vector) -> Vec<u8> {
    let borrowed: Vec<BorrowedInstruction> = vector
        .instructions
        .iter()
        .map(|i| BorrowedInstruction {
            program_id: &i.program_id,
            accounts: i
                .accounts
                .iter()
                .map(|(pubkey, is_signer, is_writable)| BorrowedAccountMeta {
                    pubkey,
                    is_signer: *is_signer,
                    is_writable: *is_writable,
                })
                .collect(),
            data: &i.data,
        })
        .collect();
    let mut data = construct_instructions_data(&borrowed).unwrap();
    // The runtime writes the executing instruction's index into the trailing u16.
    let end = data.len() - 2;
    data[end..].copy_from_slice(&vector.current_index.to_le_bytes());
    data
}

/// The program's decoders in `processor.rs` order, with the clock supplied
/// instead of read from a syscall.
fn evaluate(vector: &Vector) -> Result<(), EquityGuardError> {
    let request = AssertSafeExecutionV2::unpack(&vector.guard_data)?;
    let [mint, instructions_sysvar] = vector.accounts.as_slice() else {
        return Err(EquityGuardError::InvalidAccountCount);
    };
    if mint.pubkey != request.expected_mint {
        return Err(EquityGuardError::MintKeyMismatch);
    }
    if !solana_instructions_sysvar::check_id(&instructions_sysvar.pubkey) {
        return Err(EquityGuardError::InvalidInstructionsSysvar);
    }
    let actual: ProtectedState = decode_protected_state(&mint.owner, &mint.data)?;

    let mut data = sysvar_data(vector);
    let owner = Address::default();
    let mut lamports = 0;
    let info = AccountInfo::new(
        &instructions_sysvar.pubkey,
        false,
        false,
        &mut lamports,
        &mut data,
        &owner,
        false,
    );
    verify_downstream(
        &vector.program_id,
        &vector.guard_data,
        &request,
        &mint.pubkey,
        &info,
    )?;
    guard::check(&request.execution, &actual, vector.clock)
}

fn outcome(result: &Result<(), EquityGuardError>) -> String {
    match result {
        Ok(()) => "ok".to_owned(),
        Err(error) => format!("{error:?}"),
    }
}

fn expected_outcome(vector: &Vector) -> String {
    vector.expected.clone().unwrap_or_else(|| "ok".to_owned())
}

// ----------------------------------------------------------------- tests

#[test]
fn corpus_parses_and_is_not_trivially_small() {
    let vectors = parse();
    assert!(vectors.len() >= 200, "corpus shrank to {}", vectors.len());
    let mut ids: Vec<&str> = vectors.iter().map(|v| v.id.as_str()).collect();
    ids.sort_unstable();
    let unique = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), unique, "duplicate vector ids");
}

#[test]
fn every_vector_matches_its_expected_result() {
    let vectors = parse();
    let mut failures = Vec::new();
    for vector in &vectors {
        let actual = outcome(&evaluate(vector));
        let expected = expected_outcome(vector);
        if actual != expected {
            failures.push(format!(
                "  {} [{}]: expected {expected}, got {actual}\n      {}",
                vector.id, vector.group, vector.description
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} conformance vectors disagree with the shared corpus:\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}

/// The corpus is only as good as its coverage: every outcome it claims to
/// exercise must actually be produced by at least one vector.
#[test]
fn corpus_reaches_every_expected_outcome() {
    let vectors = parse();
    let mut produced: Vec<String> = vectors.iter().map(|v| outcome(&evaluate(v))).collect();
    produced.sort_unstable();
    produced.dedup();

    for required in [
        "ok",
        "UnsupportedInstruction",
        "InvalidInstructionLength",
        "InvalidExpectedState",
        "InvalidAccountCount",
        "InvalidMintOwner",
        "InvalidMintData",
        "MissingScaledUiAmount",
        "InvalidExtensionCombination",
        "InvalidMultiplier",
        "MultiplierChanged",
        "NewMultiplierChanged",
        "EffectiveTimestampChanged",
        "ActivationPhaseChanged",
        "InsideTransitionWindow",
        "ArithmeticOverflow",
        "UnsupportedVersion",
        "MintKeyMismatch",
        "InvalidInstructionsSysvar",
        "MissingDownstreamInstruction",
        "UnsupportedDownstreamProgram",
        "UnsupportedDownstreamInstruction",
        "DownstreamMintMismatch",
        "DownstreamCommitmentMismatch",
        "UnsupportedAdapter",
        "GuardNotTopLevel",
    ] {
        assert!(
            produced.iter().any(|p| p == required),
            "no conformance vector produces {required}"
        );
    }
}

/// Nothing malformed may be classified as safe: only vectors the corpus
/// declares valid are allowed to pass.
#[test]
fn only_declared_valid_vectors_pass() {
    for vector in parse() {
        let passed = evaluate(&vector).is_ok();
        assert_eq!(
            passed,
            vector.expected.is_none(),
            "{}: passed={passed} but the corpus expects {}",
            vector.id,
            expected_outcome(&vector)
        );
    }
}
