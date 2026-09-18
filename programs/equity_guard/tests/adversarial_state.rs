//! M11-A step 5: adversarial Token-2022 state and clock properties.
//!
//! Complements the shared corpora (`guard_fuzz_v1.json`: 430 multiplier bit
//! patterns, 307 TLV layouts; `guard_conformance_v1.json`: 54 clock vectors)
//! with two properties they do not state:
//!
//! 1. `guard::check` equals an independent specification written in `i128`
//!    arithmetic, over extreme timestamps, windows and clocks, so no
//!    truncation, overflow or boundary slip can turn a refusal into a pass.
//! 2. Every single-byte mutation of every real mainnet mint account either
//!    fails to decode or decodes to a state the original expectation still
//!    rejects — unless it left the protected fields byte-identical. No
//!    mutation produces a *different* state that the same expectation
//!    accepts (INV-W).

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic)]

use base64::{engine::general_purpose::STANDARD, Engine};
use equity_guard::{
    error::EquityGuardError,
    guard,
    instruction::{AssertSafeExecution, ProtectionWindow},
    state::{decode_protected_state, ActivationPhase, ProtectedState, StoredMultiplier},
};
use spl_token_2022_interface::extension::{
    pausable::PausableConfig, scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions,
    ExtensionType, StateWithExtensions,
};

const MINTS: [(&str, &str); 6] = [
    ("KOx", include_str!("fixtures/mainnet/KOx.base64")),
    ("UNHx", include_str!("fixtures/mainnet/UNHx.base64")),
    ("CRMx", include_str!("fixtures/mainnet/CRMx.base64")),
    ("KOon", include_str!("fixtures/mainnet/KOon.base64")),
    ("UNHon", include_str!("fixtures/mainnet/UNHon.base64")),
    ("CRMon", include_str!("fixtures/mainnet/CRMon.base64")),
];

/// Deterministic splitmix64: reproducible without a dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[usize::try_from(self.next() % items.len() as u64).unwrap()]
    }
}

fn decode(data: &[u8]) -> Result<ProtectedState, EquityGuardError> {
    decode_protected_state(&spl_token_2022_interface::ID, data)
}

fn mint(encoded: &str) -> Vec<u8> {
    STANDARD.decode(encoded.trim()).unwrap()
}

fn multiplier(value: f64) -> StoredMultiplier {
    StoredMultiplier::new(value.to_le_bytes()).unwrap()
}

/// The guard's clock policy, restated from its documentation in `i128`.
fn spec(
    state: &ProtectedState,
    phase: ActivationPhase,
    window: ProtectionWindow,
    now: i64,
) -> Result<(), EquityGuardError> {
    if state.multiplier == state.new_multiplier {
        return Ok(());
    }
    let t = i128::from(state.new_multiplier_effective_timestamp);
    let start = t - i128::from(window.before_secs);
    let end = t + i128::from(window.after_secs);
    if start < i128::from(i64::MIN) || end > i128::from(i64::MAX) {
        return Err(EquityGuardError::ArithmeticOverflow);
    }
    let now = i128::from(now);
    if start <= now && now <= end {
        return Err(EquityGuardError::InsideTransitionWindow);
    }
    let actual = if now >= t {
        ActivationPhase::Activated
    } else {
        ActivationPhase::Pending
    };
    if actual == phase {
        Ok(())
    } else {
        Err(EquityGuardError::ActivationPhaseChanged)
    }
}

#[test]
fn clock_policy_equals_the_i128_specification_at_the_extremes() {
    let mut rng = Rng(0x0e11_a5ec);
    let special_t = [
        i64::MIN,
        i64::MIN + 1,
        -1,
        0,
        1,
        1_781_481_300,
        i64::MAX - 1,
        i64::MAX,
    ];
    let special_secs = [0, 1, 299, 300, 900, u32::MAX - 1, u32::MAX];
    let (scheduled, unscheduled) = (
        ProtectedState {
            multiplier: multiplier(1.0),
            new_multiplier: multiplier(1.0 + f64::EPSILON),
            new_multiplier_effective_timestamp: 0,
        },
        ProtectedState {
            multiplier: multiplier(1.0),
            new_multiplier: multiplier(1.0),
            new_multiplier_effective_timestamp: 0,
        },
    );
    let mut cases = 0_u64;
    let mut outcomes = std::collections::BTreeMap::<String, u64>::new();
    for _ in 0..200_000 {
        let t = if rng.next().is_multiple_of(2) {
            rng.pick(&special_t)
        } else {
            rng.next().cast_signed()
        };
        let window = ProtectionWindow {
            before_secs: if rng.next().is_multiple_of(2) {
                rng.pick(&special_secs)
            } else {
                u32::try_from(rng.next() >> 32).unwrap()
            },
            after_secs: if rng.next().is_multiple_of(2) {
                rng.pick(&special_secs)
            } else {
                u32::try_from(rng.next() >> 32).unwrap()
            },
        };
        // Clocks at, just inside and just outside every boundary.
        let offsets = [
            -i128::from(window.before_secs) - 1,
            -i128::from(window.before_secs),
            -1,
            0,
            1,
            i128::from(window.after_secs),
            i128::from(window.after_secs) + 1,
        ];
        let now = match rng.next() % 4 {
            0 => rng.pick(&[i64::MIN, i64::MAX, 0]),
            1 => rng.next().cast_signed(),
            _ => i64::try_from(i128::from(t) + rng.pick(&offsets)).unwrap_or(t),
        };
        let base = if rng.next().is_multiple_of(8) {
            unscheduled
        } else {
            scheduled
        };
        let state = ProtectedState {
            new_multiplier_effective_timestamp: t,
            ..base
        };
        let phase = if rng.next().is_multiple_of(2) {
            ActivationPhase::Pending
        } else {
            ActivationPhase::Activated
        };
        let request = AssertSafeExecution {
            expected: state,
            expected_phase: phase,
            window,
        };
        let actual = guard::check(&request, &state, now);
        assert_eq!(
            actual,
            spec(&state, phase, window, now),
            "t={t} now={now} window={window:?} phase={phase:?}"
        );
        *outcomes.entry(format!("{actual:?}")).or_default() += 1;
        cases += 1;
    }
    println!("clock policy: {cases} cases, outcomes {outcomes:?}");
    // Every outcome is reached, so the generator is not vacuous.
    assert_eq!(outcomes.len(), 4, "{outcomes:?}");
}

#[test]
fn a_changed_stored_state_is_never_accepted_by_the_old_expectation() {
    let mut rng = Rng(0x0057_a7e0);
    let mut cases = 0_u64;
    for _ in 0..100_000 {
        let valid = |rng: &mut Rng| loop {
            if let Some(m) = StoredMultiplier::new(rng.next().to_le_bytes()) {
                break m;
            }
        };
        let current = valid(&mut rng);
        let expected = ProtectedState {
            multiplier: current,
            // A third of the states have no scheduled change.
            new_multiplier: if rng.next().is_multiple_of(3) {
                current
            } else {
                valid(&mut rng)
            },
            new_multiplier_effective_timestamp: rng.next().cast_signed(),
        };
        let bit = rng.next() % 192;
        let mut actual = expected;
        match bit / 64 {
            0 => {
                let mut bytes = u64::from_le_bytes(expected.multiplier.to_bytes());
                bytes ^= 1 << (bit % 64);
                match StoredMultiplier::new(bytes.to_le_bytes()) {
                    Some(m) => actual.multiplier = m,
                    None => continue, // the decoder refuses it before any comparison
                }
            }
            1 => {
                let mut bytes = u64::from_le_bytes(expected.new_multiplier.to_bytes());
                bytes ^= 1 << (bit % 64);
                match StoredMultiplier::new(bytes.to_le_bytes()) {
                    Some(m) => actual.new_multiplier = m,
                    None => continue,
                }
            }
            _ => actual.new_multiplier_effective_timestamp ^= 1 << (bit % 64),
        }
        for phase in [ActivationPhase::Pending, ActivationPhase::Activated] {
            let request = AssertSafeExecution {
                expected,
                expected_phase: phase,
                window: ProtectionWindow {
                    before_secs: 0,
                    after_secs: 0,
                },
            };
            let now = rng.next().cast_signed();
            let verdict = guard::check(&request, &actual, now);
            assert!(
                matches!(
                    verdict,
                    Err(EquityGuardError::MultiplierChanged
                        | EquityGuardError::NewMultiplierChanged
                        | EquityGuardError::EffectiveTimestampChanged)
                ),
                "{expected:?} vs {actual:?}: {verdict:?}"
            );
            cases += 1;
        }
    }
    println!("stored-state identity: {cases} cases, none accepted");
}

#[test]
fn byte_swapped_and_sign_flipped_multipliers_never_pass_as_the_original() {
    for (symbol, encoded) in MINTS {
        let state = decode(&mint(encoded)).unwrap();
        for original in [state.multiplier, state.new_multiplier] {
            let bytes = original.to_bytes();
            let mut swapped = bytes;
            swapped.reverse();
            let mut negative = bytes;
            negative[7] |= 0x80;
            let mut big_endian_reading = bytes;
            big_endian_reading.copy_from_slice(&f64::from_be_bytes(bytes).to_le_bytes());
            for (label, candidate) in [
                ("swapped", swapped),
                ("negative", negative),
                ("big-endian", big_endian_reading),
            ] {
                // Refused outright, or a different value compared by bytes.
                if let Some(other) = StoredMultiplier::new(candidate) {
                    assert_ne!(other, original, "{symbol} {label}");
                }
            }
            assert_eq!(
                StoredMultiplier::new(negative),
                None,
                "{symbol}: a negative multiplier"
            );
        }
    }
}

/// Offset of the value of the TLV entry of type `extension` in `data`.
fn tlv_value(data: &[u8], extension: ExtensionType) -> usize {
    let wanted = u16::from(extension).to_le_bytes();
    let mut offset = 166;
    loop {
        if data[offset..offset + 2] == wanted {
            return offset + 4;
        }
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]);
        offset += 4 + usize::from(len);
    }
}

/// The protected ScaledUiAmount bytes: after the 32-byte authority,
/// multiplier (8), effective timestamp (8), new multiplier (8).
fn protected_range(data: &[u8]) -> std::ops::Range<usize> {
    let value = tlv_value(data, ExtensionType::ScaledUiAmount);
    value + 32..value + 56
}

#[test]
fn every_single_byte_mutation_of_a_real_mint_fails_closed_or_changes_nothing_protected() {
    let now = 1_800_000_000;
    let (mut decoded_unchanged, mut refused, mut rejected) = (0_u64, 0_u64, 0_u64);
    for (symbol, encoded) in MINTS {
        let original = mint(encoded);
        let state = decode(&original).unwrap();
        let protected = protected_range(&original);
        for phase in [ActivationPhase::Pending, ActivationPhase::Activated] {
            let request = AssertSafeExecution {
                expected: state,
                expected_phase: phase,
                window: ProtectionWindow {
                    before_secs: 0,
                    after_secs: 0,
                },
            };
            let baseline = guard::check(&request, &state, now);
            for offset in 0..original.len() {
                for mask in [0x01_u8, 0x10, 0x80, 0xff] {
                    let mut data = original.clone();
                    data[offset] ^= mask;
                    match decode(&data) {
                        Err(_) => refused += 1,
                        Ok(mutated) if mutated == state => {
                            assert!(
                                !protected.contains(&offset),
                                "{symbol}: protected byte {offset} changed nothing"
                            );
                            assert_eq!(guard::check(&request, &mutated, now), baseline);
                            decoded_unchanged += 1;
                        }
                        Ok(mutated) => {
                            assert!(protected.contains(&offset), "{symbol}: byte {offset} outside the protected fields changed the state");
                            assert!(guard::check(&request, &mutated, now).is_err(), "{symbol}: byte {offset} ^ {mask:#04x} accepted by the original expectation");
                            rejected += 1;
                        }
                    }
                }
            }
        }
    }
    println!("single-byte mutations: {refused} refused by the decoder, {rejected} decoded to a changed state and rejected, {decoded_unchanged} left the protected state identical");
    assert!(refused > 0 && rejected > 0 && decoded_unchanged > 0);
}

#[test]
fn the_pausable_flag_does_not_change_the_guard_verdict() {
    // Documented semantics (docs/threat-model.md): the guard does not read
    // Pausable; Token-2022 itself refuses to move a paused mint's tokens, so
    // the downstream trade fails regardless.
    for (symbol, encoded) in MINTS {
        let original = mint(encoded);
        // PausableConfig: authority (32), then the flag.
        let paused_flag = tlv_value(&original, ExtensionType::Pausable) + 32;
        let config =
            StateWithExtensions::<spl_token_2022_interface::state::Mint>::unpack(&original)
                .unwrap();
        assert!(
            !bool::from(config.get_extension::<PausableConfig>().unwrap().paused),
            "{symbol}"
        );
        assert_eq!(original[paused_flag], 0, "{symbol} was captured unpaused");
        let mut paused = original.clone();
        paused[paused_flag] = 1;
        assert_eq!(decode(&paused), decode(&original), "{symbol}");
    }
}

#[test]
fn truncated_and_extended_accounts_never_decode_to_another_state() {
    for (symbol, encoded) in MINTS {
        let original = mint(encoded);
        let state = decode(&original).unwrap();
        for len in 0..original.len() {
            if let Ok(decoded) = decode(&original[..len]) {
                assert_eq!(decoded, state, "{symbol} truncated to {len}");
            }
        }
        let mut rng = Rng(u64::try_from(original.len()).unwrap());
        for extra in 1..64 {
            let mut data = original.clone();
            data.extend((0..extra).map(|_| u8::try_from(rng.next() & 0xff).unwrap()));
            if let Ok(decoded) = decode(&data) {
                assert_eq!(decoded, state, "{symbol} extended by {extra}");
            }
            let mut zeros = original.clone();
            zeros.resize(original.len() + extra, 0);
            assert_eq!(
                decode(&zeros),
                Ok(state),
                "{symbol}: zero padding is the end of the TLV area"
            );
        }
        // The protected fields' own length is part of the layout.
        let config_len = u16::try_from(std::mem::size_of::<ScaledUiAmountConfig>()).unwrap();
        assert_eq!(config_len, 56);
    }
}

#[test]
fn extreme_effective_timestamps_decode_exactly_and_fail_closed_on_overflow() {
    use spl_token_2022_interface::extension::{BaseStateWithExtensionsMut, StateWithExtensionsMut};
    let original = mint(MINTS[0].1);
    for t in [i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX] {
        let mut data = original.clone();
        {
            let mut state =
                StateWithExtensionsMut::<spl_token_2022_interface::state::Mint>::unpack(&mut data)
                    .unwrap();
            state
                .get_extension_mut::<ScaledUiAmountConfig>()
                .unwrap()
                .new_multiplier_effective_timestamp = t.into();
        }
        let state = decode(&data).unwrap();
        assert_eq!(state.new_multiplier_effective_timestamp, t);
        let wide = ProtectionWindow {
            before_secs: u32::MAX,
            after_secs: u32::MAX,
        };
        for now in [
            i64::MIN,
            t.saturating_sub(1),
            t,
            t.saturating_add(1),
            i64::MAX,
        ] {
            for phase in [ActivationPhase::Pending, ActivationPhase::Activated] {
                let request = AssertSafeExecution {
                    expected: state,
                    expected_phase: phase,
                    window: wide,
                };
                assert_eq!(
                    guard::check(&request, &state, now),
                    spec(&state, phase, wide, now),
                    "t={t} now={now}"
                );
            }
        }
    }
}
