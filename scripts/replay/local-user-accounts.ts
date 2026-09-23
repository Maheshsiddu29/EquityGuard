/**
 * M9D-C1: writes the ONE locally fabricated account the replay needs, the
 * local taker's canonical USDC ATA, funded with a stated raw balance.
 *
 * Why fabricated: USDC's mint authority is Circle's, so a local user cannot
 * be funded by minting. The account is a plain, initialized SPL Token account
 * at the canonical ATA address. Nothing about the cloned mainnet pool, vaults,
 * mints or tick arrays is modified. The USDC mint's recorded supply therefore
 * does not include this balance; no program on the route reads supply.
 *
 * Usage:
 *   node scripts/replay/local-user-accounts.ts --taker <pubkey> --usdc-raw 10000000 [--out tmp/m9d-c1/local-accounts]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { address, getAddressEncoder, type Address } from "@solana/kit";

import { LEGACY_TOKEN_PROGRAM_ADDRESS, USDC_MINT_ADDRESS, canonicalAta } from "../../packages/guard-client/src/index.ts";
import { toJson } from "../devnet/evidence.ts";

const TOKEN_ACCOUNT_LEN = 165;
/** Rent-exempt minimum for 165 bytes. */
const TOKEN_ACCOUNT_RENT = 2_039_280;
const ACCOUNT_STATE_INITIALIZED = 1;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? fallback : process.argv[i + 1];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

export interface FabricatedUsdcAta {
  readonly taker: Address;
  readonly ata: Address;
  readonly amount: bigint;
  readonly path: string;
  readonly tokenProgram: typeof LEGACY_TOKEN_PROGRAM_ADDRESS;
  readonly mint: typeof USDC_MINT_ADDRESS;
}

export async function writeFabricatedUsdcAta(
  taker: Address,
  amount: bigint,
  outDir: string,
): Promise<FabricatedUsdcAta> {
  if (amount < 0n) throw new Error("USDC raw amount must be non-negative");
  const ata = await canonicalAta(taker, USDC_MINT_ADDRESS, LEGACY_TOKEN_PROGRAM_ADDRESS);

  // spl_token::state::Account: mint, owner, amount, delegate (COption), state,
  // is_native (COption<u64>), delegated_amount, close_authority (COption).
  const data = new Uint8Array(TOKEN_ACCOUNT_LEN);
  const view = new DataView(data.buffer);
  const encoder = getAddressEncoder();
  data.set(encoder.encode(USDC_MINT_ADDRESS), 0);
  data.set(encoder.encode(taker), 32);
  view.setBigUint64(64, amount, true);
  data[108] = ACCOUNT_STATE_INITIALIZED;

  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${ata}.json`);
  await writeFile(
    path,
    toJson({
      pubkey: ata,
      account: {
        lamports: TOKEN_ACCOUNT_RENT,
        data: [Buffer.from(data).toString("base64"), "base64"],
        owner: LEGACY_TOKEN_PROGRAM_ADDRESS,
        executable: false,
        rentEpoch: 0,
        space: TOKEN_ACCOUNT_LEN,
      },
    }),
  );
  return { taker, ata, amount, path, tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS, mint: USDC_MINT_ADDRESS };
}

async function main(): Promise<void> {
  const taker = address(arg("--taker"));
  const amount = BigInt(arg("--usdc-raw"));
  const outDir = arg("--out", "tmp/m9d-c1/local-accounts");
  const written = await writeFabricatedUsdcAta(taker, amount, outDir);
  console.log(`LOCAL-ONLY USDC ATA ${written.ata} for ${written.taker}: ${written.amount} raw -> ${written.path}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(`[local-user-accounts] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
