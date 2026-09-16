/**
 * M9D-A research tooling: empirical probe of which trade parameters are
 * recoverable from a Jupiter swap instruction on-chain.
 *
 * Read-only. It varies one request parameter at a time and diffs the resulting
 * swap instruction, so the encoding claims in the architecture note rest on
 * observation rather than on an IDL we do not control.
 *
 * Usage: node --env-file=.env scripts/research/jupiter-field-probe.ts [--out tmp/m9d-a]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getBase64Encoder } from "@solana/kit";

import { JupiterApiError, fetchBuild, readJupiterApiKey, JUPITER_API_BASE_URL, type BuildResponse } from "../../packages/jupiter/src/build-client.ts";
import { hex } from "./decode-build.ts";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KOX_MINT = "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ";
const TAKER = process.env.EQUITYGUARD_RESEARCH_TAKER ?? "AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH";
const DELAY_MS = 2500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Probe {
  readonly label: string;
  readonly amountRaw: string;
  readonly slippageBps: number;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly swapMode: string;
  readonly dataHex: string;
  readonly accountCount: number;
  readonly prefix: readonly string[];
}

async function probe(label: string, amount: bigint, slippageBps: number, apiKey: string): Promise<Probe> {
  const build: BuildResponse = await fetchBuild(
    { inputMint: USDC_MINT, outputMint: KOX_MINT, amount, taker: TAKER, slippageBps },
    { apiKey },
  );
  await sleep(DELAY_MS);
  const data = Uint8Array.from(getBase64Encoder().encode(build.swapInstruction.data));
  return {
    label,
    amountRaw: amount.toString(),
    slippageBps,
    inAmount: build.inAmount,
    outAmount: build.outAmount,
    otherAmountThreshold: build.otherAmountThreshold,
    swapMode: build.swapMode,
    dataHex: hex(data),
    accountCount: build.swapInstruction.accounts.length,
    prefix: build.swapInstruction.accounts.slice(0, 10).map((a) => a.pubkey),
  };
}

/** Byte offsets at which two same-length instruction payloads differ. */
function diffOffsets(a: string, b: string): number[] {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  const out: number[] = [];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) out.push(i);
  return out;
}

/** Jupiter's own threshold, reproduced from the two in-data fields. */
function derivedThreshold(outAmount: bigint, slippageBps: number): bigint {
  const numerator = outAmount * BigInt(10_000 - slippageBps);
  return numerator % 10_000n === 0n ? numerator / 10_000n : numerator / 10_000n + 1n;
}

/** Asks whether `/build` accepts an ExactOut request at all. */
async function exactOutSupported(apiKey: string): Promise<{ supported: boolean; detail: string }> {
  const url = new URL("/swap/v2/build", JUPITER_API_BASE_URL);
  url.searchParams.set("inputMint", USDC_MINT);
  url.searchParams.set("outputMint", KOX_MINT);
  url.searchParams.set("amount", "1000000");
  url.searchParams.set("taker", TAKER);
  url.searchParams.set("slippageBps", "50");
  url.searchParams.set("swapMode", "ExactOut");
  const response = await fetch(url, { headers: { "x-api-key": apiKey, accept: "application/json" } });
  const text = await response.text();
  await sleep(DELAY_MS);
  if (!response.ok) return { supported: false, detail: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  const json = JSON.parse(text) as { swapMode?: string; outAmount?: string; inAmount?: string };
  return { supported: json.swapMode === "ExactOut", detail: `swapMode=${String(json.swapMode)} in=${String(json.inAmount)} out=${String(json.outAmount)}` };
}

async function main(): Promise<void> {
  const apiKey = readJupiterApiKey(process.env);
  const out = process.argv.includes("--out") ? (process.argv[process.argv.indexOf("--out") + 1] as string) : "tmp/m9d-a";

  const baseProbe = await probe("base: 5 USDC, 50bps", 5_000_000n, 50, apiKey);
  const slippage = await probe("slippage: 5 USDC, 300bps", 5_000_000n, 300, apiKey);
  const amount = await probe("amount: 6 USDC, 50bps", 6_000_000n, 50, apiKey);

  let exactOut: { supported: boolean; detail: string };
  try {
    exactOut = await exactOutSupported(apiKey);
  } catch (error) {
    exactOut = { supported: false, detail: error instanceof JupiterApiError ? error.message : String(error) };
  }

  const report = {
    milestone: "M9D-A",
    recordedAt: new Date().toISOString(),
    readOnly: true,
    probes: [baseProbe, slippage, amount],
    diffs: {
      slippageOnly: diffOffsets(baseProbe.dataHex, slippage.dataHex),
      amountOnly: diffOffsets(baseProbe.dataHex, amount.dataHex),
    },
    discriminatorStable: [baseProbe, slippage, amount].every((p) => p.dataHex.slice(0, 16) === baseProbe.dataHex.slice(0, 16)),
    discriminatorHex: baseProbe.dataHex.slice(0, 16),
    fixedAccountPrefixStable: [slippage, amount].every((p) => p.prefix.join() === baseProbe.prefix.join()),
    thresholdDerivation: [baseProbe, slippage, amount].map((p) => ({
      label: p.label,
      reported: p.otherAmountThreshold,
      derived: derivedThreshold(BigInt(p.outAmount), p.slippageBps).toString(),
      matches: derivedThreshold(BigInt(p.outAmount), p.slippageBps).toString() === p.otherAmountThreshold,
    })),
    exactOut,
  };

  await mkdir(out, { recursive: true });
  const path = join(out, `field-probe-${report.recordedAt.replace(/[:.]/g, "")}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n\nreport: ${path}\n`);
}

await main();
