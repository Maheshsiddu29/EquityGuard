/**
 * Property tests for quote identity: the canonical key must change for every
 * security-relevant field, and the canonical serialization must not admit two
 * different values that encode the same way.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import {
  QuoteIdentityError,
  assertQuoteIdentityTypes,
  canonicalKey,
  quoteKey,
  quoteMismatches,
  routeIdentity,
  type QuoteIdentity,
  type QuoteMismatchCode,
} from "../src/index.ts";
import { PREFERRED_OUT, kox, quote, TRANSITION_TIME } from "./scenario.ts";

const BASE: QuoteIdentity = quote(kox(TRANSITION_TIME), PREFERRED_OUT);

/** Every mutation that must produce a different key, with the code it should report. */
const MUTATIONS: readonly (readonly [string, QuoteIdentity, QuoteMismatchCode])[] = [
  ["underlying", { ...BASE, underlying: "PEP" }, "UNDERLYING_CHANGED"],
  ["input mint", { ...BASE, inputMint: "So11111111111111111111111111111111111111112" }, "INPUT_MINT_CHANGED"],
  ["output mint", { ...BASE, mint: "So11111111111111111111111111111111111111112" }, "OUTPUT_MINT_CHANGED"],
  ["input amount", { ...BASE, inputRaw: BASE.inputRaw + 1n }, "INPUT_AMOUNT_CHANGED"],
  ["output amount", { ...BASE, outputRaw: BASE.outputRaw + 1n }, "OUTPUT_AMOUNT_CHANGED"],
  ["output amount down", { ...BASE, outputRaw: BASE.outputRaw - 1n }, "OUTPUT_AMOUNT_CHANGED"],
  ["minimum output", { ...BASE, minOutputRaw: (BASE.minOutputRaw ?? 0n) + 1n }, "MIN_OUTPUT_CHANGED"],
  ["minimum output cleared", { ...BASE, minOutputRaw: null }, "MIN_OUTPUT_CHANGED"],
  ["quoted at", { ...BASE, quotedAt: "2026-09-15T04:22:16.046Z" }, "QUOTE_CONTEXT_CHANGED"],
  ["context slot", { ...BASE, contextSlot: (BASE.contextSlot ?? 0n) + 1n }, "QUOTE_CONTEXT_CHANGED"],
  ["context slot cleared", { ...BASE, contextSlot: null }, "QUOTE_CONTEXT_CHANGED"],
  ["route source", { ...BASE, route: { ...BASE.route, source: "OTHER_SOURCE" } }, "ROUTE_CHANGED"],
  ["route id", { ...BASE, route: { ...BASE.route, routeId: "provider-route-7" } }, "ROUTE_CHANGED"],
  ["decimals", { ...BASE, state: { ...BASE.state, decimals: BASE.state.decimals + 1 } }, "ECONOMIC_STATE_CHANGED"],
  ["multiplier", { ...BASE, state: { ...BASE.state, multiplierHex: "000000000000f03f" } }, "ECONOMIC_STATE_CHANGED"],
  ["new multiplier", { ...BASE, state: { ...BASE.state, newMultiplierHex: "000000000000f03f" } }, "ECONOMIC_STATE_CHANGED"],
  ["effective timestamp", { ...BASE, state: { ...BASE.state, effectiveTimestamp: BASE.state.effectiveTimestamp + 1n } }, "ECONOMIC_STATE_CHANGED"],
  ["paused flag", { ...BASE, state: { ...BASE.state, paused: true } }, "ECONOMIC_STATE_CHANGED"],
  ["state mint", { ...BASE, state: { ...BASE.state, mint: "So11111111111111111111111111111111111111112" } }, "ECONOMIC_STATE_CHANGED"],
  [
    "phase",
    {
      ...BASE,
      state: {
        ...BASE.state,
        phase: BASE.state.phase === ActivationPhase.Pending ? ActivationPhase.Activated : ActivationPhase.Pending,
      },
    },
    "PHASE_CHANGED",
  ],
  [
    "venue",
    { ...BASE, route: routeIdentity("TEST_ROUTE", [{ ...BASE.route.legs[0]!, venue: "Raydium" }]) },
    "VENUE_CHANGED",
  ],
  [
    "pool",
    { ...BASE, route: routeIdentity("TEST_ROUTE", [{ ...BASE.route.legs[0]!, poolId: "11111111111111111111111111111111" }]) },
    "VENUE_CHANGED",
  ],
  [
    "leg percentages",
    {
      ...BASE,
      route: routeIdentity("TEST_ROUTE", [
        { ...BASE.route.legs[0]!, percent: 60 },
        { ...BASE.route.legs[0]!, percent: 40 },
      ]),
    },
    "ROUTE_CHANGED",
  ],
  [
    "leg order",
    {
      ...BASE,
      route: routeIdentity("TEST_ROUTE", [
        { venue: "B", poolId: "pool-b", inputMint: null, outputMint: null, percent: 50 },
        { venue: "A", poolId: "pool-a", inputMint: null, outputMint: null, percent: 50 },
      ]),
    },
    "VENUE_CHANGED",
  ],
];

test("every security-relevant mutation changes the quote key", () => {
  const baseKey = quoteKey(BASE);
  const seen = new Map<string, string>([[baseKey, "base"]]);
  for (const [label, mutated] of MUTATIONS) {
    const key = quoteKey(mutated);
    assert.notEqual(key, baseKey, `${label} left the quote key unchanged`);
    const other = seen.get(key);
    assert.equal(other, undefined, `${label} and ${other} produce the same quote key`);
    seen.set(key, label);
  }
  assert.equal(seen.size, MUTATIONS.length + 1);
});

test("every mutation is reported with its precise reason", () => {
  for (const [label, mutated, expected] of MUTATIONS) {
    const codes = quoteMismatches(BASE, mutated).map((m) => m.code);
    assert.ok(codes.includes(expected), `${label}: expected ${expected}, got ${codes.join(", ") || "none"}`);
  }
  assert.deepEqual(quoteMismatches(BASE, structuredClone(BASE)), [], "a structural clone is the same quote");
});

test("reordering legs is a different route even when the set of legs is equal", () => {
  const legs = [
    { venue: "A", poolId: "pool-a", inputMint: null, outputMint: null, percent: 50 },
    { venue: "B", poolId: "pool-b", inputMint: null, outputMint: null, percent: 50 },
  ];
  const forward = { ...BASE, route: routeIdentity("TEST_ROUTE", legs) };
  const reversed = { ...BASE, route: routeIdentity("TEST_ROUTE", [legs[1]!, legs[0]!]) };
  assert.notEqual(quoteKey(forward), quoteKey(reversed));
  assert.ok(quoteMismatches(forward, reversed).length > 0);
});

// --------------------------------------------------- canonical serialization

test("object key insertion order does not change the canonical key", () => {
  assert.equal(canonicalKey({ a: 1, b: 2 }), canonicalKey({ b: 2, a: 1 }));
  assert.equal(canonicalKey({ x: { p: 1n, q: "z" } }), canonicalKey({ x: { q: "z", p: 1n } }));
  // The same quote, rebuilt with its fields in a different order.
  const shuffled = Object.fromEntries(Object.entries(BASE).reverse()) as unknown as QuoteIdentity;
  assert.equal(quoteKey(shuffled), quoteKey(BASE));
});

test("array order is significant", () => {
  assert.notEqual(canonicalKey([1, 2]), canonicalKey([2, 1]));
  assert.notEqual(canonicalKey(["a", "b"]), canonicalKey(["b", "a"]));
});

test("values of different types never collide", () => {
  // Each of these would be indistinguishable under a naive JSON encoding.
  const values: [string, unknown][] = [
    ["bigint 5", 5n],
    ["number 5", 5],
    ["string 5", "5"],
    ["string 5n", "5n"],
    ["boolean true", true],
    ["string true", "true"],
    ["null", null],
    ["string null", "null"],
    ["empty array", []],
    ["empty object", {}],
    ["array of 5", [5]],
    ["object with 5", { v: 5 }],
  ];
  const keys = new Map<string, string>();
  for (const [label, value] of values) {
    const key = canonicalKey(value);
    const other = keys.get(key);
    assert.equal(other, undefined, `${label} and ${other} encode identically`);
    keys.set(key, label);
  }
});

test("a missing key and an explicit null are different", () => {
  assert.notEqual(canonicalKey({ a: 1 }), canonicalKey({ a: 1, b: null }));
  assert.notEqual(canonicalKey({}), canonicalKey({ b: null }));
});

test("undefined, unsafe numbers and non-plain objects are refused outright", () => {
  const refused: [string, unknown][] = [
    ["undefined", undefined],
    ["undefined in an object", { a: undefined }],
    ["undefined in an array", [undefined]],
    ["negative zero", -0],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 2],
    ["below MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER - 2],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["Set", new Set()],
    ["Uint8Array", new Uint8Array(1)],
    ["class instance", new (class Thing { value = 1 })()],
    ["function", () => 1],
    ["symbol", Symbol("s")],
  ];
  for (const [label, value] of refused) {
    assert.throws(() => canonicalKey(value), QuoteIdentityError, `${label} was accepted into a canonical key`);
  }
  // A null-prototype object is a plain record and is accepted.
  const bare = Object.create(null) as Record<string, unknown>;
  bare.a = 1;
  assert.equal(canonicalKey(bare), canonicalKey({ a: 1 }));
});

test("deserialized quotes with the wrong runtime types are refused, not coerced", () => {
  const cases: [string, unknown][] = [
    ["number output amount", { ...BASE, outputRaw: Number(BASE.outputRaw) }],
    ["string output amount", { ...BASE, outputRaw: BASE.outputRaw.toString() }],
    ["number input amount", { ...BASE, inputRaw: 5_000_000 }],
    ["string minimum output", { ...BASE, minOutputRaw: "1000" }],
    ["number context slot", { ...BASE, contextSlot: 447157559 }],
    ["missing state", { ...BASE, state: undefined }],
    ["null state", { ...BASE, state: null }],
    ["float decimals", { ...BASE, state: { ...BASE.state, decimals: 6.5 } }],
    ["negative decimals", { ...BASE, state: { ...BASE.state, decimals: -1 } }],
    ["decimals above 255", { ...BASE, state: { ...BASE.state, decimals: 256 } }],
    ["uppercase multiplier hex", { ...BASE, state: { ...BASE.state, multiplierHex: BASE.state.multiplierHex.toUpperCase() } }],
    ["short multiplier hex", { ...BASE, state: { ...BASE.state, multiplierHex: "00ff" } }],
    ["number effective timestamp", { ...BASE, state: { ...BASE.state, effectiveTimestamp: 1 } }],
    ["unknown phase", { ...BASE, state: { ...BASE.state, phase: 2 } }],
    ["string paused", { ...BASE, state: { ...BASE.state, paused: "false" } }],
    ["missing route", { ...BASE, route: undefined }],
    ["route legs not an array", { ...BASE, route: { ...BASE.route, legs: "none" } }],
    ["leg percent above 100", { ...BASE, route: { ...BASE.route, legs: [{ ...BASE.route.legs[0]!, percent: 101 }] } }],
    ["leg percent not an integer", { ...BASE, route: { ...BASE.route, legs: [{ ...BASE.route.legs[0]!, percent: 33.3 }] } }],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => assertQuoteIdentityTypes(value as QuoteIdentity), QuoteIdentityError, `${label} was accepted`);
    assert.throws(() => quoteKey(value as QuoteIdentity), QuoteIdentityError, `${label} produced a key`);
  }
});

test("a JSON round trip is not a quote", () => {
  // bigints do not survive JSON at all, which is the point: a plain
  // re-parse can never impersonate an exact quote identity.
  assert.throws(() => JSON.stringify(BASE), TypeError);
  const lossy = JSON.parse(
    JSON.stringify(BASE, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
  ) as QuoteIdentity;
  assert.throws(() => quoteKey(lossy), QuoteIdentityError);
});
