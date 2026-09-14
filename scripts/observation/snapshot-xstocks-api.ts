#!/usr/bin/env node
/**
 * Seals a copy of an xStocks API watcher JSONL file (INV-CAP-01). The source
 * is read once and re-verified unchanged, then written as a new read-only file
 * with a SHA-256 manifest under gitignored tmp/. The watcher is never written.
 *
 *   node scripts/observation/snapshot-xstocks-api.ts --input <KOx-multiplier.jsonl> [--output-dir tmp/observation]
 */

import { pathToFileURL } from "node:url";

import { sealSnapshot, type SnapshotHooks, type SnapshotResult } from "./snapshot-capture.ts";

export function runXStocksApiSnapshot(argv: string[], env: NodeJS.ProcessEnv, hooks: SnapshotHooks = {}): Promise<SnapshotResult> {
  return sealSnapshot(argv, env, hooks, "equityguard-xstocks-api-snapshot", "--input <path to the API watcher JSONL>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runXStocksApiSnapshot(process.argv.slice(2), process.env)
    .then(({ path, manifest }) =>
      console.log(JSON.stringify({ path, sha256: manifest.sha256, sourceSha256: manifest.sourceSha256, bytes: manifest.bytes, lines: manifest.lines, sourceVerifiedUnchanged: true }, null, 2)),
    )
    .catch((error: unknown) => {
      console.error(`[snapshot-xstocks-api] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
