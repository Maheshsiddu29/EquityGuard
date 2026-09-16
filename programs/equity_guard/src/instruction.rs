//! `assert_safe_execution` instruction encoding.
//!
//! ABI v2: fixed layout, little-endian, exactly
//! [`ASSERT_SAFE_EXECUTION_V2_LEN`] bytes. Trailing bytes are rejected. ABI v1
//! (which bound neither the mint identity nor the downstream action) is not
//! accepted: any version byte other than [`VERSION_V2`] fails with
//! `UnsupportedVersion`.
//!
//! | Offset | Size | Field |
//! | --- | --- | --- |
//! | 0 | 1 | version, must be [`VERSION_V2`] |
//! | 1 | 32 | expected mint pubkey |
//! | 33 | 8 | expected `multiplier`, stored `f64` LE bytes |
//! | 41 | 8 | expected `new_multiplier`, stored `f64` LE bytes |
//! | 49 | 8 | expected `new_multiplier_effective_timestamp`, `i64` LE |
//! | 57 | 1 | expected activation phase: `0` pending, `1` activated |
//! | 58 | 4 | `protection_before_secs`, `u32` LE |
//! | 62 | 4 | `protection_after_secs`, `u32` LE |
//! | 66 | 1 | downstream adapter kind, see [`DownstreamAdapter`] |
//! | 67 | 32 | downstream commitment, SHA-256; its domain and scope are set by the adapter kind |
//!
//! Accounts:
//! - `[0]` the protected Token-2022 mint (read-only);
//! - `[1]` the Instructions sysvar (read-only).
//!
//! No other accounts.

use solana_address::Address;

use crate::{
    error::EquityGuardError,
    state::{ActivationPhase, ProtectedState, StoredMultiplier},
};

/// The only supported ABI version.
pub const VERSION_V2: u8 = 2;
/// Exact encoded length of an ABI v2 instruction.
pub const ASSERT_SAFE_EXECUTION_V2_LEN: usize = 99;

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

/// The economic-state expectation the guard checks against the mint and clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssertSafeExecution {
    /// Protected state the client observed when building the transaction.
    pub expected: ProtectedState,
    /// Phase the client observed when building the transaction.
    pub expected_phase: ActivationPhase,
    /// Transition protection bounds.
    pub window: ProtectionWindow,
}

/// The downstream action kinds the guard understands.
///
/// The kind alone determines the semantic validator, the commitment domain and
/// the commitment scope, so a digest can never be read under another kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DownstreamAdapter {
    /// The next top-level instruction is Token-2022 `TransferChecked` of the
    /// protected mint. Commitment: `EQUITYGUARD_DOWNSTREAM_V2` over that one
    /// instruction ([`crate::downstream`]).
    Token2022TransferChecked = 1,
    /// The whole transaction is a guarded Jupiter `route_v2` buying the
    /// protected mint with canonical USDC. Commitment:
    /// `EQUITYGUARD_JUPITER_SUFFIX_V1` over every instruction after the guard
    /// ([`crate::jupiter`]).
    JupiterRouteV2BuyUsdc = 2,
    /// As [`Self::JupiterRouteV2BuyUsdc`], selling the protected mint for
    /// canonical USDC.
    JupiterRouteV2SellUsdc = 3,
}

impl DownstreamAdapter {
    /// Decodes the ABI byte. Unknown kinds have no semantics and are `None`.
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Token2022TransferChecked),
            2 => Some(Self::JupiterRouteV2BuyUsdc),
            3 => Some(Self::JupiterRouteV2SellUsdc),
            _ => None,
        }
    }
}

/// Decoded ABI v2 `assert_safe_execution` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssertSafeExecutionV2 {
    /// The mint the transaction intends to protect.
    pub expected_mint: Address,
    /// Economic-state expectation.
    pub execution: AssertSafeExecution,
    /// Supported downstream action kind.
    pub adapter: DownstreamAdapter,
    /// SHA-256 commitment to the exact downstream action, in the domain and
    /// scope `adapter` defines.
    pub downstream_commitment: [u8; 32],
}

impl AssertSafeExecutionV2 {
    /// Decodes and validates ABI v2 instruction data.
    pub fn unpack(data: &[u8]) -> Result<Self, EquityGuardError> {
        let Some((&version, fields)) = data.split_first() else {
            return Err(EquityGuardError::UnsupportedInstruction);
        };
        if version != VERSION_V2 {
            return Err(EquityGuardError::UnsupportedVersion);
        }
        if data.len() != ASSERT_SAFE_EXECUTION_V2_LEN {
            return Err(EquityGuardError::InvalidInstructionLength);
        }

        let mut reader = Reader(fields);
        let expected_mint = Address::new_from_array(reader.take()?);
        let multiplier = StoredMultiplier::new(reader.take()?);
        let new_multiplier = StoredMultiplier::new(reader.take()?);
        let new_multiplier_effective_timestamp = i64::from_le_bytes(reader.take()?);
        let [phase] = reader.take()?;
        let before_secs = u32::from_le_bytes(reader.take()?);
        let after_secs = u32::from_le_bytes(reader.take()?);
        let [adapter] = reader.take()?;
        let downstream_commitment = reader.take()?;

        let (Some(multiplier), Some(new_multiplier), Some(expected_phase)) =
            (multiplier, new_multiplier, ActivationPhase::from_u8(phase))
        else {
            return Err(EquityGuardError::InvalidExpectedState);
        };
        let adapter =
            DownstreamAdapter::from_u8(adapter).ok_or(EquityGuardError::UnsupportedAdapter)?;

        Ok(Self {
            expected_mint,
            execution: AssertSafeExecution {
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
            },
            adapter,
            downstream_commitment,
        })
    }

    /// Encodes as ABI v2 instruction data.
    pub fn pack(&self) -> [u8; ASSERT_SAFE_EXECUTION_V2_LEN] {
        let mut out = [0; ASSERT_SAFE_EXECUTION_V2_LEN];
        let execution = &self.execution;
        let fields: [&[u8]; 10] = [
            &[VERSION_V2],
            self.expected_mint.as_ref(),
            &execution.expected.multiplier.to_bytes(),
            &execution.expected.new_multiplier.to_bytes(),
            &execution
                .expected
                .new_multiplier_effective_timestamp
                .to_le_bytes(),
            &[execution.expected_phase as u8],
            &execution.window.before_secs.to_le_bytes(),
            &execution.window.after_secs.to_le_bytes(),
            &[self.adapter as u8],
            &self.downstream_commitment,
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

    fn request() -> AssertSafeExecutionV2 {
        AssertSafeExecutionV2 {
            expected_mint: Address::new_from_array([0xaa; 32]),
            execution: AssertSafeExecution {
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
            },
            adapter: DownstreamAdapter::Token2022TransferChecked,
            downstream_commitment: [0x5c; 32],
        }
    }

    #[test]
    fn encodes_documented_layout() {
        let mut expected = vec![VERSION_V2];
        expected.extend([0xaa; 32]);
        expected.extend(1.5_f64.to_le_bytes());
        expected.extend(3.0_f64.to_le_bytes());
        expected.extend((-2_i64).to_le_bytes());
        expected.push(1);
        expected.extend([0x04, 0x03, 0x02, 0x01]);
        expected.extend([0xff; 4]);
        expected.push(1);
        expected.extend([0x5c; 32]);
        assert_eq!(expected.len(), ASSERT_SAFE_EXECUTION_V2_LEN);

        let packed = request().pack();
        assert_eq!(packed.as_slice(), expected.as_slice());
        assert_eq!(AssertSafeExecutionV2::unpack(&packed), Ok(request()));
        // Documented offsets.
        assert_eq!(packed[1], 0xaa);
        assert_eq!(&packed[33..41], &1.5_f64.to_le_bytes());
        assert_eq!(packed[57], 1);
        assert_eq!(packed[66], 1);
        assert_eq!(&packed[67..99], &[0x5c; 32]);
    }

    #[test]
    fn rejects_abi_v1_and_unknown_versions() {
        assert_eq!(
            AssertSafeExecutionV2::unpack(&[]),
            Err(EquityGuardError::UnsupportedInstruction)
        );
        // A complete, well-formed ABI v1 payload (34 bytes) is refused by version.
        let mut v1 = vec![1_u8];
        v1.extend(1.5_f64.to_le_bytes());
        v1.extend(3.0_f64.to_le_bytes());
        v1.extend(0_i64.to_le_bytes());
        v1.push(1);
        v1.extend([0; 8]);
        assert_eq!(v1.len(), 34);
        for data in [v1, vec![0], vec![1], vec![3], vec![u8::MAX]] {
            assert_eq!(
                AssertSafeExecutionV2::unpack(&data),
                Err(EquityGuardError::UnsupportedVersion)
            );
        }
        let mut v1_header_v2_body = request().pack();
        v1_header_v2_body[0] = 1;
        assert_eq!(
            AssertSafeExecutionV2::unpack(&v1_header_v2_body),
            Err(EquityGuardError::UnsupportedVersion)
        );
    }

    #[test]
    fn rejects_wrong_length() {
        let packed = request().pack();
        let mut trailing = packed.to_vec();
        trailing.push(0);
        for data in [
            &packed[..1],
            &packed[..34],
            &packed[..ASSERT_SAFE_EXECUTION_V2_LEN - 1],
            &trailing,
        ] {
            assert_eq!(
                AssertSafeExecutionV2::unpack(data),
                Err(EquityGuardError::InvalidInstructionLength),
                "len {}",
                data.len()
            );
        }
    }

    #[test]
    fn rejects_malformed_expected_state_and_unknown_adapters() {
        for (label, bytes) in invalid_multiplier_bytes() {
            for offset in [33, 41] {
                let mut data = request().pack();
                data[offset..offset + 8].copy_from_slice(&bytes);
                assert_eq!(
                    AssertSafeExecutionV2::unpack(&data),
                    Err(EquityGuardError::InvalidExpectedState),
                    "{label} at offset {offset}"
                );
            }
        }
        for phase in [2, u8::MAX] {
            let mut data = request().pack();
            data[57] = phase;
            assert_eq!(
                AssertSafeExecutionV2::unpack(&data),
                Err(EquityGuardError::InvalidExpectedState)
            );
        }
        for adapter in [0, 4, 5, u8::MAX] {
            let mut data = request().pack();
            data[66] = adapter;
            assert_eq!(
                AssertSafeExecutionV2::unpack(&data),
                Err(EquityGuardError::UnsupportedAdapter)
            );
        }
    }

    #[test]
    fn adapter_byte_round_trips_for_every_known_kind() {
        for (byte, adapter) in [
            (1, DownstreamAdapter::Token2022TransferChecked),
            (2, DownstreamAdapter::JupiterRouteV2BuyUsdc),
            (3, DownstreamAdapter::JupiterRouteV2SellUsdc),
        ] {
            assert_eq!(DownstreamAdapter::from_u8(byte), Some(adapter));
            let packed = AssertSafeExecutionV2 {
                adapter,
                ..request()
            }
            .pack();
            assert_eq!(packed.len(), ASSERT_SAFE_EXECUTION_V2_LEN);
            assert_eq!(packed[66], byte);
            assert_eq!(
                AssertSafeExecutionV2::unpack(&packed).map(|r| r.adapter),
                Ok(adapter)
            );
        }
    }
}
