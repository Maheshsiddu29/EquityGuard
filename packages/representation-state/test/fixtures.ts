import { readFileSync } from "node:fs";

import type { TransitionPolicy } from "../src/index.ts";

export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ACCOUNT_TYPE_OFFSET = 165;
const SCALED_UI_AMOUNT = 25;
const PAUSABLE = 26;

/** Real mainnet mint bytes captured at slot 446827429 (shared with the Rust program tests). */
export function mainnetMint(symbol: string): Uint8Array {
  const url = new URL(`../../../programs/equity_guard/tests/fixtures/mainnet/${symbol}.base64`, import.meta.url);
  return Uint8Array.from(Buffer.from(readFileSync(url, "utf8").trim(), "base64"));
}

function extensionValueOffset(data: Uint8Array, type: number): number {
  const view = new DataView(data.buffer, data.byteOffset);
  let offset = ACCOUNT_TYPE_OFFSET + 1;
  while (view.getUint16(offset, true) !== type) offset += 4 + view.getUint16(offset + 2, true);
  return offset + 4;
}

/** Copy of `data` with ScaledUiAmount fields overwritten. */
export function withScaledUi(
  data: Uint8Array,
  edit: { multiplier?: number; newMultiplier?: number; effectiveTimestamp?: bigint },
): Uint8Array {
  const copy = data.slice();
  const view = new DataView(copy.buffer);
  const value = extensionValueOffset(copy, SCALED_UI_AMOUNT);
  if (edit.multiplier !== undefined) view.setFloat64(value + 32, edit.multiplier, true);
  if (edit.effectiveTimestamp !== undefined) view.setBigInt64(value + 40, edit.effectiveTimestamp, true);
  if (edit.newMultiplier !== undefined) view.setFloat64(value + 48, edit.newMultiplier, true);
  return copy;
}

/** Copy of `data` with the Pausable flag set. */
export function withPaused(data: Uint8Array, paused: boolean): Uint8Array {
  const copy = data.slice();
  copy[extensionValueOffset(copy, PAUSABLE) + 32] = paused ? 1 : 0;
  return copy;
}

/** Test-only policy; not an issuer policy. */
export const TEST_POLICY: TransitionPolicy = {
  beforeSecs: 900n,
  afterSecs: 900n,
  calibration: "UNCALIBRATED",
  basis: "unit-test value",
};
