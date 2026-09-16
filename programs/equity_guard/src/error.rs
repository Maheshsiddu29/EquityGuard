//! Program error codes.

use solana_program_error::ProgramError;

/// Errors returned by the EquityGuard program.
///
/// Discriminants are part of the on-chain interface: clients decode
/// `ProgramError::Custom(code)`. Never renumber existing variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EquityGuardError {
    /// Instruction data is empty.
    UnsupportedInstruction = 0,
    /// Instruction data length does not match the ABI version.
    InvalidInstructionLength = 1,
    /// Expected state in the instruction is malformed (invalid multiplier
    /// encoding or unknown activation phase).
    InvalidExpectedState = 2,
    /// Instruction was not given exactly one account.
    InvalidAccountCount = 3,
    /// Mint account is not owned by the Token-2022 program.
    InvalidMintOwner = 4,
    /// Mint account data is not a valid, initialized Token-2022 mint with
    /// well-formed extension data.
    InvalidMintData = 5,
    /// Mint has no ScaledUiAmount extension.
    MissingScaledUiAmount = 6,
    /// Mint carries an extension set Token-2022 forbids (e.g. ScaledUiAmount
    /// together with InterestBearingConfig).
    InvalidExtensionCombination = 7,
    /// A stored multiplier is not positive and normal.
    InvalidMultiplier = 8,
    /// Stored `multiplier` differs from the expected bytes.
    MultiplierChanged = 9,
    /// Stored `new_multiplier` differs from the expected bytes.
    NewMultiplierChanged = 10,
    /// Stored `new_multiplier_effective_timestamp` differs from expected.
    EffectiveTimestampChanged = 11,
    /// The clock crossed the effective timestamp relative to what the client
    /// observed, so a different multiplier is now effective.
    ActivationPhaseChanged = 12,
    /// Execution falls inside the protection window around a scheduled
    /// multiplier activation.
    InsideTransitionWindow = 13,
    /// Protection window bounds overflow `i64`.
    ArithmeticOverflow = 14,
    /// The Clock sysvar could not be read.
    ClockUnavailable = 15,
    /// Instruction data names an ABI version other than v2 (ABI v1 included).
    UnsupportedVersion = 16,
    /// The expected mint pubkey in the payload is not the mint account passed.
    MintKeyMismatch = 17,
    /// Account 1 is not the Instructions sysvar.
    InvalidInstructionsSysvar = 18,
    /// No top-level instruction immediately follows the guard.
    MissingDownstreamInstruction = 19,
    /// The next instruction's program is not a supported downstream program.
    UnsupportedDownstreamProgram = 20,
    /// The next instruction is not the supported downstream instruction.
    UnsupportedDownstreamInstruction = 21,
    /// The downstream action's mint is not the protected mint.
    DownstreamMintMismatch = 22,
    /// The next instruction is not the exact instruction the payload commits to.
    DownstreamCommitmentMismatch = 23,
    /// The payload names an unknown downstream adapter.
    UnsupportedAdapter = 24,
    /// The guard is not executing as the current top-level instruction.
    GuardNotTopLevel = 25,

    // Adapter kinds 2 and 3 (Jupiter `route_v2`, USDC only). See
    // `crate::jupiter` for the grammar these enforce.
    /// A Jupiter adapter guard is not top-level instruction 0.
    GuardNotFirst = 26,
    /// The instructions after the guard are not the supported shape: wrong
    /// count, or an unsupported program at a position.
    UnsupportedTransactionGrammar = 27,
    /// A ComputeBudget position does not hold the exact expected variant
    /// (`SetComputeUnitPrice` then `SetComputeUnitLimit`) in canonical form.
    InvalidComputeBudgetInstruction = 28,
    /// The optional setup instruction is not `CreateIdempotent` of this
    /// trade's destination token account.
    InvalidAtaSetup = 29,
    /// The trade instruction, or its `program` account, is not the pinned
    /// Jupiter aggregator.
    InvalidJupiterProgram = 30,
    /// The trade instruction is not a structurally valid `route_v2`.
    InvalidJupiterInstruction = 31,
    /// The protected mint is not in the adapter kind's role.
    InvalidJupiterDirection = 32,
    /// The counter mint is not canonical USDC.
    InvalidCounterMint = 33,
    /// A trade leg's token program is not the one its mint requires.
    InvalidTokenProgram = 34,
    /// `route_v2`'s optional destination override is set.
    DestinationOverrideUnsupported = 35,
    /// `route_v2` carries a platform fee or a positive-slippage fee.
    UnsupportedJupiterFee = 36,
    /// The source token account is not the authority's canonical ATA.
    NonCanonicalSourceAccount = 37,
    /// The destination token account is not the authority's canonical ATA.
    NonCanonicalDestinationAccount = 38,
}

impl From<EquityGuardError> for ProgramError {
    fn from(error: EquityGuardError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
