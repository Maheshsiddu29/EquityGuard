"""The recorded mainnet Jupiter builds (M9D-A, 2026-09-16) in the normalized
guarded order, for the fixture generators.

Normalized order, exactly as the composer emits it:

    0 guard | price | limit | [setup] | route_v2
"""

import base64
import json
from pathlib import Path

from solana_encoding import set_compute_unit_limit

ROOT = Path(__file__).resolve().parents[2]
BUILDS_PATH = ROOT / "scripts/research/fixtures/route-v2-builds-2026-09-16.json"
MAINNET_MINTS = ROOT / "programs/equity_guard/tests/fixtures/mainnet"

PROGRAM_ID = "EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT"
JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
LEGACY_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111"
ADAPTER_BUY = 2
ADAPTER_SELL = 3
#: The limit the composer and the LiteSVM suite add to every replayed build.
COMPUTE_UNIT_LIMIT = 400_000


def builds() -> list[dict]:
    return json.loads(BUILDS_PATH.read_text())["builds"]


def build(symbol: str, direction: str) -> dict:
    return next(b for b in builds() if b["symbol"] == symbol and b["direction"] == direction)


def protected_mint(b: dict) -> str:
    return b["outputMint"] if b["direction"] == "BUY" else b["inputMint"]


def adapter(b: dict) -> int:
    return ADAPTER_BUY if b["direction"] == "BUY" else ADAPTER_SELL


def normalized(b: dict) -> list[dict]:
    """price, limit, then Jupiter's setup / swap / cleanup in its own order."""
    recorded = b["jupiterInstructions"]
    assert recorded[0]["programId"] == set_compute_unit_limit(0)["programId"]
    assert recorded[0]["dataHex"].startswith("03")
    return [recorded[0], set_compute_unit_limit(COMPUTE_UNIT_LIMIT), *recorded[1:]]


def mainnet_mint_hex(symbol: str) -> str:
    return base64.b64decode((MAINNET_MINTS / f"{symbol}.base64").read_text().strip()).hex()
