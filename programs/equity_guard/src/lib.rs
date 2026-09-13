//! EquityGuard on-chain program.
//!
//! Enforces, at execution time, that a Token-2022 tokenized equity's protected
//! corporate-action state still matches what the transaction was built against.
//! See `docs/invariants.md`.
//!
//! Milestone 1 skeleton: no instruction is implemented yet, so every call fails
//! closed with [`EquityGuardError::UnsupportedInstruction`].

pub mod error;
pub mod processor;

pub use error::EquityGuardError;

#[cfg(target_os = "solana")]
solana_program_entrypoint::entrypoint!(processor::process_instruction);
