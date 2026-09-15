/**
 * Canonical quote identity: the exact quote a normalization, comparison,
 * disclosure and execution plan are built from.
 *
 * Every field is an exact value: raw integer amounts, mint addresses, the
 * route plan and the `EconomicState` used for normalization (mint, decimals,
 * stored multiplier bytes, effective timestamp, phase, paused). No formatted
 * decimals. `quoteMismatches` is the single canonical comparison and reports
 * precise reasons; `canonicalKey` is a deterministic string form used to bind
 * derived structures (comparisons, plans) without a hash dependency.
 */

import { economicStateMismatches, type EconomicState } from "./economic-state.ts";

/** One hop or split of a route plan. */
export interface RouteLeg {
  /** Venue label as reported by the route source, e.g. "Whirlpool". */
  readonly venue: string;
  /** Pool / AMM account, when the source reports one. */
  readonly poolId: string | null;
  readonly inputMint: string | null;
  readonly outputMint: string | null;
  /** Integer percent of the input routed through this leg. */
  readonly percent: number;
}

export interface RouteIdentity {
  /** Where the route came from, e.g. "JUPITER_MAINNET_SNAPSHOT" or the devnet fixture label. */
  readonly source: string;
  /** Provider route id when one exists; otherwise derived deterministically from the plan. */
  readonly routeId: string;
  readonly legs: readonly RouteLeg[];
}

/** The identity-bearing fields of a normalized quote. */
export interface QuoteIdentity {
  readonly underlying: string;
  readonly inputMint: string;
  /** Output mint: the representation being acquired. */
  readonly mint: string;
  readonly inputRaw: bigint;
  readonly outputRaw: bigint;
  /** Minimum acceptable output (slippage bound) when the quote carries one. */
  readonly minOutputRaw: bigint | null;
  readonly route: RouteIdentity;
  /** When the quote was observed; null for fixtures. */
  readonly quotedAt: string | null;
  /** Chain context slot the quote was observed against, when known. */
  readonly contextSlot: bigint | null;
  /** Exact economic state used for normalization (includes decimals and multiplier identity). */
  readonly state: EconomicState;
}

export type QuoteMismatchCode =
  | "UNDERLYING_CHANGED"
  | "INPUT_MINT_CHANGED"
  | "OUTPUT_MINT_CHANGED"
  | "INPUT_AMOUNT_CHANGED"
  | "OUTPUT_AMOUNT_CHANGED"
  | "MIN_OUTPUT_CHANGED"
  | "ROUTE_CHANGED"
  | "VENUE_CHANGED"
  | "QUOTE_CONTEXT_CHANGED"
  | "ECONOMIC_STATE_CHANGED"
  | "PHASE_CHANGED";

export interface QuoteMismatch {
  readonly code: QuoteMismatchCode;
  readonly detail: string;
}

export class QuoteIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteIdentityError";
  }
}

/**
 * Deterministic, type-tagged serialization. Every primitive carries its type,
 * so bigint `5n`, string `"5n"`, number `5`, string `"5"` and `null` never
 * collide. Object keys are sorted; a missing key and a `null` value differ;
 * `undefined`, non-integer or unsafe numbers, `-0`, NaN, Infinity and
 * non-plain objects are rejected outright. Arrays keep their order.
 */
export function canonicalKey(value: unknown): string {
  const encode = (v: unknown): unknown => {
    switch (typeof v) {
      case "bigint":
        return ["bigint", v.toString()];
      case "string":
        return ["string", v];
      case "boolean":
        return ["boolean", v];
      case "number":
        if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new QuoteIdentityError(`canonical keys accept safe integers only, got ${String(v)}`);
        return ["int", v];
      case "undefined":
        throw new QuoteIdentityError("undefined is not allowed in a canonical key");
      case "object": {
        if (v === null) return ["null"];
        if (Array.isArray(v)) return ["array", v.map(encode)];
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto !== Object.prototype && proto !== null) throw new QuoteIdentityError("only plain objects are allowed in a canonical key");
        const record = v as Record<string, unknown>;
        return ["object", Object.keys(record).sort().map((k) => [k, encode(record[k])])];
      }
      default:
        throw new QuoteIdentityError(`unsupported value in canonical key: ${typeof v}`);
    }
  };
  return JSON.stringify(encode(value));
}

const isHex16 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
const isStringOrNull = (v: unknown) => v === null || typeof v === "string";
const isBigintOrNull = (v: unknown) => v === null || typeof v === "bigint";

/**
 * Runtime type check for data that may not have come through the type
 * system (deserialized, hand-built). Raw amounts must be bigints; a Number
 * amount is rejected rather than coerced.
 */
export function assertQuoteIdentityTypes(quote: QuoteIdentity): void {
  const q = quote as unknown as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of ["underlying", "inputMint", "mint"]) if (typeof q[k] !== "string") problems.push(`${k} must be a string`);
  for (const k of ["inputRaw", "outputRaw"]) if (typeof q[k] !== "bigint") problems.push(`${k} must be a bigint`);
  if (!isBigintOrNull(q.minOutputRaw)) problems.push("minOutputRaw must be a bigint or null");
  if (!isBigintOrNull(q.contextSlot)) problems.push("contextSlot must be a bigint or null");
  if (!isStringOrNull(q.quotedAt)) problems.push("quotedAt must be a string or null");
  const state = q.state as Record<string, unknown> | null | undefined;
  if (typeof state !== "object" || state === null) problems.push("state is required");
  else {
    if (typeof state.mint !== "string") problems.push("state.mint must be a string");
    if (typeof state.decimals !== "number" || !Number.isInteger(state.decimals) || state.decimals < 0 || state.decimals > 255) problems.push("state.decimals must be an integer in [0, 255]");
    if (!isHex16(state.multiplierHex) || !isHex16(state.newMultiplierHex)) problems.push("state multipliers must be 16 lowercase hex digits");
    if (typeof state.effectiveTimestamp !== "bigint") problems.push("state.effectiveTimestamp must be a bigint");
    if (state.phase !== 0 && state.phase !== 1) problems.push("state.phase must be 0 or 1");
    if (state.paused !== null && typeof state.paused !== "boolean") problems.push("state.paused must be a boolean or null");
  }
  const route = q.route as Record<string, unknown> | null | undefined;
  if (typeof route !== "object" || route === null || typeof route.source !== "string" || typeof route.routeId !== "string" || !Array.isArray(route.legs)) {
    problems.push("route must have source, routeId and legs");
  } else {
    for (const leg of route.legs as Record<string, unknown>[]) {
      if (typeof leg?.venue !== "string" || !isStringOrNull(leg.poolId) || !isStringOrNull(leg.inputMint) || !isStringOrNull(leg.outputMint)) problems.push("route leg fields have wrong types");
      if (typeof leg?.percent !== "number" || !Number.isInteger(leg.percent) || leg.percent < 0 || leg.percent > 100) problems.push("route leg percent must be an integer in [0, 100]");
    }
  }
  if (problems.length > 0) throw new QuoteIdentityError(`malformed quote identity: ${problems.join("; ")}`);
}

/** Route identity; without a provider id the id is derived from the source and legs. */
export function routeIdentity(source: string, legs: readonly RouteLeg[], providerRouteId: string | null = null): RouteIdentity {
  for (const leg of legs) {
    if (!Number.isInteger(leg.percent) || leg.percent < 0 || leg.percent > 100) throw new QuoteIdentityError(`leg percent must be an integer in [0, 100]`);
  }
  const frozenLegs = legs.map((leg) => ({ venue: leg.venue, poolId: leg.poolId, inputMint: leg.inputMint, outputMint: leg.outputMint, percent: leg.percent }));
  return { source, routeId: providerRouteId ?? `derived:${canonicalKey({ source, legs: frozenLegs })}`, legs: frozenLegs };
}

/** Projects any quote-shaped value onto its identity fields (drops e.g. `issuer`). */
export function quoteIdentityOf(quote: QuoteIdentity): QuoteIdentity {
  assertQuoteIdentityTypes(quote);
  return {
    underlying: quote.underlying,
    inputMint: quote.inputMint,
    mint: quote.mint,
    inputRaw: quote.inputRaw,
    outputRaw: quote.outputRaw,
    minOutputRaw: quote.minOutputRaw,
    route: quote.route,
    quotedAt: quote.quotedAt,
    contextSlot: quote.contextSlot,
    state: quote.state,
  };
}

export function quoteKey(quote: QuoteIdentity): string {
  return canonicalKey(quoteIdentityOf(quote));
}

const venuesOf = (route: RouteIdentity) => canonicalKey(route.legs.map((l) => [l.venue, l.poolId]));

/** Precise differences between an expected quote and the one presented; empty means identical. */
export function quoteMismatches(expected: QuoteIdentity, actual: QuoteIdentity): readonly QuoteMismatch[] {
  assertQuoteIdentityTypes(expected);
  assertQuoteIdentityTypes(actual);
  const out: QuoteMismatch[] = [];
  const diff = (code: QuoteMismatchCode, a: unknown, b: unknown) => {
    if (canonicalKey(a) !== canonicalKey(b)) out.push({ code, detail: `${canonicalKey(a)} != ${canonicalKey(b)}` });
  };
  diff("UNDERLYING_CHANGED", expected.underlying, actual.underlying);
  diff("INPUT_MINT_CHANGED", expected.inputMint, actual.inputMint);
  diff("OUTPUT_MINT_CHANGED", expected.mint, actual.mint);
  diff("INPUT_AMOUNT_CHANGED", expected.inputRaw, actual.inputRaw);
  diff("OUTPUT_AMOUNT_CHANGED", expected.outputRaw, actual.outputRaw);
  diff("MIN_OUTPUT_CHANGED", expected.minOutputRaw, actual.minOutputRaw);
  if (venuesOf(expected.route) !== venuesOf(actual.route)) out.push({ code: "VENUE_CHANGED", detail: `${venuesOf(expected.route)} != ${venuesOf(actual.route)}` });
  diff("ROUTE_CHANGED", expected.route, actual.route);
  diff("QUOTE_CONTEXT_CHANGED", [expected.quotedAt, expected.contextSlot], [actual.quotedAt, actual.contextSlot]);
  const state = economicStateMismatches(expected.state, actual.state);
  if (state.length > 0) {
    const onlyPhase = state.every((m) => m.startsWith("phase "));
    out.push({ code: onlyPhase ? "PHASE_CHANGED" : "ECONOMIC_STATE_CHANGED", detail: state.join("; ") });
  }
  return out;
}
