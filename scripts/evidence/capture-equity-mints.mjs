#!/usr/bin/env node
// @ts-check
/**
 * Raw mainnet mint evidence recorder.
 *
 * Periodically fetches the raw account bytes of configured tokenized-equity
 * mints and appends one JSON line per mint per poll. It deliberately does not
 * decode anything: the output is evidence of what the chain held at a slot,
 * independent of any parsing logic we may later get wrong.
 *
 * Usage:
 *   EQUITYGUARD_MAINNET_RPC_URL=<url> node scripts/evidence/capture-equity-mints.mjs \
 *     --mints scripts/evidence/mints.json [--out evidence/mint-captures.jsonl] \
 *     [--interval-seconds 30] [--once]
 *
 * See evidence/README.md for the output format.
 */

import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Bump when the output record shape changes. */
export const SCHEMA_VERSION = 1;

const DEFAULT_OUT = "evidence/mint-captures.jsonl";
const DEFAULT_INTERVAL_SECONDS = 30;
// Solana RPC caps getMultipleAccounts at 100 keys per request.
const MAX_ACCOUNTS_PER_REQUEST = 100;
// Keep polls from hanging forever on a stuck RPC connection.
const RPC_TIMEOUT_MS = 15_000;
// "confirmed" balances freshness against the chance of observing a fork that
// later disappears; the slot is recorded so either can be reconciled.
const COMMITMENT = "confirmed";
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Structured error for configuration and RPC failures. */
export class CaptureError extends Error {
  /**
   * @param {"config" | "rpc"} kind
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(kind, message, cause) {
    super(message, { cause });
    this.name = "CaptureError";
    this.kind = kind;
  }
}

/**
 * @typedef {{ symbol: string, issuer: string, mint: string }} MintTarget
 * @typedef {{ owner: string, lamports: number, executable: boolean, data: [string, string] }} RpcAccount
 * @typedef {{ context: { slot: number }, value: Array<RpcAccount | null> }} MultipleAccountsResult
 */

/**
 * Validates the mint list file contents.
 * @param {unknown} value parsed JSON
 * @returns {MintTarget[]}
 */
export function parseMintList(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CaptureError("config", "mint list must be a non-empty JSON array");
  }
  if (value.length > MAX_ACCOUNTS_PER_REQUEST) {
    throw new CaptureError("config", `mint list exceeds ${MAX_ACCOUNTS_PER_REQUEST} entries`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new CaptureError("config", `mint list entry ${index} must be an object`);
    }
    const { symbol, issuer, mint } = /** @type {Record<string, unknown>} */ (entry);
    for (const [field, fieldValue] of Object.entries({ symbol, issuer, mint })) {
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new CaptureError("config", `mint list entry ${index}: "${field}" must be a non-empty string`);
      }
    }
    const target = /** @type {MintTarget} */ ({ symbol, issuer, mint });
    if (!BASE58_ADDRESS.test(target.mint)) {
      throw new CaptureError("config", `mint list entry ${index} (${target.symbol}): invalid base58 address`);
    }
    if (seen.has(target.mint)) {
      throw new CaptureError("config", `mint list entry ${index} (${target.symbol}): duplicate mint`);
    }
    seen.add(target.mint);
    return target;
  });
}

/**
 * Builds one evidence record per mint from a getMultipleAccounts response.
 * Missing accounts are recorded explicitly rather than skipped, because
 * absence is itself evidence.
 * @param {MintTarget[]} mints
 * @param {MultipleAccountsResult} result
 * @param {number | null} blockTime
 * @param {Date} capturedAt
 */
export function buildRecords(mints, result, blockTime, capturedAt) {
  if (result.value.length !== mints.length) {
    throw new CaptureError(
      "rpc",
      `expected ${mints.length} accounts, RPC returned ${result.value.length}`,
    );
  }
  return mints.map((target, index) => {
    const account = result.value[index];
    if (account && account.data[1] !== "base64") {
      throw new CaptureError("rpc", `unexpected account encoding "${account.data[1]}" for ${target.mint}`);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: capturedAt.toISOString(),
      wallclockMs: capturedAt.getTime(),
      slot: result.context.slot,
      blockTime,
      commitment: COMMITMENT,
      symbol: target.symbol,
      issuer: target.issuer,
      mint: target.mint,
      exists: account !== null,
      owner: account?.owner ?? null,
      lamports: account?.lamports ?? null,
      dataBase64: account?.data[0] ?? null,
    };
  });
}

/**
 * Minimal JSON-RPC call. The RPC URL is never logged because provider URLs
 * commonly embed API keys.
 * @param {string} rpcUrl
 * @param {string} method
 * @param {unknown[]} params
 * @returns {Promise<unknown>}
 */
async function rpcCall(rpcUrl, method, params) {
  let response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CaptureError("rpc", `${method}: request failed`, error);
  }
  if (!response.ok) {
    throw new CaptureError("rpc", `${method}: HTTP ${response.status}`);
  }
  const body = /** @type {{ result?: unknown, error?: { code: number, message: string } }} */ (
    await response.json()
  );
  if (body.error) {
    throw new CaptureError("rpc", `${method}: ${body.error.code} ${body.error.message}`);
  }
  return body.result;
}

/**
 * Captures one snapshot of all mints and appends it to the output file.
 * @param {string} rpcUrl
 * @param {MintTarget[]} mints
 * @param {string} outPath
 */
export async function captureOnce(rpcUrl, mints, outPath) {
  const result = /** @type {MultipleAccountsResult} */ (
    await rpcCall(rpcUrl, "getMultipleAccounts", [
      mints.map((m) => m.mint),
      { encoding: "base64", commitment: COMMITMENT },
    ])
  );
  const capturedAt = new Date();

  // blockTime can be unavailable for very recent or skipped slots; the slot
  // remains the authoritative ordering key, so record null instead of failing.
  let blockTime = null;
  try {
    blockTime = /** @type {number | null} */ (await rpcCall(rpcUrl, "getBlockTime", [result.context.slot]));
  } catch (error) {
    console.error(`[capture] blockTime unavailable for slot ${result.context.slot}: ${describe(error)}`);
  }

  const records = buildRecords(mints, result, blockTime, capturedAt);
  await appendFile(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return records;
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function parseConfig(argv, env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mints: { type: "string" },
      out: { type: "string", default: DEFAULT_OUT },
      "interval-seconds": { type: "string", default: String(DEFAULT_INTERVAL_SECONDS) },
      once: { type: "boolean", default: false },
    },
    strict: true,
  });
  const rpcUrl = env.EQUITYGUARD_MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new CaptureError("config", "EQUITYGUARD_MAINNET_RPC_URL is not set");
  }
  if (!values.mints) {
    throw new CaptureError("config", "--mints <path> is required");
  }
  const intervalSeconds = Number(values["interval-seconds"]);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new CaptureError("config", "--interval-seconds must be a positive integer");
  }
  return {
    rpcUrl,
    mintsPath: values.mints,
    outPath: values.out ?? DEFAULT_OUT,
    intervalMs: intervalSeconds * 1000,
    once: values.once ?? false,
  };
}

async function main() {
  const config = parseConfig(process.argv.slice(2), process.env);
  const mints = parseMintList(JSON.parse(await readFile(config.mintsPath, "utf8")));
  console.error(`[capture] ${mints.length} mints -> ${config.outPath}`);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  // Polls run sequentially so a slow RPC cannot cause overlapping writes.
  while (!stopping) {
    const started = Date.now();
    try {
      const records = await captureOnce(config.rpcUrl, mints, config.outPath);
      console.error(`[capture] slot ${records[0]?.slot} wrote ${records.length} records`);
    } catch (error) {
      if (config.once) throw error;
      console.error(`[capture] poll failed, will retry: ${describe(error)}`);
    }
    if (config.once) break;
    const waitMs = Math.max(0, config.intervalMs - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const prefix = error instanceof CaptureError ? `${error.kind} error` : "error";
    console.error(`[capture] ${prefix}: ${describe(error)}`);
    process.exitCode = 1;
  });
}
