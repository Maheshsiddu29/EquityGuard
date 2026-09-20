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

import { DEVNET_RPC_URL, verifyDevnetCluster, verifyEquityGuardDeployment } from "./cluster-gate.ts";
import type { PhantomProvider } from "./wallet.ts";

const POLL_MS = 900;

export type LivePhase = "READY" | "SIGNING" | "SUBMITTED" | "CONFIRMING" | "CONFIRMED" | "VERIFYING_MINT" | "SETUP_COMPLETE" | "CANCELLED" | "FAILED";
export type LiveKind = "SETUP" | "SAFE" | "BLOCK" | "REFRESH";

export interface TokenBalances {
  readonly source: bigint;
  readonly destination: bigint;
}

export type LiveResult =
  | { readonly type: "LOCAL_PREVIEW"; readonly kind: LiveKind; readonly expected: "ALLOW" | "REJECT" }
  | { readonly type: "PENDING"; readonly kind: LiveKind; readonly phase: Exclude<LivePhase, "CONFIRMED" | "SETUP_COMPLETE" | "CANCELLED" | "FAILED">; readonly signature?: string }
  | { readonly type: "CONFIRMED_SUCCESS"; readonly kind: Exclude<LiveKind, "BLOCK">; readonly signature: string; readonly slot: bigint; readonly before: TokenBalances; readonly after: TokenBalances }
  | { readonly type: "CONFIRMED_GUARD_REJECTION"; readonly kind: "BLOCK"; readonly signature: string; readonly slot: bigint; readonly instructionIndex: number; readonly customCode: number; readonly before: TokenBalances; readonly after: TokenBalances }
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

export async function verifyMutationEnvironment(): Promise<void> {
  const cluster = await verifyDevnetCluster(DEVNET_RPC_URL);
  const deployment = cluster.verified ? await verifyEquityGuardDeployment(DEVNET_RPC_URL) : null;
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

export function friendlyLiveError(kind: LiveKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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
