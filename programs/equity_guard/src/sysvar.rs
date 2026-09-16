//! In-place reads of top-level instructions from the Instructions sysvar.
//!
//! `solana_instructions_sysvar::load_instruction_at_checked` copies every
//! account meta into a fresh `Instruction`. The Jupiter adapter reads four
//! instructions with ~30 accounts between them, so it borrows the bytes
//! instead. The layout is the one `solana-instructions-sysvar` documents and
//! serializes:
//!
//! ```text
//! u16 LE instruction count N, then N u16 LE instruction offsets
//! at each offset:
//!   u16 LE account count A
//!   A × (u8 flags: bit 0 signer, bit 1 writable; 32-byte pubkey)
//!   32-byte program id
//!   u16 LE data length D, then D bytes
//! ```
//!
//! Flag bits other than 0 and 1 are ignored, exactly as the crate's own
//! deserializer ignores them. Anything out of bounds is `None`; callers fail
//! closed.

const ACCOUNT_META_LEN: usize = 33;
const IS_SIGNER: u8 = 0b01;
const IS_WRITABLE: u8 = 0b10;

/// One account of a borrowed instruction, with transaction-level flags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountRef<'a> {
    /// Account address.
    pub pubkey: &'a [u8; 32],
    /// Transaction-level signer flag.
    pub is_signer: bool,
    /// Transaction-level writable flag.
    pub is_writable: bool,
}

/// A top-level instruction borrowed from the sysvar's account data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstructionRef<'a> {
    /// Program id.
    pub program_id: &'a [u8; 32],
    /// `account_count() * 33` bytes of flags and pubkeys.
    accounts: &'a [u8],
    /// Exact instruction data.
    pub data: &'a [u8],
}

impl<'a> InstructionRef<'a> {
    /// Number of accounts.
    pub fn account_count(&self) -> usize {
        self.accounts.len() / ACCOUNT_META_LEN
    }

    /// The account at `index`, if any.
    pub fn account(&self, index: usize) -> Option<AccountRef<'a>> {
        let start = index.checked_mul(ACCOUNT_META_LEN)?;
        let meta: &'a [u8; ACCOUNT_META_LEN] = self.accounts.get(start..)?.first_chunk()?;
        let (flags, pubkey) = meta.split_first()?;
        Some(AccountRef {
            pubkey: pubkey.first_chunk()?,
            is_signer: flags & IS_SIGNER != 0,
            is_writable: flags & IS_WRITABLE != 0,
        })
    }

    /// Every account, in order.
    pub fn accounts(&self) -> impl Iterator<Item = AccountRef<'a>> + 'a {
        // `accounts` is a whole number of metas (see `instruction_at`), so
        // every chunk decodes.
        self.accounts
            .chunks_exact(ACCOUNT_META_LEN)
            .filter_map(|meta| {
                let (flags, pubkey) = meta.split_first()?;
                Some(AccountRef {
                    pubkey: pubkey.first_chunk()?,
                    is_signer: flags & IS_SIGNER != 0,
                    is_writable: flags & IS_WRITABLE != 0,
                })
            })
    }
}

/// The number of top-level instructions.
pub fn instruction_count(data: &[u8]) -> Option<usize> {
    data.first_chunk::<2>()
        .map(|count| usize::from(u16::from_le_bytes(*count)))
}

/// The top-level instruction at `index`, borrowed from `data`.
pub fn instruction_at(data: &[u8], index: usize) -> Option<InstructionRef<'_>> {
    if index >= instruction_count(data)? {
        return None;
    }
    let offset_at = index.checked_mul(2)?.checked_add(2)?;
    let offset: &[u8; 2] = data.get(offset_at..)?.first_chunk()?;
    let body = data.get(usize::from(u16::from_le_bytes(*offset))..)?;

    let (account_count, body) = body.split_first_chunk::<2>()?;
    let accounts_len =
        usize::from(u16::from_le_bytes(*account_count)).checked_mul(ACCOUNT_META_LEN)?;
    let (accounts, body) = body.split_at_checked(accounts_len)?;
    let (program_id, body) = body.split_first_chunk::<32>()?;
    let (data_len, body) = body.split_first_chunk::<2>()?;
    let data = body.get(..usize::from(u16::from_le_bytes(*data_len)))?;
    Some(InstructionRef {
        program_id,
        accounts,
        data,
    })
}

#[cfg(test)]
mod tests {
    use solana_account_info::AccountInfo;
    use solana_address::Address;
    use solana_instruction::{BorrowedAccountMeta, BorrowedInstruction};
    use solana_instructions_sysvar::{construct_instructions_data, load_instruction_at_checked};

    use super::*;

    fn key(seed: u8) -> Address {
        Address::new_from_array([seed; 32])
    }

    /// Instructions of assorted shapes, including empty accounts and data.
    fn sample() -> Vec<u8> {
        let (a, b, c, p, q) = (key(1), key(2), key(3), key(8), key(9));
        let meta = |pubkey, is_signer, is_writable| BorrowedAccountMeta {
            pubkey,
            is_signer,
            is_writable,
        };
        construct_instructions_data(&[
            BorrowedInstruction {
                program_id: &p,
                accounts: vec![],
                data: &[3, 1, 2, 3, 4, 5, 6, 7, 8],
            },
            BorrowedInstruction {
                program_id: &q,
                accounts: vec![
                    meta(&a, true, true),
                    meta(&b, false, true),
                    meta(&c, true, false),
                    meta(&a, false, false),
                ],
                data: &[],
            },
            BorrowedInstruction {
                program_id: &p,
                accounts: vec![meta(&c, false, false)],
                data: &[0xbb; 300],
            },
        ])
        .unwrap()
    }

    #[test]
    fn matches_the_sysvar_crate_deserializer() {
        let mut data = sample();
        let reference_data = data.clone();
        let sysvar = solana_instructions_sysvar::ID;
        let owner = Address::default();
        let mut lamports = 0;
        let info = AccountInfo::new(
            &sysvar,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
        );
        assert_eq!(instruction_count(&reference_data), Some(3));
        for index in 0..3 {
            let expected = load_instruction_at_checked(index, &info).unwrap();
            let actual = instruction_at(&reference_data, index).unwrap();
            assert_eq!(actual.program_id, expected.program_id.as_array());
            assert_eq!(actual.data, expected.data.as_slice());
            assert_eq!(actual.account_count(), expected.accounts.len());
            let by_index: Vec<_> = (0..actual.account_count())
                .map(|i| actual.account(i).unwrap())
                .collect();
            let iterated: Vec<_> = actual.accounts().collect();
            assert_eq!(by_index, iterated);
            for (account, meta) in iterated.iter().zip(&expected.accounts) {
                assert_eq!(account.pubkey, meta.pubkey.as_array());
                assert_eq!(account.is_signer, meta.is_signer);
                assert_eq!(account.is_writable, meta.is_writable);
            }
            assert_eq!(actual.account(actual.account_count()), None);
        }
        assert_eq!(instruction_at(&reference_data, 3), None);
    }

    #[test]
    fn every_truncation_fails_closed() {
        let data = sample();
        // Cutting anywhere inside an instruction's encoding hides it; nothing
        // panics and nothing reads past the end.
        for len in 0..data.len() - 2 {
            let cut = &data[..len];
            for index in 0..3 {
                if let Some(instruction) = instruction_at(cut, index) {
                    let end = instruction.data.as_ptr() as usize + instruction.data.len();
                    assert!(end <= cut.as_ptr() as usize + cut.len());
                }
            }
        }
        assert_eq!(instruction_count(&[]), None);
        assert_eq!(instruction_at(&[1], 0), None);
        // An offset pointing past the end.
        assert_eq!(instruction_at(&[1, 0, 0xff, 0xff], 0), None);
        // An account count that overruns the buffer.
        assert_eq!(instruction_at(&[1, 0, 4, 0, 0xff, 0xff], 0), None);
    }

    #[test]
    fn unknown_flag_bits_are_ignored_like_the_crate_does() {
        let mut data = sample();
        let second = usize::from(u16::from_le_bytes([data[4], data[5]]));
        let first_meta = second + 2;
        data[first_meta] |= 0b1111_0100;
        let account = instruction_at(&data, 1).unwrap().account(0).unwrap();
        assert!(account.is_signer && account.is_writable);
    }
}
