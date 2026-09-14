#!/usr/bin/env node
/**
 * Decodes a COPY of a raw capture JSONL into normalized observation records.
 * Read-only on the input (INV-CAP-01); output goes to stdout or a NEW file.
 *
 *   node scripts/observation/decode-capture.ts --input <copy.jsonl> [--output <new-file.jsonl>]
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { captureRecordToJson, decodeCaptureLine } from "@equityguard/representation-state";

import { assertSafeCaptureInput, assertSafeOutput, openNewOutput, readLinesReadOnly } from "./capture-isolation.ts";

export async function runDecodeCapture(argv: string[], env: NodeJS.ProcessEnv): Promise<{ records: number; errors: number }> {
  const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, output: { type: "string" } } });
  if (!values.input) throw new Error("--input <path to a copy of the capture> is required; there is no default");
  const input = await assertSafeCaptureInput(values.input, { env });
  const sink = values.output ? await openNewOutput(await assertSafeOutput(values.output, input, env)) : null;

  let records = 0;
  let errors = 0;
  try {
    for await (const { line, lineNumber } of readLinesReadOnly(input)) {
      for (const record of decodeCaptureLine(line, lineNumber)) {
        records += 1;
        if (record.kind === "line-error" || record.evidence.kind === "decode-error") errors += 1;
        const text = `${JSON.stringify(captureRecordToJson(record))}\n`;
        if (sink) await sink.write(text);
        else process.stdout.write(text);
      }
    }
  } finally {
    await sink?.close();
  }
  return { records, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDecodeCapture(process.argv.slice(2), process.env)
    .then(({ records, errors }) => console.error(`[decode-capture] ${records} records, ${errors} decode errors`))
    .catch((error: unknown) => {
      console.error(`[decode-capture] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
