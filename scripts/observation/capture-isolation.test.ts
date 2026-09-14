import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CaptureIsolationError,
  MIN_INPUT_QUIET_SECS,
  assertSafeCaptureInput,
  assertSafeOutput,
  openNewOutput,
} from "./capture-isolation.ts";
import { runDecodeCapture } from "./decode-capture.ts";
import { runDetectEvents } from "./detect-events.ts";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const KOX_MINT = "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ";

/** Committed real mainnet mint bytes, re-used to build synthetic capture copies. */
function fixtureBase64(symbol: string): string {
  return readFileSync(new URL(`../../programs/equity_guard/tests/fixtures/mainnet/${symbol}.base64`, import.meta.url), "utf8").trim();
}

/** Writes a small synthetic capture COPY and ages it past the quiet period. */
async function agedCaptureCopy(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eg-capture-"));
  const path = join(dir, "copy.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`);
  const past = new Date(Date.now() - (MIN_INPUT_QUIET_SECS + 60) * 1000);
  await utimes(path, past, past);
  return path;
}

function poll(slot: number, blockTime: number): string {
  return JSON.stringify({
    wallclock: new Date(blockTime * 1000).toISOString(),
    slot,
    blockTime,
    accounts: [{ symbol: "KOx", issuer: "xStocks", address: KOX_MINT, exists: true, owner: TOKEN_2022, data: fixtureBase64("KOx"), encoding: "base64" }],
  });
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

test("decode and detect read a copy without modifying it", async () => {
  const input = await agedCaptureCopy([poll(1, 1_781_481_299), poll(2, 1_781_481_300), "{broken"]);
  const before = { hash: await sha256(input), mtime: (await stat(input)).mtimeMs };

  const output = join(input, "..", "decoded.jsonl");
  assert.deepEqual(await runDecodeCapture(["--input", input, "--output", output], {}), { records: 3, errors: 1 });
  assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 3);

  const events = join(input, "..", "events.jsonl");
  assert.deepEqual(await runDetectEvents(["--input", input, "--output", events], {}), {
    ACTIVATION_PHASE_CHANGED: 1,
    DECODE_ERROR: 1,
  });

  assert.equal(await sha256(input), before.hash);
  assert.equal((await stat(input)).mtimeMs, before.mtime);
});

test("there is no default input path", async () => {
  await assert.rejects(runDecodeCapture([], {}), /--input/);
  await assert.rejects(runDetectEvents([], {}), /--input/);
});

test("recently modified inputs are refused as possibly live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eg-live-"));
  const live = join(dir, "equity-mints.jsonl");
  await writeFile(live, `${poll(1, 1)}\n`);
  await assert.rejects(assertSafeCaptureInput(live, { env: {} }), CaptureIsolationError);
  await assert.rejects(runDecodeCapture(["--input", live], {}), CaptureIsolationError);
});

test("protected capture paths are refused for input and output", async () => {
  const input = await agedCaptureCopy([poll(1, 1)]);
  const env = { EQUITYGUARD_PROTECTED_CAPTURE_PATHS: input };
  await assert.rejects(assertSafeCaptureInput(input, { env }), CaptureIsolationError);
  const other = await agedCaptureCopy([poll(1, 1)]);
  await assert.rejects(assertSafeOutput(input, other, env), CaptureIsolationError);
});

test("output can never be the input or an existing file", async () => {
  const input = await agedCaptureCopy([poll(1, 1)]);
  const before = await sha256(input);
  await assert.rejects(runDecodeCapture(["--input", input, "--output", input], {}), CaptureIsolationError);
  // A pre-existing file is never truncated: `wx` refuses to open it.
  const existing = join(input, "..", "existing.jsonl");
  await writeFile(existing, "keep\n");
  await assert.rejects(openNewOutput(existing), { code: "EEXIST" });
  assert.equal(await readFile(existing, "utf8"), "keep\n");
  assert.equal(await sha256(input), before);
});
