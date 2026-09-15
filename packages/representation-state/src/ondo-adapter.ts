/**
 * Ondo adapter: chain and issuer/API evidence are observed independently.
 *
 * Nothing here assumes the API and the mint transition at the same moment. If
 * both are present and disagree, the result is a CONFLICT that keeps both
 * states and has no reconciled state; deciding what to do about it belongs to
 * the decision layer.
 *
 * API evidence counts only when it is LIVE_API_STATE and still fresh at the
 * explicit evaluation time. HISTORICAL_API_STATE is recorded but never
 * affects the state. A live observation that is stale, lacks `validUntil`, or
 * is evaluated without an evaluation time contributes UNKNOWN, which fails
 * closed (UNKNOWN on its own, CONFLICT beside a chain state).
 *
 * UNCALIBRATED: no live Ondo API client exists yet. `ApiObservation` is the
 * integration seam; the mapping of real Ondo API fields to `ApiStatus`, and
 * whether the Pausable flag tracks Ondo trading pauses, await empirical
 * calibration from the KO capture.
 */

import { classifyChainEvidence } from "./chain-observation.ts";
import { RegistryError, type Representation } from "./registry.ts";
import {
  RepresentationState,
  StateSource,
  type ApiObservation,
  type ApiStatus,
  type ChainEvidence,
  type ResolvedRepresentationState,
  type TransitionPolicy,
} from "./types.ts";

const API_STATUS_TO_STATE: Readonly<Record<ApiStatus, RepresentationState>> = {
  active: RepresentationState.SAFE,
  paused: RepresentationState.PAUSED,
  transition: RepresentationState.TRANSITION,
  unknown: RepresentationState.UNKNOWN,
};

export function resolveOndoState(
  representation: Representation,
  evidence: {
    readonly chain: ChainEvidence | null;
    readonly api: ApiObservation | null;
    /** ISO wallclock at which live API freshness is judged; required whenever `api` is live. */
    readonly evaluatedAt?: string | null;
  },
  policy: TransitionPolicy,
): ResolvedRepresentationState {
  if (representation.issuer !== "Ondo") {
    throw new RegistryError(`${representation.symbol} is not an Ondo representation`);
  }
  const { chain, api } = evidence;
  if (chain && chain.mint !== representation.mint) {
    throw new RegistryError(`chain evidence mint ${chain.mint} does not match ${representation.symbol}`);
  }
  if (api && (api.symbol !== representation.symbol || api.issuer !== "Ondo")) {
    throw new RegistryError(`API evidence ${api.issuer}:${api.symbol} does not match ${representation.symbol}`);
  }

  const chainClass = chain ? classifyChainEvidence(chain, policy) : null;
  const apiUse = api ? apiEvidenceUse(api, evidence.evaluatedAt ?? null) : null;
  const apiState = apiUse?.state ?? null;
  const chainState = chainClass?.state ?? null;

  const common = {
    underlying: representation.underlying,
    issuer: representation.issuer,
    symbol: representation.symbol,
    mint: representation.mint,
    chainState,
    apiState,
    slot: chain?.slot ?? null,
    blockTime: chain?.blockTime ?? null,
    observedAt: chain?.observedAt ?? api?.observedAt ?? null,
    chainObservation: chain,
    apiObservation: api,
    transitionPolicy: chain ? policy : null,
  };

  if (chainState === null && apiState === null) {
    return { ...common, state: RepresentationState.UNKNOWN, stateSource: null, reason: apiUse ? `no chain evidence; ${apiUse.reason}` : "no chain or API evidence" };
  }
  if (apiState === null) {
    return { ...common, state: chainState, stateSource: StateSource.CHAIN, reason: `${chainClass?.reason ?? ""}${apiUse ? `; ${apiUse.reason}` : ""}` };
  }
  if (chainState === null) {
    return { ...common, state: apiState, stateSource: StateSource.API, reason: `API ${apiUse?.reason}` };
  }
  if (chainState === apiState) {
    return {
      ...common,
      state: chainState,
      stateSource: StateSource.BOTH_AGREE,
      reason: `chain and API agree: ${chainClass?.reason}`,
    };
  }
  return {
    ...common,
    state: null,
    stateSource: StateSource.CONFLICT,
    reason: `chain says ${chainState} (${chainClass?.reason}); API says ${apiState} (${apiUse?.reason})`,
  };
}

/** How an API observation may be used at `evaluatedAt`: its state, or null when it must be ignored. */
function apiEvidenceUse(api: ApiObservation, evaluatedAt: string | null): { state: RepresentationState | null; reason: string } {
  if (api.sourceClass === "HISTORICAL_API_STATE") {
    return { state: null, reason: `historical API evidence (${api.observedAt}) ignored: never live state` };
  }
  if (api.sourceClass !== "LIVE_API_STATE") return { state: RepresentationState.UNKNOWN, reason: "API evidence without a known source class" };
  const until = api.validUntil === null ? Number.NaN : Date.parse(api.validUntil);
  const at = evaluatedAt === null ? Number.NaN : Date.parse(evaluatedAt);
  if (Number.isNaN(until) || Number.isNaN(at)) {
    return { state: RepresentationState.UNKNOWN, reason: "live API evidence without a freshness bound or evaluation time" };
  }
  if (at > until) return { state: RepresentationState.UNKNOWN, reason: `live API evidence expired at ${api.validUntil}` };
  return { state: API_STATUS_TO_STATE[api.status], reason: `status ${api.status} (live until ${api.validUntil})` };
}
