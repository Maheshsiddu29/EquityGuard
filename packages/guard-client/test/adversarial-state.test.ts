/**
 * M11-A step 5, client half: the same two properties
 * `programs/equity_guard/tests/adversarial_state.rs` states for the program,
 * over the decoder and offline check the SDK refuses with before signing.
 *
 * 1. `checkGuardOffline` equals an independent bigint specification at the
 *    extremes of timestamps, windows and clocks.
 * 2. Every single-byte mutation of every real mainnet mint either fails to
 *    decode or decodes to a state the original expectation still rejects,
 *    unless the protected bytes are untouched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase, bytesEqual, checkGuardOffline, decodeProtectedState, type ProtectedState, type ProtectionWindow } from "../src/index.ts";
import { TOKEN_2022, mainnetMint } from "./fixtures.ts";

const SYMBOLS = ["KOx", "UNHx", "CRMx", "KOon", "UNHon", "CRMon"];
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U32_MAX = 2 ** 32 - 1;

/** Deterministic splitmix64 over bigints. */
function rng(seed: bigint): () => bigint {
  let state = seed;
  const mask = 2n ** 64n - 1n;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & mask;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return z ^ (z >> 31n);
  };
}

const f64 = (value: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
};

function spec(state: ProtectedState, phase: ActivationPhase, window: ProtectionWindow, now: bigint): string | null {
  if (bytesEqual(state.multiplier, state.newMultiplier)) return null;
  const t = state.newMultiplierEffectiveTimestamp;
  const start = t - BigInt(window.beforeSecs);
  const end = t + BigInt(window.afterSecs);
  if (start < I64_MIN || end > I64_MAX) return "ArithmeticOverflow";
  if (start <= now && now <= end) return "InsideTransitionWindow";
  return (now >= t ? ActivationPhase.Activated : ActivationPhase.Pending) === phase ? null : "ActivationPhaseChanged";
}

test("M11-A: the offline clock policy equals the bigint specification at the extremes", () => {
  const next = rng(0x0e11a5ecn);
  const pick = <T>(items: readonly T[]) => items[Number(next() % BigInt(items.length))] as T;
  const specialT = [I64_MIN, I64_MIN + 1n, -1n, 0n, 1n, 1_781_481_300n, I64_MAX - 1n, I64_MAX];
  const specialSecs = [0, 1, 299, 300, 900, U32_MAX - 1, U32_MAX];
  const outcomes = new Map<string, number>();
  for (let i = 0; i < 50_000; i += 1) {
    const t = next() % 2n === 0n ? pick(specialT) : BigInt.asIntN(64, next());
    const secs = () => (next() % 2n === 0n ? pick(specialSecs) : Number(next() >> 32n));
    const window = { beforeSecs: secs(), afterSecs: secs() };
    const offsets = [-BigInt(window.beforeSecs) - 1n, -BigInt(window.beforeSecs), -1n, 0n, 1n, BigInt(window.afterSecs), BigInt(window.afterSecs) + 1n];
    const roll = next() % 4n;
    let now = roll === 0n ? pick([I64_MIN, I64_MAX, 0n]) : roll === 1n ? BigInt.asIntN(64, next()) : t + pick(offsets);
    if (now < I64_MIN || now > I64_MAX) now = t;
    const scheduled = next() % 8n !== 0n;
    const state: ProtectedState = { multiplier: f64(1), newMultiplier: scheduled ? f64(1 + Number.EPSILON) : f64(1), newMultiplierEffectiveTimestamp: t };
    const phase = next() % 2n === 0n ? ActivationPhase.Pending : ActivationPhase.Activated;
    const actual = checkGuardOffline({ expected: state, expectedPhase: phase, window }, state, now);
    assert.equal(actual, spec(state, phase, window, now), `t=${t} now=${now} window=${JSON.stringify(window)} phase=${phase}`);
    const key = actual ?? "ok";
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
  }
  assert.equal(outcomes.size, 4, JSON.stringify([...outcomes]));
});

test("M11-A: every single-byte mutation of a real mint fails closed or changes nothing protected", () => {
  const now = 1_800_000_000n;
  let refused = 0;
  let rejected = 0;
  let unchanged = 0;
  for (const symbol of SYMBOLS) {
    const original = mainnetMint(symbol);
    const state = decodeProtectedState(TOKEN_2022, original);
    for (const phase of [ActivationPhase.Pending, ActivationPhase.Activated]) {
      const request = { expected: state, expectedPhase: phase, window: { beforeSecs: 0, afterSecs: 0 } };
      const baseline = checkGuardOffline(request, state, now);
      for (let offset = 0; offset < original.length; offset += 1) {
        for (const mask of [0x01, 0x10, 0x80, 0xff]) {
          const data = original.slice();
          data[offset] = (data[offset] ?? 0) ^ mask;
          let mutated: ProtectedState;
          try {
            mutated = decodeProtectedState(TOKEN_2022, data);
          } catch {
            refused += 1;
            continue;
          }
          const same =
            bytesEqual(mutated.multiplier, state.multiplier) &&
            bytesEqual(mutated.newMultiplier, state.newMultiplier) &&
            mutated.newMultiplierEffectiveTimestamp === state.newMultiplierEffectiveTimestamp;
          if (same) {
            assert.equal(checkGuardOffline(request, mutated, now), baseline);
            unchanged += 1;
          } else {
            assert.notEqual(checkGuardOffline(request, mutated, now), null, `${symbol} byte ${offset} ^ ${mask} accepted`);
            rejected += 1;
          }
        }
      }
    }
  }
  assert.ok(refused > 0 && rejected > 0 && unchanged > 0, `${refused}/${rejected}/${unchanged}`);
});
