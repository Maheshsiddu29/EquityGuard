/**
 * Transaction submission and outcome retrieval. Failed transactions can be
 * submitted with preflight disabled so they land on-chain and their failure
 * is independently verifiable by signature.
 */

import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { DevnetContext } from "./config.ts";

const CONFIRMATION_POLL_MS = 1_000;

export class TransactionTimeoutError extends Error {
  readonly signature: Signature;

  constructor(signature: Signature) {
    super(`transaction ${signature} was not confirmed before its blockhash expired`);
    this.signature = signature;
    this.name = "TransactionTimeoutError";
  }
}

/** On-chain outcome of a confirmed transaction. */
export interface TransactionOutcome {
  readonly signature: Signature;
  readonly slot: bigint;
  readonly blockTime: bigint | null;
  readonly succeeded: boolean;
  /** `[instructionIndex, customCode]` when an instruction returned `Custom`. */
  readonly customError: { readonly instructionIndex: number; readonly code: number } | null;
  readonly rawError: unknown;
  readonly logs: readonly string[];
}

/**
 * Signs, sends and waits for confirmation, then fetches the landed
 * transaction. With `skipPreflight`, a failing transaction still lands and
 * returns `succeeded: false` instead of being rejected by simulation.
 */
export async function sendInstructions(
  ctx: DevnetContext,
  instructions: readonly Instruction[],
  options: { readonly skipPreflight: boolean },
): Promise<TransactionOutcome> {
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(ctx.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);

  await ctx.rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      skipPreflight: options.skipPreflight,
      preflightCommitment: "confirmed",
    })
    .send();

  await waitForConfirmation(ctx, signature, blockhash.lastValidBlockHeight);
  return fetchOutcome(ctx, signature);
}

async function waitForConfirmation(
  ctx: DevnetContext,
  signature: Signature,
  lastValidBlockHeight: bigint,
): Promise<void> {
  for (;;) {
    const { value } = await ctx.rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    const height = await ctx.rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > lastValidBlockHeight) throw new TransactionTimeoutError(signature);
    await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_MS));
  }
}

async function fetchOutcome(ctx: DevnetContext, signature: Signature): Promise<TransactionOutcome> {
  const tx = await ctx.rpc
    .getTransaction(signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
    .send();
  if (!tx) throw new TransactionTimeoutError(signature);
  const rawError = tx.meta?.err ?? null;
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    succeeded: rawError === null,
    customError: parseCustomError(rawError),
    rawError,
    logs: tx.meta?.logMessages ?? [],
  };
}

/** Extracts `{ InstructionError: [index, { Custom: code }] }` from an RPC error. */
export function parseCustomError(
  rawError: unknown,
): { readonly instructionIndex: number; readonly code: number } | null {
  if (typeof rawError !== "object" || rawError === null || !("InstructionError" in rawError)) return null;
  const detail = (rawError as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail) || detail.length !== 2) return null;
  const [index, inner] = detail as [unknown, unknown];
  if (typeof inner !== "object" || inner === null || !("Custom" in inner)) return null;
  const code = (inner as { Custom: unknown }).Custom;
  return { instructionIndex: Number(index), code: Number(code) };
}
