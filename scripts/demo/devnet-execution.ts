/**
 * DEVNET_EXECUTION demo: the same state engine, decision engine and
 * execution-eligibility layer as the mainnet replay, executed against the
 * deployed EquityGuard devnet program and the EQ-A / EQ-B devnet test assets.
 *
 * Every transaction is `[assert_safe_execution(asset), create recipient ATA,
 * transferChecked(asset)]`: the token delivery settles only if the guard
 * passes. The guard asserts exactly the economic state the decision and the
 * quote comparison were built against, so a state change between decision
 * and landing fails the transaction instead of executing on stale economics.
 * Quotes come from the DEVNET DEMO QUOTE / FIXTURE, never from a live market.
 *
 * Each run first resets both test mints to one fixed target (EQ-A effective
 * multiplier 1.5 with 1.75 scheduled; EQ-B 1.0 with nothing scheduled) and
 * verifies the result on chain, so repeated runs normalize to the same
 * economics instead of accumulating multiplier changes.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  bytesEqual,
  equityGuardErrorName,
  fetchGuardSnapshot,
  getAssertSafeExecutionInstruction,
  type ProtectedState,
} from "@equityguard/guard-client";
import {
  RepresentationState,
  StateSource,
  assertExecutable,
  classifyChainEvidence,
  compareQuotes,
  decideExecution,
  devnetExecutionResult,
  economicStateOf,
  fetchChainObservation,
  protectedStateOf,
  routeIdentity,
  verifyExecutionPlan,
  createExecutionPlan,
  type ChainEvidence,
  type DevnetExecutionResult,
  type DevnetTransactionEvidence,
  type EconomicState,
  type EvidenceReference,
  type ExecutionDecision,
  type ExecutionPlan,
  type NormalizedQuote,
  type QuoteAvailability,
  type QuoteComparison,
  type ResolvedRepresentationState,
  type RouteObservation,
  type TransitionPolicy,
} from "@equityguard/representation-state";

import { assertVerifiedDevnetContext, type DevnetContext } from "../devnet/config.ts";
import { findAsset, requireDeployment, type DevnetState, type TestAsset } from "../devnet/devnet-state.ts";
import { explorerUrl } from "../devnet/evidence.ts";
import { sendInstructions } from "../devnet/send.ts";
import { getScheduleMultiplierInstruction } from "../devnet/test-mint.ts";

export const DEVNET_QUOTE_FIXTURE_URL = new URL("./fixtures/devnet-demo-quotes.json", import.meta.url);

/** Devnet demo policy, UNCALIBRATED; the guard instruction carries the same window. */
export const DEVNET_DEMO_POLICY: TransitionPolicy = {
  beforeSecs: 900n,
  afterSecs: 300n,
  calibration: "UNCALIBRATED",
  basis: "M6 devnet demo policy (15 min before / 5 min after T); not an issuer policy",
};
/** Seconds ahead of chain time for the preferred asset's scheduled change; inside `beforeSecs`. */
export const PREFERRED_TRANSITION_LEAD_SECS = 600n;

/**
 * Fixed demo target. Every run resets to it, so with the fixture outputs
 * (EQ-A 4.000000, EQ-B 5.990000) the comparison is always 6.0 vs 5.99
 * share-equivalents, 17 bps.
 */
export const DEVNET_DEMO_TARGET = {
  preferred: { effectiveMultiplier: 1.5, scheduledMultiplier: 1.75 },
  alternative: { effectiveMultiplier: 1.0 },
} as const;

export interface DevnetDemoQuoteFixture {
  readonly label: "DEVNET DEMO QUOTE / FIXTURE";
  readonly notice: string;
  readonly environment: "DEVNET_EXECUTION";
  readonly underlying: string;
  readonly inputRaw: string;
  readonly outputsRaw: Readonly<Record<string, string>>;
}

export function loadDevnetQuoteFixture(): { fixture: DevnetDemoQuoteFixture; sha256: string } {
  const bytes = readFileSync(DEVNET_QUOTE_FIXTURE_URL);
  const fixture = JSON.parse(bytes.toString("utf8")) as DevnetDemoQuoteFixture;
  if (fixture.label !== "DEVNET DEMO QUOTE / FIXTURE" || fixture.environment !== "DEVNET_EXECUTION") {
    throw new Error("devnet quote fixture must be labelled DEVNET DEMO QUOTE / FIXTURE");
  }
  return { fixture, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** State resolution for a devnet test asset: chain-only, same classifier as mainnet. */
export function resolveDevnetAsset(asset: TestAsset, underlying: string, evidence: ChainEvidence, policy: TransitionPolicy): ResolvedRepresentationState {
  const { state, reason } = classifyChainEvidence(evidence, policy);
  return {
    underlying,
    issuer: "DEVNET_TEST",
    symbol: asset.label,
    mint: asset.mint,
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
  };
}

/**
 * The fixture has no input token: the demo delivers the quoted output with
 * transferChecked. This label makes that explicit in every quote identity.
 */
export const DEVNET_DEMO_INPUT = "DEVNET_DEMO_FIXTURE_INPUT";

/**
 * Route identity of a fixture quote: one leg, the fixture itself, for this
 * asset. Delivery is a guarded transferChecked, not a DEX swap.
 */
export function devnetFixtureRoute(asset: TestAsset, fixture: DevnetDemoQuoteFixture): ReturnType<typeof routeIdentity> {
  return routeIdentity(fixture.label, [{ venue: "DEVNET_GUARDED_TRANSFER_CHECKED", poolId: null, inputMint: DEVNET_DEMO_INPUT, outputMint: asset.mint, percent: 100 }]);
}

/** Route observation for a devnet asset: AVAILABLE only when the demo fixture lists an output for it. */
export function fixtureRoute(asset: TestAsset, underlying: string, evidence: ChainEvidence, fixture: DevnetDemoQuoteFixture): RouteObservation {
  const output = fixture.outputsRaw[asset.label];
  const base = { mint: asset.mint, source: fixture.label };
  if (output === undefined) return { ...base, status: "UNAVAILABLE", quote: null, detail: `${asset.label} is not in the DEVNET DEMO QUOTE / FIXTURE` };
  const state = economicStateOf(evidence);
  if (!state) return { ...base, status: "AVAILABLE", quote: null, detail: `${asset.label} chain state could not be bound` };
  const quote: NormalizedQuote = {
    underlying,
    issuer: "DEVNET_TEST",
    inputMint: DEVNET_DEMO_INPUT,
    mint: asset.mint,
    inputRaw: BigInt(fixture.inputRaw),
    outputRaw: BigInt(output),
    minOutputRaw: BigInt(output),
    route: devnetFixtureRoute(asset, fixture),
    quotedAt: null,
    contextSlot: evidence.slot,
    state,
  };
  return { ...base, status: "AVAILABLE", quote, detail: null };
}

export interface DevnetDemoPlan {
  readonly preferred: ResolvedRepresentationState;
  readonly alternative: ResolvedRepresentationState;
  readonly comparison: QuoteComparison | null;
  readonly inputRaw: bigint;
  readonly routes: { readonly preferred: RouteObservation; readonly alternative: RouteObservation };
  readonly consentOff: ExecutionDecision;
  readonly consentOn: ExecutionDecision;
}

/** Pure: resolve, normalize, compare, decide and evaluate eligibility with consent off and on. */
export function planDevnetDemo(input: {
  readonly preferredAsset: TestAsset;
  readonly alternativeAsset: TestAsset;
  readonly preferredEvidence: ChainEvidence;
  readonly alternativeEvidence: ChainEvidence;
  readonly fixture: DevnetDemoQuoteFixture;
  readonly policy: TransitionPolicy;
}): DevnetDemoPlan {
  const { fixture, policy } = input;
  const preferred = resolveDevnetAsset(input.preferredAsset, fixture.underlying, input.preferredEvidence, policy);
  const alternative = resolveDevnetAsset(input.alternativeAsset, fixture.underlying, input.alternativeEvidence, policy);
  const routes = {
    preferred: fixtureRoute(input.preferredAsset, fixture.underlying, input.preferredEvidence, fixture),
    alternative: fixtureRoute(input.alternativeAsset, fixture.underlying, input.alternativeEvidence, fixture),
  };
  const comparison = routes.preferred.quote && routes.alternative.quote ? compareQuotes(routes.preferred.quote, routes.alternative.quote, { toleranceBps: 0n }) : null;
  const inputRaw = BigInt(fixture.inputRaw);
  const base = { preferred, alternative, inputRaw, comparison, routes };
  return {
    preferred,
    alternative,
    comparison,
    inputRaw,
    routes,
    consentOff: decideExecution({ ...base, policy: { allowCrossIssuerReroute: false } }),
    consentOn: decideExecution({ ...base, policy: { allowCrossIssuerReroute: true } }),
  };
}

const f64Bytes = (value: number) => new Uint8Array(new Float64Array([value]).buffer);

export interface SetupUpdate {
  readonly newMultiplier: number;
  readonly effectiveTimestamp: bigint;
}

export interface SetupStep {
  readonly asset: TestAsset;
  readonly purpose: string;
  /** Sent as one transaction, in order. */
  readonly updates: readonly SetupUpdate[];
}

/**
 * Pure setup plan that resets both assets to `DEVNET_DEMO_TARGET` regardless
 * of their current state. EQ-A: set the effective multiplier immediately
 * (timestamp at chain time), then schedule the next one
 * `PREFERRED_TRANSITION_LEAD_SECS` ahead. EQ-B: set it immediately, only if
 * it is not already exactly at target. Absolute values only: nothing depends
 * on the previous multiplier, so no drift can accumulate.
 */
export function planDemoSetup(input: {
  readonly preferredAsset: TestAsset;
  readonly alternativeAsset: TestAsset;
  readonly alternativeState: ProtectedState;
  readonly chainNow: bigint;
}): { readonly steps: readonly SetupStep[]; readonly scheduledTimestamp: bigint } {
  const { preferred, alternative } = DEVNET_DEMO_TARGET;
  const scheduledTimestamp = input.chainNow + PREFERRED_TRANSITION_LEAD_SECS;
  const steps: SetupStep[] = [
    {
      asset: input.preferredAsset,
      purpose: `reset ${input.preferredAsset.label} to effective ${preferred.effectiveMultiplier}, schedule ${preferred.scheduledMultiplier} in ${PREFERRED_TRANSITION_LEAD_SECS}s`,
      updates: [
        { newMultiplier: preferred.effectiveMultiplier, effectiveTimestamp: input.chainNow },
        { newMultiplier: preferred.scheduledMultiplier, effectiveTimestamp: scheduledTimestamp },
      ],
    },
  ];
  const target = f64Bytes(alternative.effectiveMultiplier);
  if (!bytesEqual(input.alternativeState.multiplier, target) || !bytesEqual(input.alternativeState.newMultiplier, target)) {
    steps.push({
      asset: input.alternativeAsset,
      purpose: `reset ${input.alternativeAsset.label} to ${alternative.effectiveMultiplier} immediately`,
      updates: [{ newMultiplier: alternative.effectiveMultiplier, effectiveTimestamp: input.chainNow }],
    });
  }
  return { steps, scheduledTimestamp };
}

/** Differences between on-chain state after setup and `DEVNET_DEMO_TARGET`; empty means at target. */
export function demoSetupMismatches(preferred: ProtectedState, alternative: ProtectedState, scheduledTimestamp: bigint): readonly string[] {
  const { preferred: p, alternative: a } = DEVNET_DEMO_TARGET;
  const mismatches: string[] = [];
  if (!bytesEqual(preferred.multiplier, f64Bytes(p.effectiveMultiplier))) mismatches.push("preferred multiplier");
  if (!bytesEqual(preferred.newMultiplier, f64Bytes(p.scheduledMultiplier))) mismatches.push("preferred newMultiplier");
  if (preferred.newMultiplierEffectiveTimestamp !== scheduledTimestamp) mismatches.push("preferred effective timestamp");
  if (!bytesEqual(alternative.multiplier, f64Bytes(a.effectiveMultiplier))) mismatches.push("alternative multiplier");
  if (!bytesEqual(alternative.newMultiplier, f64Bytes(a.effectiveMultiplier))) mismatches.push("alternative newMultiplier");
  return mismatches;
}

/**
 * `[guard(asset), create recipient ATA, transferChecked(asset)]`, guard first.
 * The guard expects exactly `boundState`: the state the decision was made on.
 */
export async function guardedDeliveryInstructions(input: {
  readonly programId: Address;
  readonly payer: TransactionSigner;
  readonly recipient: Address;
  readonly asset: TestAsset;
  readonly boundState: EconomicState;
  readonly policy: TransitionPolicy;
  readonly amount: bigint;
}): Promise<Instruction[]> {
  if (input.boundState.mint !== input.asset.mint) throw new Error("bound state is for a different mint than the delivered asset");
  if (input.boundState.decimals !== input.asset.decimals) throw new Error("bound state decimals differ from the delivered asset");
  const [source] = await findAssociatedTokenPda({ owner: input.payer.address, mint: input.asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner: input.recipient, mint: input.asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return [
    getAssertSafeExecutionInstruction({
      programAddress: input.programId,
      mint: input.asset.mint,
      request: {
        expected: protectedStateOf(input.boundState),
        expectedPhase: input.boundState.phase,
        window: { beforeSecs: Number(input.policy.beforeSecs), afterSecs: Number(input.policy.afterSecs) },
      },
    }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: input.payer, owner: input.recipient, mint: input.asset.mint }),
    getTransferCheckedInstruction({ source, mint: input.asset.mint, destination, authority: input.payer, amount: input.amount, decimals: input.asset.decimals }),
  ];
}

export class DevnetDemoEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevnetDemoEnvironmentError";
  }
}

async function tokenBalance(ctx: DevnetContext, owner: Address, mint: Address): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const info = await ctx.rpc.getAccountInfo(ata, { encoding: "base64", commitment: "confirmed" }).send();
  if (!info.value) return 0n;
  const { value } = await ctx.rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send();
  return BigInt(value.amount);
}

async function submitGuardedDelivery(ctx: DevnetContext, programId: Address, asset: TestAsset, boundState: EconomicState, amount: bigint, recipient: Address): Promise<DevnetTransactionEvidence> {
  const instructions = await guardedDeliveryInstructions({ programId, payer: ctx.payer, recipient, asset, boundState, policy: DEVNET_DEMO_POLICY, amount });
  const before = await tokenBalance(ctx, recipient, asset.mint);
  // Preflight is skipped so a rejected attempt lands on-chain and is verifiable.
  const outcome = await sendInstructions(ctx, instructions, { skipPreflight: true });
  const after = await tokenBalance(ctx, recipient, asset.mint);
  return {
    signature: outcome.signature,
    slot: outcome.slot,
    succeeded: outcome.succeeded,
    customErrorName: outcome.customError && outcome.customError.instructionIndex === 0 ? equityGuardErrorName(outcome.customError.code) ?? null : null,
    downstreamBalanceBefore: before,
    downstreamBalanceAfter: after,
    explorerUrl: explorerUrl(ctx.cluster, outcome.signature),
  };
}

/** Opaque verified devnet context (genesis re-checked again before signing) and the pinned program. No RPC. */
function requireDevnet(ctx: DevnetContext, programId: Address): void {
  assertVerifiedDevnetContext(ctx);
  if (programId !== EQUITY_GUARD_DEVNET_PROGRAM_ID) throw new DevnetDemoEnvironmentError("deployment is not the pinned devnet program");
}

/**
 * The only path that executes. It consumes an `ExecutionPlan` (which can only
 * exist for an EXECUTABLE devnet decision) and verifies it first, before any
 * RPC call: `quote` is the quote about to be delivered and `comparison` the
 * one consent was given to; any substitution fails closed. The guard asserts
 * `plan.economicState` and the delivered amount is `plan.expectedOutputRaw`.
 */
export async function executeGuardedPlan(
  ctx: DevnetContext,
  input: {
    readonly programId: Address;
    readonly plan: ExecutionPlan;
    readonly quote: NormalizedQuote;
    readonly comparison: QuoteComparison | null;
    readonly asset: TestAsset;
    readonly recipient: Address;
  },
): Promise<DevnetTransactionEvidence> {
  verifyExecutionPlan(input.plan, { quote: input.quote, comparison: input.comparison });
  requireDevnet(ctx, input.programId);
  if (input.plan.selectedRepresentation.mint !== input.asset.mint || input.plan.economicState.decimals !== input.asset.decimals) {
    throw new DevnetDemoEnvironmentError("execution asset differs from the plan's selected representation");
  }
  return submitGuardedDelivery(ctx, input.programId, input.asset, input.plan.economicState, input.plan.expectedOutputRaw, input.recipient);
}

/**
 * NOT an execution of a decision: deliberately submits a guarded delivery for
 * a representation the state engine did NOT classify SAFE, to prove the
 * on-chain guard rejects it atomically. Refuses to run for a SAFE state.
 */
export async function submitRejectionProbe(
  ctx: DevnetContext,
  input: { readonly programId: Address; readonly representation: ResolvedRepresentationState; readonly boundState: EconomicState; readonly asset: TestAsset; readonly amount: bigint; readonly recipient: Address },
): Promise<DevnetTransactionEvidence> {
  requireDevnet(ctx, input.programId);
  if (input.representation.state === RepresentationState.SAFE || input.representation.mint !== input.asset.mint) {
    throw new DevnetDemoEnvironmentError("a rejection probe is only for a non-SAFE representation of the probed asset");
  }
  return submitGuardedDelivery(ctx, input.programId, input.asset, input.boundState, input.amount, input.recipient);
}

export interface SetupTransaction {
  readonly purpose: string;
  readonly signature: string;
}

/** Applies `planDemoSetup` on devnet and verifies the resulting chain state; throws if it is not at target. */
async function resetDemoState(ctx: DevnetContext, preferredAsset: TestAsset, alternativeAsset: TestAsset): Promise<SetupTransaction[]> {
  const alternative = await fetchGuardSnapshot(ctx.rpc, alternativeAsset.mint);
  const plan = planDemoSetup({ preferredAsset, alternativeAsset, alternativeState: alternative.state, chainNow: alternative.clock.unixTimestamp });
  const sent: SetupTransaction[] = [];
  for (const step of plan.steps) {
    const instructions = step.updates.map((u) => getScheduleMultiplierInstruction({ mint: step.asset.mint, authority: ctx.payer, newMultiplier: u.newMultiplier, effectiveTimestamp: u.effectiveTimestamp }));
    const outcome = await sendInstructions(ctx, instructions, { skipPreflight: false });
    if (!outcome.succeeded) throw new DevnetDemoSetupError(`setup failed: ${step.purpose} (${outcome.signature})`);
    sent.push({ purpose: step.purpose, signature: outcome.signature });
  }
  const [p, a] = [await fetchGuardSnapshot(ctx.rpc, preferredAsset.mint), await fetchGuardSnapshot(ctx.rpc, alternativeAsset.mint)];
  const mismatches = demoSetupMismatches(p.state, a.state, plan.scheduledTimestamp);
  if (mismatches.length > 0) throw new DevnetDemoSetupError(`devnet demo state is not at target after setup: ${mismatches.join(", ")}`);
  return sent;
}

export class DevnetDemoSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevnetDemoSetupError";
  }
}

export interface DevnetDemoRun {
  readonly setupTransactions: readonly SetupTransaction[];
  readonly recipient: Address;
  readonly consentOff: DevnetExecutionResult;
  readonly consentOn: DevnetExecutionResult;
  readonly executionPlan: ExecutionPlan | null;
}

export async function runDevnetDemo(
  ctx: DevnetContext,
  state: DevnetState,
  options: { readonly preferredLabel: string; readonly alternativeLabel: string; readonly recipient: Address },
): Promise<DevnetDemoRun> {
  const programId = requireDeployment(state).programId;
  requireDevnet(ctx, programId);
  const preferredAsset = findAsset(state, options.preferredLabel);
  const alternativeAsset = findAsset(state, options.alternativeLabel);
  const { fixture, sha256 } = loadDevnetQuoteFixture();

  const setupTransactions = await resetDemoState(ctx, preferredAsset, alternativeAsset);
  const preferredEvidence = await fetchChainObservation(ctx.rpc, preferredAsset.mint);
  const alternativeEvidence = await fetchChainObservation(ctx.rpc, alternativeAsset.mint);
  const plan = planDevnetDemo({ preferredAsset, alternativeAsset, preferredEvidence, alternativeEvidence, fixture, policy: DEVNET_DEMO_POLICY });

  const evidenceSources: EvidenceReference[] = [
    { kind: "DEVNET_CHAIN_STATE", description: `${preferredAsset.label} mint at slot ${preferredEvidence.slot}`, sha256: null, observedAt: preferredEvidence.observedAt },
    { kind: "DEVNET_CHAIN_STATE", description: `${alternativeAsset.label} mint at slot ${alternativeEvidence.slot}`, sha256: null, observedAt: alternativeEvidence.observedAt },
    { kind: "DEVNET_DEMO_QUOTE_FIXTURE", description: "scripts/demo/fixtures/devnet-demo-quotes.json", sha256, observedAt: null },
  ];
  const quoteAvailability: QuoteAvailability = {
    source: "DEVNET_DEMO_QUOTE_FIXTURE",
    observedAt: null,
    preferred: plan.routes.preferred.status,
    alternative: plan.routes.alternative.status,
    note: fixture.notice,
  };
  const amountFor = (asset: TestAsset) => BigInt(fixture.outputsRaw[asset.label] ?? "0");

  const consentOff = devnetExecutionResult({ decision: plan.consentOff, evidenceSources, quoteAvailability });
  if (plan.consentOn.executionEligibility !== "EXECUTABLE") {
    return { setupTransactions, recipient: options.recipient, consentOff, consentOn: devnetExecutionResult({ decision: plan.consentOn, evidenceSources, quoteAvailability }), executionPlan: null };
  }

  // Immutable plan from the EXECUTABLE consented decision: exact quote, route, state and comparison.
  const executionPlan = createExecutionPlan(plan.consentOn, "DEVNET_EXECUTION");
  // Rejection probe: the non-SAFE preferred delivery must be rejected atomically.
  const rejectedPreferredAttempt =
    plan.preferred.state !== RepresentationState.SAFE && plan.comparison
      ? await submitRejectionProbe(ctx, { programId, representation: plan.preferred, boundState: plan.comparison.preferredQuote.state, asset: preferredAsset, amount: amountFor(preferredAsset), recipient: options.recipient })
      : null;
  // Execution consumes the plan; the presented quote is the selected route's quote.
  const selected = executionPlan.selectedRepresentation.mint === alternativeAsset.mint ? { asset: alternativeAsset, route: plan.routes.alternative } : { asset: preferredAsset, route: plan.routes.preferred };
  if (!selected.route.quote) throw new DevnetDemoEnvironmentError("selected route has no quote");
  const executed = await executeGuardedPlan(ctx, { programId, plan: executionPlan, quote: selected.route.quote, comparison: plan.comparison, asset: selected.asset, recipient: options.recipient });
  const consentOn = devnetExecutionResult({ decision: plan.consentOn, evidenceSources, quoteAvailability, execution: { executed, rejectedPreferredAttempt }, executionPlanId: executionPlan.planId });
  return { setupTransactions, recipient: options.recipient, consentOff, consentOn, executionPlan };
}
