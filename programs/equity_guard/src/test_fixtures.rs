//! Deterministic fixtures for host-side unit tests.

use base64::{engine::general_purpose::STANDARD, Engine};
use spl_token_2022_interface::{
    extension::{
        scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensionsMut, StateWithExtensionsMut,
    },
    state::Mint,
};

/// Symbols with a captured mainnet mint account under `tests/fixtures/mainnet`.
pub const FIXTURE_SYMBOLS: [&str; 6] = ["UNHx", "UNHon", "KOx", "KOon", "CRMx", "CRMon"];

/// Raw account data of a verified mainnet mint captured at slot 446827429.
pub fn mainnet_mint(symbol: &str) -> Vec<u8> {
    let encoded = match symbol {
        "UNHx" => include_str!("../tests/fixtures/mainnet/UNHx.base64"),
        "UNHon" => include_str!("../tests/fixtures/mainnet/UNHon.base64"),
        "KOx" => include_str!("../tests/fixtures/mainnet/KOx.base64"),
        "KOon" => include_str!("../tests/fixtures/mainnet/KOon.base64"),
        "CRMx" => include_str!("../tests/fixtures/mainnet/CRMx.base64"),
        "CRMon" => include_str!("../tests/fixtures/mainnet/CRMon.base64"),
        other => panic!("no fixture for {other}"),
    };
    STANDARD.decode(encoded.trim()).unwrap()
}

/// Returns `data` with its ScaledUiAmount config modified by `edit`.
pub fn with_scaled_ui_config(
    mut data: Vec<u8>,
    edit: impl FnOnce(&mut ScaledUiAmountConfig),
) -> Vec<u8> {
    let mut mint = StateWithExtensionsMut::<Mint>::unpack(&mut data).unwrap();
    edit(mint.get_extension_mut::<ScaledUiAmountConfig>().unwrap());
    data
}
