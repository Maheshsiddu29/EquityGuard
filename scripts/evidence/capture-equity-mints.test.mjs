// @ts-check
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  CaptureError,
  SCHEMA_VERSION,
  buildRecords,
  parseConfig,
  parseMintList,
} from "./capture-equity-mints.mjs";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("parseMintList accepts well-formed entries", () => {
  const mints = parseMintList([
    { symbol: "AAAx", issuer: "xstocks", mint: MINT_A },
    { symbol: "AAAon", issuer: "ondo", mint: MINT_B },
  ]);
  assert.equal(mints.length, 2);
  assert.deepEqual(mints[1], { symbol: "AAAon", issuer: "ondo", mint: MINT_B });
});

test("parseMintList rejects bad config with a config error", () => {
  const cases = [
    [],
    {},
    [{ symbol: "A", issuer: "xstocks" }],
    [{ symbol: "A", issuer: "xstocks", mint: "not-base58-0OIl" }],
    [
      { symbol: "A", issuer: "xstocks", mint: MINT_A },
      { symbol: "B", issuer: "ondo", mint: MINT_A },
    ],
  ];
  for (const value of cases) {
    assert.throws(() => parseMintList(value), (e) => e instanceof CaptureError && e.kind === "config");
  }
});

test("example mint list is rejected until real addresses are filled in", async () => {
  const example = JSON.parse(await readFile(new URL("./mints.example.json", import.meta.url), "utf8"));
  assert.throws(() => parseMintList(example), CaptureError);
});

test("buildRecords preserves raw bytes and records missing accounts", () => {
  const mints = parseMintList([
    { symbol: "AAAx", issuer: "xstocks", mint: MINT_A },
    { symbol: "AAAon", issuer: "ondo", mint: MINT_B },
  ]);
  const capturedAt = new Date("2026-09-13T12:00:00.000Z");
  const records = buildRecords(
    mints,
    {
      context: { slot: 123 },
      value: [{ owner: TOKEN_2022, lamports: 5, executable: false, data: ["AQID", "base64"] }, null],
    },
    1_789_000_000,
    capturedAt,
  );

  assert.deepEqual(records[0], {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: "2026-09-13T12:00:00.000Z",
    wallclockMs: capturedAt.getTime(),
    slot: 123,
    blockTime: 1_789_000_000,
    commitment: "confirmed",
    symbol: "AAAx",
    issuer: "xstocks",
    mint: MINT_A,
    exists: true,
    owner: TOKEN_2022,
    lamports: 5,
    dataBase64: "AQID",
  });
  assert.equal(records[1].exists, false);
  assert.equal(records[1].dataBase64, null);
  assert.equal(records[1].slot, 123);
});

test("buildRecords fails on RPC shape mismatch instead of misattributing accounts", () => {
  const mints = parseMintList([{ symbol: "AAAx", issuer: "xstocks", mint: MINT_A }]);
  assert.throws(
    () => buildRecords(mints, { context: { slot: 1 }, value: [] }, null, new Date()),
    (e) => e instanceof CaptureError && e.kind === "rpc",
  );
  assert.throws(
    () =>
      buildRecords(
        mints,
        { context: { slot: 1 }, value: [{ owner: TOKEN_2022, lamports: 1, executable: false, data: ["{}", "json"] }] },
        null,
        new Date(),
      ),
    (e) => e instanceof CaptureError && e.kind === "rpc",
  );
});

test("parseConfig requires RPC URL from the environment and validates interval", () => {
  assert.throws(() => parseConfig(["--mints", "m.json"], {}), /EQUITYGUARD_MAINNET_RPC_URL/);
  assert.throws(
    () => parseConfig(["--mints", "m.json", "--interval-seconds", "0"], { EQUITYGUARD_MAINNET_RPC_URL: "http://x" }),
    /interval-seconds/,
  );
  const config = parseConfig(["--mints", "m.json", "--once"], { EQUITYGUARD_MAINNET_RPC_URL: "http://x" });
  assert.equal(config.intervalMs, 30_000);
  assert.equal(config.once, true);
  assert.equal(config.outPath, "evidence/mint-captures.jsonl");
});
