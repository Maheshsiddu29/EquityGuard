/**
 * DEVNET_EXECUTION demo: the same state engine and decision engine as the
 * mainnet replay, executed against the deployed EquityGuard devnet program and
 * the EQ-A / EQ-B devnet test assets.
 *
 * Every transaction is `[assert_safe_execution(asset), create recipient ATA,
 * transferChecked(asset)]`: the token delivery settles only if the guard
 * passes. The guard asserts exactly the economic state the decision and the
 * quote comparison were built against, so a state change between decision
 * and landing fails the transaction instead of executing on stale economics. Quotes come from the DEVNET DEMO QUOTE / FIXTURE, never from a live
 * market.
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
  Decision,
  RepresentationState,
  StateSource,
  classifyChainEvidence,
  compareQuotes,
  decide,
  devnetExecutionResult,
  economicStateOf,
  fetchChainObservation,
  protectedStateOf,
  type ChainEvidence,
  type DecisionResult,
  type DevnetExecutionResult,
  type DevnetTransactionEvidence,
  type EconomicState,
  type EvidenceReference,
  type NormalizedQuote,
  type QuoteAvailability,
  type QuoteComparison,
  type ResolvedRepresentationState,
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

function quoteFor(asset: TestAsset, underlying: string, evidence: ChainEvidence, fixture: DevnetDemoQuoteFixture): NormalizedQuote | null {
  const output = fixture.outputsRaw[asset.label];
  const state = economicStateOf(evidence);
  if (output === undefined || !state) return null;
  return { underlying, issuer: "DEVNET_TEST", mint: asset.mint, inputRaw: BigInt(fixture.inputRaw), outputRaw: BigInt(output), state };
}

export interface DevnetDemoPlan {
  readonly preferred: ResolvedRepresentationState;
  readonly alternative: ResolvedRepresentationState;
  readonly comparison: QuoteComparison | null;
  readonly inputRaw: bigint;
  readonly consentOff: DecisionResult;
  readonly consentOn: DecisionResult;
}

/** Pure: resolve, normalize, compare and decide with consent off and on. */
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
  const p = quoteFor(input.preferredAsset, fixture.underlying, input.preferredEvidence, fixture);
  const a = quoteFor(input.alternativeAsset, fixture.underlying, input.alternativeEvidence, fixture);
  const comparison = p && a ? compareQuotes(p, a, { toleranceBps: 0n }) : null;
  const inputRaw = BigInt(fixture.inputRaw);
  const base = { preferred, alternative, inputRaw, comparison };
  return {
    preferred,
    alternative,
    comparison,
    inputRaw,
    consentOff: decide({ ...base, policy: { allowCrossIssuerReroute: false } }),
    consentOn: decide({ ...base, policy: { allowCrossIssuerReroute: true } }),
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

async function guardedDelivery(ctx: DevnetContext, programId: Address, asset: TestAsset, boundState: EconomicState, amount: bigint, recipient: Address): Promise<DevnetTransactionEvidence> {
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
  if (ctx.cluster !== "devnet") throw new DevnetDemoEnvironmentError(`the devnet execution demo only runs on devnet, not ${ctx.cluster}`);
  const programId = requireDeployment(state).programId;
  if (programId !== EQUITY_GUARD_DEVNET_PROGRAM_ID) throw new DevnetDemoEnvironmentError("deployment is not the pinned devnet program");
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
    preferred: fixture.outputsRaw[preferredAsset.label] ? "AVAILABLE" : "UNAVAILABLE",
    alternative: fixture.outputsRaw[alternativeAsset.label] ? "AVAILABLE" : "UNAVAILABLE",
    note: fixture.notice,
  };

  const consentOff = devnetExecutionResult({ decision: plan.consentOff, comparison: plan.comparison, evidenceSources, quoteAvailability });
  if (plan.consentOn.decision !== Decision.USE_ALTERNATIVE) {
    return { scheduleSignature, recipient: options.recipient, consentOff, consentOn: devnetExecutionResult({ decision: plan.consentOn, comparison: plan.comparison, evidenceSources, quoteAvailability }) };
  }

  // USE_ALTERNATIVE implies a state-bound comparison exists.
  const bound = plan.comparison;
  if (!bound) throw new Error("USE_ALTERNATIVE without a state-bound comparison");
  // Proof attempt: the unsafe preferred delivery must be rejected atomically.
  const rejectedPreferredAttempt = await guardedDelivery(ctx, programId, preferredAsset, bound.preferredState, BigInt(fixture.outputsRaw[preferredAsset.label] ?? "0"), options.recipient);
  // Consented execution of the SAFE alternative, guarded by the state it was compared on.
  const executed = await guardedDelivery(ctx, programId, alternativeAsset, bound.alternativeState, BigInt(fixture.outputsRaw[alternativeAsset.label] ?? "0"), options.recipient);
  const consentOn = devnetExecutionResult({
    decision: plan.consentOn,
    comparison: plan.comparison,
    evidenceSources,
    quoteAvailability,
    execution: { executed, rejectedPreferredAttempt },
  });
  return { scheduleSignature, recipient: options.recipient, consentOff, consentOn };
}
