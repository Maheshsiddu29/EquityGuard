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
  equityGuardErrorName,
  fetchGuardSnapshot,
  getAssertSafeExecutionInstruction,
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
  type ChainEvidence,
  type DevnetExecutionResult,
  type DevnetTransactionEvidence,
  type EconomicState,
  type EvidenceReference,
  type ExecutionDecision,
  type NormalizedQuote,
  type QuoteAvailability,
  type QuoteComparison,
  type ResolvedRepresentationState,
  type RouteObservation,
  type TransitionPolicy,
} from "@equityguard/representation-state";

import type { DevnetContext } from "../devnet/config.ts";
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
/** Seconds ahead of chain time for the preferred asset's scheduled change. */
export const PREFERRED_TRANSITION_LEAD_SECS = 600n;


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

/** Route observation for a devnet asset: AVAILABLE only when the demo fixture lists an output for it. */
export function fixtureRoute(asset: TestAsset, underlying: string, evidence: ChainEvidence, fixture: DevnetDemoQuoteFixture): RouteObservation {
  const output = fixture.outputsRaw[asset.label];
  const base = { mint: asset.mint, source: fixture.label };
  if (output === undefined) return { ...base, status: "UNAVAILABLE", quote: null, detail: `${asset.label} is not in the DEVNET DEMO QUOTE / FIXTURE` };
  const state = economicStateOf(evidence);
  if (!state) return { ...base, status: "AVAILABLE", quote: null, detail: `${asset.label} chain state could not be bound` };
  const quote: NormalizedQuote = { underlying, issuer: "DEVNET_TEST", mint: asset.mint, inputRaw: BigInt(fixture.inputRaw), outputRaw: BigInt(output), state };
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

function requireDevnet(ctx: DevnetContext, programId: Address): void {
  if (ctx.cluster !== "devnet") throw new DevnetDemoEnvironmentError(`the devnet execution demo only runs on devnet, not ${ctx.cluster}`);
  if (programId !== EQUITY_GUARD_DEVNET_PROGRAM_ID) throw new DevnetDemoEnvironmentError("deployment is not the pinned devnet program");
}

/**
 * The only path that executes a decision. The eligibility gate runs first,
 * before any RPC call: anything but EXECUTABLE is refused, and the guard
 * asserts the decision's executable state.
 */
export async function executeGuardedDecision(
  ctx: DevnetContext,
  input: { readonly programId: Address; readonly decision: ExecutionDecision; readonly asset: TestAsset; readonly amount: bigint; readonly recipient: Address },
): Promise<DevnetTransactionEvidence> {
  assertExecutable(input.decision);
  requireDevnet(ctx, input.programId);
  if (input.decision.selectedRepresentation.mint !== input.asset.mint) {
    throw new DevnetDemoEnvironmentError("execution asset differs from the decision's selected representation");
  }
  return submitGuardedDelivery(ctx, input.programId, input.asset, input.decision.executableState, input.amount, input.recipient);
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

/** Puts the preferred asset into a scheduled transition inside the policy window, unless it already is. */
async function ensurePreferredTransition(ctx: DevnetContext, asset: TestAsset): Promise<string | null> {
  const evidence = await fetchChainObservation(ctx.rpc, asset.mint);
  if (classifyChainEvidence(evidence, DEVNET_DEMO_POLICY).state === RepresentationState.TRANSITION) return null;
  const snapshot = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  const effective = snapshot.phase === 1 ? snapshot.state.newMultiplier : snapshot.state.multiplier;
  const current = new DataView(effective.buffer, effective.byteOffset, 8).getFloat64(0, true);
  const outcome = await sendInstructions(
    ctx,
    [getScheduleMultiplierInstruction({ mint: asset.mint, authority: ctx.payer, newMultiplier: current + 0.25, effectiveTimestamp: snapshot.clock.unixTimestamp + PREFERRED_TRANSITION_LEAD_SECS })],
    { skipPreflight: false },
  );
  return outcome.signature;
}

export interface DevnetDemoRun {
  readonly scheduleSignature: string | null;
  readonly recipient: Address;
  readonly consentOff: DevnetExecutionResult;
  readonly consentOn: DevnetExecutionResult;
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

  const scheduleSignature = await ensurePreferredTransition(ctx, preferredAsset);
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
    return { scheduleSignature, recipient: options.recipient, consentOff, consentOn: devnetExecutionResult({ decision: plan.consentOn, evidenceSources, quoteAvailability }) };
  }

  // Rejection probe: the non-SAFE preferred delivery must be rejected atomically.
  const rejectedPreferredAttempt =
    plan.preferred.state !== RepresentationState.SAFE && plan.comparison
      ? await submitRejectionProbe(ctx, { programId, representation: plan.preferred, boundState: plan.comparison.preferredState, asset: preferredAsset, amount: amountFor(preferredAsset), recipient: options.recipient })
      : null;
  // Execution of the consented decision, through the eligibility gate.
  const selectedAsset = plan.consentOn.selectedRepresentation?.mint === alternativeAsset.mint ? alternativeAsset : preferredAsset;
  const executed = await executeGuardedDecision(ctx, { programId, decision: plan.consentOn, asset: selectedAsset, amount: amountFor(selectedAsset), recipient: options.recipient });
  const consentOn = devnetExecutionResult({ decision: plan.consentOn, evidenceSources, quoteAvailability, execution: { executed, rejectedPreferredAttempt } });
  return { scheduleSignature, recipient: options.recipient, consentOff, consentOn };
}
