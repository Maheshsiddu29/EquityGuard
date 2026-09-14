#!/usr/bin/env node
/**
 * Detects protected/economic state changes in a COPY of a raw capture JSONL.
 * Read-only on the input (INV-CAP-01); events go to stdout or a NEW file.
 *
 *   node scripts/observation/detect-events.ts --input <copy.jsonl> [--output <new-events.jsonl>]
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  ObservationEventDetector,
  captureRecordToJson,
  decodeCaptureLine,
  type ObservationEvent,
  type ObservationEventType,
} from "@equityguard/representation-state";

import { assertSafeCaptureInput, assertSafeOutput, openNewOutput, readLinesReadOnly } from "./capture-isolation.ts";

function eventToJson(event: ObservationEvent): unknown {
  const project = (value: unknown) =>
    value && typeof value === "object" && "kind" in value ? captureRecordToJson(value as Parameters<typeof captureRecordToJson>[0]) : value;
  return JSON.parse(
    JSON.stringify({ ...event, previous: project(event.previous), current: project(event.current) }, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}

export async function runDetectEvents(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<Partial<Record<ObservationEventType, number>>> {
  const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, output: { type: "string" } } });
  if (!values.input) throw new Error("--input <path to a copy of the capture> is required; there is no default");
  const input = await assertSafeCaptureInput(values.input, { env });
  const sink = values.output ? await openNewOutput(await assertSafeOutput(values.output, input, env)) : null;

  const detector = new ObservationEventDetector();
  const counts: Partial<Record<ObservationEventType, number>> = {};
  try {
    for await (const { line, lineNumber } of readLinesReadOnly(input)) {
      for (const record of decodeCaptureLine(line, lineNumber)) {
        for (const event of detector.push(record)) {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          const text = `${JSON.stringify(eventToJson(event))}\n`;
          if (sink) await sink.write(text);
          else process.stdout.write(text);
        }
      }
    }
  } finally {
    await sink?.close();
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDetectEvents(process.argv.slice(2), process.env)
    .then((counts) => console.error(`[detect-events] ${JSON.stringify(counts)}`))
    .catch((error: unknown) => {
      console.error(`[detect-events] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
