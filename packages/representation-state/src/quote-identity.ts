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

/** Deterministic serialization: sorted object keys, bigints tagged, no floats allowed except integers. */
export function canonicalKey(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new QuoteIdentityError("canonical keys accept integers only");
      return v;
    }
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map(encode);
    if (typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, encode((v as Record<string, unknown>)[k])]),
      );
    }
    throw new QuoteIdentityError(`unsupported value in canonical key: ${typeof v}`);
  };
  return JSON.stringify(encode(value));
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
