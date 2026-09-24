import { createHash } from "node:crypto";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
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
} from "@solana/kit";
import {
  ActivationPhase,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  type GuardSnapshot,
  findReviewedGuardDeployment,
  verifyReviewedGuardDeployment,
  type AssertSafeExecutionRequest,
  type GuardIdentityCheck,
  type LoaderAccountView,
} from "@equityguard/guard-client";

import { DEVNET_RPC_URL, verifyDevnetCluster } from "./cluster-gate.ts";
import { buildClockCrossingTransfer, pendingSignDecision } from "./transactions.ts";
import type { EquityScenario } from "./scenarios.ts";
import type { PhantomProvider } from "./wallet.ts";

const POLL_MS = 900;

export type LivePhase = "READY" | "SIGNING" | "HOLDING" | "WAITING_FOR_CLOCK" | "SUBMITTED" | "CONFIRMING" | "CONFIRMED" | "VERIFYING_MINT" | "SETUP_COMPLETE" | "CANCELLED" | "FAILED";
export type LiveKind = "SETUP" | "SAFE" | "BLOCK" | "REFRESH" | "STALE" | "UPDATED";

export interface TokenBalances {
  readonly source: bigint;
  readonly destination: bigint;
}

export type LiveResult =
  | { readonly type: "LOCAL_PREVIEW"; readonly kind: LiveKind; readonly expected: "ALLOW" | "REJECT" }
  | { readonly type: "PENDING"; readonly kind: LiveKind; readonly phase: Exclude<LivePhase, "CONFIRMED" | "SETUP_COMPLETE" | "CANCELLED" | "FAILED">; readonly signature?: string }
  | { readonly type: "CONFIRMED_SUCCESS"; readonly kind: Exclude<LiveKind, "BLOCK">; readonly signature: string; readonly slot: bigint; readonly before: TokenBalances; readonly after: TokenBalances }
  | { readonly type: "CONFIRMED_GUARD_REJECTION"; readonly kind: "BLOCK"; readonly signature: string; readonly slot: bigint; readonly instructionIndex: number; readonly customCode: number; readonly before: TokenBalances; readonly after: TokenBalances }
  | {
      readonly type: "CONFIRMED_ACTIVATION_REJECTION";
      readonly signature: string;
      readonly symbol: string;
      readonly eventLabel: string;
      readonly authorizedMultiplier: string;
      readonly currentMultiplier: string;
    }
  | { readonly type: "STALE_AUTHORIZATION_EXPIRED" }
  | { readonly type: "AUTHORIZATION_WINDOW_ELAPSED"; readonly clock: string; readonly activation: string }
  | {
      readonly type: "CONFIRMED_UPDATED_EXECUTION";
      readonly signature: string;
      readonly symbol: string;
      readonly eventLabel: string;
      readonly tokenMovementRaw: string;
    }
  | { readonly type: "CANCELLED"; readonly kind: LiveKind; readonly detail: string }
  | { readonly type: "FAILED"; readonly kind: LiveKind; readonly detail: string; readonly signature?: string };

export interface ConfirmedOutcome {
  readonly signature: string;
  readonly slot: bigint;
  readonly error: unknown;
  readonly customError: { readonly instructionIndex: number; readonly code: number } | null;
  readonly logs: readonly string[];
  readonly guardInstructionIndex?: number;
}

export interface SubmitInput {
  readonly provider: PhantomProvider;
  readonly feePayer: Address;
  readonly instructions: readonly Instruction[];
  readonly skipPreflight: boolean;
  readonly onPhase: (phase: LivePhase, signature?: string) => void;
  readonly onDiagnostic?: (message: string, raw?: unknown) => void;
  /** Runs immediately before Phantom is asked to sign. A throw skips the request. */
  readonly beforeSign?: () => Promise<void>;
}

export class StaleAuthorizationExpired extends Error {
  readonly code = "STALE_AUTHORIZATION_EXPIRED" as const;
  constructor() {
    super("STALE_AUTHORIZATION_EXPIRED");
    this.name = "StaleAuthorizationExpired";
  }
}

export const AUTHORIZATION_WINDOW_ELAPSED_MESSAGE =
  "The corporate action activated before wallet approval completed. No transaction was submitted. Start a new attempt.";

export class AuthorizationWindowElapsed extends Error {
  readonly code = "AUTHORIZATION_WINDOW_ELAPSED" as const;
  readonly clock: bigint;
  readonly activation: bigint;
  constructor(clock: bigint, activation: bigint) {
    super(AUTHORIZATION_WINDOW_ELAPSED_MESSAGE);
    this.name = "AuthorizationWindowElapsed";
    this.clock = clock;
    this.activation = activation;
  }
}

export interface HeldSignedTransaction {
  readonly signedBytes: Uint8Array;
  readonly sha256: string;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly guardInstructionIndex: number;
  readonly expectation: AssertSafeExecutionRequest;
}

export class LiveExecutionError extends Error {
  readonly stage: LivePhase;
  readonly signature: string | undefined;
  readonly logs: readonly string[];
  readonly raw?: unknown;

  constructor(
    stage: LivePhase,
    message: string,
    signature?: string,
    logs: readonly string[] = [],
    raw?: unknown,
  ) {
    super(message);
    this.name = "LiveExecutionError";
    this.stage = stage;
    this.signature = signature;
    this.logs = logs;
    this.raw = raw;
  }
}

export function phantomSignature(response: unknown): string {
  if (typeof response !== "object" || response === null || !("signature" in response)) {
    throw new LiveExecutionError("SIGNING", "Phantom returned no transaction signature");
  }
  const signature = (response as { readonly signature?: unknown }).signature;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new LiveExecutionError("SIGNING", "Phantom returned no transaction signature");
  }
  return signature;
}

export function encodePhantomTransaction(transaction: Transaction): string {
  return getBase58Decoder().decode(getTransactionEncoder().encode(transaction));
}

function serializedBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

export function phantomSignedTransaction(response: unknown): Uint8Array {
  const candidate = typeof response === "object" && response !== null && "signedTransaction" in response
    ? (response as { readonly signedTransaction: unknown }).signedTransaction
    : response;
  const direct = serializedBytes(candidate);
  if (direct) return direct;
  if (typeof candidate === "object" && candidate !== null && "serialize" in candidate) {
    const serialize = (candidate as { readonly serialize?: unknown }).serialize;
    if (typeof serialize === "function") {
      const serialized = serializedBytes(serialize.call(candidate));
      if (serialized) return serialized;
    }
  }
  throw new LiveExecutionError("SIGNING", "Phantom returned no signed transaction bytes");
}

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

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
  if (unsignedMessage.version !== "legacy" || signedMessage.version !== "legacy") {
    throw new LiveExecutionError("SIGNING", "Phantom returned an unexpected transaction version");
  }
  const unsignedSigners = unsignedMessage.staticAccounts.slice(0, unsignedMessage.header.numSignerAccounts);
  const signedSigners = signedMessage.staticAccounts.slice(0, signedMessage.header.numSignerAccounts);
  if (unsignedSigners.length !== 1 || signedSigners.length !== 1 || unsignedSigners[0] !== signedSigners[0] || unsignedMessage.lifetimeToken !== signedMessage.lifetimeToken) {
    throw new LiveExecutionError("SIGNING", "Phantom changed the transaction signer or lifetime");
  }
  const unsignedInstructions = getInstructionsFromCompiledTransactionMessage(unsignedMessage);
  const signedInstructions = getInstructionsFromCompiledTransactionMessage(signedMessage);
  const prefixLength = signedInstructions.length - unsignedInstructions.length;
  if (prefixLength < 0 || prefixLength > 2) {
    throw new LiveExecutionError("SIGNING", "Phantom returned an unexpected signed transaction shape");
  }
  const prefix = signedInstructions.slice(0, prefixLength);
  const discriminators = prefix.map((instruction) => instruction.data?.[0]);
  if (!prefix.every(isAllowedComputeBudgetPrefix) || new Set(discriminators).size !== discriminators.length) {
    throw new LiveExecutionError("SIGNING", "Phantom added an unsupported transaction instruction");
  }
  const signedSuffix = signedInstructions.slice(prefixLength);
  if (!unsignedInstructions.every((instruction, index) => {
    const signedInstruction = signedSuffix[index];
    return signedInstruction !== undefined && sameInstruction(instruction, signedInstruction);
  })) {
    throw new LiveExecutionError("SIGNING", "Phantom changed a protected transaction instruction while signing");
  }
  const signatureBytes = Object.values(signedTransaction.signatures)[0];
  if (signatureBytes == null) throw new LiveExecutionError("SIGNING", "Phantom returned an unsigned transaction");
  if (signatureBytes.every((byte) => byte === 0)) {
    throw new LiveExecutionError("SIGNING", "Phantom returned an unsigned transaction");
  }
  return { signature: getBase58Decoder().decode(signatureBytes), guardInstructionIndex: prefixLength };
}

export function assertBlockhashActive(currentBlockHeight: bigint, lastValidBlockHeight: bigint, signature?: string): void {
  if (currentBlockHeight > lastValidBlockHeight) {
    throw new LiveExecutionError(
      signature ? "CONFIRMING" : "SIGNING",
      `Transaction expired before confirmation (current block height ${currentBlockHeight}, last valid ${lastValidBlockHeight})`,
      signature,
    );
  }
}

export function assertMutationGate(
  cluster: { readonly verified: boolean; readonly reason?: string },
  deployment: { readonly verified: boolean; readonly reason?: string } | null,
): void {
  if (!cluster.verified) throw new Error(cluster.reason ?? "Devnet verification failed");
  if (!deployment?.verified) throw new Error(deployment?.reason ?? "Program verification failed");
}

function accountBytes(data: unknown): Uint8Array {
  const encoded = Array.isArray(data) ? data[0] : undefined;
  if (typeof encoded !== "string") throw new Error("Account data missing");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

/** The reviewed-binary check. A truthy object with `ok: false` is a refusal. */
export function acceptanceFromIdentity(
  check: GuardIdentityCheck,
  reviewedElfSha256: string,
): { readonly verified: true; readonly upgradeAuthority: string | null; readonly mutability: string } | { readonly verified: false; readonly reason: string } {
  if (!check.ok || check.attestation.identity !== "REVIEWED_BINARY" || check.attestation.reviewedElfSha256 !== reviewedElfSha256) {
    return { verified: false, reason: check.ok ? "Deployment verification failed: hash mismatch or invalid state" : check.message };
  }
  return {
    verified: true,
    upgradeAuthority: check.attestation.upgradeAuthority,
    mutability: check.attestation.mutability,
  };
}

export async function readReviewedDeployment(): Promise<{ readonly verified: true; readonly upgradeAuthority: string | null; readonly mutability: string } | { readonly verified: false; readonly reason: string }> {
  const deployment = findReviewedGuardDeployment(EQUITY_GUARD_DEVNET_PROGRAM_ID);
  if (!deployment) return { verified: false, reason: "No reviewed deployment found for devnet program ID" };
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const accounts = await rpc.getMultipleAccounts(
    [deployment.programAddress, deployment.programDataAddress],
    { encoding: "base64", commitment: "confirmed" },
  ).send();
  const view = (entry: (typeof accounts.value)[number] | undefined): LoaderAccountView | null => entry
    ? { executable: entry.executable, owner: entry.owner, data: accountBytes(entry.data) }
    : null;
  return acceptanceFromIdentity(
    verifyReviewedGuardDeployment(deployment, view(accounts.value[0]), view(accounts.value[1])),
    deployment.elfSha256,
  );
}

export async function verifyMutationEnvironment(): Promise<void> {
  const cluster = await verifyDevnetCluster(DEVNET_RPC_URL);
  const deployment = cluster.verified ? await readReviewedDeployment() : null;
  assertMutationGate(cluster, deployment);
}

export async function submitAndConfirm(input: SubmitInput): Promise<ConfirmedOutcome> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  await verifyMutationEnvironment();
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "processed" }).send();
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(input.instructions, m),
  );
  const transaction = compileTransaction(message);
  const encodedTransaction = encodePhantomTransaction(transaction);

  const signingHeight = await rpc.getBlockHeight({ commitment: "processed" }).send();
  assertBlockhashActive(signingHeight, blockhash.lastValidBlockHeight);
  input.onDiagnostic?.("Transaction lifetime before Phantom", {
    blockhash: blockhash.blockhash,
    currentBlockHeight: signingHeight,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });
  if (input.beforeSign) await input.beforeSign();
  input.onPhase("SIGNING");
  let signature: string;
  let guardInstructionIndex: number | undefined;
  try {
    if (input.skipPreflight) {
      const signedWire = phantomSignedTransaction(await input.provider.request({
        method: "signTransaction",
        params: { message: encodedTransaction },
      }));
      const verified = verifyWalletSignedTransaction(transaction, signedWire);
      signature = verified.signature;
      guardInstructionIndex = verified.guardInstructionIndex;
      input.onDiagnostic?.("Phantom returned signed transaction", signature);
      const submittedSignature = await rpc.sendTransaction(getBase64EncodedWireTransaction(getTransactionDecoder().decode(signedWire)), {
        encoding: "base64",
        skipPreflight: true,
        preflightCommitment: "confirmed",
      }).send();
      if (submittedSignature !== signature) {
        throw new LiveExecutionError("SUBMITTED", "Devnet RPC returned a different transaction signature", signature);
      }
    } else {
      signature = phantomSignature(await input.provider.request({
        method: "signAndSendTransaction",
        params: { message: encodedTransaction, options: { skipPreflight: false } },
      }));
    }
  } catch (error) {
    if (isWalletCancellation(error)) input.onPhase("CANCELLED");
    else input.onPhase("FAILED");
    if (error instanceof LiveExecutionError) throw error;
    throw new LiveExecutionError(isWalletCancellation(error) ? "CANCELLED" : "SIGNING", error instanceof Error ? error.message : String(error), undefined, [], error);
  }

  input.onPhase("SUBMITTED", signature);
  input.onDiagnostic?.("Phantom returned signature", signature);
  input.onPhase("CONFIRMING", signature);
  try {
    for (;;) {
      const { value } = await rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send();
      const status = value[0];
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
      const height = await rpc.getBlockHeight({ commitment: "processed" }).send();
      input.onDiagnostic?.("Confirmation poll", { currentBlockHeight: height, lastValidBlockHeight: blockhash.lastValidBlockHeight });
      assertBlockhashActive(height, blockhash.lastValidBlockHeight, signature);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (error) {
    input.onPhase("FAILED", signature);
    throw new LiveExecutionError("CONFIRMING", error instanceof Error ? error.message : String(error), signature, [], error);
  }

  const tx = await rpc.getTransaction(signature as Signature, {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();
  if (!tx) throw new LiveExecutionError("CONFIRMING", "Confirmed transaction metadata is unavailable", signature);
  input.onPhase("CONFIRMED", signature);
  const error = tx.meta?.err ?? null;
  return {
    signature,
    slot: tx.slot,
    error,
    customError: parseCustomError(error),
    logs: tx.meta?.logMessages ?? [],
    ...(guardInstructionIndex === undefined ? {} : { guardInstructionIndex }),
  };
}

export function assertSetupTransactionSucceeded(outcome: ConfirmedOutcome): void {
  if (outcome.error !== null) {
    throw new LiveExecutionError("CONFIRMED", "Demo asset transaction failed on devnet", outcome.signature, outcome.logs, outcome.error);
  }
}

export function parseCustomError(error: unknown): { readonly instructionIndex: number; readonly code: number } | null {
  if (typeof error !== "object" || error === null || !("InstructionError" in error)) return null;
  const detail = (error as { readonly InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail) || detail.length !== 2) return null;
  const [index, inner] = detail;
  if (typeof inner !== "object" || inner === null || !("Custom" in inner)) return null;
  const instructionIndex = safeNonnegativeNumber(index);
  const code = safeNonnegativeNumber((inner as { readonly Custom: unknown }).Custom);
  return instructionIndex === null || code === null ? null : { instructionIndex, code };
}

function safeNonnegativeNumber(value: unknown): number | null {
  if (typeof value === "bigint") return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isConfirmedTransfer(result: LiveResult): result is Extract<LiveResult, { readonly type: "CONFIRMED_SUCCESS" }> {
  return result.type === "CONFIRMED_SUCCESS";
}

export function isConfirmedGuardRejection(result: LiveResult): result is Extract<LiveResult, { readonly type: "CONFIRMED_GUARD_REJECTION" }> {
  return result.type === "CONFIRMED_GUARD_REJECTION" && result.instructionIndex >= 0 && result.customCode === 9 && balancesUnchanged(result.before, result.after);
}

export function balancesUnchanged(before: TokenBalances, after: TokenBalances): boolean {
  return before.source === after.source && before.destination === after.destination;
}

export function expectedTransferDelta(before: TokenBalances, after: TokenBalances, amount: bigint): boolean {
  return before.source - after.source === amount && after.destination - before.destination === amount;
}

export function confirmedTransferResult(
  kind: "SAFE" | "REFRESH",
  outcome: ConfirmedOutcome,
  before: TokenBalances,
  after: TokenBalances,
  amount: bigint,
): LiveResult {
  if (outcome.error !== null || !expectedTransferDelta(before, after, amount)) {
    throw new Error("Confirmed transaction did not produce the expected token balance delta");
  }
  return { type: "CONFIRMED_SUCCESS", kind, signature: outcome.signature, slot: outcome.slot, before, after };
}

export function confirmedSetupResult(outcome: ConfirmedOutcome, after: TokenBalances, expectedSource: bigint): LiveResult {
  if (outcome.error !== null || after.source !== expectedSource || after.destination !== 0n) {
    throw new Error("Confirmed setup did not produce the expected demo-asset balances");
  }
  return {
    type: "CONFIRMED_SUCCESS",
    kind: "SETUP",
    signature: outcome.signature,
    slot: outcome.slot,
    before: { source: 0n, destination: 0n },
    after,
  };
}

export function confirmedGuardRejectionResult(outcome: ConfirmedOutcome, before: TokenBalances, after: TokenBalances): LiveResult {
  if (outcome.error === null || outcome.guardInstructionIndex === undefined || outcome.customError?.instructionIndex !== outcome.guardInstructionIndex || outcome.customError.code !== 9 || !balancesUnchanged(before, after)) {
    throw new LiveExecutionError("CONFIRMED", "Confirmed failure was not the expected MultiplierChanged guard rejection with zero token delta", outcome.signature, outcome.logs, outcome.error);
  }
  return { type: "CONFIRMED_GUARD_REJECTION", kind: "BLOCK", signature: outcome.signature, slot: outcome.slot, instructionIndex: outcome.guardInstructionIndex, customCode: 9, before, after };
}

export function hasWalletContext(provider: PhantomProvider | null, wallet: Address | null): boolean {
  return provider !== null && wallet !== null;
}

export function isWalletCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  const message = "message" in error ? String((error as { readonly message?: unknown }).message) : "";
  return code === 4001 || /\b(?:user|request|signature request) (?:rejected|cancelled|canceled)\b/i.test(message);
}

export function programLogSucceeded(logs: readonly string[], program: string): boolean {
  return logs.some((line) => line === `Program ${program} success`);
}

export function programLogInvoked(logs: readonly string[], program: string): boolean {
  return logs.some((line) => line.startsWith(`Program ${program} invoke`));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sealSignedTransaction(input: {
  readonly signedBytes: Uint8Array;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly guardInstructionIndex: number;
  readonly expectation: AssertSafeExecutionRequest;
}): HeldSignedTransaction {
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

export function assertSameSignedBytes(held: HeldSignedTransaction, actual: Uint8Array): void {
  if (actual.length !== held.signedBytes.length || sha256Hex(actual) !== held.sha256) {
    throw new Error("Signed transaction bytes changed");
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== held.signedBytes[index]) throw new Error("Signed transaction bytes changed");
  }
}

/**
 * Post-Phantom check. `wait` is still pending: the sign lead is only a
 * pre-request timing limit. Clock equal to T is already too late.
 */
export function pendingAuthorizationAfterSignature(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): "hold" | "elapsed" {
  const decision = pendingSignDecision(snapshot, scenario, activation);
  return decision === "sign" || decision === "wait" ? "hold" : "elapsed";
}

export function assertPendingAuthorizationStillOpen(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): void {
  if (pendingAuthorizationAfterSignature(snapshot, scenario, activation) !== "hold") {
    throw new AuthorizationWindowElapsed(snapshot.clock.unixTimestamp, activation);
  }
}

/** Seals signed bytes only while the re-read mint is still the locked pending state. */
export function sealPendingAuthorizationIfOpen(input: {
  readonly snapshot: GuardSnapshot;
  readonly scenario: EquityScenario;
  readonly activationTimestamp: bigint;
  readonly signedBytes: Uint8Array;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly guardInstructionIndex: number;
  readonly expectation: AssertSafeExecutionRequest;
}): HeldSignedTransaction {
  assertPendingAuthorizationStillOpen(input.snapshot, input.scenario, input.activationTimestamp);
  return sealSignedTransaction(input);
}

/** Bytes that may be submitted. Expiry and any mutation refuse before a send. */
export function prepareHeldSubmission(held: HeldSignedTransaction, currentBlockHeight: bigint): Uint8Array {
  if (currentBlockHeight > held.lastValidBlockHeight) throw new StaleAuthorizationExpired();
  const bytes = Uint8Array.from(held.signedBytes);
  assertSameSignedBytes(held, bytes);
  return bytes;
}

function encodeWire(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export async function signPendingProtectedTransfer(input: {
  readonly provider: PhantomProvider;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly scenario: EquityScenario;
  readonly activationTimestamp: bigint;
  readonly transferChecked: Instruction;
  readonly readSnapshot: () => Promise<GuardSnapshot>;
  readonly onPhase: (phase: LivePhase, signature?: string) => void;
  readonly onDiagnostic?: (message: string, raw?: unknown) => void;
}): Promise<HeldSignedTransaction> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  await verifyMutationEnvironment();
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "processed" }).send();
  const snapshot = await input.readSnapshot();
  if (pendingSignDecision(snapshot, input.scenario, input.activationTimestamp) !== "sign") {
    throw new Error("Chain clock is no longer inside the pending authorization window. No signature was requested.");
  }
  const built = buildClockCrossingTransfer({
    snapshot,
    scenario: input.scenario,
    activationTimestamp: input.activationTimestamp,
    requiredPhase: ActivationPhase.Pending,
    feePayer: input.feePayer,
    mint: input.mint,
    transferChecked: input.transferChecked,
  });
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (current) => setTransactionMessageFeePayer(input.feePayer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
    (current) => appendTransactionMessageInstructions(built.guarded.instructions, current),
  );
  const transaction = compileTransaction(message);
  const signingHeight = await rpc.getBlockHeight({ commitment: "processed" }).send();
  assertBlockhashActive(signingHeight, blockhash.lastValidBlockHeight);
  const again = await input.readSnapshot();
  if (pendingSignDecision(again, input.scenario, input.activationTimestamp) !== "sign") {
    throw new Error("Chain clock is no longer inside the pending authorization window. No signature was requested.");
  }
  if (!sameBytes(again.state.multiplier, snapshot.state.multiplier)
    || !sameBytes(again.state.newMultiplier, snapshot.state.newMultiplier)
    || again.state.newMultiplierEffectiveTimestamp !== snapshot.state.newMultiplierEffectiveTimestamp) {
    throw new Error("Session mint changed before signing. No signature was requested.");
  }
  input.onPhase("SIGNING");
  let signedWire: Uint8Array;
  try {
    signedWire = phantomSignedTransaction(await input.provider.request({
      method: "signTransaction",
      params: { message: encodePhantomTransaction(transaction) },
    }));
  } catch (error) {
    if (isWalletCancellation(error)) input.onPhase("CANCELLED");
    else input.onPhase("FAILED");
    if (error instanceof LiveExecutionError) throw error;
    throw new LiveExecutionError(isWalletCancellation(error) ? "CANCELLED" : "SIGNING", error instanceof Error ? error.message : String(error), undefined, [], error);
  }
  const afterSign = await input.readSnapshot();
  try {
    assertPendingAuthorizationStillOpen(afterSign, input.scenario, input.activationTimestamp);
  } catch (error) {
    if (error instanceof AuthorizationWindowElapsed) {
      input.onPhase("FAILED");
      input.onDiagnostic?.("AUTHORIZATION_WINDOW_ELAPSED", {
        clock: afterSign.clock.unixTimestamp.toString(),
        activation: input.activationTimestamp.toString(),
      });
    }
    throw error;
  }
  const verified = verifyWalletSignedTransaction(transaction, signedWire);
  const held = sealPendingAuthorizationIfOpen({
    snapshot: afterSign,
    scenario: input.scenario,
    activationTimestamp: input.activationTimestamp,
    signedBytes: signedWire,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    signature: verified.signature,
    guardInstructionIndex: verified.guardInstructionIndex,
    expectation: built.expectation,
  });
  input.onPhase("HOLDING", held.signature);
  input.onDiagnostic?.("Held signed authorization", held.sha256);
  return held;
}

export async function submitHeldAuthorization(input: {
  readonly held: HeldSignedTransaction;
  readonly onPhase: (phase: LivePhase, signature?: string) => void;
  readonly onDiagnostic?: (message: string, raw?: unknown) => void;
}): Promise<ConfirmedOutcome> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  await verifyMutationEnvironment();
  const height = await rpc.getBlockHeight({ commitment: "processed" }).send();
  const bytes = prepareHeldSubmission(input.held, height);
  input.onPhase("SUBMITTED", input.held.signature);
  let submitted: string;
  try {
    submitted = await rpc.sendTransaction(encodeWire(bytes) as Parameters<typeof rpc.sendTransaction>[0], {
      encoding: "base64",
      skipPreflight: true,
      preflightCommitment: "confirmed",
    }).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/blockhash not found|block height exceeded/i.test(message)) throw new StaleAuthorizationExpired();
    throw new LiveExecutionError("SUBMITTED", message, input.held.signature, [], error);
  }
  if (submitted !== input.held.signature) {
    throw new LiveExecutionError("SUBMITTED", "Devnet RPC returned a different transaction signature", input.held.signature);
  }
  input.onPhase("CONFIRMING", input.held.signature);
  try {
    for (;;) {
      const { value } = await rpc.getSignatureStatuses([input.held.signature as Signature], { searchTransactionHistory: true }).send();
      const status = value[0];
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
      const current = await rpc.getBlockHeight({ commitment: "processed" }).send();
      input.onDiagnostic?.("Confirmation poll", { currentBlockHeight: current, lastValidBlockHeight: input.held.lastValidBlockHeight });
      if (current > input.held.lastValidBlockHeight) throw new StaleAuthorizationExpired();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (error) {
    if (error instanceof StaleAuthorizationExpired) throw error;
    input.onPhase("FAILED", input.held.signature);
    throw new LiveExecutionError("CONFIRMING", error instanceof Error ? error.message : String(error), input.held.signature, [], error);
  }
  const tx = await rpc.getTransaction(input.held.signature as Signature, {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();
  if (!tx) throw new LiveExecutionError("CONFIRMING", "Confirmed transaction metadata is unavailable", input.held.signature);
  input.onPhase("CONFIRMED", input.held.signature);
  return {
    signature: input.held.signature,
    slot: tx.slot,
    error: tx.meta?.err ?? null,
    customError: parseCustomError(tx.meta?.err ?? null),
    logs: tx.meta?.logMessages ?? [],
    guardInstructionIndex: input.held.guardInstructionIndex,
  };
}

export function confirmedActivationRejection(input: {
  readonly outcome: ConfirmedOutcome;
  readonly before: TokenBalances;
  readonly after: TokenBalances;
  readonly symbol: string;
  readonly eventLabel: string;
  readonly authorizedMultiplier: string;
  readonly currentMultiplier: string;
}): LiveResult {
  const code = input.outcome.customError?.code;
  const index = input.outcome.customError?.instructionIndex;
  const logs = input.outcome.logs;
  const accepted = input.outcome.error !== null
    && input.outcome.guardInstructionIndex !== undefined
    && index === input.outcome.guardInstructionIndex
    && code === 12
    && balancesUnchanged(input.before, input.after)
    && programLogInvoked(logs, EQUITY_GUARD_DEVNET_PROGRAM_ID)
    && !programLogSucceeded(logs, TOKEN_2022_PROGRAM_ADDRESS);
  if (!accepted) {
    throw new LiveExecutionError(
      "CONFIRMED",
      "Confirmed failure was not ActivationPhaseChanged with zero protected token movement",
      input.outcome.signature,
      logs,
      input.outcome.error,
    );
  }
  return {
    type: "CONFIRMED_ACTIVATION_REJECTION",
    signature: input.outcome.signature,
    symbol: input.symbol,
    eventLabel: input.eventLabel,
    authorizedMultiplier: input.authorizedMultiplier,
    currentMultiplier: input.currentMultiplier,
  };
}

export function confirmedUpdatedExecution(input: {
  readonly outcome: ConfirmedOutcome;
  readonly before: TokenBalances;
  readonly after: TokenBalances;
  readonly amount: bigint;
  readonly symbol: string;
  readonly eventLabel: string;
}): LiveResult {
  const logs = input.outcome.logs;
  if (input.outcome.error !== null
    || !expectedTransferDelta(input.before, input.after, input.amount)
    || !programLogSucceeded(logs, EQUITY_GUARD_DEVNET_PROGRAM_ID)
    || !programLogSucceeded(logs, TOKEN_2022_PROGRAM_ADDRESS)
    || input.outcome.signature.length === 0) {
    throw new LiveExecutionError("CONFIRMED", "Confirmed transaction did not execute the protected transfer", input.outcome.signature, logs, input.outcome.error);
  }
  return {
    type: "CONFIRMED_UPDATED_EXECUTION",
    signature: input.outcome.signature,
    symbol: input.symbol,
    eventLabel: input.eventLabel,
    tokenMovementRaw: input.amount.toString(),
  };
}

export function friendlyLiveError(kind: LiveKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthorizationWindowElapsed) return error.message;
  if (error instanceof StaleAuthorizationExpired || message === "STALE_AUTHORIZATION_EXPIRED") return "STALE_AUTHORIZATION_EXPIRED";
  if (/No signature was requested|Start a new attempt/i.test(message)) return message;
  if (isWalletCancellation(error)) return "No transaction was submitted.";
  if (error instanceof LiveExecutionError) {
    if (error.stage === "SIGNING") return "Transaction was not submitted.";
    if (error.stage === "SUBMITTED" || error.stage === "CONFIRMING") return "Transaction could not be confirmed.";
    if (error.stage === "CONFIRMED") return kind === "SETUP" ? "Demo asset transaction failed on devnet." : "Transaction failed on devnet.";
    if (error.stage === "VERIFYING_MINT") return "Transaction confirmed, but the demo asset could not be verified.";
  }
  if (/Phantom wallet not found/i.test(message)) return "Phantom was not detected. Open this page in a browser profile where Phantom is installed.";
  if (/Demo asset not found|AccountNotFound|could not find account/i.test(message)) return "Demo asset not found. Create a new demo asset to continue.";
  if (/deployment|program verification|hash mismatch|cluster|mainnet|testnet|genesis/i.test(message)) return "Devnet or reviewed program verification failed. No signature was requested.";
  if (/expired|confirmation|confirmed transaction metadata/i.test(message)) return "The transaction could not be confirmed on devnet. Check the technical activity before retrying.";
  if (/instruction 0|MultiplierChanged|guard rejection/i.test(message)) return "The expected EquityGuard rejection was not proven by the confirmed transaction.";
  if (/balance delta|demo-asset balances|setup transaction failed/i.test(message)) return kind === "SETUP"
    ? "The demo asset was not confirmed with the expected balance."
    : "The confirmed token balances did not match the expected transfer.";
  return kind === "SETUP" ? "The demo asset could not be created." : "The transaction did not produce the expected proof.";
}
