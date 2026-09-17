/**
 * The reference app's data contract. `build/derive-state.ts` produces it at
 * build time from committed evidence using the real guard model and decision
 * engine; the browser only renders it. All values are JSON-safe strings.
 *
 * Two evidence sets are kept apart on purpose:
 *   - `scenarios`: the Sep 15 2026 KOx state transition (recorded mainnet
 *     state, evaluated by the guard model; nothing was sent);
 *   - `replay`: the separate Sep 17 2026 local-validator execution of a
 *     guarded Jupiter trade, which did not cross any corporate action.
 */

import type { GuardDecision } from "./decision.ts";

/** Where a displayed value comes from. Rendered next to the value it labels. */
export type Provenance =
  /** Recorded read-only from Solana mainnet (account bytes, Clock, Jupiter /build). */
  | "MAINNET_OBSERVATION"
  /** Executed on a local solana-test-validator with mainnet-derived bytes. */
  | "LOCAL_REPLAY"
  /** Computed offline by the EquityGuard guard model / decision engine. */
  | "GUARD_MODEL"
  /** Made up for illustration; never observed. */
  | "ILLUSTRATIVE";

export type ScenarioId = "safe" | "stale" | "refreshed" | "consent";

export interface EconomicStateView {
  /** Short state name shown to users, e.g. "S" or "S′". */
  readonly tag: string;
  readonly summary: string;
  readonly phase: "PENDING" | "ACTIVATED";
  readonly multiplier: string;
  readonly newMultiplier: string;
  readonly multiplierHex: string;
  readonly newMultiplierHex: string;
  /** Scheduled activation (stored effective timestamp), ISO. */
  readonly effectiveAt: string;
  /** Chain block time of the observation, ISO. */
  readonly chainTime: string;
  readonly slot: string;
  /** First 12 hex chars of SHA-256 over the protected bytes and phase. */
  readonly fingerprint: string;
}

export interface GuardWindowView {
  readonly beforeSecs: number;
  readonly afterSecs: number;
  readonly note: string;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly label: string;
  readonly illustrative: boolean;
  readonly headline: string;
  readonly detail: string;
  readonly decision: GuardDecision;
  readonly symbol: string;
  readonly issuer: string;
  /** State the transaction was authorized under, and the moment it was prepared. */
  readonly authorized: EconomicStateView;
  /** State at the moment the guard is evaluated. */
  readonly current: EconomicStateView;
  /** Chain time at which the guard was evaluated, ISO. */
  readonly evaluatedAt: string;
  readonly window: GuardWindowView;
  /** What happens to balances, in plain words. */
  readonly settlement: string;
  /** What backs this scenario's decision, most direct first. */
  readonly backing: readonly { readonly provenance: Provenance; readonly text: string }[];
}

export interface ReplayCase {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly decision: GuardDecision;
  readonly succeeded: boolean;
  readonly failedInstruction: number | null;
  readonly programsInvoked: number;
  readonly jupiterRan: boolean;
  readonly usdcDelta: string;
  readonly stockDelta: string;
  readonly feeLamports: string | null;
  readonly expectedPhase: "PENDING" | "ACTIVATED";
}

export interface ReferenceState {
  readonly generatedFrom: readonly { readonly name: string; readonly sha256: string }[];
  readonly asset: {
    readonly name: string;
    readonly underlying: string;
    readonly symbol: string;
    readonly issuer: string;
    readonly mint: string;
    readonly decimals: number;
  };
  /** Example order shown in the trade card; no quote is attached to it. */
  readonly order: { readonly inputUsdc: string; readonly aggregator: string };
  readonly replay: {
    readonly recordedAt: string;
    readonly routeObservedAt: string;
    readonly localClock: string;
    readonly localClockPhase: "PENDING" | "ACTIVATED";
    readonly inputUsdc: string;
    readonly outputRaw: string;
    readonly minOutputRaw: string;
    readonly slippageBps: number;
    readonly venue: string;
    readonly adapterKind: number;
    readonly adapterName: string;
    readonly transactionBytes: number;
    readonly commitmentHex: string;
    readonly window: { readonly beforeSecs: number; readonly afterSecs: number };
    readonly guardProgram: string;
    readonly guardBinarySha256: string;
    readonly jupiterBinarySha256: string;
    readonly whirlpoolBinarySha256: string;
    readonly cases: readonly ReplayCase[];
  };
  readonly divergence: {
    readonly seconds: number;
    readonly kox: {
      readonly mechanism: string;
      readonly pendingFirstObservedAt: string;
      readonly apiAnnouncedAt: string;
      readonly apiReason: string;
      readonly effectiveAt: string;
      readonly lastPendingBlockTime: string;
      readonly firstActivatedBlockTime: string;
      readonly activationFirstObservedAt: string;
      readonly bytesUnchangedAtActivation: boolean;
      readonly oldMultiplier: string;
      readonly newMultiplier: string;
    };
    readonly koon: {
      readonly mechanism: string;
      readonly lastOldObservedAt: string;
      readonly effectiveAt: string;
      readonly firstNewObservedAt: string;
      readonly pendingPhaseObserved: boolean;
      readonly oldMultiplier: string;
      readonly newMultiplier: string;
    };
    readonly pollingSecs: number;
  };
  readonly scenarios: Readonly<Record<ScenarioId, Scenario>>;
}
