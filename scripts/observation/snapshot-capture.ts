#!/usr/bin/env node
/**
 * Creates a sealed local analysis snapshot from the BACKUP capture file.
 * Copy only (INV-CAP-01). The source is read once, re-verified unchanged
 * after the copy, and never written. The snapshot and its manifest are new,
 * read-only files under a gitignored directory. There is no default input.
 *
 *   node scripts/observation/snapshot-capture.ts --input <backup.jsonl> [--output-dir tmp/observation]
 */

import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  CaptureIsolationError,
  MANIFEST_SUFFIX,
  assertNotProtected,
  countLines,
  sha256Hex,
  writeSealedCopy,
  type SealedManifest,
} from "./capture-isolation.ts";

export const DEFAULT_SNAPSHOT_DIR = join("tmp", "observation");

export interface SnapshotResult {
  readonly path: string;
  readonly manifest: SealedManifest;
  readonly sourceVerifiedUnchanged: true;
}

export interface SnapshotHooks {
  /** Clock used only to name the snapshot file. */
  readonly now?: () => Date;
  /** Runs between the copy and the source re-verification; test seam only. */
  readonly afterCopy?: () => Promise<void>;
}

export async function runSnapshot(argv: string[], env: NodeJS.ProcessEnv, hooks: SnapshotHooks = {}): Promise<SnapshotResult> {
  const now = hooks.now ?? (() => new Date());
  const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, "output-dir": { type: "string" } } });
  if (!values.input) throw new Error("--input <path to the BACKUP capture> is required; there is no default");
  const source = await assertNotProtected(values.input, env);

  const statBefore = await stat(source);
  if (!statBefore.isFile()) throw new CaptureIsolationError(`${source} is not a regular file`);
  const bytes = await readFile(source, { flag: "r" });
  const shaBefore = sha256Hex(bytes);

  const dir = values["output-dir"] ?? DEFAULT_SNAPSHOT_DIR;
  await mkdir(dir, { recursive: true });
  // The timestamp only names the file; analysis never reads the current clock.
  const stamp = now().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  const path = join(dir, `${stamp}-${basename(source)}`);
  const manifest = await writeSealedCopy(path, bytes, {
    kind: "equityguard-capture-snapshot",
    source,
    createdAt: now().toISOString(),
    sourceMtimeMs: statBefore.mtimeMs,
    trailingNewline: countLines(bytes).trailingNewline,
  });

  await hooks.afterCopy?.();
  const statAfter = await stat(source);
  const shaAfter = sha256Hex(await readFile(source, { flag: "r" }));
  if (shaAfter !== shaBefore || statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {
    // Only files this run created are removed; the source is never touched.
    await unlink(path);
    await unlink(`${path}${MANIFEST_SUFFIX}`);
    throw new CaptureIsolationError(`${source} changed while it was being copied; retry the snapshot`);
  }
  return { path, manifest, sourceVerifiedUnchanged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSnapshot(process.argv.slice(2), process.env)
    .then(({ path, manifest }) =>
      console.log(JSON.stringify({ path, sha256: manifest.sha256, bytes: manifest.bytes, lines: manifest.lines, trailingNewline: manifest.trailingNewline, sourceVerifiedUnchanged: true }, null, 2)),
    )
    .catch((error: unknown) => {
      console.error(`[snapshot-capture] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
