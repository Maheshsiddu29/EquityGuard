//! Cross-language golden tests. The fixtures were generated independently of
//! both implementations; the TypeScript client asserts the same files in
//! `packages/guard-client/test`.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic)]

use base64::{engine::general_purpose::STANDARD, Engine};
use equity_guard::{
    error::EquityGuardError,
    instruction::{
        AssertSafeExecution, ProtectionWindow, ASSERT_SAFE_EXECUTION_V1_LEN, VERSION_V1,
    },
    state::{decode_protected_state, ActivationPhase, ProtectedState, StoredMultiplier},
};
use serde_json::Value;

const GOLDEN: &str = include_str!("fixtures/abi_v1_golden.json");
const DECODED: &str = include_str!("fixtures/mainnet/decoded.json");

/// Every error variant, so a new variant without a golden code fails here.
const ALL_ERRORS: [EquityGuardError; 16] = [
    EquityGuardError::UnsupportedInstruction,
    EquityGuardError::InvalidInstructionLength,
    EquityGuardError::InvalidExpectedState,
    EquityGuardError::InvalidAccountCount,
    EquityGuardError::InvalidMintOwner,
    EquityGuardError::InvalidMintData,
    EquityGuardError::MissingScaledUiAmount,
    EquityGuardError::InvalidExtensionCombination,
    EquityGuardError::InvalidMultiplier,
    EquityGuardError::MultiplierChanged,
    EquityGuardError::NewMultiplierChanged,
    EquityGuardError::EffectiveTimestampChanged,
    EquityGuardError::ActivationPhaseChanged,
    EquityGuardError::InsideTransitionWindow,
    EquityGuardError::ArithmeticOverflow,
    EquityGuardError::ClockUnavailable,
];

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
        u64::from(VERSION_V1),
        golden["abiVersion"].as_u64().unwrap()
    );
    assert_eq!(
        ASSERT_SAFE_EXECUTION_V1_LEN as u64,
        golden["encodedLength"].as_u64().unwrap()
    );
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
        let request = AssertSafeExecution {
            expected: ProtectedState {
                multiplier: multiplier(&r["multiplierHex"]),
                new_multiplier: multiplier(&r["newMultiplierHex"]),
                new_multiplier_effective_timestamp: timestamp(
                    &r["newMultiplierEffectiveTimestamp"],
                ),
            },
            expected_phase: ActivationPhase::from_u8(phase).unwrap(),
            window: ProtectionWindow {
                before_secs: u32::try_from(r["protectionBeforeSecs"].as_u64().unwrap()).unwrap(),
                after_secs: u32::try_from(r["protectionAfterSecs"].as_u64().unwrap()).unwrap(),
            },
        };
        let encoded = bytes(vector["encodedHex"].as_str().unwrap());
        assert_eq!(request.pack().as_slice(), encoded.as_slice(), "{name}");
        assert_eq!(AssertSafeExecution::unpack(&encoded), Ok(request), "{name}");
    }
}

#[test]
fn unpack_rejects_golden_invalid_vectors() {
    let golden = golden();
    for vector in golden["invalid"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        let expected = error_named(vector["error"].as_str().unwrap());
        assert_eq!(
            AssertSafeExecution::unpack(&bytes(vector["dataHex"].as_str().unwrap())),
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
