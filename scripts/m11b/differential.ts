#!/usr/bin/env node
/**
 * M11-B cross-implementation differential over a large seeded corpus.
 *
 * One generator, three implementations of the guard, one off-chain model:
 *
 * - TypeScript: the test mirror of the program (`guard-mirror.ts`), which
 *   calls the client's own decoder and `checkGuardOffline`;
 * - Rust host model: the program's decoders and `guard::check` in
 *   `processor.rs` order (`tests/common/mod.rs`), via the
 *   `m11b_differential` example;
 * - the compiled SBF program in LiteSVM, for every `--litesvm-every`-th case;
 * - the off-chain representation-state classifier (`classifyChainEvidence`),
 *   compared with the guard on every fresh-expectation case.
 *
 * Every case starts from one of the six real mainnet mint accounts and
 * changes one dimension at a time, so the generator can state the expected
 * verdict from the specification. Mutations whose effect would require
 * restating Token-2022's unpack are marked UNSPECIFIED: only agreement is
 * checked for them.
 *
 * Read-only and local: nothing is signed, sent or fetched.
 *
 *   cargo build-sbf && cargo build --example m11b_differential
 *   node scripts/m11b/differential.ts --seed 0x4d11b --count 100000 [--litesvm-every 50] [--out <dir>]
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { getAddressEncoder, type Address } from "@solana/kit";
import {
  ActivationPhase,
  KNOWN_PROTECTED_ASSETS,
  TOKEN_2022_PROGRAM_ADDRESS,
  downstreamCommitment,
  type EquityGuardErrorName,
} from "@equityguard/guard-client";
import { classifyChainEvidence, observeMintAccount } from "@equityguard/representation-state";

import { evaluateGuard } from "../../packages/guard-client/test/guard-mirror.ts";
import { Prng } from "../../packages/representation-state/test/prng.ts";
import {
  ExpectKind,
  FIXTURE_SYMBOLS,
  NO_CODE,
  PROGRAM_ID,
  codeOf,
  encodeCase,
  fixedAddress,
  fixtureMint,
  guardInstructionOf,
  mirrorInvocation,
  resultByte,
  resultName,
  transferCheckedOf,
  type GuardCase,
} from "./guard-cases.ts";

// ---------------------------------------------------------------- categories

export const CATEGORIES = [
  "FRESH",
  "STALE_PHASE",
  "STALE_MULTIPLIER",
  "STALE_NEW_MULTIPLIER",
  "STALE_TIMESTAMP",
  "IMMEDIATE_UPDATE_STALE",
  "PAUSED_FRESH",
  "MINT_INVALID_FLOAT",
  "REQUEST_INVALID_FLOAT",
  "REQUEST_INVALID_PHASE",
  "REQUEST_UNKNOWN_ADAPTER",
  "REQUEST_JUPITER_ADAPTER_ON_TRANSFER",
  "REQUEST_BAD_VERSION",
  "REQUEST_BAD_LENGTH",
  "MINT_KEY_MISMATCH",
  "COMMITMENT_MISMATCH",
  "MINT_WRONG_OWNER",
  "MINT_NO_EXTENSIONS",
  "MINT_DUPLICATE_TLV",
  "MINT_UNKNOWN_TLV",
  "MINT_FORBIDDEN_COMBINATION",
  "MINT_NOT_INITIALIZED_OR_NOT_MINT",
  "MINT_TRUNCATED",
  "MINT_RANDOM_BYTE_FLIPS",
] as const;
type Category = (typeof CATEGORIES)[number];
const categoryIndex = (name: Category) => CATEGORIES.indexOf(name);

/** Cumulative weights (out of 1000), in CATEGORIES order. */
const WEIGHTS: readonly number[] = [260, 100, 60, 60, 50, 60, 30, 40, 30, 15, 20, 10, 20, 20, 20, 25, 20, 10, 15, 15, 15, 20, 30, 55];

// ----------------------------------------------------------- real values

/** Multipliers observed on mainnet (docs/m10a-corporate-action-validation.md). */
const REAL_MULTIPLIERS = [
  1.013779482672994, 1.0183317967386898, 1.0225601246249238, 1.0196453194004143, 1.0238905041551842, 1.0229655423325776,
  1.0273478685368111, 1.0186608863722362, 1.023046908690707, 1.0036630653273484, 1.0054716788543585, 1.005894625750097,
];
/** Effective timestamps observed on mainnet. */
const REAL_TIMESTAMPS = [1789432200n, 1789430644n, 1789173000n, 1789344245n, 1781137800n, 1788344044n, 1781481300n];
const U32_MAX = 0xffff_ffff;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const MIN_POSITIVE_NORMAL_BITS = 0x0010_0000_0000_0000n;
const MAX_FINITE_BITS = 0x7fef_ffff_ffff_ffffn;

const TLV_START = 166;
const SCALED_UI = 25;
const PAUSABLE = 26;

interface Fixture {
  readonly symbol: string;
  readonly mint: Address;
  readonly data: Uint8Array;
  /** Value offset of the ScaledUiAmount config. */
  readonly scaled: number;
  /** Value offset of the Pausable config, if present. */
  readonly pausable: number | null;
  readonly decimals: number;
}

function tlvValueOffset(data: Uint8Array, type: number): number | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = TLV_START;
  while (offset + 4 <= data.length) {
    const t = view.getUint16(offset, true);
    const len = view.getUint16(offset + 2, true);
    if (t === 0) return null;
    if (t === type) return offset + 4;
    offset += 4 + len;
  }
  return null;
}

const FIXTURES: readonly Fixture[] = FIXTURE_SYMBOLS.map((symbol) => {
  const data = fixtureMint(symbol);
  const scaled = tlvValueOffset(data, SCALED_UI);
  if (scaled === null) throw new Error(`${symbol} fixture has no ScaledUiAmount`);
  const mint = KNOWN_PROTECTED_ASSETS.find((a) => a.symbol === symbol)?.mint;
  if (!mint) throw new Error(`${symbol} is not in the registry`);
  return { symbol, mint, data, scaled, pausable: tlvValueOffset(data, PAUSABLE), decimals: data[44] ?? 0 };
});

// ------------------------------------------------------------ f64 helpers

const f64Bytes = (value: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
};
const bitsBytes = (bits: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, bits & ((1n << 64n) - 1n), true);
  return out;
};
const bytesBits = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// --------------------------------------------------------------- generator

interface Economic {
  multiplier: Uint8Array;
  newMultiplier: Uint8Array;
  t: bigint;
}

class Generator {
  readonly prng: Prng;
  constructor(seed: bigint) {
    this.prng = new Prng(seed);
  }
  below(n: number) {
    return this.prng.below(n);
  }
  chance(oneIn: number) {
    return this.below(oneIn) === 0;
  }
  pick<T>(options: readonly T[]): T {
    return options[this.below(options.length)] as T;
  }

  validMultiplier(): Uint8Array {
    switch (this.below(10)) {
      case 0:
        return bitsBytes(MIN_POSITIVE_NORMAL_BITS + this.prng.belowBig(4n));
      case 1:
        return bitsBytes(MAX_FINITE_BITS - this.prng.belowBig(4n));
      case 2:
      case 3: {
        // Any positive normal: exponent 1..2046, random mantissa.
        const exponent = BigInt(1 + this.below(2046));
        return bitsBytes((exponent << 52n) | (this.prng.nextU64() & 0xf_ffff_ffff_ffffn));
      }
      case 4:
        return f64Bytes(0.01 + this.below(1_000_000) / 100_000);
      default:
        return f64Bytes(this.pick(REAL_MULTIPLIERS));
    }
  }

  /** A different valid multiplier: the adjacent representable value or another real one. */
  otherMultiplier(original: Uint8Array): Uint8Array {
    for (;;) {
      const bits = bytesBits(original);
      const candidate = this.chance(2) ? bitsBytes(this.chance(2) ? bits + 1n : bits - 1n) : this.validMultiplier();
      const bitsC = bytesBits(candidate);
      if (!eq(candidate, original) && bitsC >= MIN_POSITIVE_NORMAL_BITS && bitsC <= MAX_FINITE_BITS) return candidate;
    }
  }

  invalidMultiplier(): Uint8Array {
    switch (this.below(8)) {
      case 0:
        return bitsBytes(0n); // +0
      case 1:
        return bitsBytes(1n << 63n); // -0
      case 2:
        return bitsBytes(0x7ff8_0000_0000_0000n | (this.prng.nextU64() & 0x7_ffff_ffff_ffffn)); // quiet NaN
      case 3:
        return bitsBytes(0xfff0_0000_0000_0001n | (this.prng.nextU64() & 0xf_ffff_ffff_ffffn)); // negative NaN
      case 4:
        return bitsBytes(this.chance(2) ? 0x7ff0_0000_0000_0000n : 0xfff0_0000_0000_0000n); // ±inf
      case 5:
        return bitsBytes(1n + this.prng.belowBig(0xf_ffff_ffff_ffffn)); // subnormal
      default:
        return f64Bytes(-(0.01 + this.below(1_000_000) / 100_000)); // negative normal
    }
  }

  timestamp(): bigint {
    const r = this.below(20);
    if (r < 10) return this.pick(REAL_TIMESTAMPS);
    if (r < 17) return 1_600_000_000n + this.prng.belowBig(500_000_000n);
    return this.pick([I64_MIN, I64_MIN + 1n, I64_MAX - 1n, I64_MAX, 0n, -1n, -(10n ** 12n), 10n ** 15n]);
  }

  window(): { beforeSecs: number; afterSecs: number } {
    switch (this.below(9)) {
      case 0:
        return { beforeSecs: 0, afterSecs: 0 };
      case 1:
      case 2:
        return { beforeSecs: 900, afterSecs: 300 };
      case 3:
        return { beforeSecs: 1, afterSecs: 1 };
      case 4:
        return { beforeSecs: 86_400, afterSecs: 86_400 };
      case 5:
        return { beforeSecs: U32_MAX, afterSecs: U32_MAX };
      case 6:
        return this.chance(2) ? { beforeSecs: U32_MAX, afterSecs: 0 } : { beforeSecs: 0, afterSecs: U32_MAX };
      default:
        return { beforeSecs: this.below(U32_MAX), afterSecs: this.below(U32_MAX) };
    }
  }

  /** A chain time near T, on and around the window bounds, or far away. */
  clock(t: bigint, w: { beforeSecs: number; afterSecs: number }): bigint {
    const b = BigInt(w.beforeSecs);
    const a = BigInt(w.afterSecs);
    const candidates = [t - b - 1n, t - b, t - b + 1n, t - 1n, t, t + 1n, t + a - 1n, t + a, t + a + 1n, t - 60n, t + 60n];
    let now: bigint;
    switch (this.below(6)) {
      case 0:
      case 1:
      case 2:
        now = this.pick(candidates);
        break;
      case 3:
        now = t + BigInt(this.below(4_000_000)) - 2_000_000n;
        break;
      case 4:
        now = 1_780_000_000n + this.prng.belowBig(20_000_000n);
        break;
      default:
        now = this.pick([I64_MIN, I64_MAX, 0n, t + 10n ** 10n, t - 10n ** 10n]);
    }
    return now < I64_MIN || now > I64_MAX ? t : now;
  }
}

/** Economic state written into a mint copy's ScaledUiAmount config. */
function writeEconomic(data: Uint8Array, offset: number, e: Economic): void {
  data.set(e.multiplier, offset + 32);
  new DataView(data.buffer, data.byteOffset).setBigInt64(offset + 40, e.t, true);
  data.set(e.newMultiplier, offset + 48);
}

function readEconomic(data: Uint8Array, offset: number): Economic {
  return {
    multiplier: data.slice(offset + 32, offset + 40),
    t: new DataView(data.buffer, data.byteOffset).getBigInt64(offset + 40, true),
    newMultiplier: data.slice(offset + 48, offset + 56),
  };
}

export interface RequestFields {
  expectedMint: Address;
  multiplier: Uint8Array;
  newMultiplier: Uint8Array;
  t: bigint;
  phase: number;
  beforeSecs: number;
  afterSecs: number;
  adapter: number;
  commitment: Uint8Array;
}

/** Raw ABI v2 packing, without the client encoder's validation, so malformed requests can be expressed. */
export function packV2(r: RequestFields): Uint8Array {
  const out = new Uint8Array(99);
  const view = new DataView(out.buffer);
  out[0] = 2;
  out.set(getAddressEncoder().encode(r.expectedMint), 1);
  out.set(r.multiplier, 33);
  out.set(r.newMultiplier, 41);
  view.setBigInt64(49, r.t, true);
  out[57] = r.phase;
  view.setUint32(58, r.beforeSecs, true);
  view.setUint32(62, r.afterSecs, true);
  out[66] = r.adapter;
  out.set(r.commitment, 67);
  return out;
}

/**
 * The guard's economic policy, restated from `docs/invariants.md` I-1 (not
 * from either implementation): stored identity, then the scheduled-change
 * window with i64-bounded arithmetic, then the phase.
 */
export function specVerdict(request: Economic & { phase: number; beforeSecs: number; afterSecs: number }, actual: Economic, now: bigint): EquityGuardErrorName | null {
  if (!eq(request.multiplier, actual.multiplier)) return "MultiplierChanged";
  if (!eq(request.newMultiplier, actual.newMultiplier)) return "NewMultiplierChanged";
  if (request.t !== actual.t) return "EffectiveTimestampChanged";
  if (eq(actual.multiplier, actual.newMultiplier)) return null;
  const start = actual.t - BigInt(request.beforeSecs);
  const end = actual.t + BigInt(request.afterSecs);
  if (start < I64_MIN || end > I64_MAX) return "ArithmeticOverflow";
  if (start <= now && now <= end) return "InsideTransitionWindow";
  const phase = now >= actual.t ? ActivationPhase.Activated : ActivationPhase.Pending;
  return phase === request.phase ? null : "ActivationPhaseChanged";
}

function pickCategory(g: Generator): Category {
  const r = g.below(1000);
  let acc = 0;
  for (const [i, w] of WEIGHTS.entries()) {
    acc += w;
    if (r < acc) return CATEGORIES[i] as Category;
  }
  return "FRESH";
}

export function generateCase(g: Generator, index: number): GuardCase {
  const category = pickCategory(g);
  const fixture = g.pick(FIXTURES);
  let data: Uint8Array = fixture.data.slice();
  let owner = TOKEN_2022_PROGRAM_ADDRESS as Address;

  // The actual on-chain economic state.
  let actual: Economic;
  const shape = g.below(10);
  if (shape < 3 && category !== "IMMEDIATE_UPDATE_STALE") {
    actual = readEconomic(data, fixture.scaled);
  } else if (shape < 6 || category === "IMMEDIATE_UPDATE_STALE") {
    const m = g.validMultiplier();
    actual = { multiplier: m, newMultiplier: m.slice(), t: g.timestamp() };
  } else {
    const m = g.validMultiplier();
    actual = { multiplier: m, newMultiplier: g.otherMultiplier(m), t: g.timestamp() };
  }
  writeEconomic(data, fixture.scaled, actual);

  const window = g.window();
  const clock = g.clock(actual.t, window);
  const phase = clock >= actual.t ? ActivationPhase.Activated : ActivationPhase.Pending;
  const request: RequestFields = {
    expectedMint: fixture.mint,
    multiplier: actual.multiplier.slice(),
    newMultiplier: actual.newMultiplier.slice(),
    t: actual.t,
    phase,
    beforeSecs: window.beforeSecs,
    afterSecs: window.afterSecs,
    adapter: 1,
    commitment: new Uint8Array(32),
  };

  let expect: { kind: ExpectKind; code: number } | null = null;
  const exact = (name: EquityGuardErrorName) => ({ kind: ExpectKind.BLOCK_EXACT, code: codeOf(name) });
  let payloadEdit: ((payload: Uint8Array) => Uint8Array) | null = null;
  let flipCommitment = false;

  switch (category) {
    case "FRESH":
    case "PAUSED_FRESH":
      if (category === "PAUSED_FRESH" && fixture.pausable !== null) data[fixture.pausable + 32] = 1;
      break;
    case "STALE_PHASE":
      request.phase = phase === ActivationPhase.Activated ? ActivationPhase.Pending : ActivationPhase.Activated;
      break;
    case "STALE_MULTIPLIER":
      request.multiplier = g.otherMultiplier(actual.multiplier);
      break;
    case "STALE_NEW_MULTIPLIER":
      request.newMultiplier = g.otherMultiplier(actual.newMultiplier);
      break;
    case "STALE_TIMESTAMP": {
      const delta = g.pick([1n, -1n, 60n, -86_400n, 1n << 32n]);
      const t = actual.t + delta;
      request.t = t > I64_MAX || t < I64_MIN ? actual.t - delta : t;
      break;
    }
    case "IMMEDIATE_UPDATE_STALE": {
      // Quoted against the previous immediate-style state (m1 == m1, T1).
      const previous = g.otherMultiplier(actual.multiplier);
      request.multiplier = previous;
      request.newMultiplier = previous.slice();
      request.t = actual.t - BigInt(1 + g.below(86_400));
      break;
    }
    case "MINT_INVALID_FLOAT": {
      const bad = g.invalidMultiplier();
      data.set(bad, fixture.scaled + (g.chance(2) ? 32 : 48));
      expect = exact("InvalidMultiplier");
      break;
    }
    case "REQUEST_INVALID_FLOAT":
      if (g.chance(2)) request.multiplier = g.invalidMultiplier();
      else request.newMultiplier = g.invalidMultiplier();
      expect = exact("InvalidExpectedState");
      break;
    case "REQUEST_INVALID_PHASE":
      request.phase = 2 + g.below(254);
      expect = exact("InvalidExpectedState");
      break;
    case "REQUEST_UNKNOWN_ADAPTER":
      request.adapter = g.chance(4) ? 0 : 4 + g.below(252);
      expect = exact("UnsupportedAdapter");
      break;
    case "REQUEST_JUPITER_ADAPTER_ON_TRANSFER":
      // A TransferChecked suffix can never satisfy the route_v2 grammar.
      request.adapter = g.chance(2) ? 2 : 3;
      expect = { kind: ExpectKind.BLOCK_ANY, code: NO_CODE };
      break;
    case "REQUEST_BAD_VERSION":
      if (g.chance(5)) {
        payloadEdit = () => new Uint8Array();
        expect = exact("UnsupportedInstruction");
      } else {
        const version = g.pick([0, 1, 3, 255]);
        payloadEdit = (p) => {
          const out = g.chance(2) ? p.slice() : p.slice(0, 1 + g.below(98));
          out[0] = version;
          return out;
        };
        expect = exact("UnsupportedVersion");
      }
      break;
    case "REQUEST_BAD_LENGTH":
      payloadEdit = (p) => {
        if (g.chance(2)) return p.slice(0, 1 + g.below(98));
        const out = new Uint8Array(100 + g.below(100));
        out.set(p);
        return out;
      };
      expect = exact("InvalidInstructionLength");
      break;
    case "MINT_KEY_MISMATCH":
      request.expectedMint = g.pick(FIXTURES.filter((f) => f.mint !== fixture.mint)).mint;
      expect = exact("MintKeyMismatch");
      break;
    case "COMMITMENT_MISMATCH":
      flipCommitment = true;
      expect = exact("DownstreamCommitmentMismatch");
      break;
    case "MINT_WRONG_OWNER":
      owner = g.pick(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "11111111111111111111111111111111", fixedAddress(0xc3)]) as Address;
      expect = exact("InvalidMintOwner");
      break;
    case "MINT_NO_EXTENSIONS":
      data = data.slice(0, 82);
      expect = exact("MissingScaledUiAmount");
      break;
    case "MINT_DUPLICATE_TLV": {
      const entry = data.slice(fixture.scaled - 4, fixture.scaled + 56);
      if (g.chance(2)) entry.set(g.validMultiplier(), 4 + 32);
      data = concat(data, entry);
      expect = exact("InvalidMintData");
      break;
    }
    case "MINT_UNKNOWN_TLV": {
      const header = new Uint8Array(4);
      const view = new DataView(header.buffer);
      view.setUint16(0, 29 + g.below(65_536 - 29), true);
      view.setUint16(2, 0, true);
      data = concat(data, header);
      expect = exact("InvalidMintData");
      break;
    }
    case "MINT_FORBIDDEN_COMBINATION": {
      // InterestBearingConfig (type 10, 52 bytes) next to ScaledUiAmount.
      const entry = new Uint8Array(4 + 52);
      const view = new DataView(entry.buffer);
      view.setUint16(0, 10, true);
      view.setUint16(2, 52, true);
      data = concat(data, entry);
      expect = exact("InvalidExtensionCombination");
      break;
    }
    case "MINT_NOT_INITIALIZED_OR_NOT_MINT":
      if (g.chance(2)) data[45] = 0;
      else data[165] = g.pick([0, 2, 3, 255]);
      expect = exact("InvalidMintData");
      break;
    case "MINT_TRUNCATED":
      data = data.slice(0, g.below(data.length));
      expect = { kind: ExpectKind.UNSPECIFIED, code: NO_CODE };
      break;
    case "MINT_RANDOM_BYTE_FLIPS": {
      const flips = 1 + g.below(3);
      for (let i = 0; i < flips; i += 1) {
        const at = g.below(data.length);
        data[at] = (data[at] ?? 0) ^ (1 + g.below(255));
      }
      expect = { kind: ExpectKind.UNSPECIFIED, code: NO_CODE };
      break;
    }
  }

  // The guard at 0 and the committed TransferChecked at 1.
  const amount = BigInt(1 + g.below(1_000_000_000));
  const transfer = transferCheckedOf(fixture.mint, amount, fixture.decimals);
  const commitment = downstreamCommitment({
    programAddress: transfer.programId as Address,
    accounts: transfer.accounts.map((a) => ({ address: a.pubkey as Address, isSigner: a.isSigner, isWritable: a.isWritable })),
    data: transfer.data,
  });
  if (flipCommitment) {
    const at = g.below(32);
    commitment[at] = (commitment[at] ?? 0) ^ (1 << g.below(8));
  }
  request.commitment = commitment;
  let guardData = packV2(request);
  if (payloadEdit) guardData = payloadEdit(guardData);

  if (expect === null) {
    const verdict = specVerdict(
      { multiplier: request.multiplier, newMultiplier: request.newMultiplier, t: request.t, phase: request.phase, beforeSecs: request.beforeSecs, afterSecs: request.afterSecs },
      actual,
      clock,
    );
    expect = verdict === null ? { kind: ExpectKind.ALLOW, code: NO_CODE } : exact(verdict);
  }

  return {
    index,
    category: categoryIndex(category),
    expectKind: expect.kind,
    expectCode: expect.code,
    mintKey: fixture.mint,
    mintOwner: owner,
    mintData: data,
    guardData,
    clock,
    instructions: [guardInstructionOf(fixture.mint, guardData), transfer],
    currentIndex: 0,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ------------------------------------------------------ off-chain model

/**
 * For a fresh expectation, how the representation-state classifier relates
 * to the guard's verdict:
 *
 * - AGREE: SAFE/ok, TRANSITION/InsideTransitionWindow, UNKNOWN/decode failure;
 * - OFF_CHAIN_STRICTER_BY_DESIGN: PAUSED — the guard deliberately does not
 *   read the Pausable flag (Token-2022 blocks a paused transfer itself);
 * - UNBOUNDED_WINDOW: the guard fails closed with ArithmeticOverflow because
 *   `T ± window` leaves i64, which the bigint classifier does not model;
 * - GUARD_STRICTER / GUARD_MORE_PERMISSIVE: anything else, by direction.
 */
function offChainRelation(c: GuardCase, guard: string): { relation: string; state: string } {
  const evidence = observeMintAccount({ mint: c.mintKey, owner: c.mintOwner, data: c.mintData, slot: null, blockTime: null, observedAt: null, chainUnixTimestamp: c.clock });
  const view = new DataView(c.guardData.buffer, c.guardData.byteOffset, c.guardData.byteLength);
  const policy = { beforeSecs: BigInt(view.getUint32(58, true)), afterSecs: BigInt(view.getUint32(62, true)), calibration: "UNCALIBRATED" as const, basis: "M11-B differential" };
  const { state } = classifyChainEvidence(evidence, policy);
  const decodeErrors = ["InvalidMintOwner", "InvalidMintData", "MissingScaledUiAmount", "InvalidExtensionCombination", "InvalidMultiplier"];
  if ((state === "SAFE" && guard === "ok") || (state === "TRANSITION" && guard === "InsideTransitionWindow") || (state === "UNKNOWN" && decodeErrors.includes(guard))) {
    return { relation: "AGREE", state };
  }
  if (state === "PAUSED") return { relation: "OFF_CHAIN_STRICTER_BY_DESIGN", state };
  if (guard === "ArithmeticOverflow") return { relation: "UNBOUNDED_WINDOW", state };
  return { relation: guard === "ok" ? "GUARD_MORE_PERMISSIVE" : "GUARD_STRICTER", state };
}

// ------------------------------------------------------------------ driver

export interface DifferentialSummary {
  readonly seed: string;
  readonly generated: number;
  readonly corpusSha256: string;
  readonly byCategory: Record<string, number>;
  readonly byExpectation: Record<string, number>;
  readonly typescript: {
    readonly resultsSha256: string;
    readonly secs: number;
    readonly verdicts: Record<string, number>;
    readonly unexpectedAllows: number;
    readonly unexpectedBlocks: number;
    readonly exactMismatches: number;
    readonly examples: readonly string[];
  };
  readonly rust: Record<string, unknown>;
  readonly rustVsTypescript: { readonly disagreements: number; readonly examples: readonly string[] };
  readonly offChainModel: { readonly compared: number; readonly relations: Record<string, number>; readonly examples: readonly string[] };
  readonly generationAndTsSecs: number;
  readonly totalSecs: number;
}

const RUST_BINARY = new URL("../../target/debug/examples/m11b_differential", import.meta.url);

export async function runDifferential(options: { seed: bigint; count: number; litesvmEvery: number; outDir: string }): Promise<DifferentialSummary> {
  mkdirSync(options.outDir, { recursive: true });
  const tag = `seed-${options.seed.toString(16)}-n${options.count}`;
  const rustResults = join(options.outDir, `${tag}.rust.results`);
  const tsResults = new Uint8Array(options.count);
  const started = performance.now();

  const child = spawn(RUST_BINARY.pathname, ["--results", rustResults, "--litesvm-every", String(options.litesvmEvery)], { stdio: ["pipe", "pipe", "inherit"] });
  let rustStdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (rustStdout += chunk));
  const exited = once(child, "exit");

  const g = new Generator(options.seed);
  const corpus = createHash("sha256");
  const byCategory: Record<string, number> = {};
  const byExpectation: Record<string, number> = {};
  const verdicts: Record<string, number> = {};
  const tsExamples: string[] = [];
  let unexpectedAllows = 0;
  let unexpectedBlocks = 0;
  let exactMismatches = 0;
  const offChain = { compared: 0, relations: {} as Record<string, number>, examples: [] as string[] };
  const expectationNames = ["ALLOW", "BLOCK_EXACT", "BLOCK_ANY", "UNSPECIFIED"];
  let tsSecs = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    if (pendingBytes === 0) return;
    const chunk = Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    if (!child.stdin.write(chunk)) await once(child.stdin, "drain");
  };

  for (let index = 0; index < options.count; index += 1) {
    const c = generateCase(g, index);
    const record = encodeCase(c);
    corpus.update(record);
    pending.push(record);
    pendingBytes += record.length;
    if (pendingBytes >= 1 << 20) await flush();

    const category = CATEGORIES[c.category] as string;
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    const expectation = expectationNames[c.expectKind] as string;
    byExpectation[expectation] = (byExpectation[expectation] ?? 0) + 1;

    const t = performance.now();
    const verdict = await evaluateGuard(mirrorInvocation(c));
    tsSecs += (performance.now() - t) / 1000;
    const byte = resultByte(verdict);
    tsResults[index] = byte;
    const name = resultName(byte);
    verdicts[name] = (verdicts[name] ?? 0) + 1;
    const label = `case ${index} (${category})`;
    if (c.expectKind === ExpectKind.ALLOW && byte !== 0) {
      unexpectedBlocks += 1;
      if (tsExamples.length < 20) tsExamples.push(`${label}: unexpected ${name}`);
    } else if ((c.expectKind === ExpectKind.BLOCK_EXACT || c.expectKind === ExpectKind.BLOCK_ANY) && byte === 0) {
      unexpectedAllows += 1;
      if (tsExamples.length < 20) tsExamples.push(`${label}: unexpected allow`);
    } else if (c.expectKind === ExpectKind.BLOCK_EXACT && byte !== c.expectCode + 1) {
      exactMismatches += 1;
      if (tsExamples.length < 20) tsExamples.push(`${label}: expected ${resultName(c.expectCode + 1)}, got ${name}`);
    }
    if (category === "FRESH" || category === "PAUSED_FRESH") {
      offChain.compared += 1;
      const { relation, state } = offChainRelation(c, name);
      const key = `${relation}: ${state} vs ${name}`;
      offChain.relations[key] = (offChain.relations[key] ?? 0) + 1;
      if (relation.startsWith("GUARD_") && offChain.examples.length < 10) offChain.examples.push(`${label}: classifier ${state}, guard ${name}`);
    }
  }
  await flush();
  child.stdin.end();
  const generationAndTsSecs = (performance.now() - started) / 1000;
  const [code] = await exited;
  if (code !== 0) throw new Error(`m11b_differential exited with ${String(code)}`);
  const rust = JSON.parse(rustStdout) as Record<string, unknown>;

  const rustBytes = readFileSync(rustResults);
  const disagreements: string[] = [];
  let disagreementCount = rustBytes.length === options.count ? 0 : Math.abs(rustBytes.length - options.count);
  for (let i = 0; i < Math.min(rustBytes.length, options.count); i += 1) {
    if (rustBytes[i] !== tsResults[i]) {
      disagreementCount += 1;
      if (disagreements.length < 20) disagreements.push(`case ${i}: rust ${resultName(rustBytes[i] ?? 0)}, ts ${resultName(tsResults[i] ?? 0)}`);
    }
  }
  writeFileSync(join(options.outDir, `${tag}.ts.results`), tsResults);

  const summary: DifferentialSummary = {
    seed: `0x${options.seed.toString(16)}`,
    generated: options.count,
    corpusSha256: corpus.digest("hex"),
    byCategory,
    byExpectation,
    typescript: {
      resultsSha256: createHash("sha256").update(tsResults).digest("hex"),
      secs: Number(tsSecs.toFixed(3)),
      verdicts,
      unexpectedAllows,
      unexpectedBlocks,
      exactMismatches,
      examples: tsExamples,
    },
    rust,
    rustVsTypescript: { disagreements: disagreementCount, examples: disagreements },
    offChainModel: offChain,
    generationAndTsSecs: Number(generationAndTsSecs.toFixed(3)),
    totalSecs: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
  writeFileSync(join(options.outDir, `${tag}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { seed: { type: "string" }, count: { type: "string" }, "litesvm-every": { type: "string" }, out: { type: "string" } },
  });
  runDifferential({
    seed: BigInt(values.seed ?? "0x4d11b"),
    count: Number(values.count ?? "100000"),
    litesvmEvery: Number(values["litesvm-every"] ?? "0"),
    outDir: values.out ?? "tmp/m11b/differential",
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export { Generator, PROGRAM_ID };
