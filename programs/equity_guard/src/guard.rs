//! Execution-time safety policy.
//!
//! Pure function of (request, actual mint state, clock) so every decision is
//! testable on the host without a runtime.

use crate::{
    error::EquityGuardError,
    instruction::{AssertSafeExecution, ProtectionWindow},
    state::ProtectedState,
};

/// Decides whether execution may proceed.
///
/// Two independent checks, both required:
///
/// 1. **Stored state**: the mint's protected fields are byte-identical to what
///    the client observed.
/// 2. **Clock**: if a multiplier change is scheduled, execution is outside the
///    protection window and still in the activation phase the client
///    observed. Needed because the effective multiplier changes when the
///    clock crosses the effective timestamp while the bytes stay the same.
pub fn check(
    request: &AssertSafeExecution,
    actual: &ProtectedState,
    unix_timestamp: i64,
) -> Result<(), EquityGuardError> {
    let expected = &request.expected;
    if actual.multiplier != expected.multiplier {
        return Err(EquityGuardError::MultiplierChanged);
    }
    if actual.new_multiplier != expected.new_multiplier {
        return Err(EquityGuardError::NewMultiplierChanged);
    }
    if actual.new_multiplier_effective_timestamp != expected.new_multiplier_effective_timestamp {
        return Err(EquityGuardError::EffectiveTimestampChanged);
    }

    // Identical multipliers mean crossing the timestamp changes nothing.
    if !actual.has_scheduled_change() {
        return Ok(());
    }
    if request
        .window
        .contains(actual.new_multiplier_effective_timestamp, unix_timestamp)?
    {
        return Err(EquityGuardError::InsideTransitionWindow);
    }
    // The window alone cannot guarantee this: a narrow window plus a slow
    // landing could cross the timestamp outside it.
    if actual.phase_at(unix_timestamp) != request.expected_phase {
        return Err(EquityGuardError::ActivationPhaseChanged);
    }
    Ok(())
}

impl ProtectionWindow {
    /// Whether `now` lies in `[activation - before_secs, activation + after_secs]`
    /// (both bounds inclusive). Bounds that overflow `i64` fail closed.
    pub fn contains(&self, activation: i64, now: i64) -> Result<bool, EquityGuardError> {
        let start = activation
            .checked_sub(i64::from(self.before_secs))
            .ok_or(EquityGuardError::ArithmeticOverflow)?;
        let end = activation
            .checked_add(i64::from(self.after_secs))
            .ok_or(EquityGuardError::ArithmeticOverflow)?;
        Ok(start <= now && now <= end)
    }
}

#[cfg(test)]
mod tests {
    use spl_token_2022_interface::extension::scaled_ui_amount::{
        PodF64, ScaledUiAmountConfig, UnixTimestamp,
    };

    use super::*;
    use crate::{
        state::{decode_protected_state, ActivationPhase},
        test_fixtures::{mainnet_mint, with_scaled_ui_config},
    };

    /// Example window for boundary tests only; not an issuer policy.
    const TEST_WINDOW: ProtectionWindow = ProtectionWindow {
        before_secs: 900,
        after_secs: 900,
    };
    /// Wallclock of the fixture capture (slot 446827429).
    const FIXTURE_CAPTURE_TIME: i64 = 1_789_335_689;

    fn decode(data: &[u8]) -> ProtectedState {
        decode_protected_state(&spl_token_2022_interface::ID, data).unwrap()
    }

    fn request_for(
        state: ProtectedState,
        phase: ActivationPhase,
        window: ProtectionWindow,
    ) -> AssertSafeExecution {
        AssertSafeExecution {
            expected: state,
            expected_phase: phase,
            window,
        }
    }

    /// Rebuilds a Token-2022 config so its own UI conversion helpers can run.
    fn config_of(state: &ProtectedState) -> ScaledUiAmountConfig {
        ScaledUiAmountConfig {
            multiplier: PodF64(state.multiplier.to_bytes()),
            new_multiplier: PodF64(state.new_multiplier.to_bytes()),
            new_multiplier_effective_timestamp: state.new_multiplier_effective_timestamp.into(),
            ..Default::default()
        }
    }

    fn next_representable(bytes: [u8; 8]) -> [u8; 8] {
        f64::from_bits(u64::from_le_bytes(bytes) + 1).to_le_bytes()
    }

    #[test]
    fn unchanged_snapshot_after_activation_succeeds() {
        // KOx's scheduled change activated long before the fixture capture.
        let state = decode(&mainnet_mint("KOx"));
        let request = request_for(state, ActivationPhase::Activated, TEST_WINDOW);
        assert_eq!(check(&request, &state, FIXTURE_CAPTURE_TIME), Ok(()));
    }

    #[test]
    fn no_scheduled_change_ignores_clock() {
        let state = decode(&mainnet_mint("UNHon"));
        let t = state.new_multiplier_effective_timestamp;
        for now in [t - 1, t, t + 1] {
            for phase in [ActivationPhase::Pending, ActivationPhase::Activated] {
                let request = request_for(state, phase, TEST_WINDOW);
                assert_eq!(check(&request, &state, now), Ok(()));
            }
        }
    }

    #[test]
    fn changed_stored_fields_fail() {
        let original = mainnet_mint("UNHx");
        let expected = decode(&original);
        let request = request_for(expected, ActivationPhase::Activated, TEST_WINDOW);
        let now = FIXTURE_CAPTURE_TIME;
        assert_eq!(check(&request, &expected, now), Ok(()));

        type Edit = fn(&mut ScaledUiAmountConfig);
        let cases: [(&str, Edit, EquityGuardError); 3] = [
            (
                "multiplier",
                |c| c.multiplier = PodF64(next_representable(c.multiplier.0)),
                EquityGuardError::MultiplierChanged,
            ),
            (
                "new_multiplier",
                |c| c.new_multiplier = PodF64(next_representable(c.new_multiplier.0)),
                EquityGuardError::NewMultiplierChanged,
            ),
            (
                "timestamp",
                |c| {
                    let t = i64::from(c.new_multiplier_effective_timestamp);
                    c.new_multiplier_effective_timestamp = UnixTimestamp::from(t + 1);
                },
                EquityGuardError::EffectiveTimestampChanged,
            ),
        ];
        for (label, edit, error) in cases {
            let actual = decode(&with_scaled_ui_config(original.clone(), edit));
            assert_eq!(check(&request, &actual, now), Err(error), "{label}");
        }
    }

    #[test]
    fn transition_window_boundaries() {
        let state = decode(&mainnet_mint("UNHx"));
        let t = state.new_multiplier_effective_timestamp;
        let before = i64::from(TEST_WINDOW.before_secs);
        let after = i64::from(TEST_WINDOW.after_secs);
        let inside = Err(EquityGuardError::InsideTransitionWindow);
        use ActivationPhase::{Activated, Pending};

        let table = [
            ("just before window", t - before - 1, Pending, Ok(())),
            ("lower bound (inclusive)", t - before, Pending, inside),
            ("inside pre-activation", t - before / 2, Pending, inside),
            ("one second before T", t - 1, Pending, inside),
            ("exactly T", t, Activated, inside),
            ("one second after T", t + 1, Activated, inside),
            ("upper bound (inclusive)", t + after, Activated, inside),
            ("just after window", t + after + 1, Activated, Ok(())),
        ];
        for (label, now, phase, result) in table {
            let request = request_for(state, phase, TEST_WINDOW);
            assert_eq!(check(&request, &state, now), result, "{label}");
        }
    }

    #[test]
    fn crossing_activation_fails_even_with_identical_bytes() {
        // A zero-width window isolates the phase check: only `now == T` is in
        // the window, so any other failure comes from the crossing itself.
        let zero = ProtectionWindow {
            before_secs: 0,
            after_secs: 0,
        };
        let state = decode(&mainnet_mint("UNHx"));
        let t = state.new_multiplier_effective_timestamp;

        let built_before = request_for(state, ActivationPhase::Pending, zero);
        assert_eq!(check(&built_before, &state, t - 1), Ok(()));
        assert_eq!(
            check(&built_before, &state, t + 1),
            Err(EquityGuardError::ActivationPhaseChanged)
        );

        let built_after = request_for(state, ActivationPhase::Activated, zero);
        assert_eq!(check(&built_after, &state, t + 1), Ok(()));
        assert_eq!(
            check(&built_after, &state, t - 1),
            Err(EquityGuardError::ActivationPhaseChanged)
        );
        assert_eq!(
            check(&built_after, &state, t),
            Err(EquityGuardError::InsideTransitionWindow)
        );
    }

    #[test]
    fn window_bound_overflow_fails_closed() {
        let base = decode(&mainnet_mint("UNHx"));
        for activation in [i64::MIN + 1, i64::MAX - 1] {
            let state = ProtectedState {
                new_multiplier_effective_timestamp: activation,
                ..base
            };
            let request = request_for(state, ActivationPhase::Pending, TEST_WINDOW);
            assert_eq!(
                check(&request, &state, 0),
                Err(EquityGuardError::ArithmeticOverflow)
            );
        }
    }

    #[test]
    fn decision_ignores_ui_amount_equality() {
        let original = mainnet_mint("UNHx");
        let expected = decode(&original);
        let actual = decode(&with_scaled_ui_config(original.clone(), |c| {
            c.new_multiplier = PodF64(next_representable(c.new_multiplier.0));
        }));

        let ui = |state: &ProtectedState| {
            config_of(state).amount_to_ui_amount(1_000_000_000, 8, FIXTURE_CAPTURE_TIME)
        };
        // Displayed amounts are identical, yet the protected state changed.
        assert_eq!(ui(&expected), ui(&actual));
        let request = request_for(expected, ActivationPhase::Activated, TEST_WINDOW);
        assert_eq!(
            check(&request, &actual, FIXTURE_CAPTURE_TIME),
            Err(EquityGuardError::NewMultiplierChanged)
        );
    }

    #[test]
    fn ui_round_trip_is_not_exact() {
        // Documents why display code needs an explicit rounding policy: a real
        // multiplier does not survive raw -> UI string -> raw for every amount.
        let config = config_of(&decode(&mainnet_mint("UNHx")));
        let lossy = (1..=10_000_u64).find(|&raw| {
            let ui = config
                .amount_to_ui_amount(raw, 8, FIXTURE_CAPTURE_TIME)
                .unwrap();
            config.try_ui_amount_into_amount(&ui, 8, FIXTURE_CAPTURE_TIME) != Ok(raw)
        });
        assert!(lossy.is_some());
    }
}
