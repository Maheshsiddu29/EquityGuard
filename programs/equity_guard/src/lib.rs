//! EquityGuard on-chain program.
//!
//! One instruction, `assert_safe_execution` (ABI v2), placed immediately
//! before the action it protects in the same transaction. It fails, reverting
//! the whole transaction, if the mint account is not the expected mint, if the
//! Token-2022 tokenized equity's protected ScaledUiAmount state no longer
//! matches what the transaction was built against, if execution falls in or
//! across a scheduled multiplier activation, or if the immediately following
//! top-level instruction is not the exact committed Token-2022
//! `TransferChecked` of that mint.
//! See `docs/invariants.md`.

pub mod downstream;
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
