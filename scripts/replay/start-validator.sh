#!/usr/bin/env bash
# M9D-C1: local validator for the real-Jupiter replay. Local only.
#
# Loads, at their real addresses:
#   - EquityGuard from target/deploy/equity_guard.so (reviewed candidate)
#   - Jupiter v6, Whirlpool, SPL Token, Token-2022 executable bytes dumped
#     from mainnet programdata by capture-route.ts (upgradeable)
#   - ATA and Memo bytes dumped from mainnet (BPFLoader2, loaded non-upgradeable)
#   - every mainnet account the route references (accounts/)
#   - the one fabricated local user account (local-accounts/)
#
# --warp-slot moves past the lookup table's last_extended_slot so its
# addresses are active. --clone-feature-set copies mainnet's feature gates, so
# the programs run under mainnet's runtime rules. That is the only use of the
# mainnet RPC here; it is read-only.
#
# Usage: EQUITYGUARD_MAINNET_RPC_URL=... scripts/replay/start-validator.sh [dir]
set -euo pipefail

DIR="${1:-tmp/m9d-c1}"
: "${EQUITYGUARD_MAINNET_RPC_URL:?EQUITYGUARD_MAINNET_RPC_URL is required for --clone-feature-set}"
WARP_SLOT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).accountsReadSlot)' "$DIR/route-fixture.json")"
P="$DIR/programs"

exec solana-test-validator \
  --reset \
  --quiet \
  --ledger "$DIR/ledger" \
  --url "$EQUITYGUARD_MAINNET_RPC_URL" \
  --clone-feature-set \
  --warp-slot "$WARP_SLOT" \
  --upgradeable-program EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT target/deploy/equity_guard.so none \
  --upgradeable-program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 "$P/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so" none \
  --upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc "$P/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc.so" none \
  --upgradeable-program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA "$P/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.so" none \
  --upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$P/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.so" none \
  --bpf-program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL "$P/ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL.so" \
  --bpf-program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr "$P/MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr.so" \
  --account-dir "$DIR/accounts" \
  --account-dir "$DIR/local-accounts"
