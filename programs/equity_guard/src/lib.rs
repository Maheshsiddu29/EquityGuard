//! EquityGuard on-chain program.
//!
//! One instruction, `assert_safe_execution`, placed before execution
//! instructions in the same transaction. It fails, reverting the whole
//! transaction, if a Token-2022 tokenized equity's protected ScaledUiAmount
//! state no longer matches what the transaction was built against, or if
//! execution falls in or across a scheduled multiplier activation.
//! See `docs/invariants.md`.

pub mod error;
pub mod guard;
pub mod instruction;
pub mod processor;
pub mod state;
#[cfg(test)]
mod test_fixtures;

pub use error::EquityGuardError;

// Devnet program ID. The keypair lives outside the repository (docs/devnet.md);
// only the public address is committed.
solana_address::declare_id!("EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT");

#[cfg(target_os = "solana")]
use processor::process_instruction;
// The macro only accepts a bare identifier, not a path.
#[cfg(target_os = "solana")]
solana_program_entrypoint::entrypoint!(process_instruction);
