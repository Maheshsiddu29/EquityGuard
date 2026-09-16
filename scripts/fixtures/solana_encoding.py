"""Specification-level Solana encodings shared by the fixture generators.

Everything here is written from public definitions, independently of the Rust
program and the TypeScript client, so fixtures built with it are a third
implementation of the same rules:

- base58 addresses;
- program-derived addresses (SHA-256 of seeds, bump, program id and the
  "ProgramDerivedAddress" marker, rejected when the hash is an ed25519 curve
  point), with the curve check done from the curve equation;
- the transaction-level account flags the Instructions sysvar exposes;
- the EquityGuard downstream commitments for adapter kind 1
  (EQUITYGUARD_DOWNSTREAM_V2) and kinds 2/3 (EQUITYGUARD_JUPITER_SUFFIX_V1).
"""

import hashlib
import struct

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


# ------------------------------------------------- program-derived addresses

_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def is_on_curve(point: bytes) -> bool:
    """Whether 32 bytes decompress to an ed25519 point.

    Mirrors the decompression Solana uses: y is read little-endian with the
    sign bit cleared and taken mod p, and the point exists iff
    (y^2 - 1) / (d y^2 + 1) is a square (zero included). d is a non-square,
    so the denominator never vanishes.
    """
    y = (int.from_bytes(point, "little") & ((1 << 255) - 1)) % _P
    u = (y * y - 1) % _P
    v = (_D * y * y + 1) % _P
    x2 = u * pow(v, _P - 2, _P) % _P
    return x2 == 0 or pow(x2, (_P - 1) // 2, _P) == 1


def create_program_address(seeds: list[bytes], program_id: str) -> str | None:
    digest = hashlib.sha256(b"".join(seeds) + unb58(program_id) + b"ProgramDerivedAddress").digest()
    return None if is_on_curve(digest) else b58(digest)


def find_program_address(seeds: list[bytes], program_id: str) -> tuple[str, int]:
    for bump in range(255, -1, -1):
        found = create_program_address([*seeds, bytes([bump])], program_id)
        if found is not None:
            return found, bump
    raise ValueError("no viable bump")


ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"


def ata(owner: str, mint: str, token_program: str) -> str:
    return find_program_address([unb58(owner), unb58(token_program), unb58(mint)],
                                ASSOCIATED_TOKEN_PROGRAM)[0]


# ------------------------------------------------- instructions sysvar view

def meta(pubkey: str, is_signer: bool, is_writable: bool) -> dict:
    return {"pubkey": pubkey, "isSigner": is_signer, "isWritable": is_writable}


def sysvar_view(instructions: list[dict], fee_payer: str) -> list[dict]:
    """The instructions with the flags the runtime compiles for them: each
    account's signer/writable bits OR-ed across the whole transaction, and the
    fee payer a writable signer. (No account in these fixtures is an invoked
    program or reserved account written as writable, so no demotion applies.)
    """
    signer = {fee_payer}
    writable = {fee_payer}
    for instruction in instructions:
        for account in instruction["accounts"]:
            if account["isSigner"]:
                signer.add(account["pubkey"])
            if account["isWritable"]:
                writable.add(account["pubkey"])
    return [
        {
            "programId": i["programId"],
            "accounts": [meta(a["pubkey"], a["pubkey"] in signer, a["pubkey"] in writable)
                         for a in i["accounts"]],
            "dataHex": i["dataHex"],
        }
        for i in instructions
    ]


# ------------------------------------------------------------ commitments

DOWNSTREAM_DOMAIN = b"EQUITYGUARD_DOWNSTREAM_V2"
JUPITER_SUFFIX_DOMAIN = b"EQUITYGUARD_JUPITER_SUFFIX_V1"


def encode_instruction(instruction: dict) -> bytes:
    out = bytearray(unb58(instruction["programId"]))
    out += struct.pack("<I", len(instruction["accounts"]))
    for account in instruction["accounts"]:
        out += unb58(account["pubkey"])
        out.append(1 if account["isSigner"] else 0)
        out.append(1 if account["isWritable"] else 0)
    data = bytes.fromhex(instruction["dataHex"])
    out += struct.pack("<I", len(data)) + data
    return bytes(out)


def downstream_commitment(instruction: dict) -> bytes:
    """Kind 1: one instruction."""
    return hashlib.sha256(DOWNSTREAM_DOMAIN + encode_instruction(instruction)).digest()


def suffix_commitment(suffix: list[dict]) -> bytes:
    """Kinds 2/3: every instruction after the guard, count-framed."""
    body = b"".join(encode_instruction(i) for i in suffix)
    return hashlib.sha256(JUPITER_SUFFIX_DOMAIN + struct.pack("<I", len(suffix)) + body).digest()


# ----------------------------------------------------- known instructions

COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"


def set_compute_unit_limit(units: int) -> dict:
    return {"programId": COMPUTE_BUDGET, "accounts": [], "dataHex": struct.pack("<BI", 2, units).hex()}


def set_compute_unit_price(micro_lamports: int) -> dict:
    return {"programId": COMPUTE_BUDGET, "accounts": [],
            "dataHex": struct.pack("<BQ", 3, micro_lamports).hex()}


# -------------------------------------------------------------- self-test

def _self_test() -> None:
    # Anchor's event authority for Jupiter v6, as its published IDL pins it.
    assert find_program_address([b"__event_authority"],
                                "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") == \
        ("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf", 255)
    # The ed25519 base point (y = 4/5) and the identity (y = 1) are on the
    # curve; a program-derived address never is.
    base_y = (4 * pow(5, _P - 2, _P)) % _P
    assert is_on_curve(base_y.to_bytes(32, "little"))
    assert is_on_curve((1).to_bytes(32, "little"))
    assert not is_on_curve(unb58("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"))
    assert unb58(b58(bytes(32))) == bytes(32)


_self_test()
