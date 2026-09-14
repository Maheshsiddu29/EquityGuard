import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CaptureIsolationError, verifiedManifest } from "./capture-isolation.ts";
import { runCorrelateKOx } from "./correlate-kox.ts";
import { runSnapshot } from "./snapshot-capture.ts";
import { runXStocksApiSnapshot } from "./snapshot-xstocks-api.ts";

const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const KOX_DATA = readFileSync(new URL("../../programs/equity_guard/tests/fixtures/mainnet/KOx.base64", import.meta.url), "utf8").trim();

async function fixtures(): Promise<{ dir: string; chain: string; api: string }> {
  const dir = await mkdtemp(join(tmpdir(), "eg-corr-"));
  const chain = join(dir, "equity-mints.jsonl");
  const api = join(dir, "KOx-multiplier.jsonl");
  const start = Date.parse("2026-09-14T17:34:00Z");
  const chainLines = [0, 30, 60].map((s) =>
    JSON.stringify({
      wallclock: new Date(start + s * 1000).toISOString(), slot: 447_000_000 + s, blockTime: start / 1000 + s,
      accounts: [{ symbol: "KOx", issuer: "xStocks", address: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", exists: true, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: KOX_DATA, encoding: "base64" }],
    }),
  );
  const apiLines = [
    '{"wallclock":"2026-09-14T17:34:01Z","response":{"currentMultiplier":1.0183317967386898,"newMultiplier":0,"activationDateTime":0,"reason":null}}',
    '{"wallclock":"2026-09-14T17:34:31Z","error":"request_failed"}',
    '{"wallclock":"2026-09-14T17:35:01Z","response":{"currentMultiplier":1.0183317967386898,"newMultiplier":0,"activationDateTime":0,"reason":null}}',
  ];
  await writeFile(chain, `${chainLines.join("\n")}\n`);
  await writeFile(api, `${apiLines.join("\n")}\n`);
  return { dir, chain, api };
}

test("API snapshot seals an exact read-only copy and verifies the watcher file", async () => {
  const { dir, api } = await fixtures();
  const before = await sha(api);
  const now = () => new Date("2026-09-14T18:00:00Z");
  const { path, manifest } = await runXStocksApiSnapshot(["--input", api, "--output-dir", join(dir, "s")], {}, { now });
  assert.deepEqual([manifest.kind, manifest.sha256, manifest.sourceSha256, manifest.lines], ["equityguard-xstocks-api-snapshot", before, before, 3]);
  assert.equal(await sha(path), before);
  assert.equal((await stat(path)).mode & 0o777, 0o444);
  assert.ok(await verifiedManifest(path));
  assert.equal(await sha(api), before);
  await assert.rejects(runXStocksApiSnapshot(["--input", api, "--output-dir", join(dir, "s")], {}, { now }), { code: "EEXIST" });
  await assert.rejects(
    runXStocksApiSnapshot(["--input", api, "--output-dir", join(dir, "t")], {}, { afterCopy: () => writeFile(api, "changed\n") }),
    /changed while it was being copied/,
  );
  assert.deepEqual(await readdir(join(dir, "t")), []);
});

test("correlate-kox is deterministic, reports source hashes and leaves inputs unchanged", async () => {
  const { dir, chain, api } = await fixtures();
  const chainSnap = (await runSnapshot(["--input", chain, "--output-dir", join(dir, "s")], {})).path;
  const apiSnap = (await runXStocksApiSnapshot(["--input", api, "--output-dir", join(dir, "a")], {})).path;
  const hashes = { chain: await sha(chainSnap), api: await sha(apiSnap) };

  const first = await runCorrelateKOx(["--chain", chainSnap, "--api", apiSnap, "--output", join(dir, "c1.json")], {});
  const second = await runCorrelateKOx(["--chain", chainSnap, "--api", apiSnap, "--output", join(dir, "c2.json")], {});
  assert.equal(first.text, second.text);
  assert.deepEqual(first.sourceHashes, hashes);
  assert.deepEqual({ chain: await sha(chainSnap), api: await sha(apiSnap) }, hashes);

  const document = JSON.parse(first.text) as { summary: { outcomes: string[] }; sourceHashes: unknown; quality: { api: { decodeErrors: number } }; crossSourceEvents: { type: string }[] };
  assert.deepEqual(document.summary.outcomes, ["NO_PENDING_UPDATE_OBSERVED"]);
  assert.deepEqual(document.sourceHashes, hashes);
  assert.equal(document.quality.api.decodeErrors, 1);
  assert.deepEqual(document.crossSourceEvents.map((e) => e.type), ["API_REQUEST_ERROR"]);
  assert.ok(!first.text.includes("rawLine"));
});

test("correlate-kox refuses unsealed live-looking inputs and requires both sources", async () => {
  const { chain, api } = await fixtures();
  await assert.rejects(runCorrelateKOx(["--chain", chain, "--api", api], {}), CaptureIsolationError);
  await assert.rejects(runCorrelateKOx(["--chain", chain], {}), /--api/);
});
