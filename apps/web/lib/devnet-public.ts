/**
 * Public Devnet demo policy. This is not the local Phantom coordinator and
 * it is not the recorded KOx replay.
 *
 * Chain time is the only clock that may authorize a signature or a submit.
 * A displayed countdown is presentation and is ignored by every decision.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { getCreateAccountWithSeedInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getMintSize,
  getMintToInstruction,
  getTransferCheckedInstruction,
  getUpdateMultiplierScaledUiMintInstruction,
} from "@solana-program/token-2022";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createAddressWithSeed,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Signature,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";

export { TOKEN_2022_PROGRAM_ADDRESS, address };

/** Same phase codes as the reviewed program. Clock >= T is activated. */
export const ActivationPhase = {
  Pending: 0,
  Activated: 1,
} as const;
export type ActivationPhase = (typeof ActivationPhase)[keyof typeof ActivationPhase];

export interface ProtectedState {
  readonly multiplier: Uint8Array;
  readonly newMultiplier: Uint8Array;
  readonly newMultiplierEffectiveTimestamp: bigint;
}

export interface ProtectionWindow {
  readonly beforeSecs: number;
  readonly afterSecs: number;
}

export interface AssertSafeExecutionRequest {
  readonly expected: ProtectedState;
  readonly expectedPhase: ActivationPhase;
  readonly window: ProtectionWindow;
}

export interface GuardSnapshot {
  readonly mint?: Address;
  readonly contextSlot?: bigint;
  readonly state: ProtectedState;
  readonly phase: ActivationPhase;
  readonly hasScheduledChange: boolean;
  readonly clock: { readonly slot?: bigint; readonly unixTimestamp: bigint };
}

const I64_MIN = -(BigInt(1) << BigInt(63));
const I64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hasScheduledChange(state: ProtectedState): boolean {
  return !bytesEqual(state.multiplier, state.newMultiplier);
}

function phaseAt(state: ProtectedState, unixTimestamp: bigint): ActivationPhase {
  return unixTimestamp >= state.newMultiplierEffectiveTimestamp ? ActivationPhase.Activated : ActivationPhase.Pending;
}

/** Same check order as the reviewed program: stored bytes, then the window, then phase. */
function checkGuardOffline(
  request: AssertSafeExecutionRequest,
  actual: ProtectedState,
  unixTimestamp: bigint,
): "MultiplierChanged" | "NewMultiplierChanged" | "EffectiveTimestampChanged" | "ArithmeticOverflow" | "InsideTransitionWindow" | "ActivationPhaseChanged" | null {
  if (!bytesEqual(actual.multiplier, request.expected.multiplier)) return "MultiplierChanged";
  if (!bytesEqual(actual.newMultiplier, request.expected.newMultiplier)) return "NewMultiplierChanged";
  if (actual.newMultiplierEffectiveTimestamp !== request.expected.newMultiplierEffectiveTimestamp) return "EffectiveTimestampChanged";
  if (!hasScheduledChange(actual)) return null;
  const start = actual.newMultiplierEffectiveTimestamp - BigInt(request.window.beforeSecs);
  const end = actual.newMultiplierEffectiveTimestamp + BigInt(request.window.afterSecs);
  if (start < I64_MIN || end > I64_MAX) return "ArithmeticOverflow";
  if (start <= unixTimestamp && unixTimestamp <= end) return "InsideTransitionWindow";
  if (phaseAt(actual, unixTimestamp) !== request.expectedPhase) return "ActivationPhaseChanged";
  return null;
}

function expectationFromSnapshot(snapshot: GuardSnapshot, window: ProtectionWindow): AssertSafeExecutionRequest {
  return { expected: snapshot.state, expectedPhase: snapshot.phase, window };
}

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export const DEVNET_PUBLIC_DISCLAIMER =
  "Demo tokenized-equity assets on Solana Devnet. Not real securities and no market value.";

/** Genesis hashes. Pinned again by the web test against guard-client. */
export const PUBLIC_GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

/**
 * Setup reads the Devnet Clock and arms T this many seconds later.
 * The interval has to cover Phantom setup approval and Devnet confirmation.
 * A recent blockhash lasts about 60 seconds and is fetched only when the
 * user authorizes, so the visible countdown is whatever chain time remains
 * after that signature. It is usually a short wait and is not a fixed duration.
 */
export const ACTIVATION_DELAY_SECONDS = 35;

/**
 * Phantom is not opened when fewer than this many chain seconds remain.
 * Authorize is enabled as soon as at least this much time remains.
 * There is no extra wait once that minimum is met.
 */
export const MIN_AUTHORIZATION_REMAINING_SECONDS = 8;

export const CLOCK_CROSSING_WINDOW: ProtectionWindow = { beforeSecs: 0, afterSecs: 0 };

export const DEMO_TRANSFER_RAW = BigInt(100000);

export const AUTHORIZATION_WINDOW_MISSED_TITLE = "AUTHORIZATION WINDOW MISSED";
export const AUTHORIZATION_WINDOW_MISSED_MESSAGE =
  "The corporate action is too close to activation. Start a new attempt.";

export const AUTHORIZATION_WINDOW_ELAPSED_TITLE = "AUTHORIZATION_WINDOW_ELAPSED";
export const AUTHORIZATION_WINDOW_ELAPSED_MESSAGE =
  "The corporate action activated before wallet approval completed. No transaction was submitted. Start a new attempt.";

export const STALE_AUTHORIZATION_EXPIRED_TITLE = "STALE_AUTHORIZATION_EXPIRED";
export const STALE_AUTHORIZATION_EXPIRED_MESSAGE =
  "The signed authorization expired before Solana could land it. This is not a protection result. Start a new attempt.";

export const PROTECTION_EXPLANATION =
  "The asset's economic state changed after authorization. StateGuard required a new authorization instead of silently executing against the changed state.";

export interface EquityScenario {
  readonly id: "KO-DEMO" | "UNH-DEMO" | "CRM-DEMO";
  readonly symbol: "KO-DEMO" | "UNH-DEMO" | "CRM-DEMO";
  readonly displayName: string;
  readonly eventLabel: string;
  readonly initialMultiplier: 1;
  readonly newMultiplier: 2 | 1.5 | 0.5;
}

export const SCENARIO_CATALOG: readonly EquityScenario[] = Object.freeze([
  Object.freeze({
    id: "KO-DEMO",
    symbol: "KO-DEMO",
    displayName: "Coca-Cola Demo Equity",
    eventLabel: "2-for-1 stock split",
    initialMultiplier: 1,
    newMultiplier: 2,
  }),
  Object.freeze({
    id: "UNH-DEMO",
    symbol: "UNH-DEMO",
    displayName: "UnitedHealth Demo Equity",
    eventLabel: "3-for-2 stock split",
    initialMultiplier: 1,
    newMultiplier: 1.5,
  }),
  Object.freeze({
    id: "CRM-DEMO",
    symbol: "CRM-DEMO",
    displayName: "Salesforce Demo Equity",
    eventLabel: "1-for-2 reverse split",
    initialMultiplier: 1,
    newMultiplier: 0.5,
  }),
]);

const APPROVED_MULTIPLIERS: readonly number[] = [1, 1.5, 2, 0.5];

export type PublicDemoMode = "replay" | "devnet";

/** The public page opens on the recorded replay. Devnet is never the default. */
export function initialPublicDemoMode(): PublicDemoMode {
  return "replay";
}

export function isExplicitDevnetSelection(choice: PublicDemoMode | null): boolean {
  return choice === "devnet";
}

export function validatePublicTiming(
  delay = ACTIVATION_DELAY_SECONDS,
  minimumRemaining = MIN_AUTHORIZATION_REMAINING_SECONDS,
): void {
  if (!Number.isInteger(delay) || !Number.isInteger(minimumRemaining)) {
    throw new Error("Activation timing must be whole seconds");
  }
  if (delay < 35 || delay > 45) throw new Error("Activation delay must leave room for Devnet setup confirmation");
  if (minimumRemaining !== 8) throw new Error("Minimum authorization window must be 8 seconds");
  if (minimumRemaining >= delay) throw new Error("Minimum remaining time consumes the whole activation delay");
}

validatePublicTiming();

export function activationTimestamp(chainUnixTimestamp: bigint, delaySeconds = ACTIVATION_DELAY_SECONDS): bigint {
  if (chainUnixTimestamp < BigInt(0)) throw new Error("Chain clock is not usable");
  return chainUnixTimestamp + BigInt(delaySeconds);
}

export function isApprovedMultiplier(value: number): boolean {
  return APPROVED_MULTIPLIERS.some((approved) => Object.is(approved, value));
}

export function storedMultiplier(value: number): Uint8Array {
  if (!isApprovedMultiplier(value)) throw new Error("Multiplier is not in the approved scenario catalog");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
}

export function formatMultiplier(value: number): string {
  if (!isApprovedMultiplier(value)) throw new Error("Multiplier is not in the approved scenario catalog");
  return `${value.toFixed(2)}×`;
}

export function scenarioById(id: string): EquityScenario {
  const scenario = SCENARIO_CATALOG.find((item) => item.id === id);
  if (!scenario) throw new Error("Unknown scenario");
  return scenario;
}

export function randomScenario(random: () => number = Math.random): EquityScenario {
  const sample = random();
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("Random selection left the approved scenario catalog");
  }
  const scenario = SCENARIO_CATALOG[Math.floor(sample * SCENARIO_CATALOG.length)];
  if (!scenario) throw new Error("Random selection left the approved scenario catalog");
  return scenario;
}

export interface ActiveAttempt {
  readonly scenario: EquityScenario;
  readonly status: "ACTIVE";
}

export function startAttempt(scenario: EquityScenario): ActiveAttempt {
  return Object.freeze({ scenario: scenarioById(scenario.id), status: "ACTIVE" as const });
}

export function scenarioForAttempt(attempt: ActiveAttempt, requestedId: string): EquityScenario {
  if (attempt.status !== "ACTIVE" || requestedId !== attempt.scenario.id) {
    throw new Error("Scenario cannot change during an active attempt");
  }
  return attempt.scenario;
}

export function assertDevnetCluster(genesisHash: string): "devnet" {
  if (genesisHash === PUBLIC_GENESIS["mainnet-beta"]) {
    throw new Error("Connected to mainnet-beta — refusing all state-changing actions");
  }
  if (genesisHash === PUBLIC_GENESIS.testnet) {
    throw new Error("Connected to testnet — only devnet is supported");
  }
  if (genesisHash !== PUBLIC_GENESIS.devnet) throw new Error("Cluster is not Solana Devnet");
  return "devnet";
}

export function requirePhantom(provider: { readonly isPhantom?: boolean } | null): void {
  if (!provider?.isPhantom) throw new Error("Connect Phantom before starting a live Devnet attempt.");
}

function scheduledBytesMatch(snapshot: GuardSnapshot, scenario: EquityScenario, activation: bigint): boolean {
  return bytesEqual(snapshot.state.multiplier, storedMultiplier(scenario.initialMultiplier))
    && bytesEqual(snapshot.state.newMultiplier, storedMultiplier(scenario.newMultiplier))
    && snapshot.state.newMultiplierEffectiveTimestamp === activation
    && snapshot.hasScheduledChange
    && hasScheduledChange(snapshot.state)
    && snapshot.phase === phaseAt(snapshot.state, snapshot.clock.unixTimestamp);
}

export type AuthorizeDecision = "sign" | "missed" | "mismatch";

/**
 * Whether Authorize may open Phantom. Safe remaining time signs immediately.
 * There is no artificial delay once that minimum is met.
 */
export function authorizeDecision(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): AuthorizeDecision {
  if (!scheduledBytesMatch(snapshot, scenario, activation)) return "mismatch";
  const remaining = activation - snapshot.clock.unixTimestamp;
  if (snapshot.clock.unixTimestamp >= activation || snapshot.phase !== ActivationPhase.Pending || remaining < BigInt(MIN_AUTHORIZATION_REMAINING_SECONDS)) {
    return "missed";
  }
  return "sign";
}

/** The second read, after Phantom returns. Clock at T is already too late. */
export function pendingReturnDecision(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): "hold" | "elapsed" {
  if (!scheduledBytesMatch(snapshot, scenario, activation)) return "elapsed";
  if (snapshot.clock.unixTimestamp >= activation || snapshot.phase !== ActivationPhase.Pending) return "elapsed";
  return "hold";
}

export function presentationCountdownSeconds(chainUnixTimestamp: bigint, activation: bigint): number {
  const remaining = activation - chainUnixTimestamp;
  if (remaining <= BigInt(0)) return 0;
  return Number(remaining > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : remaining);
}

/**
 * A displayed countdown cannot submit. Only the chain-ready flag can.
 */
export function submissionPermitted(input: { readonly displayedSeconds: number; readonly chainReady: boolean }): boolean {
  return input.chainReady;
}

export function chainReadyForStaleSubmit(snapshot: GuardSnapshot, expectation: AssertSafeExecutionRequest): boolean {
  if (expectation.expectedPhase !== ActivationPhase.Pending) return false;
  if (expectation.window.beforeSecs !== 0 || expectation.window.afterSecs !== 0) return false;
  return checkGuardOffline(expectation, snapshot.state, snapshot.clock.unixTimestamp) === "ActivationPhaseChanged";
}

/**
 * Wait until the sealed authorization should produce ActivationPhaseChanged,
 * then submit those exact bytes. A later processed-height read is not Solana's
 * decision about this transaction: a public RPC can report that height from
 * another node. `lastValidBlockHeight` stays on the held authorization for
 * diagnostics. Expiry is only a sendTransaction rejection of these bytes.
 */
export function heldWaitDecision(input: {
  readonly blockHeight: bigint;
  readonly lastValidBlockHeight: bigint;
  readonly ready: boolean;
}): "wait" | "submit" | "expired" {
  void input.blockHeight;
  void input.lastValidBlockHeight;
  return input.ready ? "submit" : "wait";
}

export type ActivatedDecision = "wait" | "ready" | "mismatch";

/** A new authorization may be built only after the chain clock is past T. */
export function activatedReviewDecision(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): ActivatedDecision {
  if (!scheduledBytesMatch(snapshot, scenario, activation)) return "mismatch";
  if (snapshot.phase !== ActivationPhase.Activated || snapshot.clock.unixTimestamp <= activation) return "wait";
  const expectation = expectationFromSnapshot(snapshot, CLOCK_CROSSING_WINDOW);
  if (expectation.expectedPhase !== ActivationPhase.Activated) return "mismatch";
  return checkGuardOffline(expectation, snapshot.state, snapshot.clock.unixTimestamp) === null ? "ready" : "wait";
}

export function expectationForSnapshot(snapshot: GuardSnapshot): AssertSafeExecutionRequest {
  return expectationFromSnapshot(snapshot, CLOCK_CROSSING_WINDOW);
}

export interface TokenBalances {
  readonly source: bigint;
  readonly destination: bigint;
}

export interface ConfirmedChainOutcome {
  readonly signature: string;
  readonly slot: bigint;
  readonly error: unknown;
  readonly customError: { readonly instructionIndex: number; readonly code: number } | null;
  readonly logs: readonly string[];
  readonly guardInstructionIndex: number;
}

export function acceptActivationRejection(input: {
  readonly outcome: ConfirmedChainOutcome;
  readonly before: TokenBalances;
  readonly after: TokenBalances;
  readonly programId: string;
  readonly tokenProgram: string;
}): boolean {
  const code = input.outcome.customError?.code;
  const index = input.outcome.customError?.instructionIndex;
  return input.outcome.error !== null
    && input.outcome.signature.length > 0
    && index === input.outcome.guardInstructionIndex
    && code === 12
    && input.before.source === input.after.source
    && input.before.destination === input.after.destination
    && input.outcome.logs.some((line) => line.startsWith(`Program ${input.programId} invoke`))
    && !input.outcome.logs.some((line) => line === `Program ${input.tokenProgram} success`);
}

export function acceptUpdatedExecution(input: {
  readonly outcome: ConfirmedChainOutcome;
  readonly before: TokenBalances;
  readonly after: TokenBalances;
  readonly amount: bigint;
  readonly programId: string;
  readonly tokenProgram: string;
}): boolean {
  const sourceDelta = input.before.source - input.after.source;
  const destinationDelta = input.after.destination - input.before.destination;
  return input.outcome.error === null
    && input.outcome.signature.length > 0
    && sourceDelta === input.amount
    && destinationDelta === input.amount
    && input.outcome.logs.some((line) => line === `Program ${input.programId} success`)
    && input.outcome.logs.some((line) => line === `Program ${input.tokenProgram} success`);
}

export function shortAddress(value: string): string {
  if (value.length < 16) return value;
  return `${value.slice(0, 7)}…${value.slice(-8)}`;
}

export function devnetExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

let boundProgram: Address | null = null;

/** The page binds the reviewed deployment. The program id is not accepted from the URL. */
export function bindReviewedProgram(programId: Address): void {
  if (boundProgram !== null && boundProgram !== programId) throw new Error("Reviewed program id changed");
  boundProgram = programId;
}

export function reviewedProgramId(): Address {
  if (boundProgram === null) throw new Error("Reviewed StateGuard program was not bound");
  return boundProgram;
}

function positiveNormalMultiplier(bytes: Uint8Array): boolean {
  if (bytes.length !== 8) return false;
  const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  return Number.isFinite(value) && value >= 2.2250738585072014e-308;
}

function encodeAssertSafeExecutionV2(request: AssertSafeExecutionRequest & {
  readonly expectedMint: Address;
  readonly adapterKind: 1;
  readonly downstreamCommitment: Uint8Array;
}): Uint8Array {
  const { expected, expectedPhase, window } = request;
  if (!positiveNormalMultiplier(expected.multiplier) || !positiveNormalMultiplier(expected.newMultiplier)) {
    throw new Error("multipliers must be 8 bytes encoding a positive normal f64");
  }
  const timestamp = expected.newMultiplierEffectiveTimestamp;
  if (timestamp < I64_MIN || timestamp > I64_MAX) throw new Error("effective timestamp outside i64 range");
  if (expectedPhase !== ActivationPhase.Pending && expectedPhase !== ActivationPhase.Activated) {
    throw new Error("unknown activation phase");
  }
  for (const secs of [window.beforeSecs, window.afterSecs]) {
    if (!Number.isInteger(secs) || secs < 0 || secs > 4294967295) throw new Error("protection window must be a u32");
  }
  if (request.adapterKind !== 1 || request.downstreamCommitment.length !== 32) {
    throw new Error("downstream commitment must be a Token-2022 transfer commitment");
  }
  const mintBytes = getAddressEncoder().encode(request.expectedMint);
  const out = new Uint8Array(99);
  const view = new DataView(out.buffer);
  out[0] = 2;
  out.set(mintBytes, 1);
  out.set(expected.multiplier, 33);
  out.set(expected.newMultiplier, 41);
  view.setBigInt64(49, timestamp, true);
  out[57] = expectedPhase;
  view.setUint32(58, window.beforeSecs, true);
  view.setUint32(62, window.afterSecs, true);
  out[66] = 1;
  out.set(request.downstreamCommitment, 67);
  return out;
}

function readSessionMint(owner: string, data: Uint8Array): { readonly state: ProtectedState; readonly decimals: number } {
  if (owner !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error("Session mint is not owned by Token-2022");
  if (data.length < 166 || data.length === 355) throw new Error("Session mint data is not a Token-2022 extension mint");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (const offset of [0, 46]) {
    const tag = view.getUint32(offset, true);
    if (tag !== 0 && tag !== 1) throw new Error("Session mint authority tag is invalid");
  }
  if (data[45] !== 1) throw new Error("Session mint is not initialized");
  const decimals = data[44];
  if (decimals === undefined) throw new Error("Session mint decimals are missing");
  if (data.subarray(82, 165).some((byte) => byte !== 0) || data[165] !== 1) {
    throw new Error("Session mint extension header is invalid");
  }
  const seen = new Set<number>();
  let scaled: { readonly valueOffset: number; readonly length: number } | null = null;
  let offset = 166;
  while (data.length - offset >= 2) {
    const type = view.getUint16(offset, true);
    if (type === 0) break;
    if (type > 28 || data.length - offset < 4) throw new Error("Session mint extension header is truncated");
    const length = view.getUint16(offset + 2, true);
    const valueOffset = offset + 4;
    if (valueOffset + length > data.length || seen.has(type)) throw new Error("Session mint extension layout is invalid");
    seen.add(type);
    if (type === 25) scaled = { valueOffset, length };
    offset = valueOffset + length;
  }
  if (scaled === null) throw new Error("Session mint has no ScaledUiAmount extension");
  if (seen.has(10)) throw new Error("Session mint combines ScaledUiAmount with InterestBearingConfig");
  if (scaled.length !== 56) throw new Error("ScaledUiAmount config has the wrong length");
  const multiplier = data.slice(scaled.valueOffset + 32, scaled.valueOffset + 40);
  const newMultiplier = data.slice(scaled.valueOffset + 48, scaled.valueOffset + 56);
  if (!positiveNormalMultiplier(multiplier) || !positiveNormalMultiplier(newMultiplier)) {
    throw new Error("Stored multiplier is not a positive normal f64");
  }
  return {
    decimals,
    state: {
      multiplier,
      newMultiplier,
      newMultiplierEffectiveTimestamp: view.getBigInt64(scaled.valueOffset + 40, true),
    },
  };
}

const DEMO_MINT_DECIMALS = 6;
const DEMO_INITIAL_MULTIPLIER = 1;
const DEMO_MINT_AMOUNT = BigInt(1000000);
const SYSVAR_CLOCK_ADDRESS = "SysvarC1ock11111111111111111111111111111111" as Address;
const SYSVAR_INSTRUCTIONS_ADDRESS = "Sysvar1nstructions1111111111111111111111111" as Address;
const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const PROGRAM_DATA_ADDRESS = "4Zc4TAEYNSXCGUkpD7y7CcEWDS8a9aQBDfYHFu55dPE3" as Address;
const REVIEWED_ELF_SHA256 = "d7d59ccd9e96bb3eb3e16893aca638d8e5fdbfaf5032b4b39737ef16a41e4e46";
const REVIEWED_ELF_LENGTH = 63_840;
const PROGRAMDATA_HEADER_LEN = 45;
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;

export interface PhantomProvider {
  readonly isPhantom: boolean;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  request(input: {
    readonly method: "signTransaction" | "signAndSendTransaction";
    readonly params: { readonly message: string; readonly options?: { readonly skipPreflight?: boolean } };
  }): Promise<unknown>;
}

export interface PreparedSession {
  readonly scenario: EquityScenario;
  readonly activation: bigint;
  readonly mint: Address;
  readonly sourceAta: Address;
  readonly destinationAta: Address;
  readonly setupSignature: string;
  readonly balances: TokenBalances;
}

export interface HeldAuthorization {
  readonly signedBytes: Uint8Array;
  readonly sha256: string;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly guardInstructionIndex: number;
  readonly expectation: AssertSafeExecutionRequest;
}

export class AuthorizationWindowMissed extends Error {
  readonly code = "AUTHORIZATION_WINDOW_MISSED" as const;
  constructor() {
    super("AUTHORIZATION WINDOW MISSED");
    this.name = "AuthorizationWindowMissed";
  }
}

export class AuthorizationWindowElapsed extends Error {
  readonly code = "AUTHORIZATION_WINDOW_ELAPSED" as const;
  readonly clock: bigint;
  readonly activation: bigint;
  constructor(clock: bigint, activation: bigint) {
    super("AUTHORIZATION_WINDOW_ELAPSED");
    this.name = "AuthorizationWindowElapsed";
    this.clock = clock;
    this.activation = activation;
  }
}

export class StaleAuthorizationExpired extends Error {
  readonly code = "STALE_AUTHORIZATION_EXPIRED" as const;
  constructor() {
    super("STALE_AUTHORIZATION_EXPIRED");
    this.name = "StaleAuthorizationExpired";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function accountBytes(data: unknown): Uint8Array {
  const encoded = Array.isArray(data) ? data[0] : undefined;
  if (typeof encoded !== "string") throw new Error("Account data missing");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function decodeClock(data: Uint8Array): { readonly slot: bigint; readonly unixTimestamp: bigint } {
  if (data.length !== 40) throw new Error("Clock sysvar is not usable");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { slot: view.getBigUint64(0, true), unixTimestamp: view.getBigInt64(32, true) };
}

function client(): ReturnType<typeof createSolanaRpc> {
  return createSolanaRpc(DEVNET_RPC_URL);
}

export async function readChainSnapshot(mint: Address): Promise<GuardSnapshot> {
  const { context, value } = await client().getMultipleAccounts(
    [mint, SYSVAR_CLOCK_ADDRESS],
    { encoding: "base64", commitment: "confirmed" },
  ).send();
  const mintAccount = value[0];
  const clockAccount = value[1];
  if (!mintAccount || !clockAccount) throw new Error("Session mint or Clock was not returned");
  const clock = decodeClock(accountBytes(clockAccount.data));
  const state = readSessionMint(mintAccount.owner, accountBytes(mintAccount.data)).state;
  return {
    mint,
    contextSlot: context.slot,
    clock,
    state,
    phase: phaseAt(state, clock.unixTimestamp),
    hasScheduledChange: hasScheduledChange(state),
  };
}

export async function readChainClock(): Promise<bigint> {
  const account = await client().getAccountInfo(SYSVAR_CLOCK_ADDRESS, { commitment: "confirmed", encoding: "base64" }).send();
  if (!account.value) throw new Error("Clock sysvar not returned");
  return decodeClock(accountBytes(account.value.data)).unixTimestamp;
}

export async function verifyPublicEnvironment(): Promise<{ readonly upgradeAuthority: string | null }> {
  const connection = client();
  assertDevnetCluster(await connection.getGenesisHash().send());
  const accounts = await connection.getMultipleAccounts(
    [reviewedProgramId(), PROGRAM_DATA_ADDRESS],
    { encoding: "base64", commitment: "confirmed" },
  ).send();
  const program = accounts.value[0];
  const programData = accounts.value[1];
  if (!program?.executable || program.owner !== BPF_LOADER) {
    throw new Error("Reviewed StateGuard program is missing or not executable");
  }
  const programBytes = accountBytes(program.data);
  if (programBytes.length !== 36 || new DataView(programBytes.buffer, programBytes.byteOffset, 4).getUint32(0, true) !== 2) {
    throw new Error("Reviewed StateGuard program is not an upgradeable loader program");
  }
  const pointer = getAddressDecoder().decode(programBytes.subarray(4, 36));
  if (pointer !== PROGRAM_DATA_ADDRESS) throw new Error("ProgramData does not match the reviewed deployment");
  if (!programData || programData.owner !== BPF_LOADER) throw new Error("Reviewed ProgramData is missing");
  const data = accountBytes(programData.data);
  const end = PROGRAMDATA_HEADER_LEN + REVIEWED_ELF_LENGTH;
  if (data.length < end || new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) !== 3) {
    throw new Error("Reviewed ProgramData is malformed");
  }
  const hash = sha256Hex(data.subarray(PROGRAMDATA_HEADER_LEN, end));
  if (hash !== REVIEWED_ELF_SHA256) throw new Error("Deployed ELF does not match the reviewed hash");
  if (data.subarray(end).some((byte) => byte !== 0)) throw new Error("ProgramData carries bytes beyond the reviewed ELF");
  const option = data[12];
  const upgradeAuthority = option === 1 ? getAddressDecoder().decode(data.subarray(13, 45)) : null;
  return { upgradeAuthority };
}

function payerSigner(wallet: Address): TransactionSigner {
  return { address: wallet, signTransactions: async (transactions) => transactions };
}

function demoMintSpace(authority: Address): number {
  return getMintSize([
    extension("ScaledUiAmountConfig", {
      authority,
      multiplier: DEMO_INITIAL_MULTIPLIER,
      newMultiplierEffectiveTimestamp: BigInt(0),
      newMultiplier: DEMO_INITIAL_MULTIPLIER,
    }),
  ]);
}

export function classifyPrepareInstruction(instruction: Instruction): string {
  if (instruction.programAddress === "11111111111111111111111111111111") return "create-mint";
  const data = instruction.data;
  if (instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS && data instanceof Uint8Array) {
    if (data[0] === 20) return "initialize-mint";
    if (data[0] === 7) return "mint-to";
    if (data[0] === 43 && data[1] === 0) return "initialize-scaled-ui";
    if (data[0] === 43 && data[1] === 1) return "schedule-multiplier";
  }
  return "create-ata";
}

export async function prepareSessionInstructions(input: {
  readonly payer: TransactionSigner;
  readonly mintAddress: Address;
  readonly seed: string;
  readonly rentLamports: bigint;
  readonly recipient: Address;
  readonly scenario: EquityScenario;
  readonly effectiveTimestamp: bigint;
  readonly chainUnixTimestamp: bigint;
}): Promise<Instruction[]> {
  if (input.effectiveTimestamp <= input.chainUnixTimestamp) throw new Error("Activation timestamp must be after the chain clock");
  if (input.scenario.initialMultiplier !== DEMO_INITIAL_MULTIPLIER) throw new Error("Session mint must start at 1.00×");
  const [source] = await findAssociatedTokenPda({
    owner: input.payer.address,
    mint: input.mintAddress,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  return [
    getCreateAccountWithSeedInstruction({
      payer: input.payer,
      newAccount: input.mintAddress,
      base: input.payer.address,
      baseAccount: input.payer,
      seed: input.seed,
      amount: input.rentLamports,
      space: demoMintSpace(input.payer.address),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeScaledUiAmountMintInstruction({
      mint: input.mintAddress,
      authority: input.payer.address,
      multiplier: DEMO_INITIAL_MULTIPLIER,
    }),
    getInitializeMint2Instruction({
      mint: input.mintAddress,
      decimals: DEMO_MINT_DECIMALS,
      mintAuthority: input.payer.address,
    }),
    getUpdateMultiplierScaledUiMintInstruction({
      mint: input.mintAddress,
      authority: input.payer,
      multiplier: input.scenario.newMultiplier,
      effectiveTimestamp: input.effectiveTimestamp,
    }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.payer,
      owner: input.payer.address,
      mint: input.mintAddress,
    }),
    getMintToInstruction({
      mint: input.mintAddress,
      token: source,
      mintAuthority: input.payer,
      amount: DEMO_MINT_AMOUNT,
    }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.payer,
      owner: input.recipient,
      mint: input.mintAddress,
    }),
  ];
}

const u32le = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

function commitmentOf(instruction: Instruction, instructions: readonly Instruction[], feePayer: Address): Uint8Array {
  const encoder = getAddressEncoder();
  const flags = (account: Address): { signer: boolean; writable: boolean } => {
    let signer = account === feePayer;
    let writable = account === feePayer;
    for (const current of instructions) {
      for (const meta of current.accounts ?? []) {
        if (meta.address !== account) continue;
        signer ||= meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER;
        writable ||= meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER;
      }
    }
    return { signer, writable };
  };
  const accounts = instruction.accounts ?? [];
  const data = Uint8Array.from(instruction.data ?? []);
  const parts: Uint8Array[] = [
    new TextEncoder().encode("EQUITYGUARD_DOWNSTREAM_V2"),
    Uint8Array.from(encoder.encode(instruction.programAddress)),
    u32le(accounts.length),
  ];
  for (const meta of accounts) {
    const flag = flags(meta.address);
    parts.push(Uint8Array.from(encoder.encode(meta.address)), Uint8Array.of(flag.signer ? 1 : 0, flag.writable ? 1 : 0));
  }
  parts.push(u32le(data.length), data);
  const preimage = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }
  return sha256(preimage);
}

export function buildPublicGuardedTransfer(input: {
  readonly feePayer: Address;
  readonly mint: Address;
  readonly expectation: AssertSafeExecutionRequest;
  readonly transferChecked: Instruction;
}): { readonly instructions: readonly Instruction[]; readonly guard: Instruction } {
  if (input.transferChecked.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new Error("Protected action is not a Token-2022 transfer");
  }
  const placeholder: Instruction = {
    programAddress: reviewedProgramId(),
    accounts: [
      { address: input.mint, role: AccountRole.READONLY },
      { address: SYSVAR_INSTRUCTIONS_ADDRESS, role: AccountRole.READONLY },
    ],
    data: encodeAssertSafeExecutionV2({
      ...input.expectation,
      expectedMint: input.mint,
      adapterKind: 1,
      downstreamCommitment: new Uint8Array(32),
    }),
  };
  const commitment = commitmentOf(input.transferChecked, [placeholder, input.transferChecked], input.feePayer);
  const guard: Instruction = {
    ...placeholder,
    data: encodeAssertSafeExecutionV2({
      ...input.expectation,
      expectedMint: input.mint,
      adapterKind: 1,
      downstreamCommitment: commitment,
    }),
  };
  return { instructions: [guard, input.transferChecked], guard };
}

function encodePhantomTransaction(transaction: Transaction): string {
  return getBase58Decoder().decode(getTransactionEncoder().encode(transaction));
}

function serializedBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function ownedSignedBytes(value: Uint8Array): Uint8Array {
  if (value.length === 0) throw new Error("Phantom returned no signed transaction bytes");
  return Uint8Array.from(value);
}

/**
 * Accepts the Phantom shapes already proven in the wallet harness: raw bytes,
 * a transaction object with `serialize()`, or `{ signedTransaction }` holding
 * either of those. The returned bytes are an owned copy.
 */
export function phantomSignedTransaction(response: unknown): Uint8Array {
  const candidate = typeof response === "object" && response !== null && "signedTransaction" in response
    ? (response as { readonly signedTransaction: unknown }).signedTransaction
    : response;
  const direct = serializedBytes(candidate);
  if (direct) return ownedSignedBytes(direct);
  if (typeof candidate === "object" && candidate !== null && "serialize" in candidate) {
    const serialize = (candidate as { readonly serialize?: unknown }).serialize;
    if (typeof serialize === "function") {
      let serialized: unknown;
      try {
        serialized = serialize.call(candidate);
      } catch {
        throw new Error("Phantom returned no signed transaction bytes");
      }
      const bytes = serializedBytes(serialized);
      if (bytes) return ownedSignedBytes(bytes);
    }
  }
  throw new Error("Phantom returned no signed transaction bytes");
}

function sameBytes(left: ArrayLike<number> | undefined, right: ArrayLike<number> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function sameInstruction(left: Instruction, right: Instruction): boolean {
  if (left.programAddress !== right.programAddress || !sameBytes(left.data, right.data)) return false;
  const leftAccounts = left.accounts ?? [];
  const rightAccounts = right.accounts ?? [];
  return leftAccounts.length === rightAccounts.length && leftAccounts.every((account, index) => {
    const other = rightAccounts[index];
    return other !== undefined && account.address === other.address && account.role === other.role;
  });
}

function isAllowedComputeBudgetPrefix(instruction: Instruction): boolean {
  if (instruction.programAddress !== COMPUTE_BUDGET_PROGRAM || (instruction.accounts?.length ?? 0) !== 0 || instruction.data === undefined) return false;
  return (instruction.data.length === 5 && instruction.data[0] === 2) || (instruction.data.length === 9 && instruction.data[0] === 3);
}

export function verifyWalletSignedTransaction(unsignedTransaction: Transaction, signedWire: Uint8Array): { readonly signature: string; readonly guardInstructionIndex: number } {
  const signedTransaction = getTransactionDecoder().decode(signedWire);
  const decodeMessage = getCompiledTransactionMessageDecoder();
  const unsignedMessage = decodeMessage.decode(unsignedTransaction.messageBytes);
  const signedMessage = decodeMessage.decode(signedTransaction.messageBytes);
  if (unsignedMessage.version !== "legacy" || signedMessage.version !== "legacy") throw new Error("Phantom returned an unexpected transaction version");
  const unsignedSigners = unsignedMessage.staticAccounts.slice(0, unsignedMessage.header.numSignerAccounts);
  const signedSigners = signedMessage.staticAccounts.slice(0, signedMessage.header.numSignerAccounts);
  if (unsignedSigners.length !== 1 || signedSigners.length !== 1 || signedSigners[0] !== unsignedSigners[0] || unsignedMessage.lifetimeToken !== signedMessage.lifetimeToken) {
    throw new Error("Phantom changed the transaction signer or lifetime");
  }
  const unsignedInstructions = getInstructionsFromCompiledTransactionMessage(unsignedMessage);
  const signedInstructions = getInstructionsFromCompiledTransactionMessage(signedMessage);
  const prefixLength = signedInstructions.length - unsignedInstructions.length;
  if (prefixLength < 0 || prefixLength > 2) throw new Error("Phantom returned an unexpected signed transaction shape");
  const prefix = signedInstructions.slice(0, prefixLength);
  const discriminators = prefix.map((instruction) => instruction.data?.[0]);
  if (!prefix.every(isAllowedComputeBudgetPrefix) || new Set(discriminators).size !== discriminators.length) {
    throw new Error("Phantom added an unsupported transaction instruction");
  }
  const signedSuffix = signedInstructions.slice(prefixLength);
  if (!unsignedInstructions.every((instruction, index) => {
    const signedInstruction = signedSuffix[index];
    return signedInstruction !== undefined && sameInstruction(instruction, signedInstruction);
  })) {
    throw new Error("Phantom changed a protected transaction instruction while signing");
  }
  const signatureBytes = Object.values(signedTransaction.signatures)[0];
  if (signatureBytes == null || signatureBytes.every((byte) => byte === 0)) throw new Error("Phantom returned an unsigned transaction");
  return { signature: getBase58Decoder().decode(signatureBytes), guardInstructionIndex: prefixLength };
}

function seal(input: {
  readonly signedBytes: Uint8Array;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly guardInstructionIndex: number;
  readonly expectation: AssertSafeExecutionRequest;
}): HeldAuthorization {
  const signedBytes = Uint8Array.from(input.signedBytes);
  return Object.freeze({
    signedBytes,
    sha256: sha256Hex(signedBytes),
    lastValidBlockHeight: input.lastValidBlockHeight,
    signature: input.signature,
    guardInstructionIndex: input.guardInstructionIndex,
    expectation: input.expectation,
  });
}

export function assertSameSignedBytes(held: HeldAuthorization, actual: Uint8Array): void {
  if (sha256Hex(actual) !== held.sha256 || actual.length !== held.signedBytes.length) throw new Error("Signed transaction bytes changed");
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== held.signedBytes[index]) throw new Error("Signed transaction bytes changed");
  }
}

async function signAndSend(input: {
  readonly provider: PhantomProvider;
  readonly wallet: Address;
  readonly instructions: readonly Instruction[];
  readonly beforeSign?: () => Promise<void>;
}): Promise<ConfirmedChainOutcome> {
  await verifyPublicEnvironment();
  const connection = client();
  const { value: blockhash } = await connection.getLatestBlockhash({ commitment: "processed" }).send();
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (current) => setTransactionMessageFeePayer(input.wallet, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
    (current) => appendTransactionMessageInstructions(input.instructions, current),
  );
  const transaction = compileTransaction(message);
  const height = await connection.getBlockHeight({ commitment: "processed" }).send();
  if (height > blockhash.lastValidBlockHeight) throw new StaleAuthorizationExpired();
  if (input.beforeSign) await input.beforeSign();
  const response = await input.provider.request({
    method: "signAndSendTransaction",
    params: { message: encodePhantomTransaction(transaction), options: { skipPreflight: false } },
  });
  const signature = typeof response === "object" && response !== null && "signature" in response
    ? String((response as { readonly signature: unknown }).signature)
    : "";
  if (signature.length === 0) throw new Error("Phantom returned no transaction signature");
  return confirmSignature(signature, 0);
}

function encodeWire(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function safeNonnegativeNumber(value: unknown): number | null {
  if (typeof value === "bigint") return value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Kit's confirmed JSON meta uses bigint instruction indexes and custom codes. */
export function parseCustomError(error: unknown): { readonly instructionIndex: number; readonly code: number } | null {
  if (typeof error !== "object" || error === null || !("InstructionError" in error)) return null;
  const detail = (error as { readonly InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail) || detail.length !== 2) return null;
  const inner = detail[1];
  if (typeof inner !== "object" || inner === null || !("Custom" in inner)) return null;
  const instructionIndex = safeNonnegativeNumber(detail[0]);
  const code = safeNonnegativeNumber((inner as { readonly Custom: unknown }).Custom);
  return instructionIndex === null || code === null ? null : { instructionIndex, code };
}

export class DevnetSubmissionError extends Error {
  readonly kind: "PREFLIGHT_REJECTED" | "SUBMISSION_FAILED" | "CONFIRMATION_FAILED";
  readonly signature: string | null;
  constructor(kind: DevnetSubmissionError["kind"], message: string, signature: string | null = null) {
    super(message);
    this.name = "DevnetSubmissionError";
    this.kind = kind;
    this.signature = signature;
  }
}

/** True only when sendTransaction itself rejects these exact signed bytes. */
export function staleSendExpiry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /blockhash not found|block height exceeded/i.test(message);
}

export function staleSendFailure(error: unknown): DevnetSubmissionError {
  const message = error instanceof Error ? error.message : String(error);
  if (/preflight|simulation failed/i.test(message)) {
    return new DevnetSubmissionError("PREFLIGHT_REJECTED", `PREFLIGHT_REJECTED. The transaction was not broadcast. No signature was returned. ${message}`);
  }
  return new DevnetSubmissionError("SUBMISSION_FAILED", `SUBMISSION_FAILED. The send failed before a signature was returned. ${message}`);
}

export function unexpectedStaleResultCopy(outcome: ConfirmedChainOutcome): string {
  const chainError = JSON.stringify(outcome.error, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  const parsed = outcome.customError
    ? `instruction ${String(outcome.customError.instructionIndex)} custom ${String(outcome.customError.code)}`
    : "no custom program error";
  return `UNEXPECTED_ONCHAIN_RESULT. Signature ${outcome.signature} was confirmed, but it was not an ActivationPhaseChanged rejection with zero token movement. Guard instruction ${String(outcome.guardInstructionIndex)}. Parsed ${parsed}. Error ${chainError}. Logs ${outcome.logs.join(" | ")}`;
}

async function confirmSignature(signature: string, guardInstructionIndex: number): Promise<ConfirmedChainOutcome> {
  const connection = client();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { value } = await connection.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  const tx = await connection.getTransaction(signature as Signature, {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();
  if (!tx) {
    throw new DevnetSubmissionError("CONFIRMATION_FAILED", `CONFIRMATION_FAILED. Signature ${signature} was returned, but confirmation could not be established.`, signature);
  }
  return {
    signature,
    slot: tx.slot,
    error: tx.meta?.err ?? null,
    customError: parseCustomError(tx.meta?.err ?? null),
    logs: tx.meta?.logMessages ?? [],
    guardInstructionIndex,
  };
}

async function readBalances(source: Address, destination: Address): Promise<TokenBalances> {
  const connection = client();
  const [sourceBalance, destinationBalance] = await Promise.all([
    connection.getTokenAccountBalance(source, { commitment: "confirmed" }).send(),
    connection.getTokenAccountBalance(destination, { commitment: "confirmed" }).send(),
  ]);
  return { source: BigInt(sourceBalance.value.amount), destination: BigInt(destinationBalance.value.amount) };
}

export async function prepareLiveSession(input: {
  readonly provider: PhantomProvider;
  readonly wallet: Address;
  readonly scenario: EquityScenario;
}): Promise<PreparedSession> {
  await verifyPublicEnvironment();
  const clock = await readChainClock();
  const activation = activationTimestamp(clock, ACTIVATION_DELAY_SECONDS);
  const seedBytes = crypto.getRandomValues(new Uint8Array(8));
  const seed = `eg-${Array.from(seedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const mint = await createAddressWithSeed({
    baseAddress: input.wallet,
    seed,
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const recipient = await generateKeyPairSigner();
  const signer = payerSigner(input.wallet);
  const connection = client();
  const rent = await connection.getMinimumBalanceForRentExemption(BigInt(demoMintSpace(input.wallet))).send();
  const [sourceAta] = await findAssociatedTokenPda({ owner: input.wallet, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [destinationAta] = await findAssociatedTokenPda({ owner: recipient.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const instructions = await prepareSessionInstructions({
    payer: signer,
    mintAddress: mint,
    seed,
    rentLamports: rent,
    recipient: recipient.address,
    scenario: input.scenario,
    effectiveTimestamp: activation,
    chainUnixTimestamp: clock,
  });
  const outcome = await signAndSend({
    provider: input.provider,
    wallet: input.wallet,
    instructions,
  });
  if (outcome.error !== null) throw new Error("The session mint transaction failed on Devnet");
  const mintAccount = await connection.getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" }).send();
  if (!mintAccount.value) throw new Error("Confirmed demo mint account is missing");
  const mintData = accountBytes(mintAccount.value.data);
  const decoded = readSessionMint(mintAccount.value.owner, mintData);
  const state = decoded.state;
  if (decoded.decimals !== DEMO_MINT_DECIMALS) throw new Error("Demo mint decimals did not match");
  if (state.newMultiplierEffectiveTimestamp !== activation) throw new Error("Demo mint activation timestamp does not match this attempt");
  const snapshot = await readChainSnapshot(mint);
  if (authorizeDecision(snapshot, input.scenario, activation) === "mismatch") {
    throw new Error("The session mint does not match the selected scenario");
  }
  return {
    scenario: input.scenario,
    activation,
    mint,
    sourceAta,
    destinationAta,
    setupSignature: outcome.signature,
    balances: await readBalances(sourceAta, destinationAta),
  };
}

export async function authorizePending(input: {
  readonly provider: PhantomProvider;
  readonly wallet: Address;
  readonly session: PreparedSession;
}): Promise<HeldAuthorization> {
  await verifyPublicEnvironment();
  const snapshot = await readChainSnapshot(input.session.mint);
  const decision = authorizeDecision(snapshot, input.session.scenario, input.session.activation);
  if (decision !== "sign") throw new AuthorizationWindowMissed();
  const connection = client();
  const { value: blockhash } = await connection.getLatestBlockhash({ commitment: "processed" }).send();
  const transfer = getTransferCheckedInstruction({
    source: input.session.sourceAta,
    mint: input.session.mint,
    destination: input.session.destinationAta,
    authority: input.wallet,
    amount: DEMO_TRANSFER_RAW,
    decimals: DEMO_MINT_DECIMALS,
  });
  const built = buildPublicGuardedTransfer({
    feePayer: input.wallet,
    mint: input.session.mint,
    expectation: expectationForSnapshot(snapshot),
    transferChecked: transfer,
  });
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (current) => setTransactionMessageFeePayer(input.wallet, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
    (current) => appendTransactionMessageInstructions(built.instructions, current),
  );
  const transaction = compileTransaction(message);
  const height = await connection.getBlockHeight({ commitment: "processed" }).send();
  if (height > blockhash.lastValidBlockHeight) throw new AuthorizationWindowMissed();
  const again = await readChainSnapshot(input.session.mint);
  if (authorizeDecision(again, input.session.scenario, input.session.activation) !== "sign") throw new AuthorizationWindowMissed();
  const signedWire = phantomSignedTransaction(await input.provider.request({
    method: "signTransaction",
    params: { message: encodePhantomTransaction(transaction) },
  }));
  const afterSign = await readChainSnapshot(input.session.mint);
  if (pendingReturnDecision(afterSign, input.session.scenario, input.session.activation) !== "hold") {
    throw new AuthorizationWindowElapsed(afterSign.clock.unixTimestamp, input.session.activation);
  }
  const verified = verifyWalletSignedTransaction(transaction, signedWire);
  return seal({
    signedBytes: signedWire,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    signature: verified.signature,
    guardInstructionIndex: verified.guardInstructionIndex,
    expectation: expectationForSnapshot(snapshot),
  });
}

export async function currentBlockHeight(): Promise<bigint> {
  return client().getBlockHeight({ commitment: "processed" }).send();
}

export async function submitHeld(held: HeldAuthorization): Promise<ConfirmedChainOutcome> {
  await verifyPublicEnvironment();
  const connection = client();
  const bytes = Uint8Array.from(held.signedBytes);
  assertSameSignedBytes(held, bytes);
  let submitted: string;
  try {
    submitted = await connection.sendTransaction(encodeWire(bytes) as Parameters<ReturnType<typeof createSolanaRpc>["sendTransaction"]>[0], {
      encoding: "base64",
      skipPreflight: true,
      preflightCommitment: "confirmed",
    }).send();
  } catch (error) {
    if (staleSendExpiry(error)) throw new StaleAuthorizationExpired();
    if (error instanceof DevnetSubmissionError) throw error;
    throw staleSendFailure(error);
  }
  if (submitted !== held.signature) throw new Error("Devnet RPC returned a different transaction signature");
  return confirmSignature(held.signature, held.guardInstructionIndex);
}

export async function readSessionBalances(session: PreparedSession): Promise<TokenBalances> {
  return readBalances(session.sourceAta, session.destinationAta);
}

export async function authorizeUpdated(input: {
  readonly provider: PhantomProvider;
  readonly wallet: Address;
  readonly session: PreparedSession;
}): Promise<ConfirmedChainOutcome> {
  const snapshot = await readChainSnapshot(input.session.mint);
  if (activatedReviewDecision(snapshot, input.session.scenario, input.session.activation) !== "ready") {
    throw new Error("Updated authorization is not ready at this chain clock. No signature was requested.");
  }
  const transfer = getTransferCheckedInstruction({
    source: input.session.sourceAta,
    mint: input.session.mint,
    destination: input.session.destinationAta,
    authority: input.wallet,
    amount: DEMO_TRANSFER_RAW,
    decimals: DEMO_MINT_DECIMALS,
  });
  const built = buildPublicGuardedTransfer({
    feePayer: input.wallet,
    mint: input.session.mint,
    expectation: expectationForSnapshot(snapshot),
    transferChecked: transfer,
  });
  return signAndSend({
    provider: input.provider,
    wallet: input.wallet,
    instructions: built.instructions,
    beforeSign: async () => {
      const latest = await readChainSnapshot(input.session.mint);
      if (activatedReviewDecision(latest, input.session.scenario, input.session.activation) !== "ready") {
        throw new Error("Chain state changed before the updated authorization. No signature was requested.");
      }
    },
  });
}

export function detectPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const provider = window.phantom?.solana;
  return provider?.isPhantom ? provider : null;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

export async function requestDevnetSol(wallet: Address): Promise<void> {
  await verifyPublicEnvironment();
  const response = await fetch(DEVNET_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [wallet, 1000000000] }),
  });
  const body = await response.json() as { readonly error?: { readonly message?: string } };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? "Devnet airdrop failed");
}
