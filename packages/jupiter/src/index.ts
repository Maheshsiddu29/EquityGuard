/**
 * The canonical `@equityguard/jupiter` surface.
 *
 * `composeGuardedJupiterTrade` is NOT here: it takes the economic-state
 * expectation as an argument and encodes it as given, so it lives in
 * `@equityguard/jupiter/advanced`. Integrators want `protectJupiterSwap` from
 * `@equityguard/jupiter/protect`, which derives that expectation from chain
 * state itself. See `docs/sdk-trust-boundary.md`.
 */

export {
  JUPITER_API_BASE_URL,
  JupiterApiError,
  JupiterConfigError,
  buildRequestUrl,
  fetchBuild,
  parseBuildResponse,
  readJupiterApiKey,
  type ApiAccountMeta,
  type ApiInstruction,
  type BuildRequest,
  type BuildResponse,
  type RoutePlanStep,
} from "./build-client.ts";
export {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  CompositionError,
  MAX_TRANSACTION_BYTES,
  UNSIMULATED_COMPUTE_UNIT_LIMIT,
  UnsupportedJupiterBuildError,
  assertSupportedJupiterBuild,
  compileAndMeasure,
  getSetComputeUnitLimitInstruction,
  normalizedJupiterSuffix,
  resolveWireTransaction,
  toKitInstruction,
  type GuardedJupiterComposition,
  type JupiterTradeRequest,
  type TransactionMetrics,
} from "./compose.ts";
