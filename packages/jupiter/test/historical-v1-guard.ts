/**
 * TEST-ONLY, HISTORICAL. The ABI v1 guard layout that the recorded M4 Jupiter
 * composition fixture (2026-09-14) was sized with. It exists only to
 * reproduce that recorded evidence byte-for-byte.
 *
 * It is not exported by any package and is never submit-capable: the
 * EquityGuard program candidate rejects ABI v1 with `UnsupportedVersion`, and
 * ABI v2 cannot guard a Jupiter swap at all (it binds only an immediately
 * following Token-2022 TransferChecked).
 */

import { AccountRole, type Address, type Instruction } from "@solana/kit";
import type { AssertSafeExecutionRequest } from "@equityguard/guard-client";

export function encodeHistoricalAbiV1(request: AssertSafeExecutionRequest): Uint8Array {
  const out = new Uint8Array(34);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out.set(request.expected.multiplier, 1);
  out.set(request.expected.newMultiplier, 9);
  view.setBigInt64(17, request.expected.newMultiplierEffectiveTimestamp, true);
  out[25] = request.expectedPhase;
  view.setUint32(26, request.window.beforeSecs, true);
  view.setUint32(30, request.window.afterSecs, true);
  return out;
}

export function historicalAbiV1GuardInstruction(input: { readonly programAddress: Address; readonly mint: Address; readonly request: AssertSafeExecutionRequest }): Instruction {
  return { programAddress: input.programAddress, accounts: [{ address: input.mint, role: AccountRole.READONLY }], data: encodeHistoricalAbiV1(input.request) };
}
