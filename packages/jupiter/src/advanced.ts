/**
 * `@equityguard/jupiter/advanced` — TRUSTED-BUILDER API.
 *
 * Trusted-builder API. The caller is responsible for ensuring the encoded
 * economic-state expectation corresponds to the state under which the user is
 * authorizing the transaction.
 *
 * {@link composeGuardedJupiterTrade} takes the expectation as an argument and
 * encodes it as given. It validates the Jupiter route grammar, pins the suffix
 * with a commitment and proves the compiled wire resolves to what it
 * committed to — but it never reads chain state, so it cannot tell a
 * snapshot-derived expectation from a future-dated one.
 *
 * `protectJupiterSwap` in `@equityguard/jupiter/protect` is the canonical
 * path: it reads the mint and Clock at one slot, derives the expectation, and
 * refuses to build anything the program would reject at that moment.
 *
 * See `../../guard-client/src/advanced.ts` for why this boundary exists, and
 * `docs/sdk-trust-boundary.md`.
 */

export { composeGuardedJupiterTrade } from "./compose.ts";

// The composer's own refusals are part of the trusted-builder surface: a
// caller that composes by hand still needs to reject unsupported builds.
export {
  CompositionError,
  UNSIMULATED_COMPUTE_UNIT_LIMIT,
  UnsupportedJupiterBuildError,
  assertSupportedJupiterBuild,
  normalizedJupiterSuffix,
  resolveWireTransaction,
  type GuardedJupiterComposition,
  type JupiterTradeRequest,
} from "./compose.ts";

export { TRUSTED_BUILDER_CONTRACT } from "@equityguard/guard-client/advanced";

/**
 * Every API in this package that accepts a caller-controlled economic-state
 * expectation. Machine-checked against this module's exports and against the
 * canonical `./protect` surface.
 */
export const TRUSTED_BUILDER_APIS: readonly string[] = Object.freeze([
  "composeGuardedJupiterTrade",
]);
