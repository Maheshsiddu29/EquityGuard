#!/usr/bin/env node
/**
 * Extracts an exact, immutable slice of a snapshot for a UTC interval
 * (INV-CAP-01).
 *
 * - Selected lines are copied byte-for-byte; nothing is decoded and
 *   re-serialized.
 * - A poll line is selected when its captured wallclock is in [start, end)
 *   and, with --symbols, it contains at least one of those symbols. The
 *   other accounts in that poll are kept as-is.
 * - The output is a new read-only file with a manifest (SHA-256, lines,
 *   first/last slot, gaps).
 *
 *   node scripts/observation/extract-window.ts --input <snapshot.jsonl> --start <ISO-Z> --end <ISO-Z> [--symbols KOx,KOon] --output <new.jsonl>
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CAPTURE_GAP_THRESHOLD_SECS } from "@equityguard/representation-state";

import {
  assertSafeCaptureInput,
  assertSafeOutput,
  sha256Hex,
  writeSealedCopy,
  type SealedManifest,
} from "./capture-isolation.ts";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

interface WindowGap {
  readonly fromWallclock: string;
  readonly toWallclock: string;
  readonly wallclockGapMs: number;
  readonly fromSlot: number | string | null;
  readonly toSlot: number | string | null;
}

function parseUtc(value: string | undefined, name: string): number {
  if (!value || !ISO_UTC.test(value)) throw new Error(`--${name} must be an ISO-8601 UTC timestamp ending in Z`);
  return Date.parse(value);
}

/** Splits into lines keeping each line's exact bytes, including its terminator. */
function splitLinesExact(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

function symbolsOf(record: Record<string, unknown>): string[] {
  if (Array.isArray(record.accounts)) {
    return record.accounts.flatMap((a) => (a && typeof a === "object" && typeof (a as { symbol?: unknown }).symbol === "string" ? [(a as { symbol: string }).symbol] : []));
  }
  return typeof record.symbol === "string" ? [record.symbol] : [];
}

export async function runExtractWindow(argv: string[], env: NodeJS.ProcessEnv): Promise<{ path: string; manifest: SealedManifest }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      symbols: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.input) throw new Error("--input <snapshot> is required; there is no default");
  if (!values.output) throw new Error("--output <new file> is required");
  const startMs = parseUtc(values.start, "start");
  const endMs = parseUtc(values.end, "end");
  if (endMs <= startMs) throw new Error("--end must be after --start");
  const symbols = values.symbols ? new Set(values.symbols.split(",").map((s) => s.trim()).filter(Boolean)) : null;

  const input = await assertSafeCaptureInput(values.input, { env });
  const output = await assertSafeOutput(values.output, input, env);
  const bytes = await readFile(input, { flag: "r" });

  const selected: Uint8Array[] = [];
  const gaps: WindowGap[] = [];
  let unplaceableLines = 0;
  let first: { wallclock: string; slot: number | string | null } | null = null;
  let last: { wallclock: string; ms: number; slot: number | string | null } | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const lineBytes of splitLinesExact(bytes)) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(decoder.decode(lineBytes));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      record = parsed as Record<string, unknown>;
    } catch {
      if (decoder.decode(lineBytes).trim() !== "") unplaceableLines += 1;
      continue;
    }
    const wallclock = typeof record.wallclock === "string" ? record.wallclock : typeof record.capturedAt === "string" ? record.capturedAt : null;
    const ms = wallclock === null ? Number.NaN : Date.parse(wallclock);
    if (wallclock === null || Number.isNaN(ms)) {
      unplaceableLines += 1;
      continue;
    }
    if (ms < startMs || ms >= endMs) continue;
    if (symbols && !symbolsOf(record).some((s) => symbols.has(s))) continue;

    const slot = typeof record.slot === "number" || typeof record.slot === "string" ? record.slot : null;
    if (last && ms - last.ms >= CAPTURE_GAP_THRESHOLD_SECS * 1000) {
      gaps.push({ fromWallclock: last.wallclock, toWallclock: wallclock, wallclockGapMs: ms - last.ms, fromSlot: last.slot, toSlot: slot });
    }
    first ??= { wallclock, slot };
    last = { wallclock, ms, slot };
    selected.push(lineBytes);
  }

  const out = new Uint8Array(selected.reduce((n, l) => n + l.length, 0));
  let offset = 0;
  for (const line of selected) {
    out.set(line, offset);
    offset += line.length;
  }
  const manifest = await writeSealedCopy(output, out, {
    kind: "equityguard-capture-window",
    source: input,
    sourceSha256: sha256Hex(bytes),
    start: values.start,
    end: values.end,
    symbols: symbols ? [...symbols] : null,
    firstWallclock: first?.wallclock ?? null,
    lastWallclock: last?.wallclock ?? null,
    firstSlot: first?.slot ?? null,
    lastSlot: last?.slot ?? null,
    gaps,
    unplaceableLines,
  });
  return { path: output, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExtractWindow(process.argv.slice(2), process.env)
    .then(({ path, manifest }) => console.log(JSON.stringify({ path, ...manifest }, null, 2)))
    .catch((error: unknown) => {
      console.error(`[extract-window] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
