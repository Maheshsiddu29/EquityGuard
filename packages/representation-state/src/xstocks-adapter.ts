/**
 * xStocks adapter: CHAIN-PRIMARY. State comes only from the Token-2022 mint
 * (ScaledUiAmount + Pausable) evaluated at chain time.
 */

import { classifyChainEvidence } from "./chain-observation.ts";
import { RegistryError, type Representation } from "./registry.ts";
import { StateSource, type ChainEvidence, type ResolvedRepresentationState, type TransitionPolicy } from "./types.ts";

export function resolveXStocksState(
  representation: Representation,
  evidence: ChainEvidence,
  policy: TransitionPolicy,
): ResolvedRepresentationState {
  if (representation.issuer !== "xStocks") {
    throw new RegistryError(`${representation.symbol} is not an xStocks representation`);
  }
  if (evidence.mint !== representation.mint) {
    throw new RegistryError(`evidence mint ${evidence.mint} does not match ${representation.symbol}`);
  }
  const { state, reason } = classifyChainEvidence(evidence, policy);
  return {
    underlying: representation.underlying,
    issuer: representation.issuer,
    symbol: representation.symbol,
    mint: representation.mint,
    state,
    stateSource: StateSource.CHAIN,
    chainState: state,
    apiState: null,
    slot: evidence.slot,
    blockTime: evidence.blockTime,
    observedAt: evidence.observedAt,
    reason,
    chainObservation: evidence,
    apiObservation: null,
    transitionPolicy: policy,
  };
}
