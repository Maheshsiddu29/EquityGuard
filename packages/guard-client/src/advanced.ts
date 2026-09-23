/**
 * `@equityguard/guard-client/advanced` — TRUSTED-BUILDER API.
 *
 * Trusted-builder API. The caller is responsible for ensuring the encoded
 * economic-state expectation corresponds to the state under which the user is
 * authorizing the transaction.
 *
 * # Why this module exists
 *
 * The on-chain program compares the expectation carried by the instruction
 * against the mint and the Clock at execution time. It has no way to know when
 * that expectation was created, or what a user was shown when they approved
 * it. Those are the two things a builder chooses, and the program cannot
 * second-guess either.
 *
 * Concretely: a builder may encode `expectedPhase: Activated` while the chain
 * is still `Pending`, have the user sign, and wait. Submitted before the
 * scheduled activation `T` the guard rejects it (`ActivationPhaseChanged`);
 * submitted after `T` — and after any protection window the same builder
 * chose — the guard **accepts** it, because by then the payload describes the
 * live state. The user authorized a trade priced under the old multiplier and
 * executed one under the new one. Nothing in the ABI can detect this, and
 * widening the protection window delays it rather than preventing it.
 *
 * # Use the canonical API instead
 *
 * `protectJupiterSwap` from `@equityguard/jupiter/protect` derives the
 * expectation itself, from one `getMultipleAccounts` read of the mint and the
 * Clock, and refuses to build anything the program would reject at that
 * moment. A future-dated expectation is therefore unrepresentable through it.
 *
 * Reach for this module only when you are the builder *and* the signer's
 * counterparty-of-trust — a first-party wallet, a test harness, or an
 * integrator that derives the expectation from a fresh snapshot itself and can
 * say so. If you do, call {@link checkGuardOffline} against a fresh
 * {@link fetchGuardSnapshot} before encoding, which is exactly what the
 * canonical path does on your behalf.
 *
 * See `docs/sdk-trust-boundary.md`.
 */

export { encodeAssertSafeExecutionV2 } from "./abi.ts";
export { buildGuardedTransferChecked, getAssertSafeExecutionV2Instruction } from "./downstream.ts";
export { buildGuardedJupiterTrade } from "./jupiter.ts";

// Re-exported so a trusted builder can run the canonical safety check without
// importing two entry points.
export { checkGuardOffline } from "./offline-check.ts";
export { expectationFromSnapshot } from "./instruction.ts";
export { fetchGuardSnapshot } from "./snapshot.ts";

/**
 * The obligation a caller of this module takes on. Quoted verbatim in
 * `docs/sdk-trust-boundary.md` and asserted by `advanced.test.ts`, so the
 * contract and its documentation cannot drift apart.
 */
export const TRUSTED_BUILDER_CONTRACT =
  "Trusted-builder API. The caller is responsible for ensuring the encoded economic-state expectation corresponds to the state under which the user is authorizing the transaction.";

/**
 * Every API in this package that accepts a caller-controlled economic-state
 * expectation. Machine-checked against this module's actual exports and
 * against the canonical surface, so an expectation-accepting builder cannot be
 * added to `@equityguard/guard-client` without failing a test.
 */
export const TRUSTED_BUILDER_APIS: readonly string[] = Object.freeze([
  "buildGuardedJupiterTrade",
  "buildGuardedTransferChecked",
  "encodeAssertSafeExecutionV2",
  "getAssertSafeExecutionV2Instruction",
]);
