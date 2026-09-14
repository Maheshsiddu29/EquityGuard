import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CaptureIsolationError, MANIFEST_SUFFIX, assertSafeCaptureInput, verifiedManifest } from "./capture-isolation.ts";
import { runSnapshot } from "./snapshot-capture.ts";
import { runTimeline } from "./timeline.ts";

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

test("snapshot copies the backup exactly into a new read-only sealed file", async () => {
  const dir = await tempDir();
  const backup = await writeBackup(dir, [pollLine(0), pollLine(30)]);
  const before = { hash: await sha(backup), mtime: (await stat(backup)).mtimeMs };
  const outDir = join(dir, "snapshots");
  const now = () => new Date("2026-09-14T12:00:00.000Z");

  const { path, manifest } = await runSnapshot(["--input", backup, "--output-dir", outDir], {}, { now });
  assert.equal(await sha(path), before.hash);
  assert.deepEqual([manifest.sha256, manifest.lines, manifest.bytes], [before.hash, 2, (await stat(backup)).size]);
  assert.equal((await stat(path)).mode & 0o777, 0o444);
  assert.ok(await verifiedManifest(path));
  // Source unchanged.
  assert.deepEqual({ hash: await sha(backup), mtime: (await stat(backup)).mtimeMs }, before);
  // Destination must not already exist: the same name again is refused.
  await assert.rejects(runSnapshot(["--input", backup, "--output-dir", outDir], {}, { now }), { code: "EEXIST" });
});

test("snapshot refuses protected paths and has no default input", async () => {
  const dir = await tempDir();
  const primary = await writeBackup(dir, [pollLine(0)]);
  await assert.rejects(runSnapshot(["--input", primary], { EQUITYGUARD_PROTECTED_CAPTURE_PATHS: primary }), CaptureIsolationError);
  await assert.rejects(runSnapshot([], {}), /--input/);
});

test("snapshot fails and leaves nothing behind if the source changes during the copy", async () => {
  const dir = await tempDir();
  const backup = await writeBackup(dir, [pollLine(0)]);
  const outDir = join(dir, "snapshots");
  await assert.rejects(
    runSnapshot(["--input", backup, "--output-dir", outDir], {}, { afterCopy: () => appendFile(backup, `${pollLine(30)}\n`) }),
    /changed while it was being copied/,
  );
  assert.deepEqual(await readdir(outDir), []);
});

test("a sealed copy bypasses the quiet period only while its bytes match the manifest", async () => {
  const dir = await tempDir();
  const backup = await writeBackup(dir, [pollLine(0)]);
  const { path } = await runSnapshot(["--input", backup, "--output-dir", join(dir, "s")], {});
  assert.equal(await assertSafeCaptureInput(path, { env: {} }), await realpath(path));
  // An unsealed, recently modified file is still refused.
  await assert.rejects(assertSafeCaptureInput(backup, { env: {} }), CaptureIsolationError);
  // A sealed name with a forged manifest is refused.
  const forged = join(dir, "forged.jsonl");
  await writeFile(forged, `${pollLine(0)}\n`);
  await writeFile(`${forged}${MANIFEST_SUFFIX}`, JSON.stringify({ kind: "equityguard-capture-snapshot", schemaVersion: 1, sha256: "00", bytes: 1, lines: 1 }));
  await assert.rejects(assertSafeCaptureInput(forged, { env: {} }), CaptureIsolationError);
});

async function sealedSnapshot(lines: string[]): Promise<{ dir: string; path: string }> {
  const dir = await tempDir();
  const backup = await writeBackup(dir, lines);
  const old = new Date(START - 3_600_000);
  await utimes(backup, old, old);
  const { path } = await runSnapshot(["--input", backup, "--output-dir", join(dir, "s")], {});
  return { dir, path };
}

test("timeline CLI is deterministic for the same snapshot bytes and leaves the input unchanged", async () => {
  const { dir, path } = await sealedSnapshot([pollLine(0), pollLine(30), "{broken", pollLine(90)]);
  const before = await sha(path);
  const first = await runTimeline(["--input", path, "--symbols", "KOx,KOon", "--output", join(dir, "t1.jsonl")], {});
  const second = await runTimeline(["--input", path, "--symbols", "KOx,KOon", "--output", join(dir, "t2.jsonl")], {});
  assert.equal(first.text, second.text);
  assert.equal(await sha(join(dir, "t1.jsonl")), await sha(join(dir, "t2.jsonl")));
  assert.equal(first.inputSha256, before);
  assert.equal(await sha(path), before);
  const summary = JSON.parse(first.text.trim().split("\n").at(-1) ?? "{}") as { entry: string; overall: { decodeErrors: number; gaps: number } };
  assert.deepEqual([summary.entry, summary.overall.decodeErrors, summary.overall.gaps], ["SUMMARY", 1, 1]);
});
