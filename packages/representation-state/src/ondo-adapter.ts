/**
 * Ondo adapter: chain and issuer/API evidence are observed independently.
 *
 * Nothing here assumes the API and the mint transition at the same moment. If
 * both are present and disagree, the result is a CONFLICT that keeps both
 * states and has no reconciled state; deciding what to do about it belongs to
 * the decision layer.
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
  evidence: { readonly chain: ChainEvidence | null; readonly api: ApiObservation | null },
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
  const apiState = api ? API_STATUS_TO_STATE[api.status] : null;
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
    return { ...common, state: RepresentationState.UNKNOWN, stateSource: null, reason: "no chain or API evidence" };
  }
  if (apiState === null) {
    return { ...common, state: chainState, stateSource: StateSource.CHAIN, reason: chainClass?.reason ?? "" };
  }
  if (chainState === null) {
    return { ...common, state: apiState, stateSource: StateSource.API, reason: `API status ${api?.status}` };
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
    reason: `chain says ${chainState} (${chainClass?.reason}); API says ${apiState} (status ${api?.status})`,
  };
}
