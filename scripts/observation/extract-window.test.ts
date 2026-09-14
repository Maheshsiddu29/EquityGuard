import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runSnapshot } from "./snapshot-capture.ts";
import { runExtractWindow } from "./extract-window.ts";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const KOX = { symbol: "KOx", issuer: "xStocks", address: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ" };
const KOON = { symbol: "KOon", issuer: "Ondo", address: "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo" };
const START = Date.parse("2026-09-14T23:40:00Z");

function fixture(symbol: string): string {
  return readFileSync(new URL(`../../programs/equity_guard/tests/fixtures/mainnet/${symbol}.base64`, import.meta.url), "utf8").trim();
}

/** Poll lines with deliberately irregular key spacing, so byte preservation is observable. */
function pollLine(offsetSecs: number, accounts = [KOX, KOON]): string {
  const body = {
    wallclock: new Date(START + offsetSecs * 1000).toISOString(),
    slot: 447_000_000 + offsetSecs * 2,
    blockTime: Math.floor(START / 1000) + offsetSecs,
    accounts: accounts.map((a) => ({ ...a, exists: true, owner: TOKEN_2022, data: fixture(a.symbol), encoding: "base64" })),
  };
  return JSON.stringify(body).replace('"slot":', '"slot" :');
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "eg-obs-"));
}

const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

async function writeBackup(dir: string, lines: string[]): Promise<string> {
  const path = join(dir, "equity-mints.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

async function sealedSnapshot(lines: string[]): Promise<{ dir: string; path: string }> {
  const dir = await tempDir();
  const backup = await writeBackup(dir, lines);
  const old = new Date(START - 3_600_000);
  await utimes(backup, old, old);
  const { path } = await runSnapshot(["--input", backup, "--output-dir", join(dir, "s")], {});
  return { dir, path };
}

test("extract-window preserves original line bytes and reports slots, lines and gaps", async () => {
  const lines = [pollLine(-30), pollLine(0), pollLine(30), "{not json", pollLine(120), pollLine(150, [KOON]), pollLine(2400)];
  const { dir, path } = await sealedSnapshot(lines);
  const output = join(dir, "window.jsonl");
  const { manifest } = await runExtractWindow(
    ["--input", path, "--start", "2026-09-14T23:40:00Z", "--end", "2026-09-15T00:20:00Z", "--symbols", "KOx", "--output", output],
    {},
  );
  const extracted = await readFile(output, "utf8");
  const expected = [pollLine(0), pollLine(30), pollLine(120)];
  // Byte-for-byte: the irregular `"slot" :` spacing survives, so nothing was re-serialized.
  assert.equal(extracted, `${expected.join("\n")}\n`);
  assert.ok(extracted.includes('"slot" :'));
  assert.deepEqual(
    [manifest.lines, manifest.firstSlot, manifest.lastSlot, manifest.unplaceableLines],
    [3, 447_000_000, 447_000_240, 1],
  );
  assert.deepEqual(manifest.gaps, [
    { fromWallclock: "2026-09-14T23:40:30.000Z", toWallclock: "2026-09-14T23:42:00.000Z", wallclockGapMs: 90_000, fromSlot: 447_000_060, toSlot: 447_000_240 },
  ]);
  assert.equal(manifest.sha256, await sha(output));
  assert.equal((await stat(output)).mode & 0o777, 0o444);
  // Destination must not exist.
  await assert.rejects(
    runExtractWindow(["--input", path, "--start", "2026-09-14T23:40:00Z", "--end", "2026-09-15T00:20:00Z", "--output", output], {}),
    { code: "EEXIST" },
  );
});

test("extract-window is reproducible and validates its interval", async () => {
  const { dir, path } = await sealedSnapshot([pollLine(0), pollLine(30), pollLine(60)]);
  const args = (out: string) => ["--input", path, "--start", "2026-09-14T23:40:00Z", "--end", "2026-09-14T23:41:00Z", "--output", join(dir, out)];
  const a = await runExtractWindow(args("a.jsonl"), {});
  const b = await runExtractWindow(args("b.jsonl"), {});
  assert.equal(a.manifest.sha256, b.manifest.sha256);
  assert.equal(a.manifest.lines, 2); // end is exclusive
  await assert.rejects(runExtractWindow(["--input", path, "--start", "2026-09-14 23:40", "--end", "2026-09-15T00:00:00Z", "--output", join(dir, "c")], {}), /ISO-8601 UTC/);
  await assert.rejects(runExtractWindow(["--input", path, "--start", "2026-09-15T00:00:00Z", "--end", "2026-09-14T23:40:00Z", "--output", join(dir, "d")], {}), /after --start/);
});
