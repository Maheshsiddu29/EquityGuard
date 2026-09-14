/**
 * INV-CAP-01 — Capture Isolation, enforced for analysis CLIs.
 *
 * The live capture file is append-only and single-writer. Analysis reads only
 * copies, opens them read-only, and writes only to new files that are neither
 * the input nor a protected capture path. There is deliberately no default
 * input path.
 */

import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve, delimiter } from "node:path";
import { createInterface } from "node:readline";

/**
 * A live recorder appends every ~30 s, so its file is never older than that.
 * Inputs modified more recently than this are refused as possibly live; copy
 * the capture and let the copy rest before analysing it.
 */
export const MIN_INPUT_QUIET_SECS = 90;

export class CaptureIsolationError extends Error {
  constructor(message: string) {
    super(`INV-CAP-01: ${message}`);
    this.name = "CaptureIsolationError";
  }
}

/** Paths that must never be analysed or written, from `EQUITYGUARD_PROTECTED_CAPTURE_PATHS`. */
export function protectedCapturePaths(env: NodeJS.ProcessEnv): string[] {
  return (env.EQUITYGUARD_PROTECTED_CAPTURE_PATHS ?? "")
    .split(delimiter)
    .filter((p) => p.trim() !== "")
    .map((p) => resolve(p));
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Refuses protected or possibly live inputs; returns the canonical input path. */
export async function assertSafeCaptureInput(
  inputPath: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly now?: Date },
): Promise<string> {
  const input = await canonical(inputPath);
  for (const protectedPath of protectedCapturePaths(options.env)) {
    if ((await canonical(protectedPath)) === input) {
      throw new CaptureIsolationError(`${input} is a protected live capture path; analyse a copy instead`);
    }
  }
  const info = await stat(input);
  if (!info.isFile()) throw new CaptureIsolationError(`${input} is not a regular file`);
  const ageSecs = ((options.now ?? new Date()).getTime() - info.mtimeMs) / 1000;
  if (ageSecs < MIN_INPUT_QUIET_SECS) {
    throw new CaptureIsolationError(
      `${input} was modified ${Math.max(0, Math.floor(ageSecs))}s ago and may be a live capture; ` +
        `copy it and retry once the copy has been unmodified for ${MIN_INPUT_QUIET_SECS}s`,
    );
  }
  return input;
}

/** Output must be a new file, distinct from the input and protected paths. */
export async function assertSafeOutput(outputPath: string, inputPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const output = await canonical(outputPath);
  const blocked = [await canonical(inputPath), ...(await Promise.all(protectedCapturePaths(env).map(canonical)))];
  if (blocked.includes(output)) throw new CaptureIsolationError(`refusing to write to ${output}`);
  return output;
}

/** Iterates lines of a file opened strictly read-only. */
export async function* readLinesReadOnly(path: string): AsyncGenerator<{ line: string; lineNumber: number }> {
  const stream = createReadStream(path, { flags: "r", encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      yield { line, lineNumber };
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Opens a brand-new output file. The `wx` flag fails if the path exists, so an
 * existing file (including any capture) can never be truncated or appended to.
 */
export async function openNewOutput(path: string): Promise<{ write(text: string): Promise<void>; close(): Promise<void> }> {
  const handle = await open(path, "wx");
  return {
    write: async (text) => {
      await handle.write(text);
    },
    close: () => handle.close(),
  };
}
