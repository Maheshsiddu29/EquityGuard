import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActivationPhase,
  GuardClientError,
  decodeClock,
  decodeMintMetadata,
  decodeProtectedState,
  hasScheduledChange,
  phaseAt,
  type GuardClientErrorCode,
} from "../src/index.ts";
import { TOKEN_2022, hex, mainnetMint, readDecodedMints } from "./fixtures.ts";

const ACCOUNT_TYPE_OFFSET = 165;
const SCALED_UI_AMOUNT = 25;
const INTEREST_BEARING_CONFIG = 10;
const INTEREST_BEARING_CONFIG_LEN = 52;

function expectCode(fn: () => unknown, code: GuardClientErrorCode, label: string): void {
  assert.throws(fn, (e) => e instanceof GuardClientError && e.code === code, label);
}

function scaledUiValueOffset(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset);
  let offset = ACCOUNT_TYPE_OFFSET + 1;
  while (view.getUint16(offset, true) !== SCALED_UI_AMOUNT) {
    offset += 4 + view.getUint16(offset + 2, true);
  }
  return offset + 4;
}

test("decodes all six mainnet fixtures exactly as the independent extraction", () => {
  for (const expected of readDecodedMints()) {
    const state = decodeProtectedState(TOKEN_2022, mainnetMint(expected.symbol));
    assert.equal(hex(state.multiplier), expected.multiplierHex, expected.symbol);
    assert.equal(hex(state.newMultiplier), expected.newMultiplierHex, expected.symbol);
    assert.equal(state.newMultiplierEffectiveTimestamp, BigInt(expected.newMultiplierEffectiveTimestamp));
  }
});

test("phase and scheduled-change semantics match Token-2022", () => {
  const unhx = decodeProtectedState(TOKEN_2022, mainnetMint("UNHx"));
  const t = unhx.newMultiplierEffectiveTimestamp;
  assert.equal(phaseAt(unhx, t - 1n), ActivationPhase.Pending);
  assert.equal(phaseAt(unhx, t), ActivationPhase.Activated);
  assert.ok(hasScheduledChange(unhx));
  assert.ok(!hasScheduledChange(decodeProtectedState(TOKEN_2022, mainnetMint("UNHon"))));
});

test("fails closed on malformed accounts", () => {
  const original = mainnetMint("UNHx");
  const mutate = (edit: (data: Uint8Array) => void) => {
    const copy = original.slice();
    edit(copy);
    return copy;
  };
  const value = scaledUiValueOffset(original);

  expectCode(() => decodeProtectedState("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", original), "InvalidMintOwner", "legacy owner");
  expectCode(() => decodeProtectedState(TOKEN_2022, original.slice(0, 82)), "MissingScaledUiAmount", "no extensions");
  for (const len of [0, 81, 120, 165, original.length - 1]) {
    expectCode(() => decodeProtectedState(TOKEN_2022, original.slice(0, len)), "InvalidMintData", `truncated ${len}`);
  }
  const cases: [string, (d: Uint8Array) => void][] = [
    ["uninitialized", (d) => (d[45] = 0)],
    ["token account type", (d) => (d[ACCOUNT_TYPE_OFFSET] = 2)],
    ["non-zero padding", (d) => (d[100] = 1)],
    ["bad COption tag", (d) => (d[0] = 2)],
    ["TLV overrun", (d) => new DataView(d.buffer).setUint16(value - 2, 0xffff, true)],
    ["unknown extension type", (d) => new DataView(d.buffer).setUint16(value - 4, 0xffff, true)],
  ];
  for (const [label, edit] of cases) {
    expectCode(() => decodeProtectedState(TOKEN_2022, mutate(edit)), "InvalidMintData", label);
  }
});

test("rejects invalid stored multipliers", () => {
  const original = mainnetMint("KOx");
  const value = scaledUiValueOffset(original);
  const invalid = [0, -0, Number.NaN, Number.POSITIVE_INFINITY, -1, 5e-324];
  for (const bad of invalid) {
    for (const field of [32, 48]) {
      const copy = original.slice();
      new DataView(copy.buffer).setFloat64(value + field, bad, true);
      expectCode(() => decodeProtectedState(TOKEN_2022, copy), "InvalidMultiplier", `${bad} at ${field}`);
    }
  }
});

test("rejects ScaledUiAmount combined with InterestBearingConfig", () => {
  const original = mainnetMint("UNHx");
  const withInterest = new Uint8Array(original.length + 4 + INTEREST_BEARING_CONFIG_LEN);
  withInterest.set(original);
  const view = new DataView(withInterest.buffer);
  view.setUint16(original.length, INTEREST_BEARING_CONFIG, true);
  view.setUint16(original.length + 2, INTEREST_BEARING_CONFIG_LEN, true);
  expectCode(() => decodeProtectedState(TOKEN_2022, withInterest), "InvalidExtensionCombination", "combination");
});

test("decodes the Clock sysvar layout", () => {
  const data = new Uint8Array(40);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 123n, true);
  view.setBigInt64(32, -5n, true);
  assert.deepEqual(decodeClock(data), { slot: 123n, unixTimestamp: -5n });
  expectCode(() => decodeClock(new Uint8Array(39)), "InvalidClockData", "short clock");
});

test("decodes decimals and the real Pausable flag from mainnet fixtures", () => {
  // xStocks mints use 8 decimals and Ondo mints 9; all six carry Pausable, unpaused at capture.
  const expected: Record<string, number> = { UNHx: 8, KOx: 8, CRMx: 8, UNHon: 9, KOon: 9, CRMon: 9 };
  for (const [symbol, decimals] of Object.entries(expected)) {
    assert.deepEqual(decodeMintMetadata(TOKEN_2022, mainnetMint(symbol)), { decimals, paused: false });
  }
});

test("Pausable flag decoding fails closed and reports absence as null", () => {
  const original = mainnetMint("KOx");
  const view = new DataView(original.buffer, original.byteOffset);
  let offset = ACCOUNT_TYPE_OFFSET + 1;
  while (view.getUint16(offset, true) !== 26) offset += 4 + view.getUint16(offset + 2, true);
  const pausedFlag = offset + 4 + 32;

  const paused = original.slice();
  paused[pausedFlag] = 1;
  assert.equal(decodeMintMetadata(TOKEN_2022, paused).paused, true);

  const invalid = original.slice();
  invalid[pausedFlag] = 2;
  expectCode(() => decodeMintMetadata(TOKEN_2022, invalid), "InvalidMintData", "non-boolean pause flag");

  assert.equal(decodeMintMetadata(TOKEN_2022, original.slice(0, 82)).paused, null);
  expectCode(() => decodeMintMetadata("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", original), "InvalidMintOwner", "owner");
});
