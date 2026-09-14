/**
 * INV-CAP-01 — Capture Isolation, enforced for analysis CLIs.
 *
 * The live capture file is append-only and single-writer. Analysis reads only
 * copies, opens them read-only, and writes only to new files that are neither
 * the input nor a protected capture path. There is deliberately no default
 * input path.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, open, readFile, realpath, stat } from "node:fs/promises";
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

/** Sidecar written next to every sealed snapshot or extracted window. */
export const MANIFEST_SUFFIX = ".manifest.json";
/** Snapshots and extracts are written read-only so later tools cannot alter them. */
const READ_ONLY_MODE = 0o444;

export interface SealedManifest {
  readonly kind: "equityguard-capture-snapshot" | "equityguard-capture-window";
  readonly schemaVersion: 1;
  readonly sha256: string;
  readonly bytes: number;
  readonly lines: number;
  readonly [key: string]: unknown;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Number of newline-terminated lines plus a trailing unterminated line, if any. */
export function countLines(bytes: Uint8Array): { lines: number; trailingNewline: boolean } {
  let newlines = 0;
  for (const byte of bytes) if (byte === 0x0a) newlines += 1;
  const trailingNewline = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
  return { lines: newlines + (trailingNewline ? 0 : 1), trailingNewline };
}

/**
 * Returns the manifest when `path` is a sealed copy whose current bytes still
 * match the recorded SHA-256 and size; otherwise null.
 */
export async function verifiedManifest(path: string): Promise<SealedManifest | null> {
  let manifest: SealedManifest;
  try {
    manifest = JSON.parse(await readFile(`${path}${MANIFEST_SUFFIX}`, "utf8")) as SealedManifest;
  } catch {
    return null;
  }
  const bytes = await readFile(path, { flag: "r" });
  return manifest.sha256 === sha256Hex(bytes) && manifest.bytes === bytes.length ? manifest : null;
}

/**
 * Writes `bytes` to a NEW file and a manifest beside it, both read-only.
 * `wx` guarantees nothing existing is overwritten.
 */
export async function writeSealedCopy(
  path: string,
  bytes: Uint8Array,
  manifest: { readonly kind: SealedManifest["kind"]; readonly [key: string]: unknown },
): Promise<SealedManifest> {
  const sealed: SealedManifest = {
    ...manifest,
    schemaVersion: 1,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    lines: countLines(bytes).lines,
  };
  const file = await open(path, "wx");
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  const sidecar = await open(`${path}${MANIFEST_SUFFIX}`, "wx");
  try {
    await sidecar.writeFile(`${JSON.stringify(sealed, null, 2)}\n`);
  } finally {
    await sidecar.close();
  }
  await chmod(path, READ_ONLY_MODE);
  await chmod(`${path}${MANIFEST_SUFFIX}`, READ_ONLY_MODE);
  return sealed;
}

/** Refuses protected inputs; returns the canonical path. Allows a recently modified file. */
export async function assertNotProtected(inputPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const input = await canonical(inputPath);
  for (const protectedPath of protectedCapturePaths(env)) {
    if ((await canonical(protectedPath)) === input) {
      throw new CaptureIsolationError(`${input} is a protected live capture path; use the backup instead`);
    }
  }
  return input;
}

/**
 * Refuses protected or possibly live inputs; returns the canonical input path.
 * A recently modified file is accepted only if it is a sealed copy whose
 * manifest still matches its bytes.
 */
export async function assertSafeCaptureInput(
  inputPath: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly now?: Date },
): Promise<string> {
  const input = await assertNotProtected(inputPath, options.env);
  const info = await stat(input);
  if (!info.isFile()) throw new CaptureIsolationError(`${input} is not a regular file`);
  const ageSecs = ((options.now ?? new Date()).getTime() - info.mtimeMs) / 1000;
  if (ageSecs < MIN_INPUT_QUIET_SECS && !(await verifiedManifest(input))) {
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
