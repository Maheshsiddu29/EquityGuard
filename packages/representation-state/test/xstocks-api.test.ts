import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  XStocksApiEventDetector,
  XStocksApiParseError,
  decodeCaptureLine,
  decodeXStocksApiLine,
  f64Hex,
  findRepresentationBySymbol,
  interpretActivationTime,
  isExecutionRelevant,
  parseXStocksHistoricalRecord,
  type XStocksApiObservation,
} from "../src/index.ts";
import { TOKEN_2022, mainnetMint } from "./fixtures.ts";

const CURRENT = 1.0183317967386898;

function apiLine(wallclock: string, response: Record<string, unknown>): string {
  return JSON.stringify({ wallclock, response });
}

const NO_PENDING = { currentMultiplier: CURRENT, newMultiplier: 0, activationDateTime: 0, reason: null };

function decodeAll(lines: string[]): XStocksApiObservation[] {
  return lines.map((l, i) => decodeXStocksApiLine(l, i + 1)).filter((o): o is XStocksApiObservation => o !== null);
}

function events(lines: string[]) {
  const detector = new XStocksApiEventDetector();
  return decodeAll(lines).flatMap((o) => detector.push(o));
}

test("zero pending fields are a valid no-pending state, not malformed", () => {
  const o = decodeXStocksApiLine(apiLine("2026-09-14T17:34:01Z", NO_PENDING), 1);
  assert.ok(o);
  assert.deepEqual(
    [o.decodeStatus, o.currentMultiplier, o.newMultiplier, o.activationDateTimeRaw, o.activationTime?.interpretation, o.reason, o.hasPendingUpdate, o.source],
    ["ok", CURRENT, 0, 0, "none", null, false, "LIVE_API_STATE"],
  );
  assert.equal(o.wallclockMs, Date.parse("2026-09-14T17:34:01Z"));
  assert.equal(o.rawLine, apiLine("2026-09-14T17:34:01Z", NO_PENDING));
});

test("API stable current state emits no events", () => {
  const lines = ["17:34:01", "17:34:31", "17:35:03"].map((t) => apiLine(`2026-09-14T${t}Z`, NO_PENDING));
  assert.deepEqual(events(lines), []);
});

test("0 -> pending multiplier and activation emits API_PENDING_UPDATE_PUBLISHED", () => {
  const pending = { currentMultiplier: CURRENT, newMultiplier: 1.0229, activationDateTime: "2026-09-14T23:55:00.000Z", reason: "Dividend" };
  const detected = events([apiLine("2026-09-14T20:00:00Z", NO_PENDING), apiLine("2026-09-14T20:00:30Z", pending)]);
  assert.deepEqual(detected.map((e) => e.type), ["API_PENDING_UPDATE_PUBLISHED"]);
  const [published] = detected;
  assert.equal(published?.lineNumber, 2);
  assert.equal(published?.previous?.hasPendingUpdate, false);
  assert.equal(published?.current.activationTime?.unixMs, Date.parse("2026-09-14T23:55:00.000Z"));
});

test("activation time, pending multiplier, reason and clearing changes", () => {
  const p = (newMultiplier: number, activationDateTime: unknown, reason: string | null) => ({ currentMultiplier: CURRENT, newMultiplier, activationDateTime, reason });
  const detected = events([
    apiLine("2026-09-14T20:00:00Z", p(1.0229, "2026-09-14T23:55:00.000Z", "Dividend")),
    apiLine("2026-09-14T20:00:30Z", p(1.0229, "2026-09-15T00:15:00.000Z", "Dividend")),
    apiLine("2026-09-14T20:01:00Z", p(1.0231, "2026-09-15T00:15:00.000Z", "Dividend")),
    apiLine("2026-09-14T20:01:30Z", p(1.0231, "2026-09-15T00:15:00.000Z", "Dividend (revised)")),
    apiLine("2026-09-15T00:16:00Z", { currentMultiplier: 1.0231, newMultiplier: 0, activationDateTime: 0, reason: null }),
  ]);
  assert.deepEqual(detected.map((e) => e.type), [
    "API_ACTIVATION_TIME_CHANGED",
    "API_PENDING_UPDATE_CHANGED",
    "API_REASON_CHANGED",
    "API_CURRENT_MULTIPLIER_CHANGED",
    "API_PENDING_UPDATE_CLEARED",
  ]);
});

test("request errors are explicit, deduplicated, and do not reset comparisons", () => {
  const detected = events([
    apiLine("2026-09-14T20:00:00Z", NO_PENDING),
    JSON.stringify({ wallclock: "2026-09-14T20:00:30Z", error: "request_failed" }),
    JSON.stringify({ wallclock: "2026-09-14T20:01:00Z", error: "request_failed" }),
    apiLine("2026-09-14T20:01:30Z", NO_PENDING),
  ]);
  assert.deepEqual(detected.map((e) => e.type), ["API_REQUEST_ERROR"]);
  assert.equal(detected[0]?.current.decodeStatus, "request-error");
});

test("malformed API records are explicit errors", () => {
  const cases = [
    "{not json",
    "[1]",
    JSON.stringify({ response: NO_PENDING }),
    apiLine("2026-09-14T20:00:00Z", { ...NO_PENDING, currentMultiplier: 0 }),
    apiLine("2026-09-14T20:00:00Z", { ...NO_PENDING, newMultiplier: -1 }),
    apiLine("2026-09-14T20:00:00Z", { ...NO_PENDING, activationDateTime: "tomorrow" }),
    apiLine("2026-09-14T20:00:00Z", { ...NO_PENDING, reason: 7 }),
    JSON.stringify({ wallclock: "2026-09-14T20:00:00Z", response: "oops" }),
  ];
  for (const line of cases) {
    assert.equal(decodeXStocksApiLine(line, 1)?.decodeStatus, "malformed", line);
  }
  assert.deepEqual(events(["{not json"]).map((e) => e.type), ["API_MALFORMED_RECORD"]);
  assert.equal(decodeXStocksApiLine("  ", 1), null);
});

test("activationDateTime interpretation is explicit", () => {
  assert.deepEqual(interpretActivationTime(0), { interpretation: "none", unixMs: null });
  assert.deepEqual(interpretActivationTime(null), { interpretation: "none", unixMs: null });
  assert.deepEqual(interpretActivationTime(1_781_481_300), { interpretation: "unix-seconds", unixMs: 1_781_481_300_000 });
  assert.deepEqual(interpretActivationTime(1_781_481_300_000), { interpretation: "unix-milliseconds", unixMs: 1_781_481_300_000 });
  assert.deepEqual(interpretActivationTime("2026-06-14T23:55:00.000Z"), { interpretation: "iso-8601", unixMs: 1_781_481_300_000 });
  for (const bad of [-1, 1.5, "2026-06-14", {}, true]) assert.throws(() => interpretActivationTime(bad), XStocksApiParseError);
});

test("historical June 2026 KOx record matches the on-chain KOx fixture exactly", () => {
  const { record } = JSON.parse(readFileSync(new URL("./fixtures/xstocks-kox-history-2026-06.json", import.meta.url), "utf8")) as { record: unknown };
  const history = parseXStocksHistoricalRecord(record);
  assert.equal(history.source, "HISTORICAL_API_STATE");
  assert.equal(history.reason, "Dividend");
  assert.equal(history.activationTime.unixMs, Date.parse("2026-06-14T23:55:00.000Z"));

  const [chain] = decodeCaptureLine(
    JSON.stringify({
      wallclock: "2026-09-13T21:24:38.436Z", slot: 446804766, blockTime: 1789334677,
      accounts: [{ symbol: "KOx", issuer: "xStocks", address: findRepresentationBySymbol("KOx")!.mint, exists: true, owner: TOKEN_2022, data: Buffer.from(mainnetMint("KOx")).toString("base64"), encoding: "base64" }],
    }),
    1,
  );
  assert.ok(chain?.kind === "observation" && chain.evidence.kind === "decoded");
  const stored = chain.evidence.protectedState;
  assert.equal(f64Hex(history.previousMultiplier), Buffer.from(stored.multiplier).toString("hex"));
  assert.equal(f64Hex(history.multiplier), Buffer.from(stored.newMultiplier).toString("hex"));
  assert.equal(BigInt(history.activationTime.unixMs ?? 0) / 1000n, stored.newMultiplierEffectiveTimestamp);
  for (const bad of [{ ...(record as object), multiplier: 0 }, { ...(record as object), activationDateTime: 0 }, null]) {
    assert.throws(() => parseXStocksHistoricalRecord(bad), XStocksApiParseError);
  }
});

test("only live chain state is execution-relevant", () => {
  assert.equal(isExecutionRelevant("LIVE_CHAIN_STATE"), true);
  for (const source of ["DOCUMENTED_SCHEDULE", "HISTORICAL_API_STATE", "LIVE_API_STATE"] as const) {
    assert.equal(isExecutionRelevant(source), false, source);
  }
});
