//! Shared decoder fuzz corpus, evaluated against the program's decoders.
//!
//! The corpus (`fixtures/guard_fuzz_v1.json`) is generated from the
//! specification by `scripts/fixtures/generate_guard_fuzz.py` and is also
//! asserted by `packages/guard-client/test/guard-fuzz.test.ts`. Every
//! expectation is authored there; nothing here is derived from the
//! implementation under test.
//!
//! A panic anywhere in this file's corpus is a security finding, not a test
//! failure to paper over: these are the decoders a hostile transaction
//! reaches first.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic, clippy::result_large_err)]

use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount},
    error::EquityGuardError,
    instruction::AssertSafeExecutionV2,
    state::{decode_protected_state, StoredMultiplier},
};
use serde_json::Value;
use solana_address::Address;

const CORPUS: &str = include_str!("fixtures/guard_fuzz_v1.json");
const TOKEN_2022: Address = spl_token_2022_interface::ID;

fn corpus() -> Value {
    let document: Value = serde_json::from_str(CORPUS).unwrap();
    assert_eq!(document["formatVersion"], 1);
    document
}

fn hex_bytes(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd-length hex: {text}");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn array8(bytes: &[u8]) -> [u8; 8] {
    bytes.try_into().unwrap()
}

fn section(document: &Value, name: &str) -> Vec<Value> {
    let entries = document[name].as_array().unwrap().clone();
    assert_eq!(
        entries.len(),
        document["counts"][name].as_u64().unwrap() as usize,
        "{name} count does not match the corpus header"
    );
    assert!(!entries.is_empty(), "{name} is empty");
    entries
}

// ------------------------------------------------------ f64 bit patterns

#[test]
fn stored_multiplier_validity_matches_the_corpus() {
    let document = corpus();
    let mut failures = Vec::new();
    let cases = section(&document, "multipliers");
    for case in &cases {
        let bytes = array8(&hex_bytes(case["bytesHex"].as_str().unwrap()));
        let accepted = StoredMultiplier::new(bytes).is_some();
        let expected = case["valid"].as_bool().unwrap();
        if accepted != expected {
            failures.push(format!(
                "  {} ({}): accepted={accepted}, corpus says valid={expected}",
                case["label"].as_str().unwrap(),
                case["class"].as_str().unwrap()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} multiplier patterns disagree:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn accepted_multipliers_round_trip_their_exact_bytes() {
    for case in section(&corpus(), "multipliers") {
        if !case["valid"].as_bool().unwrap() {
            continue;
        }
        let bytes = array8(&hex_bytes(case["bytesHex"].as_str().unwrap()));
        let stored = StoredMultiplier::new(bytes).unwrap();
        // Identity is byte identity: no float round trip may alter the bytes.
        assert_eq!(stored.to_bytes(), bytes, "{}", case["label"]);
    }
}

#[test]
fn every_multiplier_class_is_exercised() {
    let classes: Vec<String> = section(&corpus(), "multipliers")
        .iter()
        .map(|c| c["class"].as_str().unwrap().to_owned())
        .collect();
    for required in [
        "normal",
        "negative-normal",
        "zero",
        "negative-zero",
        "subnormal",
        "negative-subnormal",
        "infinity",
        "negative-infinity",
        "nan",
        "negative-nan",
    ] {
        assert!(
            classes.iter().any(|c| c == required),
            "no multiplier of class {required} in the corpus"
        );
    }
}

// --------------------------------------------------------- ABI payloads

fn decode_outcome(data: &[u8]) -> String {
    match AssertSafeExecutionV2::unpack(data) {
        Ok(_) => "ok".to_owned(),
        Err(error) => format!("{error:?}"),
    }
}

#[test]
fn abi_payload_decoding_matches_the_corpus() {
    let document = corpus();
    let cases = section(&document, "abiPayloads");
    let mut failures = Vec::new();
    for case in &cases {
        let data = hex_bytes(case["dataHex"].as_str().unwrap());
        let actual = decode_outcome(&data);
        let expected = case["expected"].as_str().unwrap();
        if actual != expected {
            failures.push(format!(
                "  {} ({} bytes): expected {expected}, got {actual}",
                case["label"].as_str().unwrap(),
                data.len()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} ABI payloads disagree:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn every_accepted_abi_payload_re_encodes_to_the_same_bytes() {
    for case in section(&corpus(), "abiPayloads") {
        if case["expected"] != "ok" {
            continue;
        }
        let data = hex_bytes(case["dataHex"].as_str().unwrap());
        let decoded = AssertSafeExecutionV2::unpack(&data).unwrap();
        assert_eq!(
            decoded.pack().as_slice(),
            data.as_slice(),
            "{} does not round trip",
            case["label"]
        );
    }
}

// ------------------------------------------------- downstream commitment

fn committed_accounts(instruction: &Value) -> Vec<CommittedAccount> {
    instruction["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| CommittedAccount {
            pubkey: a["pubkey"]
                .as_str()
                .unwrap()
                .parse::<Address>()
                .unwrap()
                .to_bytes(),
            is_signer: a["isSigner"].as_bool().unwrap(),
            is_writable: a["isWritable"].as_bool().unwrap(),
        })
        .collect()
}

fn commitment_of(instruction: &Value) -> String {
    let program_id: Address = instruction["programId"].as_str().unwrap().parse().unwrap();
    let data = hex_bytes(instruction["dataHex"].as_str().unwrap());
    to_hex(
        &downstream_commitment(
            &program_id.to_bytes(),
            &committed_accounts(instruction),
            &data,
        )
        .unwrap(),
    )
}

#[test]
fn downstream_commitments_match_the_corpus() {
    let document = corpus();
    let cases = section(&document, "commitments");
    for case in &cases {
        assert_eq!(
            commitment_of(&case["instruction"]),
            case["commitmentHex"].as_str().unwrap(),
            "{}",
            case["label"]
        );
    }
}

/// INV-SEC-22: the commitment covers every security-relevant downstream field.
#[test]
fn every_single_field_mutation_changes_the_commitment() {
    let document = corpus();
    let mutations = section(&document, "commitmentMutations");
    let base = mutations
        .iter()
        .find(|m| m["label"] == "base")
        .expect("no base mutation");
    let base_commitment = commitment_of(&base["instruction"]);

    let mut seen: Vec<(String, String)> = Vec::new();
    for mutation in &mutations {
        let label = mutation["label"].as_str().unwrap().to_owned();
        let actual = commitment_of(&mutation["instruction"]);
        assert_eq!(
            actual,
            mutation["commitmentHex"].as_str().unwrap(),
            "{label} commitment disagrees with the corpus"
        );
        if label != "base" {
            assert_ne!(
                actual, base_commitment,
                "{label} ({}) leaves the commitment unchanged",
                mutation["field"]
            );
        }
        if let Some((other, _)) = seen.iter().find(|(_, c)| *c == actual) {
            panic!("{label} and {other} share a commitment");
        }
        seen.push((label, actual));
    }
    // Every field of the encoding must be represented by at least one mutation.
    let fields: Vec<&str> = mutations
        .iter()
        .map(|m| m["field"].as_str().unwrap())
        .collect();
    for required in [
        "programId",
        "accounts.pubkey",
        "accounts.isSigner",
        "accounts.isWritable",
        "accounts.length",
        "accounts.order",
        "data.amount",
        "data.decimals",
        "data.tag",
        "data.length",
        "framing",
    ] {
        assert!(
            fields.contains(&required),
            "no commitment mutation covers {required}"
        );
    }
}

/// Equal commitments must mean equal preimages across the whole corpus: a
/// canonical-encoding and field-coverage check, not a claim about SHA-256
/// itself. The base instruction appears in both sections by design, so this
/// is keyed on the preimage rather than on instruction count.
#[test]
fn equal_commitments_only_ever_come_from_equal_preimages() {
    let document = corpus();
    let mut by_commitment: Vec<(String, String, String)> = Vec::new();
    for entry in section(&document, "commitments")
        .iter()
        .chain(section(&document, "commitmentMutations").iter())
    {
        let label = entry["label"].as_str().unwrap().to_owned();
        let preimage = entry["preimageHex"].as_str().unwrap().to_owned();
        let commitment = entry["commitmentHex"].as_str().unwrap().to_owned();
        // The recorded hash really is SHA-256 of the recorded preimage.
        assert_eq!(
            to_hex(&solana_sha256_hasher::hash(&hex_bytes(&preimage)).to_bytes()),
            commitment,
            "{label}: the corpus preimage does not hash to its commitment"
        );
        if let Some((other, other_preimage, _)) =
            by_commitment.iter().find(|(_, _, c)| *c == commitment)
        {
            assert_eq!(
                *other_preimage, preimage,
                "commitment collision between {other} and {label}"
            );
        }
        by_commitment.push((label, preimage, commitment));
    }
    assert!(by_commitment.len() > 300);
}

// ---------------------------------------------------- Token-2022 layouts

#[test]
fn token_2022_layout_decisions_match_the_corpus() {
    let document = corpus();
    let cases = section(&document, "tlvCases");
    let mut failures = Vec::new();
    for case in &cases {
        let data = hex_bytes(case["dataHex"].as_str().unwrap());
        let decoded = decode_protected_state(&TOKEN_2022, &data);
        let accepted = decoded.is_ok();
        let expected = case["accept"].as_bool().unwrap();
        if accepted != expected {
            failures.push(format!(
                "  {} ({} bytes): accepted={accepted}, corpus says accept={expected} ({})\n      {:?}",
                case["label"].as_str().unwrap(),
                data.len(),
                case["reason"].as_str().unwrap(),
                decoded.err()
            ));
            continue;
        }
        // An accepted layout must report exactly the bytes at the documented offsets.
        if let (Ok(state), Some(protected)) = (decoded, case.get("protected")) {
            assert_eq!(
                to_hex(&state.multiplier.to_bytes()),
                protected["multiplierHex"].as_str().unwrap(),
                "{} multiplier",
                case["label"]
            );
            assert_eq!(
                to_hex(&state.new_multiplier.to_bytes()),
                protected["newMultiplierHex"].as_str().unwrap(),
                "{} new multiplier",
                case["label"]
            );
            assert_eq!(
                state.new_multiplier_effective_timestamp.to_string(),
                protected["effectiveTimestamp"].as_str().unwrap(),
                "{} effective timestamp",
                case["label"]
            );
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} Token-2022 layouts disagree:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// The owner check comes first: no layout, however well formed, is accepted
/// from an account another program owns.
#[test]
fn no_layout_is_accepted_from_a_foreign_owner() {
    let legacy_token: Address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        .parse()
        .unwrap();
    for case in section(&corpus(), "tlvCases") {
        let data = hex_bytes(case["dataHex"].as_str().unwrap());
        for owner in [legacy_token, Address::default(), equity_guard::ID] {
            assert_eq!(
                decode_protected_state(&owner, &data),
                Err(EquityGuardError::InvalidMintOwner),
                "{} under owner {owner}",
                case["label"]
            );
        }
    }
}
