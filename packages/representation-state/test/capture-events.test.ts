import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConflictEventDetector,
  ObservationEventDetector,
  captureRecordToJson,
  decodeCaptureLine,
  findRepresentationBySymbol,
  resolveOndoState,
  type CaptureRecord,
  type ObservationEventType,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withPaused, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOX_T = 1_781_481_300;

/** A poll-format line shaped like the external recorder's, built from committed fixtures. */
function pollLine(accounts: { symbol: string; data: Uint8Array; owner?: string; exists?: boolean }[], slot: number, blockTime: number): string {
  return JSON.stringify({
    wallclock: new Date(blockTime * 1000).toISOString(),
    slot,
    blockTime,
    accounts: accounts.map((a) => ({
      symbol: a.symbol,
      issuer: a.symbol.endsWith("x") ? "xStocks" : "Ondo",
      address: findRepresentationBySymbol(a.symbol)!.mint,
      exists: a.exists ?? true,
      owner: a.owner ?? TOKEN_2022,
      data: Buffer.from(a.data).toString("base64"),
      encoding: "base64",
    })),
  });
}

function decode(line: string, n = 1): CaptureRecord[] {
  return decodeCaptureLine(line, n);
}

function types(detector: ObservationEventDetector, records: CaptureRecord[]): ObservationEventType[] {
  return records.flatMap((r) => detector.push(r)).map((e) => e.type);
}

test("decodes a poll-format line, preserving wallclock, slot, blockTime and mint", () => {
  const records = decode(pollLine([{ symbol: "KOx", data: mainnetMint("KOx") }, { symbol: "KOon", data: mainnetMint("KOon") }], 446804766, 1789334677));
  assert.equal(records.length, 2);
  const [kox] = records;
  assert.ok(kox?.kind === "observation" && kox.evidence.kind === "decoded");
  assert.equal(kox.mint, KOX.mint);
  assert.equal(kox.slot, 446804766n);
  assert.equal(kox.blockTime, 1789334677n);
  assert.equal(kox.wallclock, "2026-09-13T21:24:37.000Z");
  assert.equal(kox.evidence.decimals, 8);
  assert.equal(kox.evidence.phase, 1);
  const json = captureRecordToJson(kox) as { evidence: { protectedState: { multiplierHex: string } } };
  assert.equal(json.evidence.protectedState.multiplierHex, "1efbb6d57038f03f");
});

test("decodes the repository recorder schema v1", () => {
  const line = JSON.stringify({
    schemaVersion: 1,
    capturedAt: "2026-09-13T12:00:00.000Z",
    slot: 5,
    blockTime: 6,
    symbol: "KOx",
    issuer: "xstocks",
    mint: KOX.mint,
    exists: true,
    owner: TOKEN_2022,
    dataBase64: Buffer.from(mainnetMint("KOx")).toString("base64"),
  });
  const [record] = decode(line);
  assert.ok(record?.kind === "observation" && record.evidence.kind === "decoded" && record.slot === 5n);
});

test("malformed JSON, unrecognized records and missing mints become line errors", () => {
  assert.deepEqual(decode("{not json").map((r) => r.kind === "line-error" && r.code), ["MalformedJson"]);
  assert.deepEqual(decode("[1,2]").map((r) => r.kind === "line-error" && r.code), ["UnrecognizedRecord"]);
  assert.deepEqual(decode('{"slot":1}').map((r) => r.kind === "line-error" && r.code), ["UnrecognizedRecord"]);
  assert.deepEqual(decode('{"slot":1,"blockTime":2,"accounts":[{"owner":"x"}]}').map((r) => r.kind === "line-error" && r.code), ["MissingMint"]);
  assert.deepEqual(decode("   "), []);
});

test("invalid owner, missing ScaledUiAmount and missing accounts are decode-error evidence", () => {
  const records = decode(
    pollLine(
      [
        { symbol: "KOx", data: mainnetMint("KOx"), owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { symbol: "KOon", data: mainnetMint("KOon").slice(0, 82) },
        { symbol: "UNHx", data: mainnetMint("UNHx"), exists: false },
      ],
      1,
      2,
    ),
  );
  assert.deepEqual(
    records.map((r) => (r.kind === "observation" && r.evidence.kind === "decode-error" ? r.evidence.code : "decoded")),
    ["InvalidMintOwner", "MissingScaledUiAmount", "AccountNotFound"],
  );
});

test("event detector: no change emits nothing", () => {
  const d = new ObservationEventDetector();
  const line = (slot: number, time: number) => decode(pollLine([{ symbol: "KOx", data: mainnetMint("KOx") }], slot, time));
  assert.deepEqual(types(d, [...line(1, KOX_T + 100), ...line(2, KOX_T + 130)]), []);
});

test("event detector: multiplier and effective timestamp changes", () => {
  const d = new ObservationEventDetector();
  const base = mainnetMint("KOx");
  const at = (data: Uint8Array, slot: number) => decode(pollLine([{ symbol: "KOx", data }], slot, KOX_T + 100 + slot));
  types(d, at(base, 1));
  const events = [
    ...at(withScaledUi(base, { newMultiplier: 1.05 }), 2).flatMap((r) => d.push(r)),
    ...at(withScaledUi(withScaledUi(base, { newMultiplier: 1.05 }), { effectiveTimestamp: BigInt(KOX_T + 500) }), 3).flatMap((r) => d.push(r)),
  ];
  assert.deepEqual(events.map((e) => [e.type, e.detail]), [
    ["SCALED_UI_STATE_CHANGED", ["newMultiplier"]],
    // The new timestamp is in the future relative to block time, so the phase flips back too.
    ["SCALED_UI_STATE_CHANGED", ["newMultiplierEffectiveTimestamp"]],
    ["ACTIVATION_PHASE_CHANGED", ["phase 1 -> 0"]],
  ]);
  const [first] = events;
  assert.ok(first?.previous && "kind" in first.previous && first.previous.kind === "observation");
  assert.equal(first.mint, KOX.mint);
  assert.equal(first.slot, 2n);
});

test("event detector: phase change with identical bytes as block time crosses T", () => {
  const d = new ObservationEventDetector();
  const data = mainnetMint("KOx");
  const events = [
    ...decode(pollLine([{ symbol: "KOx", data }], 1, KOX_T - 1)),
    ...decode(pollLine([{ symbol: "KOx", data }], 2, KOX_T)),
  ].flatMap((r) => d.push(r));
  assert.deepEqual(events.map((e) => e.type), ["ACTIVATION_PHASE_CHANGED"]);
});

test("event detector: pause change and deduplicated decode errors", () => {
  const d = new ObservationEventDetector();
  const data = mainnetMint("KOx");
  const at = (bytes: Uint8Array, slot: number, owner?: string) =>
    decode(pollLine([{ symbol: "KOx", data: bytes, ...(owner ? { owner } : {}) }], slot, KOX_T + 1000));
  assert.deepEqual(types(d, [...at(data, 1), ...at(withPaused(data, true), 2)]), ["PAUSE_STATE_CHANGED"]);
  const legacy = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  assert.deepEqual(types(d, [...at(data, 3, legacy), ...at(data, 4, legacy)]), ["DECODE_ERROR"]);
  assert.deepEqual(types(d, decode("{broken", 9)), ["DECODE_ERROR"]);
});

test("conflict detector emits when a resolved state enters conflict", () => {
  const koon = findRepresentationBySymbol("KOon")!;
  const chain = decode(pollLine([{ symbol: "KOon", data: mainnetMint("KOon") }], 1, 1_789_400_000))[0];
  assert.ok(chain?.kind === "observation");
  const api = (status: "active" | "paused") => ({ issuer: "Ondo" as const, symbol: "KOon", observedAt: "t", status, detail: null, calibration: "UNCALIBRATED" as const, sourceClass: "LIVE_API_STATE" as const, validUntil: "2026-09-14T00:01:00Z" });
  const d = new ConflictEventDetector();
  const agree = resolveOndoState(koon, { chain: chain.evidence, evaluatedAt: "2026-09-14T00:00:30Z", api: api("active") }, TEST_POLICY);
  const conflict = resolveOndoState(koon, { chain: chain.evidence, evaluatedAt: "2026-09-14T00:00:30Z", api: api("paused") }, TEST_POLICY);
  assert.deepEqual([agree, conflict, conflict].flatMap((r) => d.push(r)).map((e) => e.type), ["STATE_SOURCE_CONFLICT"]);
});
