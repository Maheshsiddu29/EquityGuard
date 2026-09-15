//! Token-2022 ScaledUiAmount state decoding.
//!
//! Extracts only the fields the guard protects, in their stored
//! representation. Nothing here converts to UI amounts: safety decisions must
//! never depend on floating-point arithmetic or float equality.

use solana_address::Address;
use spl_token_2022_interface::{
    extension::{
        scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::Mint,
};

use crate::error::EquityGuardError;

/// A multiplier as its stored little-endian IEEE-754 bytes.
///
/// Identity is byte identity, deliberately not `f64` equality: `0.0 == -0.0`
/// and `NaN != NaN` make float equality unsound for snapshot comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredMultiplier([u8; 8]);

impl StoredMultiplier {
    /// Accepts bytes only if they encode a positive, normal `f64`.
    ///
    /// Token-2022 rejects multipliers that are `<= 0` or subnormal. This is
    /// stricter still: `-0.0`, NaN (any payload) and infinities are rejected
    /// too, because none of them describes a usable economic state.
    pub fn new(bytes: [u8; 8]) -> Option<Self> {
        let value = f64::from_le_bytes(bytes);
        (value.is_normal() && value.is_sign_positive()).then_some(Self(bytes))
    }

    /// The stored bytes.
    pub fn to_bytes(self) -> [u8; 8] {
        self.0
    }
}

/// The ScaledUiAmount fields EquityGuard protects.
///
/// The authority is excluded: changing it does not change economic state, and
/// any multiplier change it later makes is caught by these fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectedState {
    /// Multiplier in effect before `new_multiplier_effective_timestamp`.
    pub multiplier: StoredMultiplier,
    /// Multiplier in effect at and after `new_multiplier_effective_timestamp`.
    pub new_multiplier: StoredMultiplier,
    /// Unix timestamp at which `new_multiplier` takes effect.
    pub new_multiplier_effective_timestamp: i64,
}

/// Which stored multiplier Token-2022 treats as effective at a given time.
///
/// Token-2022 uses `new_multiplier` when `unix_timestamp >=
/// new_multiplier_effective_timestamp` and `multiplier` otherwise. The mint
/// bytes do not change at that moment, so economic state can change while the
/// account stays byte-identical.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ActivationPhase {
    /// `now < new_multiplier_effective_timestamp`: `multiplier` is effective.
    Pending = 0,
    /// `now >= new_multiplier_effective_timestamp`: `new_multiplier` is effective.
    Activated = 1,
}

impl ActivationPhase {
    /// Decodes the ABI byte.
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Pending),
            1 => Some(Self::Activated),
            _ => None,
        }
    }
}

impl ProtectedState {
    /// Whether crossing the effective timestamp changes the effective
    /// multiplier. Compared by stored bytes, so this is exact.
    pub fn has_scheduled_change(&self) -> bool {
        self.multiplier != self.new_multiplier
    }

    /// Phase at `unix_timestamp`, matching Token-2022's boundary (`>=`).
    pub fn phase_at(&self, unix_timestamp: i64) -> ActivationPhase {
        if unix_timestamp >= self.new_multiplier_effective_timestamp {
            ActivationPhase::Activated
        } else {
            ActivationPhase::Pending
        }
    }
}

/// Decodes the protected ScaledUiAmount state from a mint account.
///
/// Fails closed on anything other than an initialized Token-2022 mint with a
/// fully well-formed extension area, no duplicate extension types, a
/// permitted extension combination, and valid multipliers. The whole TLV area is validated, not just the entry we
/// read, so corruption elsewhere in the account is not silently accepted.
pub fn decode_protected_state(
    owner: &Address,
    data: &[u8],
) -> Result<ProtectedState, EquityGuardError> {
    if *owner != spl_token_2022_interface::ID {
        return Err(EquityGuardError::InvalidMintOwner);
    }

    let mint =
        StateWithExtensions::<Mint>::unpack(data).map_err(|_| EquityGuardError::InvalidMintData)?;
    let extension_types = mint
        .get_extension_types()
        .map_err(|_| EquityGuardError::InvalidMintData)?;

    // Duplicate TLV entries are ambiguous (lookups read the first one): reject
    // any repeated extension type. Known types fit in a u64 bitmask.
    let mut seen: u64 = 0;
    for extension_type in &extension_types {
        let bit = 1_u64
            .checked_shl(u32::from(u16::from(*extension_type)))
            .ok_or(EquityGuardError::InvalidMintData)?;
        if seen & bit != 0 {
            return Err(EquityGuardError::InvalidMintData);
        }
        seen |= bit;
    }

    if !extension_types.contains(&ExtensionType::ScaledUiAmount) {
        return Err(EquityGuardError::MissingScaledUiAmount);
    }
    // Token-2022 enforces this at initialization; re-checking means a mint
    // whose UI amount could also drift via interest accrual (outside the
    // protected fields) is never treated as guardable.
    ExtensionType::check_for_invalid_mint_extension_combinations(&extension_types)
        .map_err(|_| EquityGuardError::InvalidExtensionCombination)?;

    let config = mint
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| EquityGuardError::InvalidMintData)?;

    Ok(ProtectedState {
        multiplier: StoredMultiplier::new(config.multiplier.0)
            .ok_or(EquityGuardError::InvalidMultiplier)?,
        new_multiplier: StoredMultiplier::new(config.new_multiplier.0)
            .ok_or(EquityGuardError::InvalidMultiplier)?,
        new_multiplier_effective_timestamp: config.new_multiplier_effective_timestamp.into(),
    })
}

#[cfg(test)]
mod tests {
    use spl_token_2022_interface::extension::{
        interest_bearing_mint::InterestBearingConfig, scaled_ui_amount::PodF64,
    };

    use super::*;
    use crate::test_fixtures::{
        invalid_multiplier_bytes, mainnet_mint, with_scaled_ui_config, FIXTURE_SYMBOLS,
    };

    const LEGACY_TOKEN_PROGRAM: Address =
        Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    /// Offset of the account-type byte in a Token-2022 account with extensions.
    const ACCOUNT_TYPE_OFFSET: usize = 165;
    /// Offset of `is_initialized` in the base mint layout.
    const MINT_IS_INITIALIZED_OFFSET: usize = 45;
    const BASE_MINT_LEN: usize = 82;

    fn decode(data: &[u8]) -> Result<ProtectedState, EquityGuardError> {
        decode_protected_state(&spl_token_2022_interface::ID, data)
    }

    /// Byte offset of the ScaledUiAmount TLV entry's type field.
    fn scaled_ui_tlv_offset(data: &[u8]) -> usize {
        let scaled_ui = u16::from(ExtensionType::ScaledUiAmount).to_le_bytes();
        let mut offset = ACCOUNT_TYPE_OFFSET + 1;
        loop {
            if data[offset..offset + 2] == scaled_ui {
                return offset;
            }
            let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]);
            offset += 4 + usize::from(len);
        }
    }

    #[test]
    fn decodes_every_verified_mainnet_mint() {
        for symbol in FIXTURE_SYMBOLS {
            let state = decode(&mainnet_mint(symbol));
            assert!(state.is_ok(), "{symbol}: {state:?}");
        }
    }

    #[test]
    fn decodes_exact_stored_fields() {
        // Values observed at slot 446827429; see tests/fixtures/mainnet/README.md.
        let unhx = decode(&mainnet_mint("UNHx")).unwrap();
        assert_eq!(
            unhx.multiplier.to_bytes(),
            1.0229655423325776_f64.to_le_bytes()
        );
        assert_eq!(
            unhx.new_multiplier.to_bytes(),
            1.0273478685368111_f64.to_le_bytes()
        );
        assert_eq!(unhx.new_multiplier_effective_timestamp, 1_789_173_000);

        let unhon = decode(&mainnet_mint("UNHon")).unwrap();
        assert_eq!(unhon.multiplier, unhon.new_multiplier);
        assert_eq!(unhon.new_multiplier_effective_timestamp, 1_788_344_044);
    }

    #[test]
    fn rejects_non_token_2022_owner() {
        let data = mainnet_mint("UNHx");
        for owner in [LEGACY_TOKEN_PROGRAM, Address::default()] {
            assert_eq!(
                decode_protected_state(&owner, &data),
                Err(EquityGuardError::InvalidMintOwner)
            );
        }
    }

    #[test]
    fn rejects_mint_without_scaled_ui_amount() {
        // The base 82-byte layout is a valid Token-2022 mint with no extensions.
        let data = mainnet_mint("UNHx");
        assert_eq!(
            decode(&data[..BASE_MINT_LEN]),
            Err(EquityGuardError::MissingScaledUiAmount)
        );
    }

    #[test]
    fn rejects_truncated_accounts() {
        let data = mainnet_mint("UNHx");
        for len in [
            0,
            10,
            BASE_MINT_LEN - 1,
            120,
            ACCOUNT_TYPE_OFFSET,
            data.len() - 1,
        ] {
            assert_eq!(
                decode(&data[..len]),
                Err(EquityGuardError::InvalidMintData),
                "len {len}"
            );
        }
    }

    #[test]
    fn rejects_malformed_tlv() {
        let original = mainnet_mint("UNHx");
        let tlv = scaled_ui_tlv_offset(&original);

        let mut overrun = original.clone();
        overrun[tlv + 2..tlv + 4].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(decode(&overrun), Err(EquityGuardError::InvalidMintData));

        let mut short_value = original.clone();
        short_value[tlv + 2..tlv + 4].copy_from_slice(&55_u16.to_le_bytes());
        assert_eq!(decode(&short_value), Err(EquityGuardError::InvalidMintData));

        let mut unknown_type = original.clone();
        unknown_type[tlv..tlv + 2].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(
            decode(&unknown_type),
            Err(EquityGuardError::InvalidMintData)
        );

        let mut token_account_type = original.clone();
        token_account_type[ACCOUNT_TYPE_OFFSET] = 2;
        assert_eq!(
            decode(&token_account_type),
            Err(EquityGuardError::InvalidMintData)
        );

        let mut uninitialized = original;
        uninitialized[MINT_IS_INITIALIZED_OFFSET] = 0;
        assert_eq!(
            decode(&uninitialized),
            Err(EquityGuardError::InvalidMintData)
        );
    }

    #[test]
    fn rejects_duplicate_extension_types() {
        let original = mainnet_mint("UNHx");
        let tlv = scaled_ui_tlv_offset(&original);
        let entry_len = 4 + std::mem::size_of::<ScaledUiAmountConfig>();
        // Append a second ScaledUiAmount entry with different multipliers.
        let mut duplicate_scaled_ui = original.clone();
        let mut entry = original[tlv..tlv + entry_len].to_vec();
        entry[4 + 32..4 + 40].copy_from_slice(&9.0_f64.to_le_bytes());
        entry[4 + 48..4 + 56].copy_from_slice(&9.0_f64.to_le_bytes());
        duplicate_scaled_ui.extend_from_slice(&entry);
        assert_eq!(
            decode(&duplicate_scaled_ui),
            Err(EquityGuardError::InvalidMintData)
        );
        // Any repeated type is rejected, not only ScaledUiAmount.
        let mut duplicate_other = original.clone();
        let first_type_len = u16::from_le_bytes([
            original[ACCOUNT_TYPE_OFFSET + 3],
            original[ACCOUNT_TYPE_OFFSET + 4],
        ]);
        let first_entry = original
            [ACCOUNT_TYPE_OFFSET + 1..ACCOUNT_TYPE_OFFSET + 5 + usize::from(first_type_len)]
            .to_vec();
        duplicate_other.extend_from_slice(&first_entry);
        assert_eq!(
            decode(&duplicate_other),
            Err(EquityGuardError::InvalidMintData)
        );
        // Without duplicates the same mint still decodes.
        assert!(decode(&original).is_ok());
    }

    #[test]
    fn rejects_scaled_ui_amount_with_interest_bearing_config() {
        let mut data = mainnet_mint("UNHx");
        let interest_bearing_len = std::mem::size_of::<InterestBearingConfig>();
        data.extend_from_slice(&u16::from(ExtensionType::InterestBearingConfig).to_le_bytes());
        data.extend_from_slice(&u16::try_from(interest_bearing_len).unwrap().to_le_bytes());
        data.resize(data.len() + interest_bearing_len, 0);
        assert_eq!(
            decode(&data),
            Err(EquityGuardError::InvalidExtensionCombination)
        );
    }

    #[test]
    fn rejects_invalid_stored_multipliers() {
        for (label, bytes) in invalid_multiplier_bytes() {
            let current = with_scaled_ui_config(mainnet_mint("KOx"), |config| {
                config.multiplier = PodF64(bytes);
            });
            assert_eq!(
                decode(&current),
                Err(EquityGuardError::InvalidMultiplier),
                "multiplier {label}"
            );

            let pending = with_scaled_ui_config(mainnet_mint("KOx"), |config| {
                config.new_multiplier = PodF64(bytes);
            });
            assert_eq!(
                decode(&pending),
                Err(EquityGuardError::InvalidMultiplier),
                "new_multiplier {label}"
            );
        }
    }

    #[test]
    fn accepts_extreme_but_normal_multipliers() {
        for value in [f64::MIN_POSITIVE, f64::MAX] {
            assert!(StoredMultiplier::new(value.to_le_bytes()).is_some());
        }
    }

    #[test]
    fn multiplier_identity_is_bytes_not_float_equality() {
        let one = 1.0_f64;
        let next = f64::from_bits(one.to_bits() + 1);
        assert_ne!(
            StoredMultiplier::new(one.to_le_bytes()),
            StoredMultiplier::new(next.to_le_bytes())
        );

        // Float equality would call these equal; neither is a valid multiplier.
        assert_eq!(0.0_f64, -0.0_f64);
        assert_eq!(StoredMultiplier::new(0.0_f64.to_le_bytes()), None);
        assert_eq!(StoredMultiplier::new((-0.0_f64).to_le_bytes()), None);
    }

    #[test]
    fn phase_boundary_matches_token_2022() {
        let state = decode(&mainnet_mint("UNHx")).unwrap();
        let t = state.new_multiplier_effective_timestamp;
        assert_eq!(state.phase_at(t - 1), ActivationPhase::Pending);
        assert_eq!(state.phase_at(t), ActivationPhase::Activated);
        assert_eq!(state.phase_at(t + 1), ActivationPhase::Activated);
        assert!(state.has_scheduled_change());
        assert!(!decode(&mainnet_mint("UNHon"))
            .unwrap()
            .has_scheduled_change());
    }
}
