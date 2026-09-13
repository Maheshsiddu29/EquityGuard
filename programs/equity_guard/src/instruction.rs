//! `assert_safe_execution` instruction encoding.
//!
//! ABI v1: fixed layout, little-endian, exactly
//! [`ASSERT_SAFE_EXECUTION_V1_LEN`] bytes. Trailing bytes are rejected.
//!
//! | Offset | Size | Field |
//! | --- | --- | --- |
//! | 0 | 1 | version, must be [`VERSION_V1`] |
//! | 1 | 8 | expected `multiplier`, stored `f64` LE bytes |
//! | 9 | 8 | expected `new_multiplier`, stored `f64` LE bytes |
//! | 17 | 8 | expected `new_multiplier_effective_timestamp`, `i64` LE |
//! | 25 | 1 | expected activation phase: `0` pending, `1` activated |
//! | 26 | 4 | `protection_before_secs`, `u32` LE |
//! | 30 | 4 | `protection_after_secs`, `u32` LE |
//!
//! Accounts: `[0]` the Token-2022 mint (read-only). No other accounts.

use crate::{
    error::EquityGuardError,
    state::{ActivationPhase, ProtectedState, StoredMultiplier},
};

/// The only supported ABI version.
pub const VERSION_V1: u8 = 1;
/// Exact encoded length of an ABI v1 instruction.
pub const ASSERT_SAFE_EXECUTION_V1_LEN: usize = 34;

/// Interval around a scheduled activation during which execution is refused.
///
/// This is integrator policy, analogous to a slippage tolerance: the guard
/// enforces whatever bounds the transaction carries. Issuer reference values
/// belong in issuer adapters, not in the program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectionWindow {
    /// Seconds before the effective timestamp at which protection starts.
    pub before_secs: u32,
    /// Seconds after the effective timestamp at which protection ends.
    pub after_secs: u32,
}

/// Decoded `assert_safe_execution` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssertSafeExecution {
    /// Protected state the client observed when building the transaction.
    pub expected: ProtectedState,
    /// Phase the client observed when building the transaction.
    pub expected_phase: ActivationPhase,
    /// Transition protection bounds.
    pub window: ProtectionWindow,
}

impl AssertSafeExecution {
    /// Decodes and validates ABI v1 instruction data.
    pub fn unpack(data: &[u8]) -> Result<Self, EquityGuardError> {
        let Some((&VERSION_V1, fields)) = data.split_first() else {
            return Err(EquityGuardError::UnsupportedInstruction);
        };
        if data.len() != ASSERT_SAFE_EXECUTION_V1_LEN {
            return Err(EquityGuardError::InvalidInstructionLength);
        }

        let mut reader = Reader(fields);

        let multiplier = StoredMultiplier::new(reader.take()?);
        let new_multiplier = StoredMultiplier::new(reader.take()?);
        let new_multiplier_effective_timestamp = i64::from_le_bytes(reader.take()?);
        let [phase] = reader.take()?;
        let before_secs = u32::from_le_bytes(reader.take()?);
        let after_secs = u32::from_le_bytes(reader.take()?);

        let (Some(multiplier), Some(new_multiplier), Some(expected_phase)) =
            (multiplier, new_multiplier, ActivationPhase::from_u8(phase))
        else {
            return Err(EquityGuardError::InvalidExpectedState);
        };

        Ok(Self {
            expected: ProtectedState {
                multiplier,
                new_multiplier,
                new_multiplier_effective_timestamp,
            },
            expected_phase,
            window: ProtectionWindow {
                before_secs,
                after_secs,
            },
        })
    }

    /// Encodes as ABI v1 instruction data.
    pub fn pack(&self) -> [u8; ASSERT_SAFE_EXECUTION_V1_LEN] {
        let mut out = [0; ASSERT_SAFE_EXECUTION_V1_LEN];
        let fields: [&[u8]; 7] = [
            &[VERSION_V1],
            &self.expected.multiplier.to_bytes(),
            &self.expected.new_multiplier.to_bytes(),
            &self
                .expected
                .new_multiplier_effective_timestamp
                .to_le_bytes(),
            &[self.expected_phase as u8],
            &self.window.before_secs.to_le_bytes(),
            &self.window.after_secs.to_le_bytes(),
        ];
        let mut offset = 0;
        for field in fields {
            out[offset..offset + field.len()].copy_from_slice(field);
            offset += field.len();
        }
        out
    }
}

/// Sequential fixed-size reads that cannot index out of bounds.
struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], EquityGuardError> {
        let (head, tail) = self
            .0
            .split_first_chunk::<N>()
            .ok_or(EquityGuardError::InvalidInstructionLength)?;
        self.0 = tail;
        Ok(*head)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::invalid_multiplier_bytes;

    fn request() -> AssertSafeExecution {
        AssertSafeExecution {
            expected: ProtectedState {
                multiplier: StoredMultiplier::new(1.5_f64.to_le_bytes()).unwrap(),
                new_multiplier: StoredMultiplier::new(3.0_f64.to_le_bytes()).unwrap(),
                new_multiplier_effective_timestamp: -2,
            },
            expected_phase: ActivationPhase::Activated,
            window: ProtectionWindow {
                before_secs: 0x0102_0304,
                after_secs: u32::MAX,
            },
        }
    }

    #[test]
    fn encodes_documented_layout() {
        let mut expected = vec![VERSION_V1];
        expected.extend(1.5_f64.to_le_bytes());
        expected.extend(3.0_f64.to_le_bytes());
        expected.extend((-2_i64).to_le_bytes());
        expected.push(1);
        expected.extend([0x04, 0x03, 0x02, 0x01]);
        expected.extend([0xff; 4]);

        let packed = request().pack();
        assert_eq!(packed.as_slice(), expected.as_slice());
        assert_eq!(AssertSafeExecution::unpack(&packed), Ok(request()));
    }

    #[test]
    fn rejects_unknown_or_missing_version() {
        for data in [vec![], vec![0], vec![2], vec![u8::MAX]] {
            assert_eq!(
                AssertSafeExecution::unpack(&data),
                Err(EquityGuardError::UnsupportedInstruction)
            );
        }
        let mut wrong_version = request().pack();
        wrong_version[0] = 2;
        assert_eq!(
            AssertSafeExecution::unpack(&wrong_version),
            Err(EquityGuardError::UnsupportedInstruction)
        );
    }

    #[test]
    fn rejects_wrong_length() {
        let packed = request().pack();
        let mut trailing = packed.to_vec();
        trailing.push(0);
        for data in [
            &packed[..1],
            &packed[..ASSERT_SAFE_EXECUTION_V1_LEN - 1],
            &trailing,
        ] {
            assert_eq!(
                AssertSafeExecution::unpack(data),
                Err(EquityGuardError::InvalidInstructionLength),
                "len {}",
                data.len()
            );
        }
    }

    #[test]
    fn rejects_malformed_expected_state() {
        for (label, bytes) in invalid_multiplier_bytes() {
            for offset in [1, 9] {
                let mut data = request().pack();
                data[offset..offset + 8].copy_from_slice(&bytes);
                assert_eq!(
                    AssertSafeExecution::unpack(&data),
                    Err(EquityGuardError::InvalidExpectedState),
                    "{label} at offset {offset}"
                );
            }
        }
        for phase in [2, u8::MAX] {
            let mut data = request().pack();
            data[25] = phase;
            assert_eq!(
                AssertSafeExecution::unpack(&data),
                Err(EquityGuardError::InvalidExpectedState)
            );
        }
    }
}
