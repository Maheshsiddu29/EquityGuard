//! Adapter kinds 2 and 3: a guarded Jupiter `route_v2` trade between
//! canonical USDC and the protected Token-2022 mint.
//!
//! ABI v2 authenticates exactly one mint, the protected one, so the counter
//! asset cannot come from the payload. These kinds therefore pin it: USDC
//! (`EPjFWdd5…`) under the legacy SPL Token program. Any other counter asset
//! needs a new adapter kind or an ABI change.
//!
//! # Supported transaction
//!
//! The guard must be top-level instruction 0, and the whole transaction must
//! be exactly one of:
//!
//! ```text
//! 0 EquityGuard assert_safe_execution (kind 2 or 3)
//! 1 ComputeBudget SetComputeUnitPrice
//! 2 ComputeBudget SetComputeUnitLimit
//! 3 AssociatedToken CreateIdempotent      (optional: this trade's destination)
//! 3|4 Jupiter route_v2                    (always the last instruction)
//! ```
//!
//! Anything else — another program, another ComputeBudget or ATA variant, a
//! cleanup, a tip, a second trade, anything after the trade — is rejected.
//!
//! # Why grammar and commitment are both required
//!
//! The suffix commitment proves only that the executed instructions are the
//! committed ones. A builder that writes the transaction and the commitment
//! together satisfies it for any transaction at all, so the commitment is
//! never treated as semantic validation. The grammar and the `route_v2`
//! checks below are what bound *which* transactions a successful guard can
//! mean; the commitment then pins their exact bytes against change after the
//! client fixed them.
//!
//! # Checks, in order
//!
//! 1. guard is top-level instruction 0 (`GuardNotFirst`);
//! 2. exactly 3 or 4 instructions follow it; positions hold ComputeBudget,
//!    ComputeBudget, [AssociatedToken] (`UnsupportedTransactionGrammar`) and
//!    Jupiter last (`InvalidJupiterProgram`);
//! 3. the two ComputeBudget instructions are exactly `SetComputeUnitPrice`
//!    then `SetComputeUnitLimit`, with no accounts
//!    (`InvalidComputeBudgetInstruction`);
//! 4. `route_v2` structure: ≥ 10 accounts, the fixed data prefix, the
//!    discriminator, the event authority, the signer authority, positive
//!    amounts, slippage ≤ 10 000 bps, a non-empty route plan
//!    (`InvalidJupiterInstruction`), and the `program` account
//!    (`InvalidJupiterProgram`);
//! 5. no destination override (`DestinationOverrideUnsupported`);
//! 6. roles: the protected mint on its side (`InvalidJupiterDirection`), USDC
//!    on the other (`InvalidCounterMint`), and each side's token program
//!    (`InvalidTokenProgram`);
//! 7. no platform or positive-slippage fee (`UnsupportedJupiterFee`);
//! 8. the optional setup creates exactly this trade's destination account
//!    (`InvalidAtaSetup`);
//! 9. source and destination are the authority's canonical ATAs
//!    (`NonCanonicalSourceAccount`, `NonCanonicalDestinationAccount`);
//! 10. the suffix commitment (`DownstreamCommitmentMismatch`).
//!
//! Cheap comparisons run before the two PDA derivations and the hash.
//!
//! # What the guard does not know
//!
//! The ABI carries no independently authenticated amount, quoted output,
//! slippage, route, compute-unit price or compute-unit limit. The guard
//! checks that those fields are structurally valid and pins their bytes; that
//! they are the values the user intended rests on the client's execution plan
//! and the user's signature.
//!
//! # Suffix commitment
//!
//! SHA-256 over:
//!
//! | Field | Encoding |
//! | --- | --- |
//! | domain | the 29 ASCII bytes `EQUITYGUARD_JUPITER_SUFFIX_V1` |
//! | instruction count | `u32` LE |
//! | per instruction, in order | program id (32 bytes), `u32` LE account count, per account pubkey (32 bytes) ‖ `is_signer` (`u8`) ‖ `is_writable` (`u8`), `u32` LE data length, data |
//!
//! Flags are the transaction-level ones the Instructions sysvar exposes, as
//! for kind 1. The domain differs from kind 1's, so no digest verifies under
//! both.

use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_instruction::Instruction;

use crate::{
    error::EquityGuardError,
    instruction::AssertSafeExecutionV2,
    sysvar::{instruction_at, instruction_count, AccountRef, InstructionRef},
};

/// Domain separator for the adapter-kind 2/3 suffix commitment.
pub const JUPITER_SUFFIX_COMMITMENT_DOMAIN: &[u8; 29] = b"EQUITYGUARD_JUPITER_SUFFIX_V1";

/// The Jupiter v6 aggregator.
pub const JUPITER_PROGRAM_ID: Address =
    Address::from_str_const("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/// Anchor event authority of [`JUPITER_PROGRAM_ID`]: the address the published
/// IDL pins for `route_v2` account 8, equal to
/// `find_program_address([b"__event_authority"], JUP6…)` (bump 255; asserted by
/// a unit test rather than derived on-chain).
pub const JUPITER_EVENT_AUTHORITY: Address =
    Address::from_str_const("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
/// `sha256("global:route_v2")[..8]`, as in the published IDL.
pub const ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
/// Canonical mainnet USDC, the only supported counter asset.
pub const USDC_MINT: Address =
    Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/// The legacy SPL Token program, which owns USDC.
pub const LEGACY_TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// The Associated Token Account program.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// The ComputeBudget program.
pub const COMPUTE_BUDGET_PROGRAM_ID: Address =
    Address::from_str_const("ComputeBudget111111111111111111111111111111");
/// The System program.
pub const SYSTEM_PROGRAM_ID: Address = Address::from_str_const("11111111111111111111111111111111");

/// `ComputeBudgetInstruction` Borsh tags and encoded lengths (tag + LE value).
/// Pinned against `solana-compute-budget-interface` by tests.
const SET_COMPUTE_UNIT_LIMIT_TAG: u8 = 2;
const SET_COMPUTE_UNIT_LIMIT_LEN: usize = 5;
const SET_COMPUTE_UNIT_PRICE_TAG: u8 = 3;
const SET_COMPUTE_UNIT_PRICE_LEN: usize = 9;

/// `AssociatedTokenAccountInstruction::CreateIdempotent`: one tag byte and
/// six accounts.
const CREATE_IDEMPOTENT_DATA: [u8; 1] = [1];
const CREATE_IDEMPOTENT_ACCOUNTS: usize = 6;
mod ata_account {
    pub const PAYER: usize = 0;
    pub const ATA: usize = 1;
    pub const OWNER: usize = 2;
    pub const MINT: usize = 3;
    pub const SYSTEM_PROGRAM: usize = 4;
    pub const TOKEN_PROGRAM: usize = 5;
}

/// Suffix lengths the grammar admits: without and with the setup instruction.
const SUFFIX_WITHOUT_SETUP: usize = 3;
const SUFFIX_WITH_SETUP: usize = 4;

/// `route_v2` fixed accounts, in IDL order; venue accounts follow.
mod route_account {
    pub const AUTHORITY: usize = 0;
    pub const SOURCE: usize = 1;
    pub const DESTINATION: usize = 2;
    pub const SOURCE_MINT: usize = 3;
    pub const DESTINATION_MINT: usize = 4;
    pub const SOURCE_TOKEN_PROGRAM: usize = 5;
    pub const DESTINATION_TOKEN_PROGRAM: usize = 6;
    /// Anchor optional account: the program id itself encodes `None`.
    pub const DESTINATION_OVERRIDE: usize = 7;
    pub const EVENT_AUTHORITY: usize = 8;
    pub const PROGRAM: usize = 9;
    pub const FIXED: usize = 10;
}

/// `route_v2` argument prefix: discriminator, `in_amount` u64,
/// `quoted_out_amount` u64, `slippage_bps` u16, `platform_fee_bps` u16,
/// `positive_slippage_bps` u16, route-plan length u32. The route plan follows
/// and is never parsed.
const ROUTE_V2_PREFIX_LEN: usize = 34;
const MAX_SLIPPAGE_BPS: u16 = 10_000;

/// Which side of the trade the protected mint is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtectedRole {
    /// Kind 2, BUY: USDC in, protected mint out.
    Destination,
    /// Kind 3, SELL: protected mint in, USDC out.
    Source,
}

/// The fixed-prefix fields of a `route_v2` instruction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteV2Prefix {
    /// Exact input amount.
    pub in_amount: u64,
    /// Quoted output amount.
    pub quoted_out_amount: u64,
    /// Slippage tolerance.
    pub slippage_bps: u16,
    /// Integrator platform fee.
    pub platform_fee_bps: u16,
    /// Fee on positive slippage.
    pub positive_slippage_bps: u16,
    /// Number of route-plan steps.
    pub route_plan_len: u32,
}

impl RouteV2Prefix {
    /// Decodes the prefix. `None` if the data is too short or is not `route_v2`.
    pub fn decode(data: &[u8]) -> Option<Self> {
        let prefix: &[u8; ROUTE_V2_PREFIX_LEN] = data.first_chunk()?;
        let (discriminator, rest) = prefix.split_first_chunk::<8>()?;
        if *discriminator != ROUTE_V2_DISCRIMINATOR {
            return None;
        }
        let (in_amount, rest) = rest.split_first_chunk::<8>()?;
        let (quoted_out_amount, rest) = rest.split_first_chunk::<8>()?;
        let (slippage_bps, rest) = rest.split_first_chunk::<2>()?;
        let (platform_fee_bps, rest) = rest.split_first_chunk::<2>()?;
        let (positive_slippage_bps, rest) = rest.split_first_chunk::<2>()?;
        let route_plan_len: &[u8; 4] = rest.first_chunk()?;
        Some(Self {
            in_amount: u64::from_le_bytes(*in_amount),
            quoted_out_amount: u64::from_le_bytes(*quoted_out_amount),
            slippage_bps: u16::from_le_bytes(*slippage_bps),
            platform_fee_bps: u16::from_le_bytes(*platform_fee_bps),
            positive_slippage_bps: u16::from_le_bytes(*positive_slippage_bps),
            route_plan_len: u32::from_le_bytes(*route_plan_len),
        })
    }
}

/// Read access to one top-level instruction with transaction-level flags.
///
/// The program reads [`InstructionRef`]s borrowed from the Instructions
/// sysvar; host tests pass owned [`Instruction`]s whose metas already carry
/// transaction-level flags. Both go through the same checks and encoding.
pub trait SuffixInstruction {
    /// Program id.
    fn program_id(&self) -> &[u8; 32];
    /// Number of accounts.
    fn account_count(&self) -> usize;
    /// The account at `index`.
    fn account(&self, index: usize) -> Option<AccountRef<'_>>;
    /// Every account, in order.
    fn accounts(&self) -> impl Iterator<Item = AccountRef<'_>>;
    /// Exact instruction data.
    fn data(&self) -> &[u8];
}

impl SuffixInstruction for InstructionRef<'_> {
    fn program_id(&self) -> &[u8; 32] {
        self.program_id
    }
    fn account_count(&self) -> usize {
        InstructionRef::account_count(self)
    }
    fn account(&self, index: usize) -> Option<AccountRef<'_>> {
        InstructionRef::account(self, index)
    }
    fn accounts(&self) -> impl Iterator<Item = AccountRef<'_>> {
        InstructionRef::accounts(self)
    }
    fn data(&self) -> &[u8] {
        self.data
    }
}

impl SuffixInstruction for Instruction {
    fn program_id(&self) -> &[u8; 32] {
        self.program_id.as_array()
    }
    fn account_count(&self) -> usize {
        self.accounts.len()
    }
    fn account(&self, index: usize) -> Option<AccountRef<'_>> {
        self.accounts.get(index).map(|meta| AccountRef {
            pubkey: meta.pubkey.as_array(),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
    }
    fn accounts(&self) -> impl Iterator<Item = AccountRef<'_>> {
        self.accounts.iter().map(|meta| AccountRef {
            pubkey: meta.pubkey.as_array(),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
    }
    fn data(&self) -> &[u8] {
        &self.data
    }
}

/// Computes the suffix commitment (see the module docs for the encoding).
pub fn jupiter_suffix_commitment<I: SuffixInstruction>(
    suffix: &[I],
) -> Result<[u8; 32], EquityGuardError> {
    let count = u32::try_from(suffix.len()).map_err(|_| EquityGuardError::ArithmeticOverflow)?;
    let encoded_len: usize = suffix
        .iter()
        .map(|i| 40 + i.account_count() * 34 + i.data().len())
        .sum();
    let mut encoded = Vec::with_capacity(JUPITER_SUFFIX_COMMITMENT_DOMAIN.len() + 4 + encoded_len);
    encoded.extend_from_slice(JUPITER_SUFFIX_COMMITMENT_DOMAIN);
    encoded.extend_from_slice(&count.to_le_bytes());
    for instruction in suffix {
        // Framed exactly as kind 1 frames its single instruction; only the
        // domain and the count in front differ.
        let account_count = u32::try_from(instruction.account_count())
            .map_err(|_| EquityGuardError::ArithmeticOverflow)?;
        let data = instruction.data();
        let data_len =
            u32::try_from(data.len()).map_err(|_| EquityGuardError::ArithmeticOverflow)?;
        encoded.extend_from_slice(instruction.program_id());
        encoded.extend_from_slice(&account_count.to_le_bytes());
        let mut written = 0_usize;
        for account in instruction.accounts() {
            encoded.extend_from_slice(account.pubkey);
            encoded.push(u8::from(account.is_signer));
            encoded.push(u8::from(account.is_writable));
            written += 1;
        }
        if written != instruction.account_count() {
            return Err(EquityGuardError::InvalidInstructionsSysvar);
        }
        encoded.extend_from_slice(&data_len.to_le_bytes());
        encoded.extend_from_slice(data);
    }
    Ok(solana_sha256_hasher::hash(&encoded).to_bytes())
}

/// Verifies a kind 2/3 guard. `current` is the guard's own top-level index,
/// already proven to be this invocation by the caller.
pub fn verify_jupiter_suffix(
    current: u16,
    role: ProtectedRole,
    request: &AssertSafeExecutionV2,
    mint_key: &Address,
    instructions_sysvar: &AccountInfo,
) -> Result<(), EquityGuardError> {
    if current != 0 {
        return Err(EquityGuardError::GuardNotFirst);
    }
    let data = instructions_sysvar
        .try_borrow_data()
        .map_err(|_| EquityGuardError::InvalidInstructionsSysvar)?;
    let count = instruction_count(&data).ok_or(EquityGuardError::InvalidInstructionsSysvar)?;
    // Refuse a count the grammar cannot admit before reading anything else.
    let suffix_len = count.saturating_sub(1);
    if suffix_len != SUFFIX_WITHOUT_SETUP && suffix_len != SUFFIX_WITH_SETUP {
        return Err(EquityGuardError::UnsupportedTransactionGrammar);
    }
    let suffix = (1..count)
        .map(|index| instruction_at(&data, index))
        .collect::<Option<Vec<_>>>()
        .ok_or(EquityGuardError::InvalidInstructionsSysvar)?;

    check_suffix(&suffix, role, mint_key)?;
    if jupiter_suffix_commitment(&suffix)? != request.downstream_commitment {
        return Err(EquityGuardError::DownstreamCommitmentMismatch);
    }
    Ok(())
}

/// The grammar and semantic checks over the instructions after the guard, in
/// the order documented on the module. Pure, so it is testable on the host.
pub fn check_suffix<I: SuffixInstruction>(
    suffix: &[I],
    role: ProtectedRole,
    protected_mint: &Address,
) -> Result<(), EquityGuardError> {
    let (price, limit, setup, trade) = match suffix {
        [price, limit, trade] => (price, limit, None, trade),
        [price, limit, setup, trade] => (price, limit, Some(setup), trade),
        _ => return Err(EquityGuardError::UnsupportedTransactionGrammar),
    };
    let compute_budget = COMPUTE_BUDGET_PROGRAM_ID.as_array();
    let setup_position_ok =
        setup.is_none_or(|setup| setup.program_id() == ASSOCIATED_TOKEN_PROGRAM_ID.as_array());
    if price.program_id() != compute_budget
        || limit.program_id() != compute_budget
        || !setup_position_ok
    {
        return Err(EquityGuardError::UnsupportedTransactionGrammar);
    }
    if trade.program_id() != JUPITER_PROGRAM_ID.as_array() {
        return Err(EquityGuardError::InvalidJupiterProgram);
    }

    check_compute_budget(
        price,
        SET_COMPUTE_UNIT_PRICE_TAG,
        SET_COMPUTE_UNIT_PRICE_LEN,
    )?;
    check_compute_budget(
        limit,
        SET_COMPUTE_UNIT_LIMIT_TAG,
        SET_COMPUTE_UNIT_LIMIT_LEN,
    )?;

    let route = check_route(trade, role, protected_mint)?;
    if let Some(setup) = setup {
        check_setup(setup, &route)?;
    }

    let source = canonical_ata(
        route.authority,
        route.source_mint,
        route.source_token_program,
    );
    if source.as_array() != route.source {
        return Err(EquityGuardError::NonCanonicalSourceAccount);
    }
    let destination = canonical_ata(
        route.authority,
        route.destination_mint,
        route.destination_token_program,
    );
    if destination.as_array() != route.destination {
        return Err(EquityGuardError::NonCanonicalDestinationAccount);
    }
    Ok(())
}

fn check_compute_budget<I: SuffixInstruction>(
    instruction: &I,
    tag: u8,
    len: usize,
) -> Result<(), EquityGuardError> {
    let data = instruction.data();
    let canonical =
        instruction.account_count() == 0 && data.len() == len && data.first() == Some(&tag);
    if canonical {
        Ok(())
    } else {
        Err(EquityGuardError::InvalidComputeBudgetInstruction)
    }
}

/// The fixed accounts of a validated `route_v2`.
struct Route<'a> {
    authority: &'a [u8; 32],
    source: &'a [u8; 32],
    destination: &'a [u8; 32],
    source_mint: &'a [u8; 32],
    destination_mint: &'a [u8; 32],
    source_token_program: &'a [u8; 32],
    destination_token_program: &'a [u8; 32],
}

fn check_route<'a, I: SuffixInstruction>(
    trade: &'a I,
    role: ProtectedRole,
    protected_mint: &Address,
) -> Result<Route<'a>, EquityGuardError> {
    if trade.account_count() < route_account::FIXED {
        return Err(EquityGuardError::InvalidJupiterInstruction);
    }
    let prefix =
        RouteV2Prefix::decode(trade.data()).ok_or(EquityGuardError::InvalidJupiterInstruction)?;
    let account = |index: usize| {
        trade
            .account(index)
            .ok_or(EquityGuardError::InvalidJupiterInstruction)
    };
    let key = |index: usize| account(index).map(|a| a.pubkey);
    let jupiter = JUPITER_PROGRAM_ID.as_array();

    if key(route_account::PROGRAM)? != jupiter {
        return Err(EquityGuardError::InvalidJupiterProgram);
    }
    let structurally_valid = key(route_account::EVENT_AUTHORITY)?
        == JUPITER_EVENT_AUTHORITY.as_array()
        && account(route_account::AUTHORITY)?.is_signer
        && prefix.in_amount > 0
        && prefix.quoted_out_amount > 0
        && prefix.slippage_bps <= MAX_SLIPPAGE_BPS
        && prefix.route_plan_len > 0;
    if !structurally_valid {
        return Err(EquityGuardError::InvalidJupiterInstruction);
    }
    if key(route_account::DESTINATION_OVERRIDE)? != jupiter {
        return Err(EquityGuardError::DestinationOverrideUnsupported);
    }

    let route = Route {
        authority: key(route_account::AUTHORITY)?,
        source: key(route_account::SOURCE)?,
        destination: key(route_account::DESTINATION)?,
        source_mint: key(route_account::SOURCE_MINT)?,
        destination_mint: key(route_account::DESTINATION_MINT)?,
        source_token_program: key(route_account::SOURCE_TOKEN_PROGRAM)?,
        destination_token_program: key(route_account::DESTINATION_TOKEN_PROGRAM)?,
    };
    let (protected, protected_program, counter, counter_program) = match role {
        ProtectedRole::Destination => (
            route.destination_mint,
            route.destination_token_program,
            route.source_mint,
            route.source_token_program,
        ),
        ProtectedRole::Source => (
            route.source_mint,
            route.source_token_program,
            route.destination_mint,
            route.destination_token_program,
        ),
    };
    if protected != protected_mint.as_array() {
        return Err(EquityGuardError::InvalidJupiterDirection);
    }
    if counter != USDC_MINT.as_array() {
        return Err(EquityGuardError::InvalidCounterMint);
    }
    // The guard already proved the protected mint is owned by Token-2022.
    if protected_program != spl_token_2022_interface::ID.as_array()
        || counter_program != LEGACY_TOKEN_PROGRAM_ID.as_array()
    {
        return Err(EquityGuardError::InvalidTokenProgram);
    }
    if prefix.platform_fee_bps != 0 || prefix.positive_slippage_bps != 0 {
        return Err(EquityGuardError::UnsupportedJupiterFee);
    }
    Ok(route)
}

/// The setup may only create this trade's destination, for this trade's
/// authority. The payer must sign but need not be the authority: a third
/// party funding the user's own account is harmless.
fn check_setup<I: SuffixInstruction>(setup: &I, route: &Route) -> Result<(), EquityGuardError> {
    let account = |index: usize| {
        setup
            .account(index)
            .ok_or(EquityGuardError::InvalidAtaSetup)
    };
    if setup.account_count() != CREATE_IDEMPOTENT_ACCOUNTS || setup.data() != CREATE_IDEMPOTENT_DATA
    {
        return Err(EquityGuardError::InvalidAtaSetup);
    }
    let for_this_trade = account(ata_account::PAYER)?.is_signer
        && account(ata_account::ATA)?.pubkey == route.destination
        && account(ata_account::OWNER)?.pubkey == route.authority
        && account(ata_account::MINT)?.pubkey == route.destination_mint
        && account(ata_account::SYSTEM_PROGRAM)?.pubkey == SYSTEM_PROGRAM_ID.as_array()
        && account(ata_account::TOKEN_PROGRAM)?.pubkey == route.destination_token_program;
    if for_this_trade {
        Ok(())
    } else {
        Err(EquityGuardError::InvalidAtaSetup)
    }
}

/// `ATA(owner, mint, token_program)`. Both token programs are pinned before
/// this runs, so the derivation cannot be steered to a foreign program.
fn canonical_ata(owner: &[u8; 32], mint: &[u8; 32], token_program: &[u8; 32]) -> Address {
    Address::find_program_address(&[owner, token_program, mint], &ASSOCIATED_TOKEN_PROGRAM_ID).0
}

#[cfg(test)]
mod tests {
    use solana_compute_budget_interface::ComputeBudgetInstruction;
    use solana_instruction::AccountMeta;

    use super::*;

    const AUTHORITY: Address = Address::new_from_array([0x31; 32]);
    const PAYER: Address = Address::new_from_array([0x32; 32]);
    const EQUITY: Address = Address::new_from_array([0x33; 32]);
    const VENUE: Address = Address::new_from_array([0x34; 32]);
    const TOKEN_2022: Address = spl_token_2022_interface::ID;

    fn ata(owner: &Address, mint: &Address, program: &Address) -> Address {
        canonical_ata(owner.as_array(), mint.as_array(), program.as_array())
    }

    fn route_data() -> Vec<u8> {
        let mut data = ROUTE_V2_DISCRIMINATOR.to_vec();
        data.extend(5_000_000_u64.to_le_bytes());
        data.extend(5_498_844_u64.to_le_bytes());
        data.extend(50_u16.to_le_bytes());
        data.extend(0_u16.to_le_bytes());
        data.extend(0_u16.to_le_bytes());
        data.extend(1_u32.to_le_bytes());
        data.extend([0x2f, 0x00, 0x00, 0x10, 0x27, 0x00, 0x01]);
        data
    }

    fn buy_route() -> Instruction {
        let meta = |pubkey, is_signer, is_writable| AccountMeta {
            pubkey,
            is_signer,
            is_writable,
        };
        Instruction {
            program_id: JUPITER_PROGRAM_ID,
            accounts: vec![
                meta(AUTHORITY, true, true),
                meta(
                    ata(&AUTHORITY, &USDC_MINT, &LEGACY_TOKEN_PROGRAM_ID),
                    false,
                    true,
                ),
                meta(ata(&AUTHORITY, &EQUITY, &TOKEN_2022), false, true),
                meta(USDC_MINT, false, false),
                meta(EQUITY, false, false),
                meta(LEGACY_TOKEN_PROGRAM_ID, false, false),
                meta(TOKEN_2022, false, false),
                meta(JUPITER_PROGRAM_ID, false, false),
                meta(JUPITER_EVENT_AUTHORITY, false, false),
                meta(JUPITER_PROGRAM_ID, false, false),
                meta(VENUE, false, true),
            ],
            data: route_data(),
        }
    }

    fn setup_for(route: &Instruction) -> Instruction {
        Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(PAYER, true),
                AccountMeta::new(route.accounts[2].pubkey, false),
                AccountMeta::new_readonly(route.accounts[0].pubkey, false),
                AccountMeta::new_readonly(route.accounts[4].pubkey, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(route.accounts[6].pubkey, false),
            ],
            data: vec![1],
        }
    }

    fn suffix(route: Instruction, with_setup: bool) -> Vec<Instruction> {
        let mut out = vec![
            ComputeBudgetInstruction::set_compute_unit_price(1_114),
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
        ];
        if with_setup {
            out.push(setup_for(&route));
        }
        out.push(route);
        out
    }

    #[test]
    fn pinned_constants_match_their_sources() {
        // The event authority is Anchor's PDA of the pinned program.
        let (derived, bump) =
            Address::find_program_address(&[b"__event_authority"], &JUPITER_PROGRAM_ID);
        assert_eq!(derived, JUPITER_EVENT_AUTHORITY);
        assert_eq!(bump, 255);
        // `sha256("global:route_v2")[..8]`.
        assert_eq!(
            solana_sha256_hasher::hash(b"global:route_v2").to_bytes()[..8],
            ROUTE_V2_DISCRIMINATOR
        );
        assert_eq!(
            COMPUTE_BUDGET_PROGRAM_ID,
            solana_compute_budget_interface::ID
        );
        assert_eq!(JUPITER_SUFFIX_COMMITMENT_DOMAIN.len(), 29);
    }

    #[test]
    fn compute_budget_encodings_are_the_interface_crate_encodings() {
        for value in [0_u64, 1, 1_114, u64::MAX] {
            let data = ComputeBudgetInstruction::set_compute_unit_price(value).data;
            assert_eq!(data.len(), SET_COMPUTE_UNIT_PRICE_LEN);
            assert_eq!(data[0], SET_COMPUTE_UNIT_PRICE_TAG);
            assert_eq!(
                borsh::to_vec(&ComputeBudgetInstruction::SetComputeUnitPrice(value)).unwrap(),
                data
            );
        }
        for value in [0_u32, 1_400_000, u32::MAX] {
            let data = ComputeBudgetInstruction::set_compute_unit_limit(value).data;
            assert_eq!(data.len(), SET_COMPUTE_UNIT_LIMIT_LEN);
            assert_eq!(data[0], SET_COMPUTE_UNIT_LIMIT_TAG);
            assert_eq!(
                borsh::to_vec(&ComputeBudgetInstruction::SetComputeUnitLimit(value)).unwrap(),
                data
            );
        }
        // The other variants must never be mistaken for either.
        for other in [
            ComputeBudgetInstruction::request_heap_frame(1024).data,
            ComputeBudgetInstruction::set_loaded_accounts_data_size_limit(1).data,
        ] {
            assert_ne!(other[0], SET_COMPUTE_UNIT_PRICE_TAG);
            assert_ne!(other[0], SET_COMPUTE_UNIT_LIMIT_TAG);
        }
    }

    #[test]
    fn prefix_decodes_the_documented_offsets() {
        let prefix = RouteV2Prefix::decode(&route_data()).unwrap();
        assert_eq!(
            prefix,
            RouteV2Prefix {
                in_amount: 5_000_000,
                quoted_out_amount: 5_498_844,
                slippage_bps: 50,
                platform_fee_bps: 0,
                positive_slippage_bps: 0,
                route_plan_len: 1,
            }
        );
        assert_eq!(RouteV2Prefix::decode(&route_data()[..33]), None);
        let mut other = route_data();
        other[0] ^= 1;
        assert_eq!(RouteV2Prefix::decode(&other), None);
    }

    #[test]
    fn both_supported_shapes_pass_for_buy() {
        for with_setup in [false, true] {
            assert_eq!(
                check_suffix(
                    &suffix(buy_route(), with_setup),
                    ProtectedRole::Destination,
                    &EQUITY
                ),
                Ok(()),
                "with_setup={with_setup}"
            );
        }
    }

    #[test]
    fn a_buy_route_is_not_a_sell() {
        assert_eq!(
            check_suffix(&suffix(buy_route(), true), ProtectedRole::Source, &EQUITY),
            Err(EquityGuardError::InvalidJupiterDirection)
        );
    }

    #[test]
    fn suffix_length_is_exactly_three_or_four() {
        let full = suffix(buy_route(), true);
        for len in [0, 1, 2] {
            assert_eq!(
                check_suffix(&full[..len], ProtectedRole::Destination, &EQUITY),
                Err(EquityGuardError::UnsupportedTransactionGrammar)
            );
        }
        let mut five = full.clone();
        five.push(full[0].clone());
        assert_eq!(
            check_suffix(&five, ProtectedRole::Destination, &EQUITY),
            Err(EquityGuardError::UnsupportedTransactionGrammar)
        );
    }

    #[test]
    fn suffix_commitment_is_domain_separated_and_framed() {
        let program = Address::new_from_array([5; 32]);
        let signer = AccountMeta::new_readonly(Address::new_from_array([1; 32]), true);
        let entry = |accounts: Vec<AccountMeta>, data: &[u8]| Instruction {
            program_id: program,
            accounts,
            data: data.to_vec(),
        };
        let one = jupiter_suffix_commitment(&[entry(vec![signer.clone()], &[1, 2])]).unwrap();
        // Kind 1's digest over the same single instruction differs.
        let committed = crate::downstream::CommittedAccount {
            pubkey: [1; 32],
            is_signer: true,
            is_writable: false,
        };
        assert_ne!(
            one,
            crate::downstream::downstream_commitment(&[5; 32], &[committed], &[1, 2]).unwrap()
        );
        // The count frames the instructions: one instruction is not two halves.
        let two =
            jupiter_suffix_commitment(&[entry(vec![signer], &[1]), entry(vec![], &[2])]).unwrap();
        assert_ne!(one, two);
        // The preimage is exactly domain || u32 count || instructions.
        let mut preimage = JUPITER_SUFFIX_COMMITMENT_DOMAIN.to_vec();
        preimage.extend(1_u32.to_le_bytes());
        preimage.extend([5; 32]);
        preimage.extend(1_u32.to_le_bytes());
        preimage.extend([1; 32]);
        preimage.extend([1, 0]);
        preimage.extend(2_u32.to_le_bytes());
        preimage.extend([1, 2]);
        assert_eq!(one, solana_sha256_hasher::hash(&preimage).to_bytes());
    }

    #[test]
    fn borrowed_and_owned_instructions_are_checked_and_hashed_identically() {
        use solana_instruction::{BorrowedAccountMeta, BorrowedInstruction};
        let owned = suffix(buy_route(), true);
        let borrowed: Vec<BorrowedInstruction> = owned
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
        let data = solana_instructions_sysvar::construct_instructions_data(&borrowed).unwrap();
        let views: Vec<InstructionRef> = (0..owned.len())
            .map(|i| instruction_at(&data, i).unwrap())
            .collect();
        assert_eq!(
            jupiter_suffix_commitment(&views),
            jupiter_suffix_commitment(&owned)
        );
        assert_eq!(
            check_suffix(&views, ProtectedRole::Destination, &EQUITY),
            check_suffix(&owned, ProtectedRole::Destination, &EQUITY)
        );
    }
}
