#!/usr/bin/env node
/**
 * Deterministic observation timeline over a sealed snapshot or aged copy
 * (INV-CAP-01). Emits JSONL: timeline entries in chronological order, then
 * one SUMMARY line with the input SHA-256 and evidence-quality metrics.
 *
 *   node scripts/observation/timeline.ts --input <snapshot.jsonl> [--symbols KOx,KOon] [--verbose] [--output <new.jsonl>]
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  buildTimeline,
  decodeCaptureLine,
  timelineJson,
  type CaptureRecord,
  type TimelineResult,
} from "@equityguard/representation-state";

import { assertSafeCaptureInput, assertSafeOutput, openNewOutput, readLinesReadOnly, sha256Hex } from "./capture-isolation.ts";

export interface TimelineRun {
  readonly result: TimelineResult;
  readonly inputSha256: string;
  /** Exact JSONL text produced (entries plus SUMMARY). */
  readonly text: string;
}

export async function runTimeline(argv: string[], env: NodeJS.ProcessEnv): Promise<TimelineRun> {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      symbols: { type: "string" },
      verbose: { type: "boolean", default: false },
      output: { type: "string" },
    },
  });
  if (!values.input) throw new Error("--input <snapshot> is required; there is no default");
  const input = await assertSafeCaptureInput(values.input, { env });
  const symbols = values.symbols ? new Set(values.symbols.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;

  const records: CaptureRecord[] = [];
  for await (const { line, lineNumber } of readLinesReadOnly(input)) records.push(...decodeCaptureLine(line, lineNumber));
  const result = buildTimeline(records, { ...(symbols ? { symbols } : {}), verbose: values.verbose ?? false });
  const inputSha256 = sha256Hex(await readFile(input, { flag: "r" }));

  const summary = {
    entry: "SUMMARY",
    inputSha256,
    symbols: symbols ? [...symbols] : null,
    overall: result.overall,
    bySymbol: result.bySymbol,
  };
  const text = [...result.entries, summary].map((e) => timelineJson(e)).join("\n") + "\n";
  if (values.output) {
    const sink = await openNewOutput(await assertSafeOutput(values.output, input, env));
    try {
      await sink.write(text);
    } finally {
      await sink.close();
    }
  } else {
    process.stdout.write(text);
  }
  return { result, inputSha256, text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTimeline(process.argv.slice(2), process.env)
    .then(({ result, inputSha256 }) => {
      const counts: Record<string, number> = {};
      for (const e of result.entries) counts[e.entry] = (counts[e.entry] ?? 0) + 1;
      console.error(`[timeline] input sha256 ${inputSha256}; entries ${JSON.stringify(counts)}; quality ${result.overall.status} (${result.overall.coveragePercent}% coverage)`);
    })
    .catch((error: unknown) => {
      console.error(`[timeline] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
