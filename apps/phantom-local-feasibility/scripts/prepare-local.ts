/**
 * LOCAL-ONLY: fabricate Phantom's canonical USDC ATA and reseed the M9D-C1
 * validator so every proof starts from a known baseline.
 *
 * Does not mint, does not transfer the original taker's USDC, and does not
 * introduce a second signer into the guarded trade.
 *
 * Usage:
 *   node apps/phantom-local-feasibility/scripts/prepare-local.ts [--reset-validator]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { address, createSolanaRpc, getAddressDecoder, lamports } from "@solana/kit";

import { TOKEN_2022_PROGRAM_ADDRESS } from "../../../packages/guard-client/src/index.ts";
import { writeFabricatedUsdcAta } from "../../../scripts/replay/local-user-accounts.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "../src/feasibility.ts";
import {
  EXPECTED_IN_AMOUNT,
  EXPECTED_KOX_BASELINE,
  EXPECTED_PHANTOM,
  EXPECTED_PHANTOM_KOX_ATA,
  EXPECTED_PHANTOM_USDC_ATA,
  EXPECTED_USDC_BASELINE,
} from "../src/local-funding.ts";
import { KOX_MINT } from "../src/replay-model.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const DIR = join(ROOT, "tmp/m9d-c1");
const PHANTOM_ACCOUNTS = join(DIR, "phantom-accounts");
const LOCAL_ACCOUNTS = join(DIR, "local-accounts");
const POLL_MS = 500;
const POLL_LIMIT = 400;

function applyDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(LOCAL_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

function tokenAmount(data: string): bigint {
  const bytes = Buffer.from(data, "base64");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    try {
      const json = await rpcCall("getHealth", []) as { result?: string };
      if (json.result === "ok") return;
    } catch {
      // validator still coming up
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("local validator did not become healthy");
}

async function killLocalValidator(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("lsof", ["-nP", "-iTCP:8899", "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .forEach((pid) => {
        try { execFileSync("kill", [pid]); } catch { /* already gone */ }
      });
  } catch {
    // nothing listening
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rpcCall("getHealth", []);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    } catch {
      return;
    }
  }
}

function startValidator(): void {
  if (!process.env.EQUITYGUARD_MAINNET_RPC_URL) {
    throw new Error("EQUITYGUARD_MAINNET_RPC_URL is required to reset the local replay validator");
  }
  const child = spawn("scripts/replay/start-validator.sh", [DIR], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function airdropIfNeeded(): Promise<bigint> {
  const rpc = createSolanaRpc(assertLocalRpcUrl(LOCAL_RPC_URL).href);
  const before = await rpc.getBalance(EXPECTED_PHANTOM, { commitment: "confirmed" }).send();
  if (before.value >= 10_000_000n) return before.value;
  const local = rpc as typeof rpc & {
    requestAirdrop(address: ReturnType<typeof address>, amount: ReturnType<typeof lamports>): { send(): Promise<string> };
  };
  await local.requestAirdrop(EXPECTED_PHANTOM, lamports(1_000_000_000n)).send();
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const after = await rpc.getBalance(EXPECTED_PHANTOM, { commitment: "confirmed" }).send();
    if (after.value > before.value) return after.value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("Phantom local airdrop did not confirm");
}

async function snapshot(pubkey: string) {
  const json = await rpcCall("getAccountInfo", [pubkey, { encoding: "base64", commitment: "confirmed" }]) as {
    result?: { value: { owner: string; lamports: number; data: [string, string] } | null };
  };
  const value = json.result?.value ?? null;
  if (!value) return { pubkey, exists: false as const };
  const bytes = Buffer.from(value.data[0], "base64");
  const decoder = getAddressDecoder();
  return {
    pubkey,
    exists: true as const,
    owner: value.owner,
    lamports: value.lamports,
    mint: bytes.length >= 64 ? decoder.decode(bytes.subarray(0, 32)) : null,
    tokenOwner: bytes.length >= 64 ? decoder.decode(bytes.subarray(32, 64)) : null,
    amount: bytes.length >= 72 ? tokenAmount(value.data[0]).toString() : null,
  };
}

async function main(): Promise<void> {
  applyDotEnv(join(ROOT, ".env"));
  assertLocalRpcUrl(LOCAL_RPC_URL);
  const reset = process.argv.includes("--reset-validator");
  const written = await writeFabricatedUsdcAta(EXPECTED_PHANTOM, EXPECTED_USDC_BASELINE, PHANTOM_ACCOUNTS);
  if (written.ata !== EXPECTED_PHANTOM_USDC_ATA) {
    throw new Error(`canonical Phantom USDC ATA is ${written.ata}, not ${EXPECTED_PHANTOM_USDC_ATA}`);
  }
  const leftover = join(LOCAL_ACCOUNTS, `${EXPECTED_PHANTOM_USDC_ATA}.json`);
  if (existsSync(leftover)) unlinkSync(leftover);
  const koxPath = join(PHANTOM_ACCOUNTS, `${EXPECTED_PHANTOM_KOX_ATA}.json`);
  if (existsSync(koxPath)) unlinkSync(koxPath);

  if (reset) {
    await killLocalValidator();
    startValidator();
    await waitForHealth();
  }

  const sol = await airdropIfNeeded();
  const [usdc, kox] = await Promise.all([
    snapshot(EXPECTED_PHANTOM_USDC_ATA),
    snapshot(EXPECTED_PHANTOM_KOX_ATA),
  ]);
  if (!usdc.exists || usdc.amount !== EXPECTED_USDC_BASELINE.toString() || usdc.tokenOwner !== EXPECTED_PHANTOM) {
    throw new Error(`Phantom USDC baseline is not ${EXPECTED_USDC_BASELINE}: ${JSON.stringify(usdc)}`);
  }
  const koxAmount = kox.exists ? BigInt(kox.amount ?? "0") : EXPECTED_KOX_BASELINE;
  if (koxAmount !== EXPECTED_KOX_BASELINE) {
    throw new Error(`Phantom KOx baseline is not ${EXPECTED_KOX_BASELINE}: ${JSON.stringify(kox)}`);
  }
  if (kox.exists && kox.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new Error("Phantom KOx ATA is not Token-2022 owned");
  }

  const report = {
    rpc: LOCAL_RPC_URL,
    phantom: EXPECTED_PHANTOM,
    solLamports: sol.toString(),
    usdcAta: written.ata,
    usdcRaw: written.amount.toString(),
    koxAta: EXPECTED_PHANTOM_KOX_ATA,
    koxRaw: koxAmount.toString(),
    koxExists: kox.exists,
    inAmount: EXPECTED_IN_AMOUNT.toString(),
    resetValidator: reset,
    originalTakerUsdcTransferred: false,
  };
  await mkdir(join(DIR), { recursive: true });
  await writeFile(join(DIR, "phantom-baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(`[prepare-local] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
