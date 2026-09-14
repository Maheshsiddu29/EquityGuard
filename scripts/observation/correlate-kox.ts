#!/usr/bin/env node
/**
 * Correlates a sealed KOx xStocks API snapshot with a sealed chain snapshot.
 * Both inputs must be sealed copies or quiet copies (INV-CAP-01); no network.
 * Output is one deterministic JSON document: summary, API intervals, chain
 * intervals, cross-source events, timing deltas, quality and source hashes.
 *
 *   node scripts/observation/correlate-kox.ts --chain <sealed-chain-snapshot> --api <sealed-api-snapshot> [--output <new.json>]
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  correlateKOx,
  decodeCaptureLine,
  decodeXStocksApiLine,
  findRepresentationBySymbol,
  timelineJson,
  type CaptureRecord,
  type KOxCorrelation,
  type XStocksApiObservation,
} from "@equityguard/representation-state";

import { assertSafeCaptureInput, assertSafeOutput, openNewOutput, readLinesReadOnly, sha256Hex } from "./capture-isolation.ts";

const SYMBOL = "KOx";

export interface CorrelateRun {
  readonly correlation: KOxCorrelation;
  readonly text: string;
  readonly sourceHashes: { readonly chain: string; readonly api: string };
}

export async function runCorrelateKOx(argv: string[], env: NodeJS.ProcessEnv): Promise<CorrelateRun> {
  const { values } = parseArgs({ args: argv, options: { chain: { type: "string" }, api: { type: "string" }, output: { type: "string" } } });
  if (!values.chain || !values.api) throw new Error("--chain <sealed chain snapshot> and --api <sealed API snapshot> are required");
  const chainPath = await assertSafeCaptureInput(values.chain, { env });
  const apiPath = await assertSafeCaptureInput(values.api, { env });
  const representation = findRepresentationBySymbol(SYMBOL);
  if (!representation) throw new Error(`${SYMBOL} is not in the registry`);

  const chain: CaptureRecord[] = [];
  for await (const { line, lineNumber } of readLinesReadOnly(chainPath)) chain.push(...decodeCaptureLine(line, lineNumber));
  const api: XStocksApiObservation[] = [];
  for await (const { line, lineNumber } of readLinesReadOnly(apiPath)) {
    const observation = decodeXStocksApiLine(line, lineNumber);
    if (observation) api.push(observation);
  }

  const correlation = correlateKOx({ api, chain, mint: representation.mint, symbol: SYMBOL });
  const sourceHashes = {
    chain: sha256Hex(await readFile(chainPath, { flag: "r" })),
    api: sha256Hex(await readFile(apiPath, { flag: "r" })),
  };
  const document = {
    kind: "equityguard-kox-api-chain-correlation",
    note: "Evidence only. Times are first-observed brackets at polling resolution; outcomes are descriptive, not routing policy.",
    summary: { symbol: SYMBOL, mint: representation.mint, outcomes: correlation.outcomes, derived: correlation.derived },
    apiIntervals: correlation.apiIntervals,
    chainIntervals: correlation.chainTimeline,
    crossSourceEvents: correlation.crossSourceEvents,
    timingDeltas: correlation.timingDeltas,
    quality: correlation.quality,
    sourceHashes,
  };
  const text = `${timelineJson(document)}\n`;
  if (values.output) {
    const sink = await openNewOutput(await assertSafeOutput(values.output, chainPath, env));
    try {
      await sink.write(text);
    } finally {
      await sink.close();
    }
  } else {
    process.stdout.write(text);
  }
  return { correlation, text, sourceHashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCorrelateKOx(process.argv.slice(2), process.env)
    .then(({ correlation, sourceHashes }) =>
      console.error(`[correlate-kox] outcomes ${JSON.stringify(correlation.outcomes)}; api quality ${correlation.quality.api.status}; chain quality ${correlation.quality.chain.status}; hashes ${JSON.stringify(sourceHashes)}`),
    )
    .catch((error: unknown) => {
      console.error(`[correlate-kox] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
