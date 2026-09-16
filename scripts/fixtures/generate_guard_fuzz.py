#!/usr/bin/env python3
"""Generates the shared decoder fuzz corpus.

Like the conformance corpus, this is a third independent encoding of the
rules: every expectation is decided here, in Python, from the specification,
and both the Rust program and the TypeScript client are measured against it.

Three sections, each exactly specifiable without a Solana dependency:

* multipliers   -- f64 bit patterns and whether they are a valid stored
                   multiplier (positive AND normal).
* abiPayloads   -- ABI v2 instruction bytes and the decode outcome.
* commitments   -- downstream commitment preimages, their SHA-256, and a
                   systematic single-field mutation matrix.

* tlvCases      -- Token-2022 mint layouts under constructive mutation, each
                   authored as accept or reject. Only mutations whose effect
                   follows from the layout are generated: restating the whole
                   of Token-2022's unpack in Python would be guesswork, so an
                   unpredictable mutation is not emitted at all rather than
                   guessed at. Accepted cases also carry the protected fields
                   the decoder must read, which pins the offsets.

    python3 scripts/fixtures/generate_guard_fuzz.py

Deterministic: the corpus is committed, so regeneration is only needed when
the rules change.
"""

import hashlib
import json
import random
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "programs/equity_guard/tests/fixtures/guard_fuzz_v1.json"
SEED = 0x9C_F022
rng = random.Random(SEED)

# --------------------------------------------------------------- base58

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


TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
MINT_X = b58(bytes([0xA1] * 32))
SOURCE = b58(bytes([0xB1] * 32))
DESTINATION = b58(bytes([0xB2] * 32))
AUTHORITY = b58(bytes([0xB3] * 32))

# ------------------------------------------------- 1. f64 bit patterns

#: 2^-1022, the smallest positive normal double.
MIN_POSITIVE_NORMAL = 0x0010_0000_0000_0000
MAX_FINITE = 0x7FEF_FFFF_FFFF_FFFF
EXPONENT_MASK = 0x7FF0_0000_0000_0000
MANTISSA_MASK = 0x000F_FFFF_FFFF_FFFF
SIGN_MASK = 0x8000_0000_0000_0000


def classify(bits: int) -> tuple[str, bool]:
    """(class, valid) for a stored multiplier, straight from IEEE-754.

    Valid means positive AND normal: the program refuses zero, negative
    zero, negatives, subnormals, both infinities and every NaN payload,
    because none of them describes a usable economic state.
    """
    sign = bool(bits & SIGN_MASK)
    exponent = (bits & EXPONENT_MASK) >> 52
    mantissa = bits & MANTISSA_MASK
    if exponent == 0x7FF:
        kind = "nan" if mantissa else "infinity"
    elif exponent == 0:
        kind = "zero" if mantissa == 0 else "subnormal"
    else:
        kind = "normal"
    if sign:
        kind = f"negative-{kind}" if kind != "zero" else "negative-zero"
    return kind, kind == "normal"


MULTIPLIER_CASES: list[dict] = []
_seen_bits: set[int] = set()


def multiplier_case(bits: int, label: str) -> None:
    if bits in _seen_bits:
        return
    _seen_bits.add(bits)
    kind, valid = classify(bits)
    MULTIPLIER_CASES.append({
        "label": label,
        "bytesHex": struct.pack("<Q", bits).hex(),
        "class": kind,
        "valid": valid,
    })


_NAMED = {
    "positive-zero": 0x0000_0000_0000_0000,
    "negative-zero": SIGN_MASK,
    "smallest-positive-subnormal": 0x0000_0000_0000_0001,
    "largest-positive-subnormal": MANTISSA_MASK,
    "smallest-negative-subnormal": SIGN_MASK | 1,
    "smallest-positive-normal": MIN_POSITIVE_NORMAL,
    "just-below-smallest-normal": MIN_POSITIVE_NORMAL - 1,
    "one": struct.unpack("<Q", struct.pack("<d", 1.0))[0],
    "one-ulp-above-one": struct.unpack("<Q", struct.pack("<d", 1.0))[0] + 1,
    "one-ulp-below-one": struct.unpack("<Q", struct.pack("<d", 1.0))[0] - 1,
    "negative-one": struct.unpack("<Q", struct.pack("<d", -1.0))[0],
    "max-finite": MAX_FINITE,
    "negative-max-finite": SIGN_MASK | MAX_FINITE,
    "positive-infinity": EXPONENT_MASK,
    "negative-infinity": SIGN_MASK | EXPONENT_MASK,
    "quiet-nan": EXPONENT_MASK | (1 << 51),
    "signalling-nan": EXPONENT_MASK | 1,
    "negative-quiet-nan": SIGN_MASK | EXPONENT_MASK | (1 << 51),
    "nan-max-payload": EXPONENT_MASK | MANTISSA_MASK,
    "kox-multiplier": struct.unpack("<Q", struct.pack("<d", 1.0183317967386898))[0],
    "tiny-positive-normal": struct.unpack("<Q", struct.pack("<d", 1e-300))[0],
    "huge-positive-normal": struct.unpack("<Q", struct.pack("<d", 1e300))[0],
}
for _label, _bits in _NAMED.items():
    multiplier_case(_bits, _label)

# Random bit patterns, plus patterns biased toward the boundaries where the
# valid/invalid decision actually changes.
for _i in range(400):
    multiplier_case(rng.getrandbits(64), f"random-{_i:03d}")
for _i in range(60):
    base = rng.choice([0, MIN_POSITIVE_NORMAL, EXPONENT_MASK, MAX_FINITE, MANTISSA_MASK])
    multiplier_case((base + rng.randint(-2, 2)) & 0xFFFF_FFFF_FFFF_FFFF, f"near-boundary-{_i:03d}")

# ------------------------------------------------- 2. ABI v2 payloads

ABI_LEN = 99
VERSION_V2 = 2
ADAPTER_TRANSFER_CHECKED = 1


def decode_expectation(data: bytes) -> str:
    """The documented ABI v2 decode outcome, in the program's own order."""
    if len(data) == 0:
        return "UnsupportedInstruction"
    if data[0] != VERSION_V2:
        return "UnsupportedVersion"
    if len(data) != ABI_LEN:
        return "InvalidInstructionLength"
    multiplier = struct.unpack("<Q", data[33:41])[0]
    new_multiplier = struct.unpack("<Q", data[41:49])[0]
    if not classify(multiplier)[1] or not classify(new_multiplier)[1]:
        return "InvalidExpectedState"
    if data[57] not in (0, 1):
        return "InvalidExpectedState"
    if data[66] != ADAPTER_TRANSFER_CHECKED:
        return "UnsupportedAdapter"
    return "ok"


ONE = struct.pack("<d", 1.0)
VALID_PAYLOAD = (bytes([VERSION_V2]) + unb58(MINT_X) + ONE + ONE + struct.pack("<q", 0)
                 + bytes([1]) + struct.pack("<II", 900, 300) + bytes([ADAPTER_TRANSFER_CHECKED])
                 + bytes([0x5C] * 32))
assert len(VALID_PAYLOAD) == ABI_LEN
assert decode_expectation(VALID_PAYLOAD) == "ok"

ABI_CASES: list[dict] = []
_seen_payloads: set[bytes] = set()


def abi_case(data: bytes, label: str) -> None:
    if data in _seen_payloads:
        return
    _seen_payloads.add(data)
    ABI_CASES.append({"label": label, "dataHex": data.hex(), "expected": decode_expectation(data)})


# Every length from 0 to a little past the fixed size.
for _length in range(0, 110):
    abi_case(VALID_PAYLOAD[:_length] if _length <= ABI_LEN
             else VALID_PAYLOAD + bytes(_length - ABI_LEN), f"length-{_length}")
# Every version byte, otherwise a valid payload.
for _version in range(256):
    abi_case(bytes([_version]) + VALID_PAYLOAD[1:], f"version-{_version}")
# Every phase and adapter byte.
for _phase in range(256):
    abi_case(VALID_PAYLOAD[:57] + bytes([_phase]) + VALID_PAYLOAD[58:], f"phase-{_phase}")
for _adapter in range(256):
    abi_case(VALID_PAYLOAD[:66] + bytes([_adapter]) + VALID_PAYLOAD[67:], f"adapter-{_adapter}")
# Multiplier fields driven by the f64 corpus, in both slots.
for _case in MULTIPLIER_CASES[:120]:
    _bytes = bytes.fromhex(_case["bytesHex"])
    abi_case(VALID_PAYLOAD[:33] + _bytes + VALID_PAYLOAD[41:], f"multiplier-{_case['label']}")
    abi_case(VALID_PAYLOAD[:41] + _bytes + VALID_PAYLOAD[49:], f"new-multiplier-{_case['label']}")
# Random timestamps, windows and mints: none of these can change the outcome.
for _i in range(60):
    payload = bytearray(VALID_PAYLOAD)
    payload[1:33] = rng.randbytes(32)
    payload[49:57] = rng.randbytes(8)
    payload[58:66] = rng.randbytes(8)
    payload[67:99] = rng.randbytes(32)
    abi_case(bytes(payload), f"random-fields-{_i:03d}")
# Fully random bytes at random lengths: the decoder must classify, not crash.
for _i in range(300):
    length = rng.choice([0, 1, 2, 33, 34, 66, 98, 99, 100, 128, 255, rng.randint(0, 400)])
    data = bytearray(rng.randbytes(length))
    if length > 0 and rng.random() < 0.6:
        data[0] = VERSION_V2  # steer past the version gate often enough to reach the fields
    abi_case(bytes(data), f"random-bytes-{_i:03d}")

# --------------------------------------------- 3. downstream commitment

DOMAIN = b"EQUITYGUARD_DOWNSTREAM_V2"
TRANSFER_CHECKED_TAG = 12


def meta(pubkey: str, is_signer: bool, is_writable: bool) -> dict:
    return {"pubkey": pubkey, "isSigner": is_signer, "isWritable": is_writable}


def preimage(instruction: dict) -> bytes:
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
    return bytes(encoded)


def commitment(instruction: dict) -> str:
    return hashlib.sha256(preimage(instruction)).hexdigest()


BASE = {
    "programId": TOKEN_2022,
    "accounts": [meta(SOURCE, False, True), meta(MINT_X, False, False),
                 meta(DESTINATION, False, True), meta(AUTHORITY, True, True)],
    "dataHex": struct.pack("<BQB", TRANSFER_CHECKED_TAG, 5_990_000, 6).hex(),
}

COMMITMENT_CASES: list[dict] = []
MUTATIONS: list[dict] = []


def commitment_case(instruction: dict, label: str) -> None:
    COMMITMENT_CASES.append({
        "label": label,
        "instruction": instruction,
        "preimageHex": preimage(instruction).hex(),
        "commitmentHex": commitment(instruction),
    })


def mutation(label: str, field: str, instruction: dict) -> None:
    MUTATIONS.append({
        "label": label,
        "field": field,
        "instruction": instruction,
        "preimageHex": preimage(instruction).hex(),
        "commitmentHex": commitment(instruction),
    })


commitment_case(BASE, "base-transfer-checked")
mutation("base", "none", BASE)


def replace_account(index: int, new: dict) -> dict:
    accounts = [dict(a) for a in BASE["accounts"]]
    accounts[index] = new
    return {**BASE, "accounts": accounts}


mutation("program-id", "programId", {**BASE, "programId": b58(bytes([0xEE] * 32))})
for _i, _account in enumerate(BASE["accounts"]):
    mutation(f"account-{_i}-pubkey", "accounts.pubkey",
             replace_account(_i, meta(b58(bytes([0xD0 + _i] * 32)), _account["isSigner"], _account["isWritable"])))
    mutation(f"account-{_i}-signer", "accounts.isSigner",
             replace_account(_i, meta(_account["pubkey"], not _account["isSigner"], _account["isWritable"])))
    mutation(f"account-{_i}-writable", "accounts.isWritable",
             replace_account(_i, meta(_account["pubkey"], _account["isSigner"], not _account["isWritable"])))
mutation("account-count-fewer", "accounts.length", {**BASE, "accounts": BASE["accounts"][:3]})
mutation("account-count-more", "accounts.length",
         {**BASE, "accounts": [*BASE["accounts"], meta(b58(bytes([0xCC] * 32)), False, False)]})
mutation("account-count-zero", "accounts.length", {**BASE, "accounts": []})
mutation("account-order-swap-01", "accounts.order",
         {**BASE, "accounts": [BASE["accounts"][1], BASE["accounts"][0], *BASE["accounts"][2:]]})
mutation("account-order-swap-23", "accounts.order",
         {**BASE, "accounts": [*BASE["accounts"][:2], BASE["accounts"][3], BASE["accounts"][2]]})
mutation("account-order-reverse", "accounts.order", {**BASE, "accounts": list(reversed(BASE["accounts"]))})
mutation("amount-plus-one", "data.amount",
         {**BASE, "dataHex": struct.pack("<BQB", TRANSFER_CHECKED_TAG, 5_990_001, 6).hex()})
mutation("amount-zero", "data.amount",
         {**BASE, "dataHex": struct.pack("<BQB", TRANSFER_CHECKED_TAG, 0, 6).hex()})
mutation("amount-u64-max", "data.amount",
         {**BASE, "dataHex": struct.pack("<BQB", TRANSFER_CHECKED_TAG, 2**64 - 1, 6).hex()})
mutation("decimals", "data.decimals",
         {**BASE, "dataHex": struct.pack("<BQB", TRANSFER_CHECKED_TAG, 5_990_000, 9).hex()})
mutation("instruction-tag", "data.tag",
         {**BASE, "dataHex": struct.pack("<BQB", 3, 5_990_000, 6).hex()})
mutation("data-empty", "data.length", {**BASE, "dataHex": ""})
mutation("data-trailing-zero", "data.length", {**BASE, "dataHex": BASE["dataHex"] + "00"})
mutation("data-truncated", "data.length", {**BASE, "dataHex": BASE["dataHex"][:-2]})

# A length-field confusion check: the account count and the data length are
# both u32 LE, so an encoding without them could let bytes migrate between
# fields. These two instructions differ only in where the bytes sit.
mutation("ambiguity-empty-data-extra-account", "framing",
         {**BASE, "accounts": [*BASE["accounts"], meta(b58(bytes(32)), False, False)], "dataHex": ""})
mutation("ambiguity-no-accounts-long-data", "framing",
         {**BASE, "accounts": [], "dataHex": (bytes(32) + bytes([0, 0]) + bytes.fromhex(BASE["dataHex"])).hex()})

# Random instructions, for accidental collisions across the whole corpus.
for _i in range(300):
    accounts = [meta(b58(rng.randbytes(32)), rng.random() < 0.3, rng.random() < 0.5)
                for _ in range(rng.randint(0, 6))]
    data = rng.randbytes(rng.randint(0, 40))
    commitment_case({"programId": b58(rng.randbytes(32)), "accounts": accounts, "dataHex": data.hex()},
                    f"random-{_i:03d}")


# -------------------------------------------- 4. Token-2022 TLV layouts

BASE_MINT_LEN = 82
ACCOUNT_TYPE_OFFSET = 165
TLV_START = ACCOUNT_TYPE_OFFSET + 1
SCALED_UI_LEN = 56
EXT_SCALED_UI_AMOUNT = 25
EXT_PAUSABLE = 26
#: Highest extension type spl-token-2022-interface 3.1.1 knows.
MAX_KNOWN_EXTENSION = 28
DECIMALS = 6

#: Offsets of the protected fields inside the ScaledUiAmount value.
VALUE_MULTIPLIER = 32
VALUE_EFFECTIVE = 40
VALUE_NEW_MULTIPLIER = 48


def tlv(kind: int, value: bytes) -> bytes:
    return struct.pack("<HH", kind, len(value)) + value


def scaled_ui_value(multiplier: bytes, effective: int, new_multiplier: bytes) -> bytes:
    return bytes([0x77] * 32) + multiplier + struct.pack("<q", effective) + new_multiplier


def base_mint_bytes() -> bytearray:
    data = bytearray(BASE_MINT_LEN)
    struct.pack_into("<I", data, 0, 1)
    data[4:36] = bytes([0x55] * 32)
    struct.pack_into("<Q", data, 36, 1_000_000_000)
    data[44] = DECIMALS
    data[45] = 1
    struct.pack_into("<I", data, 46, 0)
    return data


def mint_with(extensions: bytes) -> bytes:
    data = base_mint_bytes()
    data.extend(bytes(ACCOUNT_TYPE_OFFSET - BASE_MINT_LEN))
    data.append(1)
    data.extend(extensions)
    return bytes(data)


TLV_BASE = mint_with(tlv(EXT_SCALED_UI_AMOUNT, scaled_ui_value(ONE, 0, ONE)))
#: Offset of the ScaledUiAmount value when it is the first extension entry.
SCALED_VALUE_AT = TLV_START + 4


def scaled_ui_value_offset(data: bytes) -> int | None:
    """Walks the TLV area for the ScaledUiAmount value, as the decoder does."""
    offset = TLV_START
    while len(data) - offset >= 4:
        kind, length = struct.unpack("<HH", data[offset:offset + 4])
        if kind == 0:
            return None
        if kind == EXT_SCALED_UI_AMOUNT:
            return offset + 4
        offset += 4 + length
    return None

TLV_CASES: list[dict] = []
_seen_tlv: set[bytes] = set()


def tlv_case(label: str, data: bytes, accept: bool, reason: str) -> None:
    if data in _seen_tlv:
        return  # e.g. a "mutation" that reproduces the pristine bytes
    _seen_tlv.add(data)
    entry = {"label": label, "dataHex": data.hex(), "accept": accept, "reason": reason}
    if accept:
        value = scaled_ui_value_offset(data)
        assert value is not None, f"{label} is marked accept but has no ScaledUiAmount entry"
        entry["protected"] = {
            "multiplierHex": data[value + VALUE_MULTIPLIER:value + VALUE_MULTIPLIER + 8].hex(),
            "newMultiplierHex": data[value + VALUE_NEW_MULTIPLIER:value + VALUE_NEW_MULTIPLIER + 8].hex(),
            "effectiveTimestamp": str(struct.unpack("<q", data[value + VALUE_EFFECTIVE:value + VALUE_EFFECTIVE + 8])[0]),
        }
    TLV_CASES.append(entry)


def patched(offset: int, new: bytes, data: bytes = TLV_BASE) -> bytes:
    out = bytearray(data)
    out[offset:offset + len(new)] = new
    return bytes(out)


tlv_case("pristine", TLV_BASE, True, "a well-formed ScaledUiAmount mint")

# Fields outside the protected set: the decoder must ignore them.
tlv_case("mint-authority-changed", patched(4, bytes([0x66] * 32)), True,
         "the mint authority is not a protected field")
tlv_case("supply-changed", patched(36, struct.pack("<Q", 2**64 - 1)), True,
         "supply is not a protected field")
tlv_case("decimals-changed", patched(44, bytes([9])), True,
         "decimals are read separately and are not part of the guard's state")
tlv_case("freeze-authority-set", patched(46, struct.pack("<I", 1) + bytes([0x44] * 32)), True,
         "a freeze authority does not change the protected state")
tlv_case("scaled-ui-authority-changed", patched(SCALED_VALUE_AT, bytes([0x99] * 32)), True,
         "the ScaledUiAmount authority is deliberately excluded from the protected fields")
tlv_case("trailing-zero-bytes", TLV_BASE + bytes(64), True,
         "a zero extension type ends the TLV area")
tlv_case("pausable-appended", mint_with(tlv(EXT_SCALED_UI_AMOUNT, scaled_ui_value(ONE, 0, ONE))
                                        + tlv(EXT_PAUSABLE, bytes([0x78] * 32) + bytes([0]))), True,
         "Pausable alongside ScaledUiAmount is a permitted combination")
tlv_case("pausable-first", mint_with(tlv(EXT_PAUSABLE, bytes([0x78] * 32) + bytes([0]))
                                     + tlv(EXT_SCALED_UI_AMOUNT, scaled_ui_value(ONE, 0, ONE))), True,
         "extension order does not matter as long as each type appears once")

# Protected fields: accepted, but the decoder must report exactly these bytes.
for _label, _bits in (("kox", struct.unpack("<Q", struct.pack("<d", 1.0183317967386898))[0]),
                      ("max-finite", MAX_FINITE),
                      ("min-positive-normal", MIN_POSITIVE_NORMAL),
                      ("one-ulp-above-one", struct.unpack("<Q", ONE)[0] + 1)):
    tlv_case(f"multiplier-{_label}", patched(SCALED_VALUE_AT + VALUE_MULTIPLIER, struct.pack("<Q", _bits)),
             True, "a positive normal multiplier is read back byte for byte")
for _ts in (0, 1, -1, 2**31, -(2**31), 2**63 - 1, -(2**63)):
    tlv_case(f"effective-timestamp-{_ts}",
             patched(SCALED_VALUE_AT + VALUE_EFFECTIVE, struct.pack("<q", _ts)), True,
             "any i64 activation time is representable")

# Invalid multipliers in the stored state.
for _case in MULTIPLIER_CASES:
    if _case["valid"]:
        continue
    _bad = bytes.fromhex(_case["bytesHex"])
    tlv_case(f"stored-multiplier-{_case['label']}",
             patched(SCALED_VALUE_AT + VALUE_MULTIPLIER, _bad), False,
             f"a stored multiplier that is {_case['class']} is not a usable economic state")
    if len(TLV_CASES) > 220:
        break

# Structural corruption, each following directly from the layout.
tlv_case("uninitialized", patched(45, bytes([0])), False, "is_initialized is 0")
tlv_case("mint-authority-tag-invalid", patched(0, struct.pack("<I", 2)), False,
         "a COption tag other than 0 or 1")
tlv_case("freeze-authority-tag-invalid", patched(46, struct.pack("<I", 0xFFFFFFFF)), False,
         "a COption tag other than 0 or 1")
tlv_case("dirty-padding", patched(BASE_MINT_LEN, bytes([0xFF] * (ACCOUNT_TYPE_OFFSET - BASE_MINT_LEN))),
         False, "the reserved region before the account type must be zero")
for _account_type in (0, 2, 3, 255):
    tlv_case(f"account-type-{_account_type}", patched(ACCOUNT_TYPE_OFFSET, bytes([_account_type])),
             False, "the account type byte must say Mint")
tlv_case("tlv-length-overrun", patched(TLV_START + 2, struct.pack("<H", 0xFFFF)), False,
         "the declared length runs past the account")
tlv_case("tlv-length-one-short", patched(TLV_START + 2, struct.pack("<H", SCALED_UI_LEN - 1)), False,
         "the ScaledUiAmount value has a fixed size")
tlv_case("tlv-length-one-long", patched(TLV_START + 2, struct.pack("<H", SCALED_UI_LEN + 1)), False,
         "the declared length runs past the account")
tlv_case("tlv-length-zero", patched(TLV_START + 2, struct.pack("<H", 0)), False,
         "a zero-length ScaledUiAmount value")
for _unknown in (MAX_KNOWN_EXTENSION + 1, 100, 0xFFFF):
    tlv_case(f"tlv-unknown-type-{_unknown}", patched(TLV_START, struct.pack("<H", _unknown)), False,
             "an extension type the decoder does not know cannot be validated")
tlv_case("tlv-duplicate-scaled-ui",
         TLV_BASE + tlv(EXT_SCALED_UI_AMOUNT, scaled_ui_value(struct.pack("<d", 9.0), 0,
                                                              struct.pack("<d", 9.0))), False,
         "a repeated type is ambiguous: lookups read the first entry")
tlv_case("tlv-trailing-garbage", TLV_BASE + bytes([0xFF] * 8), False,
         "trailing non-zero bytes parse as an unknown extension")
tlv_case("no-scaled-ui", mint_with(tlv(EXT_PAUSABLE, bytes([0x78] * 32) + bytes([0]))), False,
         "no ScaledUiAmount extension to protect")
tlv_case("base-mint-only", bytes(base_mint_bytes()), False, "no extensions at all")

# Truncation at every boundary that matters, plus a seeded sample in between.
_truncations = {0, 1, BASE_MINT_LEN - 1, BASE_MINT_LEN, 120, ACCOUNT_TYPE_OFFSET, TLV_START,
                TLV_START + 1, TLV_START + 3, TLV_START + 4, len(TLV_BASE) - 1}
_truncations |= {rng.randrange(0, len(TLV_BASE)) for _ in range(40)}
for _length in sorted(_truncations):
    if _length == TLV_START:
        tlv_case(f"truncated-{_length}", TLV_BASE[:_length], False,
                 "a mint whose extension area is empty has no ScaledUiAmount")
    else:
        tlv_case(f"truncated-{_length}", TLV_BASE[:_length], False,
                 "a truncated account cannot be validated")

# Seeded single-byte flips inside the TLV header, where every outcome is a
# rejection: the type becomes unknown or duplicated, or the length stops
# matching the fixed ScaledUiAmount size.
for _i in range(40):
    offset = TLV_START + rng.randrange(0, 4)
    original = TLV_BASE[offset]
    flipped = original ^ (1 << rng.randrange(0, 8))
    candidate = patched(offset, bytes([flipped]))
    kind = struct.unpack("<H", candidate[TLV_START:TLV_START + 2])[0]
    length = struct.unpack("<H", candidate[TLV_START + 2:TLV_START + 4])[0]
    if kind == EXT_SCALED_UI_AMOUNT and length == SCALED_UI_LEN:
        continue  # the flip cancelled out; nothing to assert
    tlv_case(f"tlv-header-flip-{_i:03d}", candidate, False,
             f"TLV header flipped to type {kind} length {length}")

assert len({c["dataHex"] for c in TLV_CASES}) == len(TLV_CASES), "duplicate TLV case"
assert any(c["accept"] for c in TLV_CASES) and any(not c["accept"] for c in TLV_CASES)

# ------------------------------------------------------------------ emit

assert len({m["commitmentHex"] for m in MUTATIONS}) == len(MUTATIONS), \
    "two single-field mutations collide: the commitment encoding is not canonical"
# Across both sections, equal commitments must mean equal preimages. The base
# instruction deliberately appears in each, so this is keyed on the preimage.
_by_commitment: dict[str, str] = {}
for _entry in [*COMMITMENT_CASES, *MUTATIONS]:
    _previous = _by_commitment.setdefault(_entry["commitmentHex"], _entry["preimageHex"])
    assert _previous == _entry["preimageHex"], \
        f"commitment collision between distinct preimages at {_entry['label']}"

_outcomes = {c["expected"] for c in ABI_CASES}
for _required in ("ok", "UnsupportedInstruction", "UnsupportedVersion", "InvalidInstructionLength",
                  "InvalidExpectedState", "UnsupportedAdapter"):
    assert _required in _outcomes, f"ABI corpus never produces {_required}"
assert any(c["valid"] for c in MULTIPLIER_CASES) and any(not c["valid"] for c in MULTIPLIER_CASES)

document = {
    "description": (
        "Shared decoder fuzz corpus. Multiplier validity, ABI v2 decode outcomes and downstream "
        "commitments are decided here from the specification; the Rust program and the "
        "TypeScript client are both measured against these values and never against each other."
    ),
    "formatVersion": 1,
    "seed": f"0x{SEED:x}",
    "commitmentDomain": DOMAIN.decode(),
    "counts": {
        "multipliers": len(MULTIPLIER_CASES),
        "abiPayloads": len(ABI_CASES),
        "commitments": len(COMMITMENT_CASES),
        "commitmentMutations": len(MUTATIONS),
        "tlvCases": len(TLV_CASES),
    },
    "multipliers": MULTIPLIER_CASES,
    "abiPayloads": ABI_CASES,
    "commitments": COMMITMENT_CASES,
    "commitmentMutations": MUTATIONS,
    "tlvCases": TLV_CASES,
}

OUT.write_text(json.dumps(document, indent=1) + "\n")
print(f"-> {OUT}")
for name, count in document["counts"].items():
    print(f"  {name:22} {count}")
