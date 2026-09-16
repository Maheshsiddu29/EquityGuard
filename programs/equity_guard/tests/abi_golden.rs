//! Cross-language golden tests. The fixtures were generated independently of
//! both implementations; the TypeScript client asserts the same files in
//! `packages/guard-client/test`.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic)]

use base64::{engine::general_purpose::STANDARD, Engine};
use equity_guard::{
    downstream::{downstream_commitment, CommittedAccount, DOWNSTREAM_COMMITMENT_DOMAIN},
    error::EquityGuardError,
    instruction::{
        AssertSafeExecution, AssertSafeExecutionV2, DownstreamAdapter, ProtectionWindow,
        ASSERT_SAFE_EXECUTION_V2_LEN, VERSION_V2,
    },
    jupiter::{jupiter_suffix_commitment, JUPITER_SUFFIX_COMMITMENT_DOMAIN},
    state::{decode_protected_state, ActivationPhase, ProtectedState, StoredMultiplier},
};
use serde_json::Value;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

const GOLDEN: &str = include_str!("fixtures/abi_v2_golden.json");
const DECODED: &str = include_str!("fixtures/mainnet/decoded.json");

mod common;
/// Every error variant, so a new variant without a golden code fails here.
use common::ALL_ERRORS;

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn multiplier(hex: &Value) -> StoredMultiplier {
    StoredMultiplier::new(bytes(hex.as_str().unwrap()).try_into().unwrap()).unwrap()
}

fn timestamp(value: &Value) -> i64 {
    value.as_str().unwrap().parse().unwrap()
}

fn error_named(name: &str) -> EquityGuardError {
    *ALL_ERRORS
        .iter()
        .find(|error| format!("{error:?}") == name)
        .unwrap_or_else(|| panic!("unknown error {name}"))
}

#[test]
fn layout_constants_match() {
    let golden = golden();
    assert_eq!(
        u64::from(VERSION_V2),
        golden["abiVersion"].as_u64().unwrap()
    );
    assert_eq!(
        ASSERT_SAFE_EXECUTION_V2_LEN as u64,
        golden["encodedLength"].as_u64().unwrap()
    );
    assert_eq!(
        DOWNSTREAM_COMMITMENT_DOMAIN.as_slice(),
        golden["commitmentDomain"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        JUPITER_SUFFIX_COMMITMENT_DOMAIN.as_slice(),
        golden["jupiterSuffixCommitmentDomain"]
            .as_str()
            .unwrap()
            .as_bytes()
    );
}

#[test]
fn every_adapter_kind_has_a_golden_payload() {
    let golden = golden();
    let mut kinds: Vec<u64> = golden["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["request"]["adapterKind"].as_u64().unwrap())
        .collect();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(kinds, [1, 2, 3]);
}

#[test]
fn suffix_commitments_match_golden_vectors() {
    let golden = golden();
    let vectors = golden["suffixCommitmentVectors"].as_array().unwrap();
    assert!(vectors.len() >= 8);
    for vector in vectors {
        let name = vector["name"].as_str().unwrap();
        let suffix: Vec<Instruction> = vector["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| Instruction {
                program_id: i["programId"].as_str().unwrap().parse().unwrap(),
                accounts: i["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| AccountMeta {
                        pubkey: a["pubkey"].as_str().unwrap().parse().unwrap(),
                        is_signer: a["isSigner"].as_bool().unwrap(),
                        is_writable: a["isWritable"].as_bool().unwrap(),
                    })
                    .collect(),
                data: bytes(i["dataHex"].as_str().unwrap()),
            })
            .collect();
        assert_eq!(
            jupiter_suffix_commitment(&suffix).unwrap(),
            array32(vector["commitmentHex"].as_str().unwrap()),
            "{name}"
        );
    }
    // The same TransferChecked hashes differently in the two domains.
    let single = vectors
        .iter()
        .find(|v| v["name"] == "single-instruction-in-the-suffix-domain")
        .unwrap();
    let kind_one = &golden["commitmentVectors"][0];
    assert_eq!(single["instructions"][0]["dataHex"], kind_one["dataHex"]);
    assert_ne!(single["commitmentHex"], kind_one["commitmentHex"]);
}

fn array32(hex: &str) -> [u8; 32] {
    bytes(hex).try_into().unwrap()
}

#[test]
fn pack_and_unpack_match_golden_vectors() {
    let golden = golden();
    let vectors = golden["vectors"].as_array().unwrap();
    assert!(!vectors.is_empty());
    for vector in vectors {
        let name = vector["name"].as_str().unwrap();
        let r = &vector["request"];
        let phase = u8::try_from(r["expectedPhase"].as_u64().unwrap()).unwrap();
        let adapter = u8::try_from(r["adapterKind"].as_u64().unwrap()).unwrap();
        let request = AssertSafeExecutionV2 {
            expected_mint: r["expectedMint"]
                .as_str()
                .unwrap()
                .parse::<Address>()
                .unwrap(),
            execution: AssertSafeExecution {
                expected: ProtectedState {
                    multiplier: multiplier(&r["multiplierHex"]),
                    new_multiplier: multiplier(&r["newMultiplierHex"]),
                    new_multiplier_effective_timestamp: timestamp(
                        &r["newMultiplierEffectiveTimestamp"],
                    ),
                },
                expected_phase: ActivationPhase::from_u8(phase).unwrap(),
                window: ProtectionWindow {
                    before_secs: u32::try_from(r["protectionBeforeSecs"].as_u64().unwrap())
                        .unwrap(),
                    after_secs: u32::try_from(r["protectionAfterSecs"].as_u64().unwrap()).unwrap(),
                },
            },
            adapter: DownstreamAdapter::from_u8(adapter).unwrap(),
            downstream_commitment: array32(r["downstreamCommitmentHex"].as_str().unwrap()),
        };
        let encoded = bytes(vector["encodedHex"].as_str().unwrap());
        assert_eq!(request.pack().as_slice(), encoded.as_slice(), "{name}");
        assert_eq!(
            AssertSafeExecutionV2::unpack(&encoded),
            Ok(request),
            "{name}"
        );
    }
}

#[test]
fn downstream_commitments_match_golden_vectors() {
    let golden = golden();
    let vectors = golden["commitmentVectors"].as_array().unwrap();
    assert!(vectors.len() >= 4);
    for vector in vectors {
        let name = vector["name"].as_str().unwrap();
        let program: Address = vector["programId"].as_str().unwrap().parse().unwrap();
        let accounts: Vec<CommittedAccount> = vector["accounts"]
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
            .collect();
        let data = bytes(vector["dataHex"].as_str().unwrap());
        assert_eq!(
            downstream_commitment(&program.to_bytes(), &accounts, &data).unwrap(),
            array32(vector["commitmentHex"].as_str().unwrap()),
            "{name}"
        );
    }
}

#[test]
fn unpack_rejects_golden_invalid_vectors() {
    let golden = golden();
    for vector in golden["invalid"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        let expected = error_named(vector["error"].as_str().unwrap());
        assert_eq!(
            AssertSafeExecutionV2::unpack(&bytes(vector["dataHex"].as_str().unwrap())),
            Err(expected),
            "{name}"
        );
    }
}

#[test]
fn error_codes_match_golden() {
    let golden = golden();
    let codes = golden["errorCodes"].as_object().unwrap();
    assert_eq!(codes.len(), ALL_ERRORS.len());
    for error in ALL_ERRORS {
        let name = format!("{error:?}");
        assert_eq!(
            codes[&name].as_u64().unwrap(),
            u64::from(error as u32),
            "{name}"
        );
    }
}

#[test]
fn decoder_matches_independent_mainnet_extraction() {
    let decoded: Value = serde_json::from_str(DECODED).unwrap();
    for mint in decoded["mints"].as_array().unwrap() {
        let symbol = mint["symbol"].as_str().unwrap();
        let data = STANDARD
            .decode(
                std::fs::read_to_string(format!(
                    "{}/tests/fixtures/mainnet/{symbol}.base64",
                    env!("CARGO_MANIFEST_DIR")
                ))
                .unwrap()
                .trim(),
            )
            .unwrap();
        let state = decode_protected_state(&spl_token_2022_interface::ID, &data).unwrap();
        assert_eq!(
            state.multiplier,
            multiplier(&mint["multiplierHex"]),
            "{symbol}"
        );
        assert_eq!(
            state.new_multiplier,
            multiplier(&mint["newMultiplierHex"]),
            "{symbol}"
        );
        assert_eq!(
            state.new_multiplier_effective_timestamp,
            timestamp(&mint["newMultiplierEffectiveTimestamp"]),
            "{symbol}"
        );
    }
}
