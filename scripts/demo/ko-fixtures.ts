/**
 * Loaders for the curated September 2026 KO evidence and the point-in-time
 * Jupiter liquidity snapshot. Both are MAINNET_OBSERVATION data: nothing here
 * can sign or submit a transaction.
 */

import { readFileSync } from "node:fs";

import { observeMintAccount, type ChainEvidence } from "@equityguard/representation-state";

export interface CuratedObservation {
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly lineNumber: number;
  readonly wallclock: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly symbol: string;
  readonly issuer: string;
  readonly mint: string;
  readonly owner: string;
  readonly dataBase64: string;
}

export type ObservationKey =
  | "koxPendingFirstObserved"
  | "koxLastPendingBeforeT"
  | "koxActivatedFirstObserved"
  | "koonPreEventLast"
  | "koonPostEventFirst"
  | "koxAtKoonPostEvent"
  | "koonAtKoxLastPending"
  | "windowEndKOx"
  | "windowEndKOon";

export interface CuratedKoFixture {
  readonly kind: "equityguard-curated-ko-corporate-action-2026-09";
  readonly environment: "MAINNET_OBSERVATION";
  readonly sources: {
    readonly finalChainSnapshotSha256: string;
    readonly finalApiSnapshotSha256: string;
    readonly finalEventWindowSha256: string;
  };
  readonly observations: Readonly<Record<ObservationKey, CuratedObservation>>;
  readonly api: Readonly<Record<"koxApiLastNoPending" | "koxApiPendingFirstObserved", { sourceFile: string; sourceSha256: string; lineNumber: number; rawLine: string }>>;
}

export type RouteAvailability = "AVAILABLE" | "UNAVAILABLE";

export interface LiquidityQuote {
  readonly symbol: string;
  readonly underlying: string;
  readonly issuer: string;
  readonly mint: string;
  readonly observedAt: string;
  readonly httpStatus: number;
  readonly route: RouteAvailability;
  readonly outAmountRaw: string | null;
  readonly priceImpactPct: string | null;
  readonly venues: readonly { readonly label?: string; readonly ammKey?: string; readonly percent?: number }[];
  readonly error: string | null;
  readonly chainAtQuote: { readonly slot: string | null; readonly decimals: number; readonly effectiveMultiplierHex: string; readonly phase: string | null };
}

export interface LiquiditySnapshot {
  readonly kind: "equityguard-jupiter-liquidity-snapshot";
  readonly environment: "MAINNET_OBSERVATION";
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly inputMint: string;
  readonly inputRaw: string;
  readonly quotes: Readonly<Record<string, LiquidityQuote>>;
}

const FIXTURES = new URL("./fixtures/", import.meta.url);

export function loadKoFixture(): CuratedKoFixture {
  const fixture = JSON.parse(readFileSync(new URL("ko-corporate-action-2026-09.json", FIXTURES), "utf8")) as CuratedKoFixture;
  if (fixture.kind !== "equityguard-curated-ko-corporate-action-2026-09" || fixture.environment !== "MAINNET_OBSERVATION") {
    throw new Error("unexpected KO fixture kind or environment");
  }
  return fixture;
}

export function loadLiquiditySnapshot(): LiquiditySnapshot {
  const snapshot = JSON.parse(readFileSync(new URL("jupiter-liquidity-2026-09-15.json", FIXTURES), "utf8")) as LiquiditySnapshot;
  if (snapshot.kind !== "equityguard-jupiter-liquidity-snapshot" || snapshot.environment !== "MAINNET_OBSERVATION") {
    throw new Error("unexpected liquidity snapshot kind or environment");
  }
  return snapshot;
}

/** Decodes a curated observation, evaluating the phase at its captured block time. */
export function decodeObservation(observation: CuratedObservation): ChainEvidence {
  return observeMintAccount({
    mint: observation.mint,
    owner: observation.owner,
    data: Uint8Array.from(Buffer.from(observation.dataBase64, "base64")),
    slot: BigInt(observation.slot),
    blockTime: BigInt(observation.blockTime),
    observedAt: observation.wallclock,
    chainUnixTimestamp: BigInt(observation.blockTime),
  });
}
