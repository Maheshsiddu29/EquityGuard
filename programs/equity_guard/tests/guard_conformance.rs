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

use serde_json::Value;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

mod common;
use common::{evaluate, outcome, GuardAccount, GuardInvocation};

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

struct Vector {
    id: String,
    group: String,
    description: String,
    invocation: GuardInvocation,
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
                invocation: GuardInvocation {
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
                        .map(|i| Instruction {
                            program_id: address(i["programId"].as_str().unwrap()),
                            accounts: i["accounts"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|m| AccountMeta {
                                    pubkey: address(m["pubkey"].as_str().unwrap()),
                                    is_signer: m["isSigner"].as_bool().unwrap(),
                                    is_writable: m["isWritable"].as_bool().unwrap(),
                                })
                                .collect(),
                            data: hex_bytes(i["dataHex"].as_str().unwrap()),
                        })
                        .collect(),
                    current_index: transaction["currentInstructionIndex"].as_u64().unwrap() as u16,
                    clock: v["clockUnixTimestamp"].as_str().unwrap().parse().unwrap(),
                },
                expected: match expected["result"].as_str().unwrap() {
                    "ok" => None,
                    "error" => Some(expected["error"].as_str().unwrap().to_owned()),
                    other => panic!("unknown expected result {other}"),
                },
            }
        })
        .collect()
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
        let actual = outcome(&evaluate(&vector.invocation));
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
    let mut produced: Vec<String> = vectors
        .iter()
        .map(|v| outcome(&evaluate(&v.invocation)))
        .collect();
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
        "UnsupportedTransactionGrammar",
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
        let passed = evaluate(&vector.invocation).is_ok();
        assert_eq!(
            passed,
            vector.expected.is_none(),
            "{}: passed={passed} but the corpus expects {}",
            vector.id,
            expected_outcome(&vector)
        );
    }
}

// ------------------------------------------------- named program invariants

/// Asserts the corpus contains a vector matching `id` whose evaluated outcome
/// is `expected`, so an invariant cannot silently lose its evidence.
fn assert_invariant(invariant: &str, id: &str, expected: &str) {
    let vectors = parse();
    let vector = vectors
        .iter()
        .find(|v| v.id == id)
        .unwrap_or_else(|| panic!("{invariant}: the corpus no longer contains {id}"));
    assert_eq!(
        outcome(&evaluate(&vector.invocation)),
        expected,
        "{invariant} ({id})"
    );
    assert_eq!(
        expected_outcome(vector),
        expected,
        "{invariant}: the corpus expectation for {id} changed"
    );
}

/// INV-SEC-11: the guard's mint is the mint the downstream action moves.
#[test]
fn inv_sec_11_guard_mint_equals_downstream_mint() {
    // Both halves: the account handed to the guard, and the mint in the action.
    assert_invariant("INV-SEC-11", "mint-key-mismatch", "MintKeyMismatch");
    assert_invariant(
        "INV-SEC-11",
        "downstream-mint-mismatch",
        "DownstreamMintMismatch",
    );
    assert_invariant(
        "INV-SEC-11",
        "downstream-substituted-mint-account-index",
        "DownstreamMintMismatch",
    );
}

/// INV-SEC-21: the guard protects only the immediately following supported action.
#[test]
fn inv_sec_21_only_the_immediately_following_action_is_protected() {
    assert_invariant(
        "INV-SEC-21",
        "downstream-missing",
        "MissingDownstreamInstruction",
    );
    assert_invariant(
        "INV-SEC-21",
        "downstream-wrong-program-system",
        "UnsupportedDownstreamProgram",
    );
    // A guard that is not last still only reaches the instruction after itself.
    assert_invariant("INV-SEC-21", "valid-guard-at-index-2", "ok");
}

/// INV-SEC-22: the commitment covers every security-relevant downstream field.
#[test]
fn inv_sec_22_commitment_covers_every_downstream_field() {
    for field in [
        "amount",
        "decimals",
        "destination",
        "source",
        "authority",
        "extra-account",
        "account-order",
        "signer-flag",
        "writable-flag",
    ] {
        assert_invariant(
            "INV-SEC-22",
            &format!("downstream-substituted-{field}"),
            "DownstreamCommitmentMismatch",
        );
    }
}

/// INV-SEC-23: ABI v1 can never authorize execution.
#[test]
fn inv_sec_23_abi_v1_can_never_authorize_execution() {
    assert_invariant("INV-SEC-23", "abi-v1-payload", "UnsupportedVersion");
    for version in [0_u8, 1, 3, 255] {
        assert_invariant(
            "INV-SEC-23",
            &format!("abi-version-{version}"),
            "UnsupportedVersion",
        );
    }
    // No vector in the whole corpus is accepted with a version byte other than 2.
    for vector in parse() {
        if evaluate(&vector.invocation).is_ok() {
            assert_eq!(
                vector.invocation.guard_data.first(),
                Some(&2),
                "{} was accepted with a non-v2 version byte",
                vector.id
            );
        }
    }
}

/// INV-SEC-24: an adapter with no understood semantics fails closed.
#[test]
fn inv_sec_24_unsupported_adapters_fail_closed() {
    for adapter in [0_u8, 4, 255] {
        assert_invariant(
            "INV-SEC-24",
            &format!("abi-adapter-{adapter}"),
            "UnsupportedAdapter",
        );
    }
    // Kinds 2 and 3 are defined, but only for their own grammar.
    for adapter in [2_u8, 3] {
        assert_invariant(
            "INV-SEC-24",
            &format!("abi-adapter-{adapter}-over-transfer-checked"),
            "UnsupportedTransactionGrammar",
        );
    }
    for vector in parse() {
        if evaluate(&vector.invocation).is_ok() {
            assert!(
                matches!(vector.invocation.guard_data.get(66), Some(1..=3)),
                "{} was accepted with an unsupported adapter",
                vector.id
            );
        }
    }
}

/// INV-SEC-25: invoked via CPI, the guard cannot borrow another top-level
/// instruction as the action it protects.
#[test]
fn inv_sec_25_a_cpi_invocation_cannot_borrow_a_top_level_action() {
    assert_invariant("INV-SEC-25", "guard-not-top-level-cpi", "GuardNotTopLevel");
    assert_invariant(
        "INV-SEC-25",
        "guard-not-top-level-other-data",
        "GuardNotTopLevel",
    );
}
