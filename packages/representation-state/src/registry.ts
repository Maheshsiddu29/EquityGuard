/**
 * Canonical registry of tokenized representations associated with the same
 * underlying equity.
 *
 * Membership means "issued against the same underlying share", NOT "fungible"
 * or "legally or economically identical": issuers differ in legal structure,
 * custody, redemption, corporate-action handling and token mechanics. Any
 * switch between representations is a disclosed, consented financial choice.
 */

import { isAddress, type Address } from "@solana/kit";

export type Issuer = "xStocks" | "Ondo";

export interface Representation {
  readonly underlying: string;
  readonly issuer: Issuer;
  readonly symbol: string;
  readonly mint: Address;
}

export interface UnderlyingEquity {
  readonly underlying: string;
  readonly name: string;
  readonly representations: readonly Representation[];
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export class UnknownUnderlyingError extends RegistryError {
  constructor(ticker: string) {
    super(`unknown underlying ${ticker}`);
    this.name = "UnknownUnderlyingError";
  }
}

interface RawEntry {
  readonly underlying: string;
  readonly name: string;
  readonly representations: readonly { readonly issuer: Issuer; readonly symbol: string; readonly mint: string }[];
}

/**
 * Mints verified read-only on mainnet (Token-2022 owner, ScaledUiAmount
 * present, on-chain metadata symbol matches) at slot 446827429.
 */
const ENTRIES: readonly RawEntry[] = [
  {
    underlying: "KO",
    name: "Coca-Cola",
    representations: [
      { issuer: "xStocks", symbol: "KOx", mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ" },
      { issuer: "Ondo", symbol: "KOon", mint: "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo" },
    ],
  },
  {
    underlying: "UNH",
    name: "UnitedHealth",
    representations: [
      { issuer: "xStocks", symbol: "UNHx", mint: "XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe" },
      { issuer: "Ondo", symbol: "UNHon", mint: "kPBGL8vAwKN3UGmr9cjkM2dU79SC3nzTC9yu7F8ondo" },
    ],
  },
  {
    underlying: "CRM",
    name: "Salesforce",
    representations: [
      { issuer: "xStocks", symbol: "CRMx", mint: "XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN" },
      { issuer: "Ondo", symbol: "CRMon", mint: "7D7ukbcnUNYt7Et5vtsDZhAy28MKu9pkHka1Hp9ondo" },
    ],
  },
];

/** Validates raw entries and returns the typed registry. Exported for tests. */
export function buildRegistry(entries: readonly RawEntry[]): ReadonlyMap<string, UnderlyingEquity> {
  const byUnderlying = new Map<string, UnderlyingEquity>();
  const mints = new Set<string>();
  const symbols = new Set<string>();
  for (const entry of entries) {
    if (byUnderlying.has(entry.underlying)) throw new RegistryError(`duplicate underlying ${entry.underlying}`);
    const issuers = new Set<Issuer>();
    const representations = entry.representations.map((r): Representation => {
      if (!isAddress(r.mint)) throw new RegistryError(`${r.symbol}: invalid mint address`);
      if (mints.has(r.mint)) throw new RegistryError(`${r.symbol}: duplicate mint ${r.mint}`);
      if (symbols.has(r.symbol)) throw new RegistryError(`duplicate symbol ${r.symbol}`);
      if (issuers.has(r.issuer)) throw new RegistryError(`${entry.underlying}: duplicate issuer ${r.issuer}`);
      mints.add(r.mint);
      symbols.add(r.symbol);
      issuers.add(r.issuer);
      return Object.freeze({ underlying: entry.underlying, issuer: r.issuer, symbol: r.symbol, mint: r.mint as Address });
    });
    byUnderlying.set(
      entry.underlying,
      Object.freeze({ underlying: entry.underlying, name: entry.name, representations: Object.freeze(representations) }),
    );
  }
  return byUnderlying;
}

const REGISTRY = buildRegistry(ENTRIES);

/** All underlyings, in registry order. */
export function listUnderlyings(): readonly UnderlyingEquity[] {
  return [...REGISTRY.values()];
}

/** Looks up an underlying ticker; unknown tickers throw {@link UnknownUnderlyingError}. */
export function getUnderlying(ticker: string): UnderlyingEquity {
  const entry = REGISTRY.get(ticker);
  if (!entry) throw new UnknownUnderlyingError(ticker);
  return entry;
}

export function findRepresentationByMint(mint: string): Representation | undefined {
  for (const entry of REGISTRY.values()) {
    const match = entry.representations.find((r) => r.mint === mint);
    if (match) return match;
  }
  return undefined;
}

export function findRepresentationBySymbol(symbol: string): Representation | undefined {
  for (const entry of REGISTRY.values()) {
    const match = entry.representations.find((r) => r.symbol === symbol);
    if (match) return match;
  }
  return undefined;
}

/** Other representations associated with the same underlying (never the same mint). */
export function alternativesFor(representation: Representation): readonly Representation[] {
  return getUnderlying(representation.underlying).representations.filter((r) => r.mint !== representation.mint);
}
