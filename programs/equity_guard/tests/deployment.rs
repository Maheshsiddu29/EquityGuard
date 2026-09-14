//! Keeps the declared program ID and the committed devnet deployment record in
//! agreement, so clients never target a different address than the binary.

// Test harness code: a panic is the correct way to fail a test.
#![allow(clippy::unwrap_used, clippy::panic)]

use serde_json::Value;

#[test]
fn declared_id_matches_devnet_deployment_record() {
    let state: Value =
        serde_json::from_str(include_str!("../../../scripts/devnet/devnet.json")).unwrap();
    assert_eq!(state["cluster"], "devnet");
    let program_id = &state["deployment"]["programId"];
    if !program_id.is_null() {
        assert_eq!(program_id.as_str().unwrap(), equity_guard::ID.to_string());
    }
}
