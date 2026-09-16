#!/usr/bin/env python3
"""Generates the shared guard conformance corpus.

One fixture, consumed by BOTH the Rust program tests and the TypeScript
client tests. Every expected result is authored here, from the documented
semantics (programs/equity_guard/src/{instruction,state,downstream,guard}.rs
and the Token-2022 account layout) -- never read back out of either
implementation. If Rust or TypeScript disagrees with a vector, that is a
finding to investigate, not a number to update.

Account layouts, the ABI v2 payload and the SHA-256 downstream commitment are
built here from the specification with struct.pack and hashlib, so the fixture
is a third, independent encoding of the same rules.

    python3 scripts/fixtures/generate_guard_conformance.py

Deterministic: no randomness outside the seeded PRNG below, so regenerating
produces a byte-identical file.
"""

import hashlib
import json
import random
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "programs/equity_guard/tests/fixtures/guard_conformance_v1.json"

# ---------------------------------------------------------------- base58

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = _B58[rem] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def unb58(text: str) -> bytes:
    n = 0
    for ch in text:
        n = n * 58 + _B58.index(ch)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(text) - len(text.lstrip("1"))) + body


PROGRAM_ID = "EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
LEGACY_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111"
SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111"

MINT_X = b58(bytes([0xA1] * 32))
MINT_Y = b58(bytes([0xA2] * 32))
SOURCE = b58(bytes([0xB1] * 32))
DESTINATION = b58(bytes([0xB2] * 32))
AUTHORITY = b58(bytes([0xB3] * 32))
OTHER_KEY = b58(bytes([0xC9] * 32))

# ------------------------------------------------- Token-2022 mint layout

BASE_MINT_LEN = 82
ACCOUNT_TYPE_OFFSET = 165
TLV_START = ACCOUNT_TYPE_OFFSET + 1
ACCOUNT_TYPE_MINT = 1
MULTISIG_LEN = 355

EXT_TRANSFER_FEE_CONFIG = 1
EXT_CONFIDENTIAL_TRANSFER_MINT = 4
EXT_INTEREST_BEARING = 10
EXT_SCALED_UI_AMOUNT = 25
EXT_PAUSABLE = 26

SCALED_UI_LEN = 56
PAUSABLE_LEN = 33
INTEREST_BEARING_LEN = 52
DECIMALS = 6


def tlv(kind: int, value: bytes) -> bytes:
    return struct.pack("<HH", kind, len(value)) + value


def scaled_ui_value(multiplier: bytes, effective: int, new_multiplier: bytes) -> bytes:
    """authority(32) || multiplier(f64 LE) || effective(i64 LE) || new_multiplier(f64 LE)."""
    return bytes([0x77] * 32) + multiplier + struct.pack("<q", effective) + new_multiplier


def pausable_value(paused: bool) -> bytes:
    return bytes([0x78] * 32) + bytes([1 if paused else 0])


def base_mint(decimals: int = DECIMALS, initialized: bool = True) -> bytearray:
    data = bytearray(BASE_MINT_LEN)
    struct.pack_into("<I", data, 0, 1)  # mint authority COption tag = Some
    data[4:36] = bytes([0x55] * 32)
    struct.pack_into("<Q", data, 36, 1_000_000_000)  # supply
    data[44] = decimals
    data[45] = 1 if initialized else 0
    struct.pack_into("<I", data, 46, 0)  # freeze authority COption tag = None
    return data


def mint_account(extensions: bytes, decimals: int = DECIMALS, initialized: bool = True,
                 account_type: int = ACCOUNT_TYPE_MINT, padding: int = 0) -> bytes:
    data = base_mint(decimals, initialized)
    data.extend(bytes([padding]) * (ACCOUNT_TYPE_OFFSET - BASE_MINT_LEN))
    data.append(account_type)
    data.extend(extensions)
    return bytes(data)


ONE = struct.pack("<d", 1.0)
KOX = struct.pack("<d", 1.0183317967386898)
KOX_NEW = struct.pack("<d", 1.0225601246249238)

#: Chain time used by every vector that does not exercise the clock.
NOW = 1_789_400_000
#: Scheduled activation used by the transition vectors.
T = 1_789_500_000
BEFORE = 900
AFTER = 300


def scaled_ui_mint(multiplier: bytes = ONE, new_multiplier: bytes | None = None,
                   effective: int = 0, extra: bytes = b"", **kwargs) -> bytes:
    value = scaled_ui_value(multiplier, effective, new_multiplier or multiplier)
    return mint_account(tlv(EXT_SCALED_UI_AMOUNT, value) + extra, **kwargs)


#: The plain protected mint: no scheduled change, multiplier 1.0.
MINT_STABLE = scaled_ui_mint()
#: A mint with a scheduled change to KOX_NEW at T.
MINT_SCHEDULED = scaled_ui_mint(KOX, KOX_NEW, T)

# --------------------------------------------------------- ABI v2 payload

ABI_LEN = 99
ABI_FMT = "<B32s8s8sqBIIB32s"
VERSION_V2 = 2
ADAPTER_TRANSFER_CHECKED = 1
PHASE_PENDING = 0
PHASE_ACTIVATED = 1


def abi_v2(mint: str, multiplier: bytes, new_multiplier: bytes, effective: int, phase: int,
           before: int, after: int, commitment: bytes, version: int = VERSION_V2,
           adapter: int = ADAPTER_TRANSFER_CHECKED) -> bytes:
    payload = struct.pack(ABI_FMT, version, unb58(mint), multiplier, new_multiplier,
                          effective, phase, before, after, adapter, commitment)
    assert len(payload) == ABI_LEN
    return payload


def abi_v1(multiplier: bytes, new_multiplier: bytes, effective: int, phase: int,
           before: int, after: int) -> bytes:
    """The historical 34-byte ABI v1 payload, which v2 must never accept."""
    return struct.pack("<B8s8sqBII", 1, multiplier, new_multiplier, effective, phase, before, after)


# --------------------------------------------------- downstream commitment

DOMAIN = b"EQUITYGUARD_DOWNSTREAM_V2"
TRANSFER_CHECKED_TAG = 12


def commitment_of(instruction: dict) -> bytes:
    encoded = bytearray(DOMAIN)
    encoded += unb58(instruction["programId"])
    encoded += struct.pack("<I", len(instruction["accounts"]))
    for account in instruction["accounts"]:
        encoded += unb58(account["pubkey"])
        encoded.append(1 if account["isSigner"] else 0)
        encoded.append(1 if account["isWritable"] else 0)
    data = bytes.fromhex(instruction["dataHex"])
    encoded += struct.pack("<I", len(data))
    encoded += data
    return hashlib.sha256(bytes(encoded)).digest()


def meta(pubkey: str, is_signer: bool, is_writable: bool) -> dict:
    return {"pubkey": pubkey, "isSigner": is_signer, "isWritable": is_writable}


def transfer_checked(mint: str = MINT_X, source: str = SOURCE, destination: str = DESTINATION,
                     authority: str = AUTHORITY, amount: int = 5_990_000,
                     decimals: int = DECIMALS, program: str = TOKEN_2022,
                     data: bytes | None = None, accounts: list | None = None) -> dict:
    return {
        "programId": program,
        "accounts": accounts if accounts is not None else [
            meta(source, False, True),
            meta(mint, False, False),
            meta(destination, False, True),
            meta(authority, True, True),
        ],
        "dataHex": (data if data is not None
                    else struct.pack("<BQB", TRANSFER_CHECKED_TAG, amount, decimals)).hex(),
    }


# ------------------------------------------------------------- vectors

VECTORS: list[dict] = []


def vector(vid: str, group: str, description: str, *, expected,
           guard_data: bytes | None = None, mint_account_data: bytes = MINT_STABLE,
           mint_owner: str = TOKEN_2022, account0: str = MINT_X, expected_mint: str = MINT_X,
           sysvar: str = SYSVAR_INSTRUCTIONS, clock: int = NOW,
           multiplier: bytes = ONE, new_multiplier: bytes | None = None, effective: int = 0,
           phase: int = PHASE_ACTIVATED, before: int = BEFORE, after: int = AFTER,
           next_instruction: dict | None = "default", commitment: bytes | None = None,
           preceding: list | None = None, guard_accounts: list | None = None,
           top_level_override: dict | None = None, client_rule: str = "same") -> None:
    """Appends one vector; every unnamed argument defaults to the valid case."""
    if next_instruction == "default":
        next_instruction = transfer_checked()
    if guard_data is None:
        guard_data = abi_v2(expected_mint, multiplier, new_multiplier or multiplier, effective,
                            phase, before, after,
                            commitment if commitment is not None
                            else (commitment_of(next_instruction) if next_instruction else bytes(32)))
    if guard_accounts is None:
        guard_accounts = [meta(account0, False, False), meta(sysvar, False, False)]

    preceding = preceding or []
    guard_top_level = top_level_override or {
        "programId": PROGRAM_ID, "accounts": guard_accounts, "dataHex": guard_data.hex(),
    }
    instructions = [*preceding, guard_top_level]
    if next_instruction is not None:
        instructions.append(next_instruction)

    VECTORS.append({
        "id": vid,
        "group": group,
        "description": description,
        "clientRule": client_rule,
        "invocation": {
            "programId": PROGRAM_ID,
            "dataHex": guard_data.hex(),
            "accounts": [
                {"pubkey": a["pubkey"],
                 "owner": mint_owner if a["pubkey"] == account0 else SYSTEM_PROGRAM,
                 "dataHex": mint_account_data.hex() if a["pubkey"] == account0 else ""}
                for a in guard_accounts
            ],
        },
        "transaction": {
            "currentInstructionIndex": len(preceding),
            "instructions": instructions,
        },
        "clockUnixTimestamp": str(clock),
        "expected": expected,
    })


OK = {"result": "ok"}


def err(name: str) -> dict:
    return {"result": "error", "error": name}


# --- 1. valid executions ------------------------------------------------

vector("valid-stable-activated", "valid",
       "no scheduled change, activated phase: the guard passes", expected=OK)

vector("valid-stable-pending", "valid",
       "no scheduled change: the expected phase is not checked without one",
       phase=PHASE_PENDING, expected=OK)

vector("valid-scheduled-before-window", "valid",
       "scheduled change, chain time well before the protection window",
       mint_account_data=MINT_SCHEDULED, multiplier=KOX, new_multiplier=KOX_NEW, effective=T,
       phase=PHASE_PENDING, clock=T - BEFORE - 3600, expected=OK)

vector("valid-scheduled-after-window", "valid",
       "scheduled change, chain time after the protection window",
       mint_account_data=MINT_SCHEDULED, multiplier=KOX, new_multiplier=KOX_NEW, effective=T,
       phase=PHASE_ACTIVATED, clock=T + AFTER + 3600, expected=OK)

vector("valid-zero-window-before-t", "valid",
       "beforeSecs=0 and afterSecs=0: only the exact activation second is refused",
       mint_account_data=MINT_SCHEDULED, multiplier=KOX, new_multiplier=KOX_NEW, effective=T,
       phase=PHASE_PENDING, before=0, after=0, clock=T - 1, expected=OK)

vector("valid-extra-extension-pausable", "valid",
       "an unpaused Pausable extension alongside ScaledUiAmount still decodes",
       mint_account_data=scaled_ui_mint(extra=tlv(EXT_PAUSABLE, pausable_value(False))),
       expected=OK)

vector("valid-paused-mint-is-not-the-guards-concern", "valid",
       "the Pausable flag is not a protected field: Token-2022 rejects the transfer, not the guard",
       mint_account_data=scaled_ui_mint(extra=tlv(EXT_PAUSABLE, pausable_value(True))),
       expected=OK)

vector("valid-guard-at-index-2", "valid",
       "the guard need not be first, only immediately followed by the committed action",
       preceding=[
           {"programId": SYSTEM_PROGRAM, "accounts": [meta(AUTHORITY, True, True)], "dataHex": "00"},
           {"programId": SYSTEM_PROGRAM, "accounts": [], "dataHex": "01"},
       ],
       expected=OK)

vector("valid-extreme-multiplier-max", "valid",
       "f64::MAX is a positive normal multiplier and is accepted",
       mint_account_data=scaled_ui_mint(struct.pack("<d", 1.7976931348623157e308)),
       multiplier=struct.pack("<d", 1.7976931348623157e308), expected=OK)

vector("valid-extreme-multiplier-min-positive-normal", "valid",
       "the smallest positive normal f64 is accepted",
       mint_account_data=scaled_ui_mint(struct.pack("<d", 2.2250738585072014e-308)),
       multiplier=struct.pack("<d", 2.2250738585072014e-308), expected=OK)

# --- 2. ABI payload -----------------------------------------------------

vector("abi-empty", "abi", "empty instruction data", guard_data=b"",
       expected=err("UnsupportedInstruction"))

vector("abi-v1-payload", "abi",
       "a complete, well-formed ABI v1 payload can never authorize execution (INV-SEC-23)",
       guard_data=abi_v1(ONE, ONE, 0, PHASE_ACTIVATED, BEFORE, AFTER),
       expected=err("UnsupportedVersion"))

for version in (0, 1, 3, 255):
    vector(f"abi-version-{version}", "abi", f"version byte {version} is not ABI v2",
           guard_data=bytes([version]) + abi_v2(MINT_X, ONE, ONE, 0, PHASE_ACTIVATED, BEFORE,
                                                AFTER, commitment_of(transfer_checked()))[1:],
           expected=err("UnsupportedVersion"))

_valid_payload = abi_v2(MINT_X, ONE, ONE, 0, PHASE_ACTIVATED, BEFORE, AFTER,
                        commitment_of(transfer_checked()))
for length in (1, 2, 34, 98):
    vector(f"abi-truncated-{length}", "abi", f"{length} bytes is not the fixed v2 length",
           guard_data=_valid_payload[:length], expected=err("InvalidInstructionLength"))
vector("abi-trailing-byte", "abi", "trailing bytes after a complete payload are rejected",
       guard_data=_valid_payload + b"\x00", expected=err("InvalidInstructionLength"))

for phase in (2, 3, 255):
    vector(f"abi-phase-{phase}", "abi", f"activation phase {phase} is not 0 or 1",
           guard_data=abi_v2(MINT_X, ONE, ONE, 0, phase, BEFORE, AFTER,
                             commitment_of(transfer_checked())),
           expected=err("InvalidExpectedState"))

_BAD_MULTIPLIERS = {
    "zero": struct.pack("<d", 0.0),
    "negative-zero": struct.pack("<d", -0.0),
    "negative": struct.pack("<d", -1.5),
    "positive-infinity": struct.pack("<d", float("inf")),
    "negative-infinity": struct.pack("<d", float("-inf")),
    "quiet-nan": struct.pack("<Q", 0x7FF8_0000_0000_0000),
    "signalling-nan": struct.pack("<Q", 0x7FF0_0000_0000_0001),
    "negative-nan": struct.pack("<Q", 0xFFF8_0000_0000_0000),
    "positive-subnormal": struct.pack("<Q", 1),
    "negative-subnormal": struct.pack("<Q", 0x8000_0000_0000_0001),
    "largest-subnormal": struct.pack("<Q", 0x000F_FFFF_FFFF_FFFF),
}
for label, bad in _BAD_MULTIPLIERS.items():
    vector(f"abi-multiplier-{label}", "abi", f"expected multiplier {label} is not a positive normal f64",
           guard_data=abi_v2(MINT_X, bad, ONE, 0, PHASE_ACTIVATED, BEFORE, AFTER,
                             commitment_of(transfer_checked())),
           expected=err("InvalidExpectedState"))
    vector(f"abi-new-multiplier-{label}", "abi", f"expected new multiplier {label} is rejected",
           guard_data=abi_v2(MINT_X, ONE, bad, 0, PHASE_ACTIVATED, BEFORE, AFTER,
                             commitment_of(transfer_checked())),
           expected=err("InvalidExpectedState"))

for adapter in (0, 4, 255):
    vector(f"abi-adapter-{adapter}", "abi",
           f"adapter kind {adapter} has no understood semantics and fails closed (INV-SEC-24)",
           guard_data=abi_v2(MINT_X, ONE, ONE, 0, PHASE_ACTIVATED, BEFORE, AFTER,
                             commitment_of(transfer_checked()), adapter=adapter),
           expected=err("UnsupportedAdapter"))

for adapter in (2, 3):
    vector(f"abi-adapter-{adapter}-over-transfer-checked", "abi",
           f"adapter kind {adapter} is Jupiter-only: a guard followed by one TransferChecked is "
           "not its transaction grammar",
           guard_data=abi_v2(MINT_X, ONE, ONE, 0, PHASE_ACTIVATED, BEFORE, AFTER,
                             commitment_of(transfer_checked()), adapter=adapter),
           expected=err("UnsupportedTransactionGrammar"))

# --- 3. accounts --------------------------------------------------------

vector("accounts-none", "accounts", "no accounts", guard_accounts=[],
       expected=err("InvalidAccountCount"))
vector("accounts-mint-only", "accounts", "the Instructions sysvar is missing",
       guard_accounts=[meta(MINT_X, False, False)], expected=err("InvalidAccountCount"))
vector("accounts-three", "accounts", "an extra account is rejected rather than ignored",
       guard_accounts=[meta(MINT_X, False, False), meta(SYSVAR_INSTRUCTIONS, False, False),
                       meta(OTHER_KEY, False, False)],
       expected=err("InvalidAccountCount"))
vector("accounts-swapped", "accounts", "sysvar first, mint second",
       guard_accounts=[meta(SYSVAR_INSTRUCTIONS, False, False), meta(MINT_X, False, False)],
       account0=SYSVAR_INSTRUCTIONS, sysvar=MINT_X, expected=err("MintKeyMismatch"))

vector("mint-key-mismatch", "accounts",
       "account 0 is a different mint than the payload commits to (INV-SEC-11)",
       account0=MINT_Y, expected_mint=MINT_X, expected=err("MintKeyMismatch"))

for label, key in (("random-key", OTHER_KEY), ("clock-sysvar", SYSVAR_CLOCK),
                   ("token-program", TOKEN_2022)):
    vector(f"sysvar-{label}", "accounts", f"account 1 is {label}, not the Instructions sysvar",
           sysvar=key, expected=err("InvalidInstructionsSysvar"))

# --- 4. mint account ----------------------------------------------------

for label, owner in (("legacy-token", LEGACY_TOKEN), ("system", SYSTEM_PROGRAM),
                     ("program-itself", PROGRAM_ID)):
    vector(f"mint-owner-{label}", "mint", f"a mint owned by {label} is not a Token-2022 mint",
           mint_owner=owner, expected=err("InvalidMintOwner"))

vector("mint-base-only", "mint", "a valid Token-2022 mint with no extensions at all",
       mint_account_data=bytes(base_mint()), expected=err("MissingScaledUiAmount"))
vector("mint-pausable-only", "mint", "extensions, but no ScaledUiAmount",
       mint_account_data=mint_account(tlv(EXT_PAUSABLE, pausable_value(False))),
       expected=err("MissingScaledUiAmount"))

vector("mint-uninitialized", "mint", "is_initialized is 0",
       mint_account_data=scaled_ui_mint(initialized=False), expected=err("InvalidMintData"))
vector("mint-account-type-token", "mint", "the account type byte says token account, not mint",
       mint_account_data=scaled_ui_mint(account_type=2), expected=err("InvalidMintData"))
vector("mint-account-type-uninitialized", "mint", "account type 0",
       mint_account_data=scaled_ui_mint(account_type=0), expected=err("InvalidMintData"))

for length in (0, 1, 40, BASE_MINT_LEN - 1, 120, ACCOUNT_TYPE_OFFSET,
               TLV_START + 3, len(MINT_STABLE) - 1):
    vector(f"mint-truncated-{length}", "mint", f"the account is {length} bytes",
           mint_account_data=MINT_STABLE[:length], expected=err("InvalidMintData"))

vector(f"mint-truncated-{TLV_START}", "mint",
       "an account cut to exactly the account-type byte is a well-formed mint "
       "whose extension area is empty",
       mint_account_data=MINT_STABLE[:TLV_START], expected=err("MissingScaledUiAmount"))

vector("mint-multisig-length", "mint",
       "an account of exactly the multisig length is not a mint",
       mint_account_data=(MINT_STABLE + bytes(MULTISIG_LEN))[:MULTISIG_LEN],
       expected=err("InvalidMintData"))

_scaled_tlv = TLV_START


def mutate(data: bytes, offset: int, new: bytes) -> bytes:
    out = bytearray(data)
    out[offset:offset + len(new)] = new
    return bytes(out)


vector("mint-tlv-length-overrun", "mint", "the TLV length runs past the end of the account",
       mint_account_data=mutate(MINT_STABLE, _scaled_tlv + 2, struct.pack("<H", 0xFFFF)),
       expected=err("InvalidMintData"))
vector("mint-tlv-length-short", "mint", "the ScaledUiAmount value is one byte short",
       mint_account_data=mutate(MINT_STABLE, _scaled_tlv + 2, struct.pack("<H", SCALED_UI_LEN - 1)),
       expected=err("InvalidMintData"))
vector("mint-tlv-unknown-type", "mint", "an extension type the decoder does not know",
       mint_account_data=mutate(MINT_STABLE, _scaled_tlv, struct.pack("<H", 0xFFFF)),
       expected=err("InvalidMintData"))
vector("mint-tlv-header-truncated", "mint", "two bytes of TLV header, not four",
       mint_account_data=MINT_STABLE[:_scaled_tlv + 2], expected=err("InvalidMintData"))
vector("mint-tlv-zero-length-scaled-ui", "mint", "a zero-length ScaledUiAmount entry",
       mint_account_data=mint_account(tlv(EXT_SCALED_UI_AMOUNT, b"")),
       expected=err("InvalidMintData"))

vector("mint-duplicate-scaled-ui", "mint",
       "two ScaledUiAmount entries are ambiguous: lookups read the first",
       mint_account_data=scaled_ui_mint(extra=tlv(EXT_SCALED_UI_AMOUNT,
                                                  scaled_ui_value(struct.pack("<d", 9.0), 0,
                                                                  struct.pack("<d", 9.0)))),
       expected=err("InvalidMintData"))
vector("mint-duplicate-pausable", "mint", "any repeated extension type is rejected",
       mint_account_data=scaled_ui_mint(extra=tlv(EXT_PAUSABLE, pausable_value(False))
                                        + tlv(EXT_PAUSABLE, pausable_value(True))),
       expected=err("InvalidMintData"))

vector("mint-scaled-ui-with-interest-bearing", "mint",
       "interest accrual would move the UI amount outside the protected fields",
       mint_account_data=scaled_ui_mint(extra=tlv(EXT_INTEREST_BEARING,
                                                  bytes(INTEREST_BEARING_LEN))),
       expected=err("InvalidExtensionCombination"))

for label, bad in _BAD_MULTIPLIERS.items():
    vector(f"mint-multiplier-{label}", "mint", f"the stored multiplier is {label}",
           mint_account_data=scaled_ui_mint(bad, ONE), expected=err("InvalidMultiplier"))
    vector(f"mint-new-multiplier-{label}", "mint", f"the stored new multiplier is {label}",
           mint_account_data=scaled_ui_mint(ONE, bad), expected=err("InvalidMultiplier"))

vector("mint-nonzero-padding", "mint",
       "non-zero bytes in the reserved region between the base mint and the account type",
       mint_account_data=scaled_ui_mint(padding=0xFF), expected=err("InvalidMintData"))

# --- 5. downstream binding ---------------------------------------------

vector("downstream-missing", "downstream", "the guard is the last instruction (INV-SEC-21)",
       next_instruction=None, commitment=bytes(32),
       expected=err("MissingDownstreamInstruction"))

vector("downstream-wrong-program-system", "downstream",
       "an unrelated instruction was inserted between the guard and the action",
       next_instruction={"programId": SYSTEM_PROGRAM, "accounts": [meta(AUTHORITY, True, True)],
                         "dataHex": "02000000"},
       expected=err("UnsupportedDownstreamProgram"))
vector("downstream-wrong-program-legacy-token", "downstream",
       "legacy SPL Token is not Token-2022 even for an identical TransferChecked",
       next_instruction=transfer_checked(program=LEGACY_TOKEN),
       expected=err("UnsupportedDownstreamProgram"))
vector("downstream-wrong-program-guard", "downstream",
       "a second guard instruction is not a supported action",
       next_instruction={"programId": PROGRAM_ID, "accounts": [meta(MINT_X, False, False)],
                         "dataHex": _valid_payload.hex()},
       expected=err("UnsupportedDownstreamProgram"))

vector("downstream-transfer-not-checked", "downstream",
       "Token-2022 Transfer (tag 3) is not TransferChecked",
       next_instruction=transfer_checked(data=struct.pack("<BQ", 3, 5_990_000)),
       expected=err("UnsupportedDownstreamInstruction"))
vector("downstream-burn-checked", "downstream", "BurnChecked (tag 15) is not TransferChecked",
       next_instruction=transfer_checked(data=struct.pack("<BQB", 15, 5_990_000, DECIMALS)),
       expected=err("UnsupportedDownstreamInstruction"))
vector("downstream-empty-data", "downstream", "an empty Token-2022 instruction",
       next_instruction=transfer_checked(data=b""),
       expected=err("UnsupportedDownstreamInstruction"))
vector("downstream-transfer-checked-trailing-byte", "downstream",
       "TransferChecked with an extra data byte is not the fixed 10-byte encoding",
       next_instruction=transfer_checked(
           data=struct.pack("<BQB", TRANSFER_CHECKED_TAG, 5_990_000, DECIMALS) + b"\x00"),
       expected=err("UnsupportedDownstreamInstruction"))
vector("downstream-too-few-accounts", "downstream",
       "TransferChecked needs at least source, mint, destination and authority",
       next_instruction=transfer_checked(accounts=[meta(SOURCE, False, True),
                                                   meta(MINT_X, False, False),
                                                   meta(DESTINATION, False, True)]),
       expected=err("UnsupportedDownstreamInstruction"))

vector("downstream-mint-mismatch", "downstream",
       "the action moves a different mint than the guard protects (INV-SEC-11)",
       next_instruction=transfer_checked(mint=MINT_Y),
       expected=err("DownstreamMintMismatch"))

_honest = transfer_checked()
for label, mutated in (
    ("amount", transfer_checked(amount=6_000_000)),
    ("decimals", transfer_checked(decimals=DECIMALS + 1)),
    ("destination", transfer_checked(destination=OTHER_KEY)),
    ("source", transfer_checked(source=OTHER_KEY)),
    ("authority", transfer_checked(authority=OTHER_KEY)),
    ("extra-account", transfer_checked(accounts=[*_honest["accounts"], meta(OTHER_KEY, False, True)])),
    ("account-order", transfer_checked(accounts=[_honest["accounts"][0], _honest["accounts"][1],
                                                 _honest["accounts"][3], _honest["accounts"][2]])),
    ("mint-account-index", transfer_checked(accounts=[_honest["accounts"][1], _honest["accounts"][0],
                                                      *_honest["accounts"][2:]])),
    ("signer-flag", transfer_checked(accounts=[*_honest["accounts"][:3], meta(AUTHORITY, False, True)])),
    ("writable-flag", transfer_checked(accounts=[meta(SOURCE, False, False), *_honest["accounts"][1:]])),
):
    expected_error = ("DownstreamMintMismatch" if label == "mint-account-index"
                      else "DownstreamCommitmentMismatch")
    vector(f"downstream-substituted-{label}", "downstream",
           f"the committed action and the submitted action differ in {label} (INV-SEC-22)",
           next_instruction=mutated, commitment=commitment_of(_honest),
           expected=err(expected_error))

vector("downstream-commitment-zero", "downstream", "a payload that commits to nothing",
       commitment=bytes(32), expected=err("DownstreamCommitmentMismatch"))

vector("guard-not-top-level-cpi", "downstream",
       "invoked via CPI the current top-level instruction belongs to the caller (INV-SEC-25)",
       top_level_override={"programId": OTHER_KEY, "accounts": [meta(MINT_X, False, False)],
                           "dataHex": "aabb"},
       expected=err("GuardNotTopLevel"))
vector("guard-not-top-level-other-data", "downstream",
       "a top-level guard instruction carrying other data is not this invocation",
       top_level_override={"programId": PROGRAM_ID,
                           "accounts": [meta(MINT_X, False, False), meta(SYSVAR_INSTRUCTIONS, False, False)],
                           "dataHex": (_valid_payload[:98] + bytes([_valid_payload[98] ^ 1])).hex()},
       expected=err("GuardNotTopLevel"))

# --- 6. economic state --------------------------------------------------

vector("stale-multiplier", "state", "the mint's multiplier moved after the payload was built",
       mint_account_data=scaled_ui_mint(KOX), multiplier=ONE,
       expected=err("MultiplierChanged"))
vector("stale-both-multipliers", "state",
       "both stored multipliers moved: the current one is reported first",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, T), multiplier=ONE, new_multiplier=ONE,
       expected=err("MultiplierChanged"))
vector("stale-new-multiplier", "state",
       "a change was scheduled after the payload was built: only the pending multiplier differs",
       mint_account_data=scaled_ui_mint(ONE, KOX_NEW, T), multiplier=ONE, new_multiplier=ONE,
       expected=err("NewMultiplierChanged"))
vector("stale-effective-timestamp", "state", "the activation was rescheduled",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, T + 1), multiplier=KOX,
       new_multiplier=KOX_NEW, effective=T, clock=T - BEFORE - 3600, phase=PHASE_PENDING,
       expected=err("EffectiveTimestampChanged"))
vector("stale-multiplier-one-bit", "state",
       "a one-bit multiplier change is a change: identity is bytes, not float equality",
       mint_account_data=scaled_ui_mint(struct.pack("<Q", struct.unpack("<Q", ONE)[0] + 1)),
       multiplier=ONE, expected=err("MultiplierChanged"))

# --- 7. clock boundary matrix ------------------------------------------

def clock_case(now: int, before: int, after: int) -> None:
    """One boundary time, evaluated for both expected phases."""
    start, end = T - before, T + after
    inside = start <= now <= end
    actual_phase = PHASE_ACTIVATED if now >= T else PHASE_PENDING
    offset = f"{now - T:+d}"
    for phase, phase_label in ((PHASE_PENDING, "pending"), (PHASE_ACTIVATED, "activated")):
        if inside:
            expected = err("InsideTransitionWindow")
        elif phase != actual_phase:
            expected = err("ActivationPhaseChanged")
        else:
            expected = OK
        vector(f"clock-w{before}-{after}-t{offset}-{phase_label}", "clock",
               f"T{offset} with window [-{before}, +{after}], expected phase {phase_label}",
               mint_account_data=MINT_SCHEDULED, multiplier=KOX, new_multiplier=KOX_NEW,
               effective=T, before=before, after=after, phase=phase, clock=now,
               expected=expected)


# Every boundary of the refusal interval [T - before, T + after], plus the
# activation second itself, for four window shapes including the degenerate one.
for _before, _after in ((BEFORE, AFTER), (0, 0), (0, AFTER), (BEFORE, 0)):
    _times = [T - _before - 1, T - _before, T - _before + 1, T - 1, T, T + 1,
              T + _after - 1, T + _after, T + _after + 1]
    for _now in sorted(set(_times)):
        clock_case(_now, _before, _after)

I64_MAX = 2**63 - 1
I64_MIN = -(2**63)
U32_MAX = 2**32 - 1

vector("clock-overflow-end", "clock",
       "T + afterSecs overflows i64 and fails closed rather than wrapping",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, I64_MAX), multiplier=KOX,
       new_multiplier=KOX_NEW, effective=I64_MAX, before=0, after=U32_MAX, clock=NOW,
       expected=err("ArithmeticOverflow"))
vector("clock-overflow-start", "clock",
       "T - beforeSecs underflows i64 and fails closed",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, I64_MIN), multiplier=KOX,
       new_multiplier=KOX_NEW, effective=I64_MIN, before=U32_MAX, after=0, clock=NOW,
       expected=err("ArithmeticOverflow"))
vector("clock-i64-max-zero-window", "clock",
       "an activation at i64::MAX with a zero window: chain time is before it",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, I64_MAX), multiplier=KOX,
       new_multiplier=KOX_NEW, effective=I64_MAX, before=0, after=0, clock=NOW,
       phase=PHASE_PENDING, expected=OK)
vector("clock-i64-min-zero-window", "clock",
       "an activation at i64::MIN with a zero window: chain time is after it",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, I64_MIN), multiplier=KOX,
       new_multiplier=KOX_NEW, effective=I64_MIN, before=0, after=0, clock=NOW,
       phase=PHASE_ACTIVATED, expected=OK)
vector("clock-u32-max-window-covers-now", "clock",
       "a maximal window around a nearby activation refuses execution",
       mint_account_data=MINT_SCHEDULED, multiplier=KOX, new_multiplier=KOX_NEW, effective=T,
       before=U32_MAX, after=0, clock=NOW, expected=err("InsideTransitionWindow"))
vector("clock-negative-chain-time", "clock",
       "a negative chain timestamp is still ordered correctly",
       mint_account_data=scaled_ui_mint(KOX, KOX_NEW, -100), multiplier=KOX,
       new_multiplier=KOX_NEW, effective=-100, before=10, after=10, clock=-200,
       phase=PHASE_PENDING, expected=OK)

# --- 8. seeded randomized corpus ---------------------------------------

SEED = 0x9C_2026
rng = random.Random(SEED)
_AMOUNTS = [0, 1, 5_990_000, 2**32, 2**63 - 1, 2**64 - 1]

for i in range(40):
    protected = rng.choice([MINT_X, MINT_Y])
    action_mint = rng.choice([MINT_X, MINT_Y])
    amount = rng.choice(_AMOUNTS)
    dec = rng.choice([0, 6, 9, 255])
    committed_amount = rng.choice(_AMOUNTS)
    committed_dec = rng.choice([0, 6, 9, 255])
    action = transfer_checked(mint=action_mint, amount=amount, decimals=dec)
    committed = transfer_checked(mint=action_mint, amount=committed_amount, decimals=committed_dec)
    if action_mint != protected:
        expected = err("DownstreamMintMismatch")
    elif (amount, dec) != (committed_amount, committed_dec):
        expected = err("DownstreamCommitmentMismatch")
    else:
        expected = OK
    vector(f"random-{SEED:x}-{i:03d}", "random",
           f"seeded case {i}: protected {'X' if protected == MINT_X else 'Y'}, "
           f"action mint {'X' if action_mint == MINT_X else 'Y'}, "
           f"amount {amount} vs committed {committed_amount}",
           account0=protected, expected_mint=protected,
           mint_account_data=MINT_STABLE, next_instruction=action,
           commitment=commitment_of(committed), expected=expected)

# --- 9. Jupiter route_v2, adapter kinds 2 and 3 ---------------------------
#
# Every vector below is a complete guarded transaction built from a recorded
# mainnet build (scripts/research/fixtures/route-v2-builds-2026-09-16.json)
# with the recorded mainnet mint account of the protected equity. Expected
# results are authored per vector from the grammar in
# programs/equity_guard/src/jupiter.rs; only encodings (flags, ATAs,
# commitments) are computed here.
#
# "malicious" vectors recompute the suffix commitment over the mutated
# transaction, so only semantic validation can reject them. "post-commitment"
# vectors keep the honest commitment, so only identity binding can.

import copy  # noqa: E402

import jupiter_builds as jb  # noqa: E402
import solana_encoding as enc  # noqa: E402

J_NOW = NOW
J_DECODED = {m["symbol"]: m for m in json.loads((jb.MAINNET_MINTS / "decoded.json").read_text())["mints"]}
J_MINTS = {jb.protected_mint(b): b["symbol"] for b in jb.builds()}
J_TAKER = jb.builds()[0]["taker"]
J_ATTACKER = enc.b58(bytes([0xA7] * 32))
J_RELAYER = enc.b58(bytes([0x7E] * 32))
J_OTHER_USER = enc.b58(bytes([0x44] * 32))
J_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
J_MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
PRICE, LIMIT, SETUP, ROUTE = 0, 1, 2, 3
OTHER_ENTRYPOINTS = [
    "e517cb977ae3ad2a", "96564774a75d0e68", "c1209b3341d69c81", "e6798f50779f6aaa",
    "d033ef977b2bed5c", "b0d169a89a7d453e", "9d8ab85215f4f324", "d19853937cfed8e9",
    "3560e5cad8bbfa18",
]


def mint_of(symbol: str) -> str:
    return next(m for m, s in J_MINTS.items() if s == symbol)


def j_guard_data(mint: str, adapter: int, commitment: bytes) -> bytes:
    state = J_DECODED[J_MINTS[mint]]
    return abi_v2(mint, bytes.fromhex(state["multiplierHex"]), bytes.fromhex(state["newMultiplierHex"]),
                  int(state["newMultiplierEffectiveTimestamp"]), PHASE_ACTIVATED, BEFORE, AFTER,
                  commitment, adapter=adapter)


def j_guard(mint: str, data: bytes) -> dict:
    return {"programId": PROGRAM_ID,
            "accounts": [meta(mint, False, False), meta(SYSVAR_INSTRUCTIONS, False, False)],
            "dataHex": data.hex()}


def j_transaction(suffix: list, guard: dict, guard_index: int, fee_payer: str) -> list:
    instructions = copy.deepcopy(suffix)
    instructions.insert(guard_index, guard)
    return enc.sysvar_view(instructions, fee_payer)


def j_vector(vid: str, group: str, description: str, *, expected, symbol: str = "KOx",
             direction: str = "BUY", edit=None, guard_index: int = 0, adapter: int | None = None,
             guard_symbol: str | None = None, fee_payer: str | None = None,
             commitment: str = "recompute") -> None:
    b = jb.build(symbol, direction)
    honest = jb.normalized(b)
    suffix = copy.deepcopy(honest)
    ctx = {"fee_payer": fee_payer or b["taker"]}
    if edit is not None:
        edit(suffix, ctx)
    payer = ctx["fee_payer"]
    mint = mint_of(guard_symbol) if guard_symbol else jb.protected_mint(b)
    kind = adapter if adapter is not None else jb.adapter(b)

    placeholder = j_guard(mint, j_guard_data(mint, kind, bytes(32)))
    if commitment == "recompute":
        digest = enc.suffix_commitment(j_transaction(suffix, placeholder, 0, payer)[1:])
    elif commitment == "honest":
        digest = enc.suffix_commitment(enc.sysvar_view([placeholder, *honest], b["taker"])[1:])
    elif commitment == "zero":
        digest = bytes(32)
    else:
        raise ValueError(commitment)
    data = j_guard_data(mint, kind, digest)
    instructions = j_transaction(suffix, j_guard(mint, data), guard_index, payer)
    if commitment == "recompute" and guard_index == 0:
        assert enc.suffix_commitment(instructions[1:]) == digest, vid

    VECTORS.append({
        "id": vid,
        "group": group,
        "description": description,
        "clientRule": "same",
        "invocation": {
            "programId": PROGRAM_ID,
            "dataHex": data.hex(),
            "accounts": [
                {"pubkey": mint, "owner": TOKEN_2022, "dataHex": jb.mainnet_mint_hex(J_MINTS[mint])},
                {"pubkey": SYSVAR_INSTRUCTIONS, "owner": SYSTEM_PROGRAM, "dataHex": ""},
            ],
        },
        "transaction": {"currentInstructionIndex": guard_index, "instructions": instructions},
        "clockUnixTimestamp": str(J_NOW),
        "expected": expected,
    })


# Edits. Each receives the normalized suffix (price, limit, setup, route) and a
# context whose "fee_payer" it may change.

def route(sfx):
    return sfx[-1]


def set_key(ix, index, pubkey, signer=None, writable=None):
    old = ix["accounts"][index]
    ix["accounts"][index] = meta(pubkey, old["isSigner"] if signer is None else signer,
                                 old["isWritable"] if writable is None else writable)


def patch(ix, offset, fmt, value):
    data = bytearray.fromhex(ix["dataHex"])
    struct.pack_into(fmt, data, offset, value)
    ix["dataHex"] = data.hex()


def system_transfer(to):
    return {"programId": SYSTEM_PROGRAM,
            "accounts": [meta(J_TAKER, True, True), meta(to, False, True)],
            "dataHex": struct.pack("<IQ", 2, 1_000_000_000).hex()}


def memo_ix():
    return {"programId": J_MEMO, "accounts": [meta(J_TAKER, True, False)], "dataHex": b"hi".hex()}


def close_account(account, destination):
    return {"programId": jb.LEGACY_TOKEN,
            "accounts": [meta(account, False, True), meta(destination, False, True),
                         meta(J_TAKER, True, False)],
            "dataHex": "09"}


def retarget_destination(sfx, mint, program):
    r = route(sfx)
    dest = enc.ata(r["accounts"][0]["pubkey"], mint, program)
    for i, k in ((2, dest), (4, mint), (6, program)):
        set_key(r, i, k)
    for i, k in ((1, dest), (3, mint), (5, program)):
        set_key(sfx[SETUP], i, k)


def retarget_source(sfx, mint, program):
    r = route(sfx)
    for i, k in ((1, enc.ata(r["accounts"][0]["pubkey"], mint, program)), (3, mint), (5, program)):
        set_key(r, i, k)


def e(fn):
    """Adapts an edit that ignores the context."""
    return lambda sfx, ctx: fn(sfx)


OK_J = {"result": "ok"}

for _symbol in ("KOx", "UNHx"):
    for _direction in ("BUY", "SELL"):
        _tag = f"{_symbol.lower()}-{_direction.lower()}"
        j_vector(f"jupiter-valid-{_tag}", "jupiter-valid",
                 f"the recorded {_symbol} {_direction} route_v2 behind a kind "
                 f"{2 if _direction == 'BUY' else 3} guard: price, limit, setup, trade",
                 symbol=_symbol, direction=_direction, expected=OK_J)
        j_vector(f"jupiter-valid-{_tag}-without-setup", "jupiter-valid",
                 f"{_symbol} {_direction} in the three-instruction shape",
                 symbol=_symbol, direction=_direction,
                 edit=e(lambda sfx: sfx.pop(SETUP)), expected=OK_J)

j_vector("jupiter-valid-crmx-sell", "jupiter-valid",
         "CRMx SELL is a single-leg route and fits the grammar",
         symbol="CRMx", direction="SELL", expected=OK_J)


def _relayer(sfx, ctx):
    ctx["fee_payer"] = J_RELAYER
    set_key(sfx[SETUP], 0, J_RELAYER)


j_vector("jupiter-valid-relayer-pays", "jupiter-valid",
         "a third party pays the fee and the destination's rent", edit=_relayer, expected=OK_J)

# CRMx BUY hops through wSOL.
j_vector("jupiter-unsupported-crmx-buy", "jupiter-grammar",
         "CRMx BUY needs a second setup and a wSOL CloseAccount: unsupported, never weakened",
         symbol="CRMx", direction="BUY", expected=err("UnsupportedTransactionGrammar"))
j_vector("jupiter-unsupported-crmx-buy-without-cleanup", "jupiter-grammar",
         "without the cleanup, the second setup still breaks the grammar",
         symbol="CRMx", direction="BUY", edit=e(lambda sfx: sfx.pop()),
         expected=err("UnsupportedTransactionGrammar"))


def _wsol_only(sfx):
    sfx.pop()
    del sfx[SETUP]  # the destination's own setup comes first in the recording


j_vector("jupiter-unsupported-crmx-buy-wsol-setup", "jupiter-semantic",
         "the wSOL setup alone does not create this trade's destination",
         symbol="CRMx", direction="BUY", edit=e(_wsol_only), expected=err("InvalidAtaSetup"))

MALICIOUS = [
    # (id, direction, expected, edit, extra kwargs)
    ("a-transfer-after-trade", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.append(system_transfer(J_ATTACKER))), {}),
    ("a-transfer-after-setupless-trade", "SELL", "UnsupportedTransactionGrammar",
     e(lambda sfx: (sfx.pop(SETUP), sfx.append(system_transfer(J_ATTACKER)))), {}),
    ("b-transfer-in-setup-position", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, system_transfer(J_ATTACKER))), {}),
    ("b-transfer-before-trade", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.insert(ROUTE, system_transfer(J_ATTACKER))), {}),
    ("c-cleanup-after-trade", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.append(close_account(route(sfx)["accounts"][2]["pubkey"], J_ATTACKER))), {}),
    ("c-cleanup-in-setup-position", "SELL", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, close_account(route(sfx)["accounts"][1]["pubkey"], J_ATTACKER))), {}),
    ("d-second-trade-in-setup-position", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, copy.deepcopy(sfx[ROUTE]))), {}),
    ("d-second-trade-appended", "SELL", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.append(copy.deepcopy(sfx[ROUTE]))), {}),
    ("e-tip-appended", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.append(system_transfer(J_RELAYER))), {}),
    ("e-tip-in-setup-position", "SELL", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, system_transfer(J_RELAYER))), {}),
    ("f-arbitrary-program-in-setup-position", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, memo_ix())), {}),
    ("f-arbitrary-program-in-price-position", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(PRICE, memo_ix())), {}),
    ("f-arbitrary-program-as-trade", "BUY", "InvalidJupiterProgram",
     e(lambda sfx: sfx.__setitem__(ROUTE, memo_ix())), {}),
    ("g-request-heap-frame-as-price", "BUY", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx.__setitem__(PRICE, {"programId": enc.COMPUTE_BUDGET, "accounts": [],
                                           "dataHex": struct.pack("<BI", 1, 65536).hex()})), {}),
    ("g-loaded-accounts-limit-as-limit", "SELL", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx.__setitem__(LIMIT, {"programId": enc.COMPUTE_BUDGET, "accounts": [],
                                           "dataHex": struct.pack("<BI", 4, 1_000_000).hex()})), {}),
    ("g-price-with-an-account", "BUY", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx[PRICE]["accounts"].append(meta(J_ATTACKER, False, False))), {}),
    ("g-price-with-a-trailing-byte", "BUY", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx[PRICE].__setitem__("dataHex", sfx[PRICE]["dataHex"] + "00")), {}),
    ("g-unused-variant-zero", "BUY", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx.__setitem__(LIMIT, {"programId": enc.COMPUTE_BUDGET, "accounts": [],
                                           "dataHex": "00"})), {}),
    ("h-duplicate-price", "BUY", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx.__setitem__(LIMIT, copy.deepcopy(sfx[PRICE]))), {}),
    ("h-duplicate-price-in-setup-position", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, copy.deepcopy(sfx[PRICE]))), {}),
    ("i-duplicate-limit", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(SETUP, copy.deepcopy(sfx[LIMIT]))), {}),
    ("i-duplicate-limit-in-price-position", "SELL", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx.__setitem__(PRICE, copy.deepcopy(sfx[LIMIT]))), {}),
    ("j-limit-before-price", "BUY", "InvalidComputeBudgetInstruction",
     e(lambda sfx: sfx.__setitem__(slice(0, 2), [sfx[LIMIT], sfx[PRICE]])), {}),
    ("j-setup-after-trade", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__setitem__(slice(2, 4), [sfx[ROUTE], sfx[SETUP]])), {}),
    ("j-setup-first", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.insert(0, sfx.pop(SETUP))), {}),
    ("k-setup-for-attacker", "BUY", "InvalidAtaSetup",
     e(lambda sfx: (set_key(sfx[SETUP], 1, enc.ata(J_ATTACKER, route(sfx)["accounts"][4]["pubkey"], TOKEN_2022)),
                    set_key(sfx[SETUP], 2, J_ATTACKER))), {}),
    ("k-setup-for-unrelated-mint", "BUY", "InvalidAtaSetup",
     e(lambda sfx: (set_key(sfx[SETUP], 1, enc.ata(J_TAKER, mint_of("UNHx"), TOKEN_2022)),
                    set_key(sfx[SETUP], 3, mint_of("UNHx")))), {}),
    ("k-setup-plain-create", "BUY", "InvalidAtaSetup",
     e(lambda sfx: sfx[SETUP].__setitem__("dataHex", "00")), {}),
    ("k-setup-empty-data", "BUY", "InvalidAtaSetup",
     e(lambda sfx: sfx[SETUP].__setitem__("dataHex", "")), {}),
    ("k-setup-recover-nested", "SELL", "InvalidAtaSetup",
     e(lambda sfx: sfx[SETUP].__setitem__("dataHex", "02")), {}),
    ("k-setup-payer-not-signer", "BUY", "InvalidAtaSetup",
     e(lambda sfx: set_key(sfx[SETUP], 0, J_ATTACKER, signer=False)), {}),
    ("k-setup-seven-accounts", "BUY", "InvalidAtaSetup",
     e(lambda sfx: sfx[SETUP]["accounts"].append(meta(J_ATTACKER, False, False))), {}),
    ("k-setup-five-accounts", "BUY", "InvalidAtaSetup",
     e(lambda sfx: sfx[SETUP]["accounts"].pop()), {}),
    ("k-setup-foreign-system-program", "BUY", "InvalidAtaSetup",
     e(lambda sfx: set_key(sfx[SETUP], 4, J_ATTACKER)), {}),
    ("k-setup-wrong-token-program", "BUY", "InvalidAtaSetup",
     e(lambda sfx: set_key(sfx[SETUP], 5, jb.LEGACY_TOKEN)), {}),
    ("l-destination-redirected-with-setup", "BUY", "NonCanonicalDestinationAccount",
     e(lambda sfx: (set_key(route(sfx), 2, J_ATTACKER), set_key(sfx[SETUP], 1, J_ATTACKER))), {}),
    ("l-destination-redirected-without-setup", "SELL", "NonCanonicalDestinationAccount",
     e(lambda sfx: (sfx.pop(SETUP), set_key(route(sfx), 2, J_ATTACKER))), {}),
    ("l-destination-is-attackers-canonical-ata", "BUY", "NonCanonicalDestinationAccount",
     e(lambda sfx: (lambda k: (set_key(route(sfx), 2, k), set_key(sfx[SETUP], 1, k)))(
         enc.ata(J_ATTACKER, route(sfx)["accounts"][4]["pubkey"], TOKEN_2022))), {}),
    ("m-source-not-authoritys", "SELL", "NonCanonicalSourceAccount",
     e(lambda sfx: set_key(route(sfx), 1, J_ATTACKER)), {}),
    ("m-source-is-attackers-canonical-ata", "BUY", "NonCanonicalSourceAccount",
     e(lambda sfx: set_key(route(sfx), 1, enc.ata(J_ATTACKER, jb.USDC, jb.LEGACY_TOKEN))), {}),
    ("n-destination-override", "BUY", "DestinationOverrideUnsupported",
     e(lambda sfx: set_key(route(sfx), 7, J_ATTACKER, writable=True)), {}),
    ("n-destination-override-is-the-destination", "SELL", "DestinationOverrideUnsupported",
     e(lambda sfx: set_key(route(sfx), 7, route(sfx)["accounts"][2]["pubkey"])), {}),
    ("o-platform-fee", "BUY", "UnsupportedJupiterFee",
     e(lambda sfx: patch(route(sfx), 26, "<H", 50)), {}),
    ("p-positive-slippage-fee", "SELL", "UnsupportedJupiterFee",
     e(lambda sfx: patch(route(sfx), 28, "<H", 1)), {}),
    ("r-route-bytes-to-another-program", "BUY", "InvalidJupiterProgram",
     e(lambda sfx: route(sfx).__setitem__("programId", J_MEMO)), {}),
    ("r-program-account-not-jupiter", "BUY", "InvalidJupiterProgram",
     e(lambda sfx: set_key(route(sfx), 9, J_ATTACKER)), {}),
    ("s-buy-with-usdt", "BUY", "InvalidCounterMint",
     e(lambda sfx: retarget_source(sfx, J_USDT, jb.LEGACY_TOKEN)), {}),
    ("t-sell-for-usdt", "SELL", "InvalidCounterMint",
     e(lambda sfx: retarget_destination(sfx, J_USDT, jb.LEGACY_TOKEN)), {}),
    ("t-sell-for-another-equity", "SELL", "InvalidCounterMint",
     e(lambda sfx: retarget_destination(sfx, mint_of("UNHx"), TOKEN_2022)), {}),
    ("u-sell-route-under-buy-guard", "SELL", "InvalidJupiterDirection", None,
     {"adapter": jb.ADAPTER_BUY}),
    ("u-buy-route-under-sell-guard", "BUY", "InvalidJupiterDirection", None,
     {"adapter": jb.ADAPTER_SELL}),
    ("v-guard-protects-another-equity", "BUY", "InvalidJupiterDirection", None,
     {"guard_symbol": "UNHx"}),
    ("v-trade-buys-another-equity", "BUY", "InvalidJupiterDirection",
     e(lambda sfx: retarget_destination(sfx, mint_of("UNHx"), TOKEN_2022)), {}),
    ("v-trade-sells-another-equity", "SELL", "InvalidJupiterDirection",
     e(lambda sfx: retarget_source(sfx, mint_of("UNHx"), TOKEN_2022)), {}),
    ("v-buy-pays-with-the-equity", "BUY", "InvalidJupiterDirection",
     e(lambda sfx: retarget_destination(sfx, jb.USDC, jb.LEGACY_TOKEN)), {}),
    ("token-program-usdc-under-token-2022", "BUY", "InvalidTokenProgram",
     e(lambda sfx: retarget_source(sfx, jb.USDC, TOKEN_2022)), {}),
    ("token-program-equity-under-legacy", "BUY", "InvalidTokenProgram",
     e(lambda sfx: retarget_destination(sfx, route(sfx)["accounts"][4]["pubkey"], jb.LEGACY_TOKEN)), {}),
    ("token-program-sell-equity-under-legacy", "SELL", "InvalidTokenProgram",
     e(lambda sfx: retarget_source(sfx, route(sfx)["accounts"][3]["pubkey"], jb.LEGACY_TOKEN)), {}),
    ("authority-not-signer", "BUY", "InvalidJupiterInstruction",
     lambda sfx, ctx: (ctx.__setitem__("fee_payer", J_RELAYER), set_key(sfx[SETUP], 0, J_RELAYER),
                       set_key(route(sfx), 0, J_TAKER, signer=False)), {}),
    ("event-authority-substituted", "BUY", "InvalidJupiterInstruction",
     e(lambda sfx: set_key(route(sfx), 8, J_ATTACKER)), {}),
    ("zero-in-amount", "BUY", "InvalidJupiterInstruction",
     e(lambda sfx: patch(route(sfx), 8, "<Q", 0)), {}),
    ("zero-quoted-out", "SELL", "InvalidJupiterInstruction",
     e(lambda sfx: patch(route(sfx), 16, "<Q", 0)), {}),
    ("slippage-10001", "BUY", "InvalidJupiterInstruction",
     e(lambda sfx: patch(route(sfx), 24, "<H", 10_001)), {}),
    ("empty-route-plan", "BUY", "InvalidJupiterInstruction",
     e(lambda sfx: patch(route(sfx), 30, "<I", 0)), {}),
    ("route-prefix-33-bytes", "BUY", "InvalidJupiterInstruction",
     e(lambda sfx: route(sfx).__setitem__("dataHex", route(sfx)["dataHex"][:66])), {}),
    ("route-nine-accounts", "BUY", "InvalidJupiterInstruction",
     e(lambda sfx: (sfx.pop(SETUP), route(sfx)["accounts"].__delitem__(slice(9, None)))), {}),
    ("empty-suffix", "BUY", "UnsupportedTransactionGrammar", e(lambda sfx: sfx.clear()), {}),
    ("trade-alone", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__delitem__(slice(0, ROUTE))), {}),
    ("budget-without-trade", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.__delitem__(slice(SETUP, None))), {}),
    ("setup-and-trade-without-limit", "BUY", "UnsupportedTransactionGrammar",
     e(lambda sfx: sfx.pop(LIMIT)), {}),
    ("guard-at-index-1", "BUY", "GuardNotFirst", None, {"guard_index": 1}),
    ("guard-before-trade", "SELL", "GuardNotFirst", None, {"guard_index": ROUTE}),
    ("guard-last", "BUY", "GuardNotFirst", None, {"guard_index": 4}),
]
for _discriminator in OTHER_ENTRYPOINTS:
    MALICIOUS.append((f"q-entrypoint-{_discriminator}", "BUY", "InvalidJupiterInstruction",
                      e(lambda sfx, d=_discriminator: route(sfx).__setitem__(
                          "dataHex", d + route(sfx)["dataHex"][16:])), {}))

for _vid, _direction, _error, _edit, _kwargs in MALICIOUS:
    j_vector(f"jupiter-malicious-{_vid}", "jupiter-malicious",
             f"{_vid.replace('-', ' ')}; the commitment is recomputed over the mutated "
             "transaction, so only semantic validation can reject it",
             direction=_direction, edit=_edit, expected=err(_error), **_kwargs)


def _retarget_user(sfx):
    r = route(sfx)
    source = enc.ata(J_OTHER_USER, r["accounts"][3]["pubkey"], r["accounts"][5]["pubkey"])
    destination = enc.ata(J_OTHER_USER, r["accounts"][4]["pubkey"], r["accounts"][6]["pubkey"])
    for account in r["accounts"]:
        if account["pubkey"] == J_TAKER:
            account["pubkey"] = J_OTHER_USER
    set_key(r, 1, source)
    set_key(r, 2, destination)
    set_key(sfx[SETUP], 1, destination)
    set_key(sfx[SETUP], 2, J_OTHER_USER)


def _flip_writable(sfx):
    account = route(sfx)["accounts"][15]
    account["isWritable"] = not account["isWritable"]


POST_COMMITMENT = [
    ("amount", e(lambda sfx: patch(route(sfx), 8, "<Q",
                                   struct.unpack_from("<Q", bytes.fromhex(route(sfx)["dataHex"]), 8)[0] + 1))),
    ("quoted-output", e(lambda sfx: patch(route(sfx), 16, "<Q", 1))),
    ("slippage", e(lambda sfx: patch(route(sfx), 24, "<H", 51))),
    ("route-plan-byte", e(lambda sfx: route(sfx).__setitem__(
        "dataHex", route(sfx)["dataHex"][:-2] + f"{int(route(sfx)['dataHex'][-2:], 16) ^ 1:02x}"))),
    ("venue-account", e(lambda sfx: set_key(route(sfx), 15, J_ATTACKER))),
    ("venue-account-flag", e(_flip_writable)),
    ("compute-unit-price", e(lambda sfx: sfx.__setitem__(PRICE, enc.set_compute_unit_price(999_999)))),
    ("compute-unit-limit", e(lambda sfx: sfx.__setitem__(LIMIT, enc.set_compute_unit_limit(1_400_000)))),
    ("setup-payer", e(lambda sfx: set_key(sfx[SETUP], 0, J_RELAYER))),
    ("setup-removed", e(lambda sfx: sfx.pop(SETUP))),
    ("authority-source-and-destination", e(_retarget_user)),
]
for _direction in ("BUY", "SELL"):
    for _label, _edit in POST_COMMITMENT:
        j_vector(f"jupiter-post-commitment-{_direction.lower()}-{_label}", "jupiter-post-commitment",
                 f"{_direction}: {_label.replace('-', ' ')} changed after the commitment was fixed; "
                 "still grammatical, so only identity binding catches it",
                 symbol="UNHx", direction=_direction, edit=_edit, commitment="honest",
                 expected=err("DownstreamCommitmentMismatch"))

j_vector("jupiter-post-commitment-zero-digest", "jupiter-post-commitment",
         "a valid transaction whose guard commits to nothing",
         commitment="zero", expected=err("DownstreamCommitmentMismatch"))

# A valid kind 2 transaction relabelled kind 1: kind 1 reads only the next
# instruction, which is ComputeBudget.
j_vector("jupiter-relabelled-kind-1", "jupiter-kind-one",
         "a guarded Jupiter trade under adapter kind 1 is not a TransferChecked",
         adapter=ADAPTER_TRANSFER_CHECKED, expected=err("UnsupportedDownstreamProgram"))


def _route_first(sfx):
    del sfx[:ROUTE]


j_vector("jupiter-kind-1-over-route-v2", "jupiter-kind-one",
         "kind 1 followed directly by route_v2 still requires Token-2022",
         edit=e(_route_first), adapter=ADAPTER_TRANSFER_CHECKED,
         expected=err("UnsupportedDownstreamProgram"))

# ------------------------------------------------------------------ emit

ids = [v["id"] for v in VECTORS]
assert len(ids) == len(set(ids)), "duplicate vector ids"

document = {
    "description": (
        "Shared guard conformance vectors. Each vector is a complete guard invocation: the ABI "
        "v2 instruction bytes, the accounts the program receives (with the mint's owner and raw "
        "data), the chain Clock, the surrounding top-level instructions as the Instructions "
        "sysvar exposes them, and the single authored expected result. Both the Rust program "
        "and the TypeScript client are evaluated against it; neither derives the expectation."
    ),
    "formatVersion": 1,
    "seed": f"0x{SEED:x}",
    "clientRules": {
        "same": "the client must produce exactly this result",
        "client-stricter": (
            "the client decoder enforces a rule the program does not; it may reject where the "
            "program accepts, but must never accept where the program rejects"
        ),
    },
    "programId": PROGRAM_ID,
    "token2022ProgramId": TOKEN_2022,
    "instructionsSysvar": SYSVAR_INSTRUCTIONS,
    "commitmentDomain": DOMAIN.decode(),
    "jupiterSuffixCommitmentDomain": "EQUITYGUARD_JUPITER_SUFFIX_V1",
    "vectorCount": len(VECTORS),
    "vectors": VECTORS,
}

OUT.write_text(json.dumps(document, indent=1) + "\n")
print(f"{len(VECTORS)} vectors -> {OUT}")
by_group: dict[str, int] = {}
for v in VECTORS:
    by_group[v["group"]] = by_group.get(v["group"], 0) + 1
for group, count in sorted(by_group.items()):
    print(f"  {group:12} {count}")
