#!/usr/bin/env node
/**
 * M11-B benchmark of the frozen TypeScript SDK (`protectJupiterSwap`).
 *
 * A reporting artifact, never a CI threshold: laptop timings vary run to run.
 *
 * A. Pure local construction. The RPC is a frozen in-memory answer set: the
 *    real mainnet mint accounts, a Clock, the devnet genesis hash and the
 *    reviewed devnet Program/ProgramData accounts, base64-encoded ONCE up
 *    front so the fake RPC costs nothing per call. Everything the SDK does —
 *    classification, reviewed-binary verification (SHA-256 of the 63,840-byte
 *    ELF), snapshot, offline guard check, composition, compilation and
 *    re-resolution — is timed.
 *    - sequential N = 1, 10, 100, 1,000, 10,000;
 *    - concurrent (interleaved async on one thread) at 1..256;
 *    - the same with a SIMULATED per-RPC-call latency, to show how much of a
 *      real build is waiting;
 *    - worker threads, for the CPU-bound ceiling on this machine.
 * B. RPC-backed read-only construction against the configured mainnet RPC,
 *    only with `--rpc` and `EQUITYGUARD_MAINNET_RPC_URL` set. Small N, low
 *    concurrency; the URL is never printed. There is no mainnet deployment, so
 *    `protectJupiterSwap` there ends at GUARD_DEPLOYMENT_UNAVAILABLE after its
 *    classification and genesis reads; the individual reads are timed too.
 *
 *   node --expose-gc scripts/m11b/sdk-bench.ts [--rpc | --rpc-only] [--out tmp/m11b/bench]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { address, createSolanaRpc, type Address, type GetGenesisHashApi, type GetMultipleAccountsApi, type Rpc } from "@solana/kit";
import { fetchGuardSnapshot } from "@equityguard/guard-client";

import { protectJupiterSwap, supportsJupiterSwap, type ProtectJupiterSwapResult } from "../../packages/jupiter/src/protect.ts";
import type { BuildResponse } from "../../packages/jupiter/src/index.ts";
import {
  GENESIS,
  GUARD_PROGRAM,
  REVIEWED_DEVNET,
  SETTLED_TIMESTAMP,
  SYSVAR_CLOCK_ADDRESS,
  TAKER,
  mainnetMint,
  recordedBuild,
  recordedKoxBuyBuild,
  reviewedProgramAccount,
  reviewedProgramDataAccount,
  type FakeAccount,
} from "../../packages/jupiter/test/protect-fixtures.ts";

const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const MINTS: Record<string, Address> = {
  KOx: address("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ"),
  UNHx: address("XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe"),
  CRMx: address("XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN"),
};

/** The supported fixtures only; CRMx BUY is refused by the grammar and is not benchmarked as a success. */
export const FIXTURES: readonly { readonly name: string; readonly build: () => BuildResponse }[] = [
  { name: "KOx BUY", build: () => recordedBuild("KOx", "BUY") },
  { name: "KOx SELL", build: () => recordedBuild("KOx", "SELL") },
  { name: "UNHx BUY", build: () => recordedBuild("UNHx", "BUY") },
  { name: "UNHx SELL", build: () => recordedBuild("UNHx", "SELL") },
  { name: "CRMx SELL", build: () => recordedBuild("CRMx", "SELL") },
  { name: "KOx BUY (2026-09-14 full build)", build: recordedKoxBuyBuild },
];

// ------------------------------------------------------------------ frozen RPC

type BenchRpc = Rpc<GetMultipleAccountsApi & GetGenesisHashApi>;

interface Encoded {
  readonly data: [string, "base64"];
  readonly executable: boolean;
  readonly owner: string;
  readonly space: bigint;
}

function encode(account: FakeAccount): Encoded {
  return { data: [Buffer.from(account.data).toString("base64"), "base64"], executable: account.executable ?? false, owner: account.owner, space: BigInt(account.data.length) };
}

/** Pre-encoded answers, shared read-only by every call; per-call cost is a map lookup. */
function frozenAnswers(): Map<string, Encoded> {
  const clock = new Uint8Array(40);
  const view = new DataView(clock.buffer);
  view.setBigUint64(0, 100n, true);
  view.setBigInt64(32, SETTLED_TIMESTAMP, true);
  const answers = new Map<string, Encoded>([
    [GUARD_PROGRAM, encode(reviewedProgramAccount())],
    [REVIEWED_DEVNET.programDataAddress, encode(reviewedProgramDataAccount())],
    [SYSVAR_CLOCK_ADDRESS, encode({ owner: "Sysvar1111111111111111111111111111111111111", data: clock })],
  ]);
  for (const [symbol, mint] of Object.entries(MINTS)) answers.set(mint, encode({ owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: mainnetMint(symbol) }));
  return answers;
}

export interface RpcCounters {
  getMultipleAccounts: number;
  getGenesisHash: number;
  accountsRequested: number;
  base64BytesServed: number;
}

/** A read-only RPC over frozen answers, with an optional simulated latency per call. */
export function frozenRpc(answers: Map<string, Encoded>, latency: (() => number) | null, counters?: RpcCounters): BenchRpc {
  const wait = () => (latency ? new Promise<void>((resolve) => setTimeout(resolve, latency())) : Promise.resolve());
  return {
    getGenesisHash: () => ({
      send: async () => {
        await wait();
        if (counters) counters.getGenesisHash += 1;
        return GENESIS.devnet;
      },
    }),
    getMultipleAccounts: (addresses: readonly string[]) => ({
      send: async () => {
        await wait();
        const value = addresses.map((a) => {
          const found = answers.get(a);
          if (counters) {
            counters.accountsRequested += 1;
            counters.base64BytesServed += found?.data[0].length ?? 0;
          }
          return found ? { ...found, lamports: 1n, rentEpoch: 0n } : null;
        });
        if (counters) counters.getMultipleAccounts += 1;
        return { context: { slot: 100n }, value };
      },
    }),
  } as unknown as BenchRpc;
}

// ------------------------------------------------------------------ statistics

export interface LatencyStats {
  readonly n: number;
  readonly failures: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly wallMs: number;
  readonly throughputOpsPerSec: number;
}

function stats(samples: number[], failures: number, wallMs: number): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  const round = (x: number) => Number(x.toFixed(3));
  return {
    n: samples.length,
    failures,
    p50Ms: round(at(50)),
    p95Ms: round(at(95)),
    p99Ms: round(at(99)),
    maxMs: round(sorted.at(-1) ?? 0),
    meanMs: round(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)),
    wallMs: round(wallMs),
    throughputOpsPerSec: round((samples.length / wallMs) * 1000),
  };
}

const gc = (globalThis as { gc?: () => void }).gc;
const heapMb = () => {
  gc?.();
  return Number((process.memoryUsage().heapUsed / 2 ** 20).toFixed(2));
};

interface Job {
  readonly fixture: (typeof FIXTURES)[number];
  readonly build: BuildResponse;
}

function jobs(n: number): Job[] {
  // Builds are parsed once per fixture: timing covers the SDK, not fixture parsing.
  const parsed = FIXTURES.map((fixture) => ({ fixture, build: fixture.build() }));
  return Array.from({ length: n }, (_, i) => parsed[i % parsed.length]!);
}

async function once(job: Job, rpc: BenchRpc): Promise<ProtectJupiterSwapResult> {
  return protectJupiterSwap({ build: job.build, userPublicKey: TAKER, rpc, protectionWindow: WINDOW });
}

async function sequential(n: number, rpc: BenchRpc, memoryEvery = 0): Promise<LatencyStats & { memory?: { at: number; heapUsedMb: number }[] }> {
  const list = jobs(n);
  const samples: number[] = [];
  const memory: { at: number; heapUsedMb: number }[] = [];
  let failures = 0;
  const start = performance.now();
  for (const [i, job] of list.entries()) {
    const t = performance.now();
    const result = await once(job, rpc);
    samples.push(performance.now() - t);
    if (result.status !== "PROTECTED") failures += 1;
    if (memoryEvery > 0 && (i + 1) % memoryEvery === 0) memory.push({ at: i + 1, heapUsedMb: heapMb() });
  }
  const s = stats(samples, failures, performance.now() - start);
  return memoryEvery > 0 ? { ...s, memory } : s;
}

async function concurrent(n: number, concurrency: number, rpc: BenchRpc): Promise<LatencyStats> {
  const list = jobs(n);
  const samples: number[] = [];
  let failures = 0;
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < list.length) {
        const job = list[next++]!;
        const t = performance.now();
        const result = await once(job, rpc);
        samples.push(performance.now() - t);
        if (result.status !== "PROTECTED") failures += 1;
      }
    }),
  );
  return stats(samples, failures, performance.now() - start);
}

/** Deterministic jitter: 20 ms ± 10 ms per RPC call. */
function simulatedLatency(): () => number {
  let x = 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return 10 + ((x >>> 0) % 21);
  };
}

// --------------------------------------------------------------- worker threads

if (!isMainThread && parentPort) {
  const { n } = workerData as { n: number };
  const rpc = frozenRpc(frozenAnswers(), null);
  for (const job of jobs(100)) await once(job, rpc);
  const s = await sequential(n, rpc);
  parentPort.postMessage(s);
}

async function workers(count: number, perWorker: number): Promise<{ workers: number; perWorker: number; wallMs: number; throughputOpsPerSec: number; failures: number }> {
  const start = performance.now();
  const results = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<LatencyStats>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { n: perWorker } });
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    ),
  );
  const wallMs = performance.now() - start;
  return {
    workers: count,
    perWorker,
    wallMs: Number(wallMs.toFixed(1)),
    throughputOpsPerSec: Number(((count * perWorker) / wallMs * 1000).toFixed(1)),
    failures: results.reduce((a, r) => a + r.failures, 0),
  };
}

// ------------------------------------------------------------------ components

async function components(answers: Map<string, Encoded>): Promise<Record<string, LatencyStats>> {
  const rpc = frozenRpc(answers, null);
  const out: Record<string, LatencyStats> = {};
  const time = async (name: string, n: number, fn: () => Promise<unknown>) => {
    const samples: number[] = [];
    const start = performance.now();
    for (let i = 0; i < n; i += 1) {
      const t = performance.now();
      await fn();
      samples.push(performance.now() - t);
    }
    out[name] = stats(samples, 0, performance.now() - start);
  };
  const build = recordedBuild("KOx", "BUY");
  await time("supportsJupiterSwap (classification only)", 2000, () => supportsJupiterSwap({ build, rpc }));
  await time("fetchGuardSnapshot (mint + Clock decode)", 2000, () => fetchGuardSnapshot(rpc, MINTS.KOx!));
  await time("protectJupiterSwap (full PROTECTED build)", 2000, () => once({ fixture: FIXTURES[0]!, build }, rpc));
  return out;
}

// ------------------------------------------------------------------ B: real RPC

async function realRpc(url: string): Promise<Record<string, unknown>> {
  const rpc = createSolanaRpc(url) as unknown as BenchRpc;
  const build = recordedBuild("KOx", "BUY");
  const out: Record<string, unknown> = {};
  const run = async (name: string, n: number, concurrency: number, fn: () => Promise<unknown>) => {
    const samples: number[] = [];
    const errors: string[] = [];
    let next = 0;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < n) {
          next += 1;
          // Paced: the endpoint's rate limit must not decide the measurement.
          await new Promise((resolve) => setTimeout(resolve, 300 * concurrency));
          const t = performance.now();
          try {
            await fn();
            samples.push(performance.now() - t);
          } catch (error) {
            // Provider URLs often embed keys: never let one reach the report.
            const text = error instanceof Error ? error.message : String(error);
            errors.push(text.replaceAll(url, "<rpc-url>").replace(/https?:\/\/\S+/g, "<url>").slice(0, 120));
          }
        }
      }),
    );
    out[name] = { ...stats(samples, errors.length, performance.now() - start), concurrency, errorKinds: [...new Set(errors)].slice(0, 3) };
  };
  await run("getGenesisHash round trip", 10, 1, () => rpc.getGenesisHash().send());
  await run("fetchGuardSnapshot KOx (1 getMultipleAccounts)", 20, 1, () => fetchGuardSnapshot(rpc, MINTS.KOx!));
  await run("supportsJupiterSwap KOx BUY (1 getMultipleAccounts)", 20, 1, () => supportsJupiterSwap({ build, rpc }));
  await run("protectJupiterSwap on mainnet -> GUARD_DEPLOYMENT_UNAVAILABLE (2 reads)", 20, 1, async () => {
    const result = await protectJupiterSwap({ build, userPublicKey: TAKER, rpc, protectionWindow: WINDOW });
    if (result.status !== "ERROR" || result.code !== "GUARD_DEPLOYMENT_UNAVAILABLE") throw new Error(`unexpected ${result.status}`);
  });
  await run("fetchGuardSnapshot KOx, concurrency 4", 20, 4, () => fetchGuardSnapshot(rpc, MINTS.KOx!));
  return out;
}

// -------------------------------------------------------------------------- main

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { rpc: { type: "boolean" }, "rpc-only": { type: "boolean" }, out: { type: "string" } } });
  const outDir = values.out ?? "tmp/m11b/bench";
  mkdirSync(outDir, { recursive: true });
  if (values["rpc-only"]) {
    const url = process.env.EQUITYGUARD_MAINNET_RPC_URL;
    const rpcBacked = url ? await realRpc(url) : "skipped: EQUITYGUARD_MAINNET_RPC_URL is not set";
    const report = { kind: "equityguard-m11b-sdk-bench-rpc", generatedAt: new Date().toISOString(), node: process.version, rpcBacked };
    writeFileSync(join(outDir, `sdk-bench-rpc-${report.generatedAt.replaceAll(":", "")}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const answers = frozenAnswers();
  const counters: RpcCounters = { getMultipleAccounts: 0, getGenesisHash: 0, accountsRequested: 0, base64BytesServed: 0 };
  const counted = frozenRpc(answers, null, counters);
  const rpc = frozenRpc(answers, null);

  // Per-fixture sanity and RPC reads per build.
  const perFixture: Record<string, unknown> = {};
  for (const fixture of FIXTURES) {
    const before = { ...counters };
    const result = await once({ fixture, build: fixture.build() }, counted);
    perFixture[fixture.name] = {
      status: result.status,
      bytes: result.status === "PROTECTED" ? result.metrics.serializedTransactionBytes : null,
      rpcCalls: counters.getMultipleAccounts - before.getMultipleAccounts + counters.getGenesisHash - before.getGenesisHash,
      getMultipleAccounts: counters.getMultipleAccounts - before.getMultipleAccounts,
      getGenesisHash: counters.getGenesisHash - before.getGenesisHash,
      accountsRequested: counters.accountsRequested - before.accountsRequested,
      base64BytesServed: counters.base64BytesServed - before.base64BytesServed,
    };
  }

  const warmup = await sequential(500, rpc);
  const heapBefore = heapMb();
  const seq: Record<string, unknown> = {};
  for (const n of [1, 10, 100, 1000]) seq[String(n)] = await sequential(n, rpc);
  seq["10000"] = await sequential(10_000, rpc, 1000);
  const heapAfter = heapMb();

  const conc: Record<string, unknown> = {};
  for (const c of [1, 4, 16, 64, 128, 256]) conc[String(c)] = await concurrent(5000, c, rpc);

  const latency = simulatedLatency();
  const slow = frozenRpc(answers, latency);
  const simulated: Record<string, unknown> = {};
  for (const c of [1, 4, 16, 64, 128, 256]) simulated[String(c)] = await concurrent(c === 1 ? 100 : 2000, c, slow);

  const threads: unknown[] = [];
  for (const w of [1, 2, 4, 8]) threads.push(await workers(w, 1000));

  const parts = await components(answers);
  let rpcBacked: unknown = "skipped: pass --rpc with EQUITYGUARD_MAINNET_RPC_URL set";
  if (values.rpc) {
    const url = process.env.EQUITYGUARD_MAINNET_RPC_URL;
    rpcBacked = url ? await realRpc(url) : "skipped: EQUITYGUARD_MAINNET_RPC_URL is not set";
  }

  const report = {
    kind: "equityguard-m11b-sdk-bench",
    generatedAt: new Date().toISOString(),
    environment: {
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
      os: `${platform()} ${release()} ${arch()}`,
      node: process.version,
      v8: process.versions.v8,
      gcExposed: gc !== undefined,
    },
    method: {
      window: WINDOW,
      fixtures: FIXTURES.map((f) => f.name),
      rpc: "frozen in-memory answers (pre-encoded); simulated latency where stated is 10-30 ms per RPC call",
      failuresMean: "results other than PROTECTED",
    },
    perFixture,
    warmup,
    sequential: seq,
    heapUsedMb: { beforeSequential: heapBefore, afterSequential: heapAfter },
    concurrent5000: conc,
    concurrentSimulatedRpcLatency: simulated,
    workerThreads: threads,
    components: parts,
    rpcBacked,
  };
  writeFileSync(join(outDir, `sdk-bench-${report.generatedAt.replaceAll(":", "")}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
