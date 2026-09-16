//! The host model of one guard invocation, shared by the conformance corpus
//! and the LiteSVM differential.
//!
//! It composes the program's own public decoders — it does not reimplement
//! them — but it does restate the ORDER in which `processor.rs` applies them,
//! because `Clock::get()` is a syscall that cannot run off-runtime. That
//! restatement is exactly what `litesvm_differential.rs` pins against the
//! compiled program, so the model can never quietly drift from it.

// Test harness code: a panic is the correct way to fail a test. `dead_code`
// because each test binary uses a different part of this module.
#![allow(
    dead_code,
    clippy::expect_used,
    clippy::panic,
    clippy::result_large_err
)]

use equity_guard::{
    downstream::verify_downstream, error::EquityGuardError, guard,
    instruction::AssertSafeExecutionV2, state::decode_protected_state,
};
use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_instruction::{BorrowedAccountMeta, BorrowedInstruction, Instruction};
use solana_instructions_sysvar::construct_instructions_data;

/// One account as the guard receives it.
#[derive(Clone, Debug)]
pub struct GuardAccount {
    pub pubkey: Address,
    pub owner: Address,
    pub data: Vec<u8>,
}

/// Everything the guard can observe about one invocation.
#[derive(Clone, Debug)]
pub struct GuardInvocation {
    /// The program id the guard is executing as.
    pub program_id: Address,
    pub guard_data: Vec<u8>,
    pub accounts: Vec<GuardAccount>,
    /// Top-level instructions, as the Instructions sysvar exposes them.
    pub instructions: Vec<Instruction>,
    pub current_index: u16,
    pub clock: i64,
}

/// The Instructions sysvar account data, with the executing index written
/// into the trailing `u16` the way the runtime does.
///
/// `instructions` must already carry SYSVAR-LEVEL account metas: the runtime
/// compiles a message once, so each account's signer/writable flags are
/// merged across the whole transaction and the fee payer is a writable
/// signer. Callers holding raw per-instruction metas must apply that
/// transformation first (see `sysvar_view` in the LiteSVM differential).
pub fn sysvar_data(instructions: &[Instruction], current_index: u16) -> Vec<u8> {
    let borrowed: Vec<BorrowedInstruction> = instructions
        .iter()
        .map(|i| BorrowedInstruction {
            program_id: &i.program_id,
            accounts: i
                .accounts
                .iter()
                .map(|m| BorrowedAccountMeta {
                    pubkey: &m.pubkey,
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: &i.data,
        })
        .collect();
    let mut data = construct_instructions_data(&borrowed).expect("sysvar data");
    let end = data.len() - 2;
    data[end..].copy_from_slice(&current_index.to_le_bytes());
    data
}

/// The guard's verdict for `invocation`, in `processor.rs` order: payload,
/// account count, mint identity, Instructions sysvar identity, mint decoding,
/// downstream binding, then economic state and clock.
pub fn evaluate(invocation: &GuardInvocation) -> Result<(), EquityGuardError> {
    let request = AssertSafeExecutionV2::unpack(&invocation.guard_data)?;
    let [mint, instructions_sysvar] = invocation.accounts.as_slice() else {
        return Err(EquityGuardError::InvalidAccountCount);
    };
    if mint.pubkey != request.expected_mint {
        return Err(EquityGuardError::MintKeyMismatch);
    }
    if !solana_instructions_sysvar::check_id(&instructions_sysvar.pubkey) {
        return Err(EquityGuardError::InvalidInstructionsSysvar);
    }
    let actual = decode_protected_state(&mint.owner, &mint.data)?;

    let mut data = sysvar_data(&invocation.instructions, invocation.current_index);
    let owner = Address::default();
    let mut lamports = 0;
    let info = AccountInfo::new(
        &instructions_sysvar.pubkey,
        false,
        false,
        &mut lamports,
        &mut data,
        &owner,
        false,
    );
    verify_downstream(
        &invocation.program_id,
        &invocation.guard_data,
        &request,
        &mint.pubkey,
        &info,
    )?;
    guard::check(&request.execution, &actual, invocation.clock)
}

/// Every error variant, in discriminant order, so tests can name a custom
/// code and so a new variant cannot be forgotten silently.
pub const ALL_ERRORS: [EquityGuardError; 39] = {
    use EquityGuardError as E;
    [
        E::UnsupportedInstruction,
        E::InvalidInstructionLength,
        E::InvalidExpectedState,
        E::InvalidAccountCount,
        E::InvalidMintOwner,
        E::InvalidMintData,
        E::MissingScaledUiAmount,
        E::InvalidExtensionCombination,
        E::InvalidMultiplier,
        E::MultiplierChanged,
        E::NewMultiplierChanged,
        E::EffectiveTimestampChanged,
        E::ActivationPhaseChanged,
        E::InsideTransitionWindow,
        E::ArithmeticOverflow,
        E::ClockUnavailable,
        E::UnsupportedVersion,
        E::MintKeyMismatch,
        E::InvalidInstructionsSysvar,
        E::MissingDownstreamInstruction,
        E::UnsupportedDownstreamProgram,
        E::UnsupportedDownstreamInstruction,
        E::DownstreamMintMismatch,
        E::DownstreamCommitmentMismatch,
        E::UnsupportedAdapter,
        E::GuardNotTopLevel,
        E::GuardNotFirst,
        E::UnsupportedTransactionGrammar,
        E::InvalidComputeBudgetInstruction,
        E::InvalidAtaSetup,
        E::InvalidJupiterProgram,
        E::InvalidJupiterInstruction,
        E::InvalidJupiterDirection,
        E::InvalidCounterMint,
        E::InvalidTokenProgram,
        E::DestinationOverrideUnsupported,
        E::UnsupportedJupiterFee,
        E::NonCanonicalSourceAccount,
        E::NonCanonicalDestinationAccount,
    ]
};

/// The name of an on-chain custom error code.
pub fn error_name(code: u32) -> String {
    ALL_ERRORS
        .iter()
        .find(|e| **e as u32 == code)
        .map_or_else(|| format!("unknown-custom-{code}"), |e| format!("{e:?}"))
}

/// A stable name for a verdict, for corpus comparison and failure messages.
pub fn outcome(result: &Result<(), EquityGuardError>) -> String {
    match result {
        Ok(()) => "ok".to_owned(),
        Err(error) => format!("{error:?}"),
    }
}

/// Deterministic xorshift64*, so a failing corpus index reproduces exactly.
/// Not cryptographic; it only has to be stable and well spread.
pub struct Prng(u64);

impl Prng {
    pub fn new(seed: u64) -> Self {
        assert!(seed != 0, "xorshift needs a non-zero seed");
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform enough for corpus selection over small ranges.
    pub fn below(&mut self, bound: usize) -> usize {
        assert!(bound > 0);
        (self.next_u64() % bound as u64) as usize
    }

    pub fn pick<'a, T>(&mut self, options: &'a [T]) -> &'a T {
        &options[self.below(options.len())]
    }

    pub fn chance(&mut self, one_in: usize) -> bool {
        self.below(one_in) == 0
    }
}
