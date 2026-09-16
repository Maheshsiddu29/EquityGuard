#!/usr/bin/env node
/**
 * Lifts named observations out of a sealed capture into a curated fixture,
 * carrying provenance so the fixture can always be traced back.
 *
 * Read-only on the capture (INV-CAP-01) and refuses to overwrite: the output
 * must be a new file. Every emitted observation records the source file, its
 * SHA-256, the line number, the wallclock, slot, block time and the raw
 * account bytes exactly as captured. Nothing is derived, interpreted or
 * rounded here, so a fixture built this way is the capture, not a reading of
 * it.
 *
 *   node scripts/observation/curate-observations.ts \
 *     --input tmp/observation/<sealed>.jsonl \
 *     --output scripts/demo/fixtures/<name>.json \
 *     --kind equityguard-curated-... \
 *     --description "..." \
 *     --select <key>=<SYMBOL>@<lineNumber> [--select ...]
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertSafeCaptureInput, assertSafeOutput, openNewOutput, readLinesReadOnly } from "./capture-isolation.ts";

interface CapturedAccount {
  readonly symbol: string;
  readonly issuer: string;
  readonly address: string;
  readonly exists: boolean;
  readonly owner: string;
  readonly data: string;
}

interface CaptureLine {
  readonly wallclock: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly accounts: readonly CapturedAccount[];
}

export interface CuratedObservation {
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly lineNumber: number;
  readonly wallclock: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly symbol: string;
  readonly issuer: string;
  readonly mint: string;
  readonly owner: string;
  readonly dataBase64: string;
}

/** `<key>=<SYMBOL>@<lineNumber>` */
interface Selection {
  readonly key: string;
  readonly symbol: string;
  readonly lineNumber: number;
}

export function parseSelection(text: string): Selection {
  const match = /^([A-Za-z][\w]*)=([A-Za-z0-9]+)@(\d+)$/.exec(text);
  if (!match) throw new Error(`--select must look like key=SYMBOL@lineNumber, got ${text}`);
  return { key: match[1] as string, symbol: match[2] as string, lineNumber: Number(match[3]) };
}

export async function curate(
  inputPath: string,
  selections: readonly Selection[],
): Promise<Record<string, CuratedObservation>> {
  const sourceSha256 = createHash("sha256").update(await readFile(inputPath)).digest("hex");
  const sourceFile = basename(inputPath);
  const wanted = new Map<number, Selection[]>();
  for (const selection of selections) {
    wanted.set(selection.lineNumber, [...(wanted.get(selection.lineNumber) ?? []), selection]);
  }

  const out: Record<string, CuratedObservation> = {};
  for await (const { line, lineNumber } of readLinesReadOnly(inputPath)) {
    const matches = wanted.get(lineNumber);
    if (!matches) continue;
    const record = JSON.parse(line) as CaptureLine;
    for (const selection of matches) {
      const account = record.accounts.find((a) => a.symbol === selection.symbol);
      if (!account) throw new Error(`line ${lineNumber} has no account for ${selection.symbol}`);
      if (!account.exists) throw new Error(`line ${lineNumber}: ${selection.symbol} did not exist at capture time`);
      out[selection.key] = {
        sourceFile,
        sourceSha256,
        lineNumber,
        wallclock: record.wallclock,
        slot: record.slot,
        blockTime: record.blockTime,
        symbol: account.symbol,
        issuer: account.issuer,
        mint: account.address,
        owner: account.owner,
        dataBase64: account.data,
      };
    }
    wanted.delete(lineNumber);
  }
  if (wanted.size > 0) {
    throw new Error(`capture has no line ${[...wanted.keys()].join(", ")}`);
  }
  return out;
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      kind: { type: "string" },
      description: { type: "string" },
      select: { type: "string", multiple: true },
    },
  });
  if (!values.input || !values.output || !values.kind || !values.select?.length) {
    throw new Error("--input, --output, --kind and at least one --select are required");
  }
  const input = await assertSafeCaptureInput(values.input, { env });
  const output = await assertSafeOutput(values.output, input, env);
  const observations = await curate(input, values.select.map(parseSelection));

  const document = {
    kind: values.kind,
    description: values.description ?? null,
    environment: "MAINNET_OBSERVATION",
    observations,
  };
  const sink = await openNewOutput(output);
  await sink.write(`${JSON.stringify(document, null, 2)}\n`);
  await sink.close();
  console.error(`[curate-observations] ${Object.keys(observations).length} observations -> ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(`[curate-observations] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
