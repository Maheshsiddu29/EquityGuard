#!/usr/bin/env python3
"""Adds the adapter kind 2/3 material to the ABI v2 golden fixture.

    python3 scripts/fixtures/update_abi_v2_golden.py

The kind 1 vectors in `abi_v2_golden.json` were generated independently
before this milestone and are left byte-for-byte as they are. This script
only (re)writes what adapter kinds 2 and 3 add, from the specification:

- the error codes appended for kinds 2/3 (26-38);
- `jupiterSuffixCommitmentDomain`;
- ABI v2 payloads carrying adapter kinds 2 and 3 (`struct.pack`);
- suffix commitments over the recorded mainnet builds, with transaction-level
  flags (`hashlib`);
- the invalid-adapter example: byte 2 is now a defined kind, so the
  "unknown adapter" vector uses byte 4 instead.

Deterministic and idempotent.
"""

import json
import struct

import jupiter_builds as jb
from solana_encoding import (
    b58,
    downstream_commitment,
    suffix_commitment,
    sysvar_view,
    unb58,
)

GOLDEN = jb.ROOT / "programs/equity_guard/tests/fixtures/abi_v2_golden.json"

JUPITER_ERROR_CODES = {
    "GuardNotFirst": 26,
    "UnsupportedTransactionGrammar": 27,
    "InvalidComputeBudgetInstruction": 28,
    "InvalidAtaSetup": 29,
    "InvalidJupiterProgram": 30,
    "InvalidJupiterInstruction": 31,
    "InvalidJupiterDirection": 32,
    "InvalidCounterMint": 33,
    "InvalidTokenProgram": 34,
    "DestinationOverrideUnsupported": 35,
    "UnsupportedJupiterFee": 36,
    "NonCanonicalSourceAccount": 37,
    "NonCanonicalDestinationAccount": 38,
}

#: Mainnet protected state of each representation (decoded.json).
DECODED = {m["symbol"]: m for m in json.loads((jb.MAINNET_MINTS / "decoded.json").read_text())["mints"]}


def abi_v2(mint: str, state: dict, phase: int, before: int, after: int, adapter: int,
           commitment: bytes) -> bytes:
    return struct.pack("<B32s8s8sqBIIB32s", 2, unb58(mint), bytes.fromhex(state["multiplierHex"]),
                       bytes.fromhex(state["newMultiplierHex"]),
                       int(state["newMultiplierEffectiveTimestamp"]), phase, before, after,
                       adapter, commitment)


RELAYER = b58(bytes([0x7E] * 32))


def relayed(suffix: list[dict]) -> list[dict]:
    setup = suffix[2]
    payer = {**setup["accounts"][0], "pubkey": RELAYER}
    return [*suffix[:2], {**setup, "accounts": [payer, *setup["accounts"][1:]]}, *suffix[3:]]


def suffix_vector(name: str, suffix: list[dict], fee_payer: str) -> dict:
    """`instructions` are the suffix as the Instructions sysvar exposes it,
    inside a transaction whose guard (read-only mint and sysvar) is at 0."""
    view = sysvar_view(suffix, fee_payer)
    return {"name": name, "feePayer": fee_payer, "instructions": view,
            "commitmentHex": suffix_commitment(view).hex()}


def main() -> None:
    golden = json.loads(GOLDEN.read_text())

    codes = {k: v for k, v in golden["errorCodes"].items() if v < 26}
    assert len(codes) == 26
    golden["errorCodes"] = {**codes, **JUPITER_ERROR_CODES}
    golden["jupiterSuffixCommitmentDomain"] = "EQUITYGUARD_JUPITER_SUFFIX_V1"

    suffixes = []
    for symbol, direction in [("KOx", "BUY"), ("KOx", "SELL"), ("UNHx", "BUY"),
                              ("UNHx", "SELL"), ("CRMx", "SELL")]:
        b = jb.build(symbol, direction)
        suffixes.append(suffix_vector(f"{symbol.lower()}-{direction.lower()}-usdc",
                                      jb.normalized(b), b["taker"]))
    kox_buy = jb.build("KOx", "BUY")
    honest = jb.normalized(kox_buy)
    suffixes += [
        suffix_vector("kox-buy-usdc-without-setup", [honest[0], honest[1], honest[3]],
                      kox_buy["taker"]),
        suffix_vector("kox-buy-usdc-price-and-limit-swapped",
                      [honest[1], honest[0], *honest[2:]], kox_buy["taker"]),
        # A relayer paying both the fee and the setup leaves the authority a
        # read-only signer, which changes the commitment.
        suffix_vector("kox-buy-usdc-relayer-pays", relayed(honest), RELAYER),
    ]
    # One instruction, both domains: the digests must differ.
    transfer = golden["commitmentVectors"][0]
    single = {"name": "single-instruction-in-the-suffix-domain", "feePayer": None,
              "instructions": [{k: transfer[k] for k in ("programId", "accounts", "dataHex")}],
              "commitmentHex": suffix_commitment([transfer]).hex()}
    assert single["commitmentHex"] != downstream_commitment(transfer).hex()
    suffixes.append(single)
    assert len({s["commitmentHex"] for s in suffixes}) == len(suffixes)
    golden["suffixCommitmentVectors"] = suffixes

    kind1 = [v for v in golden["vectors"] if v["request"]["adapterKind"] == 1]
    jupiter_vectors = []
    for vector_name, symbol, direction, suffix_name in [
        ("kox-mainnet-jupiter-buy-usdc", "KOx", "BUY", "kox-buy-usdc"),
        ("unhx-mainnet-jupiter-sell-usdc", "UNHx", "SELL", "unhx-sell-usdc"),
    ]:
        b = jb.build(symbol, direction)
        state = DECODED[symbol]
        commitment = bytes.fromhex(next(s for s in suffixes if s["name"] == suffix_name)["commitmentHex"])
        mint = jb.protected_mint(b)
        encoded = abi_v2(mint, state, 1, 900, 300, jb.adapter(b), commitment)
        jupiter_vectors.append({
            "name": vector_name,
            "request": {
                "expectedMint": mint,
                "multiplierHex": state["multiplierHex"],
                "newMultiplierHex": state["newMultiplierHex"],
                "newMultiplierEffectiveTimestamp": state["newMultiplierEffectiveTimestamp"],
                "expectedPhase": 1,
                "protectionBeforeSecs": 900,
                "protectionAfterSecs": 300,
                "adapterKind": jb.adapter(b),
                "downstreamCommitmentHex": commitment.hex(),
            },
            "encodedHex": encoded.hex(),
        })
    golden["vectors"] = kind1 + jupiter_vectors

    invalid = [v for v in golden["invalid"] if not v["name"].startswith("adapter-")]
    base = bytes.fromhex(kind1[0]["encodedHex"])
    for label, byte in (("zero", 0), ("four", 4), ("max", 255)):
        invalid.append({"name": f"adapter-{label}", "dataHex": (base[:66] + bytes([byte]) + base[67:]).hex(),
                        "error": "UnsupportedAdapter"})
    golden["invalid"] = invalid

    GOLDEN.write_text(json.dumps(golden, indent=2) + "\n")
    print(f"{len(suffixes)} suffix vectors, {len(jupiter_vectors)} kind 2/3 payloads -> {GOLDEN}")


if __name__ == "__main__":
    main()
