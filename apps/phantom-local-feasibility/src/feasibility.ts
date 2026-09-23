import { getTransferSolInstruction } from "@solana-program/system";
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Signature,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";

import type { PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";

export const LOCAL_RPC_URL = "http://127.0.0.1:8899";
const AIRDROP_LAMPORTS = 1_000_000_000n;
const MINIMUM_BALANCE = 10_000_000n;
const POLL_MS = 500;
const POLL_LIMIT = 60;

export type FailureKind =
  | "PHANTOM_NOT_DETECTED"
  | "USER_REJECTED"
  | "SIGN_TRANSACTION_UNAVAILABLE"
  | "LOCAL_BLOCKHASH_REJECTED"
  | "WALLET_REFUSED_LOCAL_TRANSACTION"
  | "SERIALIZATION_FAILURE"
  | "SEND_RAW_TRANSACTION_FAILURE"
  | "LOCAL_CONFIRMATION_FAILURE"
  | "LOCAL_RPC_REFUSED";

export class FeasibilityError extends Error {
  readonly kind: FailureKind;
  readonly raw: unknown;

  constructor(kind: FailureKind, message: string, raw?: unknown) {
    super(message);
    this.name = "FeasibilityError";
    this.kind = kind;
    this.raw = raw;
  }
}

export interface ProviderCapabilities {
  readonly isPhantom: boolean;
  readonly connect: boolean;
  readonly signTransaction: boolean;
  readonly signAndSendTransaction: boolean;
  readonly request: boolean;
}

export interface FeasibilityResult {
  readonly publicKey: string;
  readonly rpcUrl: string;
  readonly signature: string;
  readonly slot: bigint;
  readonly signer: string;
  readonly feePayer: string;
  readonly signedBytesReturned: true;
  readonly manualLocalSubmissionSucceeded: true;
  readonly localConfirmationSucceeded: true;
  readonly apiUsed: "provider.request({ method: \"signTransaction\" })";
}

export function assertLocalRpcUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new FeasibilityError("LOCAL_RPC_REFUSED", `Refusing invalid RPC URL: ${value}`, error);
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new FeasibilityError("LOCAL_RPC_REFUSED", `Refusing non-local RPC URL: ${url.origin}`);
  }
  return url;
}

export function inspectProvider(provider: unknown): ProviderCapabilities {
  const candidate = typeof provider === "object" && provider !== null
    ? provider as Record<string, unknown>
    : {};
  return {
    isPhantom: candidate.isPhantom === true,
    connect: typeof candidate.connect === "function",
    signTransaction: typeof candidate.signTransaction === "function",
    signAndSendTransaction: typeof candidate.signAndSendTransaction === "function",
    request: typeof candidate.request === "function",
  };
}

export function assertSigningAvailable(capabilities: ProviderCapabilities): void {
  if (!capabilities.isPhantom || !capabilities.connect) {
    throw new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected.");
  }
  if (!capabilities.signTransaction || !capabilities.request) {
    throw new FeasibilityError(
      "SIGN_TRANSACTION_UNAVAILABLE",
      "Phantom signTransaction is unavailable in the injected provider; experiment stopped.",
    );
  }
}

function isUserRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  const message = "message" in error ? String((error as { readonly message?: unknown }).message) : "";
  return code === 4001 || /\b(?:user|request|signature request) (?:rejected|cancelled|canceled)\b/i.test(message);
}

function serializedBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

export function signedTransactionBytes(response: unknown): Uint8Array {
  const candidate = typeof response === "object" && response !== null && "signedTransaction" in response
    ? (response as { readonly signedTransaction: unknown }).signedTransaction
    : response;
  const direct = serializedBytes(candidate);
  if (direct) return direct;
  if (typeof candidate === "object" && candidate !== null && "serialize" in candidate) {
    const serialize = (candidate as { readonly serialize?: unknown }).serialize;
    if (typeof serialize === "function") {
      try {
        const serialized = serializedBytes(serialize.call(candidate));
        if (serialized) return serialized;
      } catch (error) {
        throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom signed transaction serialization failed.", error);
      }
    }
  }
  throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom returned no serializable signed transaction bytes.");
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

function sameInstruction(left: Instruction, right: Instruction): boolean {
  if (left.programAddress !== right.programAddress || !sameBytes(left.data ?? [], right.data ?? [])) return false;
  const leftAccounts = left.accounts ?? [];
  const rightAccounts = right.accounts ?? [];
  return leftAccounts.length === rightAccounts.length && leftAccounts.every((account, index) => {
    const other = rightAccounts[index];
    return other !== undefined && account.address === other.address && account.role === other.role;
  });
}

function isAllowedComputeBudgetPrefix(instruction: Instruction): boolean {
  if (
    instruction.programAddress !== COMPUTE_BUDGET_PROGRAM ||
    (instruction.accounts?.length ?? 0) !== 0 ||
    instruction.data === undefined
  ) {
    return false;
  }
  return (instruction.data.length === 5 && instruction.data[0] === 2) ||
    (instruction.data.length === 9 && instruction.data[0] === 3);
}

export function verifySignedTransaction(unsigned: Transaction, wireBytes: Uint8Array): {
  readonly transaction: Transaction;
  readonly signature: Signature;
} {
  let signed: Transaction;
  try {
    signed = getTransactionDecoder().decode(wireBytes);
  } catch (error) {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom returned invalid transaction bytes.", error);
  }
  const decodeMessage = getCompiledTransactionMessageDecoder();
  const unsignedMessage = decodeMessage.decode(unsigned.messageBytes);
  const signedMessage = decodeMessage.decode(signed.messageBytes);
  if (unsignedMessage.version !== "legacy" || signedMessage.version !== "legacy") {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom returned an unexpected transaction version.");
  }
  const unsignedSigners = unsignedMessage.staticAccounts.slice(0, unsignedMessage.header.numSignerAccounts);
  const signedSigners = signedMessage.staticAccounts.slice(0, signedMessage.header.numSignerAccounts);
  if (
    unsignedSigners.length !== 1 ||
    signedSigners.length !== 1 ||
    unsignedSigners[0] !== signedSigners[0] ||
    unsignedMessage.lifetimeToken !== signedMessage.lifetimeToken
  ) {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom changed the signer or local blockhash while signing.");
  }
  const unsignedInstructions = getInstructionsFromCompiledTransactionMessage(unsignedMessage);
  const signedInstructions = getInstructionsFromCompiledTransactionMessage(signedMessage);
  const prefixLength = signedInstructions.length - unsignedInstructions.length;
  if (prefixLength < 0 || prefixLength > 2) {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom returned an unexpected signed transaction shape.");
  }
  const prefix = signedInstructions.slice(0, prefixLength);
  const discriminators = prefix.map((instruction) => instruction.data?.[0]);
  if (!prefix.every(isAllowedComputeBudgetPrefix) || new Set(discriminators).size !== discriminators.length) {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom added an unsupported transaction instruction.");
  }
  const signedSuffix = signedInstructions.slice(prefixLength);
  if (!unsignedInstructions.every((instruction, index) => {
    const returned = signedSuffix[index];
    return returned !== undefined && sameInstruction(instruction, returned);
  })) {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom changed the local transfer while signing.");
  }
  try {
    return { transaction: signed, signature: getSignatureFromTransaction(signed) };
  } catch (error) {
    throw new FeasibilityError("SERIALIZATION_FAILURE", "Phantom returned an unsigned transaction.", error);
  }
}

const walletSigner = (wallet: Address): TransactionSigner => ({
  address: wallet,
  signTransactions: async (transactions) => transactions,
});

async function waitForSignature(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature,
  lastValidBlockHeight?: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
    const status = value[0];
    if (status?.err) {
      throw new FeasibilityError("LOCAL_CONFIRMATION_FAILURE", `Local transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if (lastValidBlockHeight !== undefined) {
      const height = await rpc.getBlockHeight({ commitment: "processed" }).send();
      if (height > lastValidBlockHeight) {
        throw new FeasibilityError("LOCAL_CONFIRMATION_FAILURE", "Local transaction expired before confirmation.");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new FeasibilityError("LOCAL_CONFIRMATION_FAILURE", "Local transaction was not confirmed before the polling limit.");
}

async function fundLocally(rpc: ReturnType<typeof createSolanaRpc>, wallet: Address): Promise<void> {
  const balance = await rpc.getBalance(wallet, { commitment: "confirmed" }).send();
  if (balance.value >= MINIMUM_BALANCE) return;
  const localTestRpc = rpc as typeof rpc & {
    requestAirdrop(address: Address, amount: ReturnType<typeof lamports>): { send(): Promise<Signature> };
  };
  const signature = await localTestRpc.requestAirdrop(wallet, lamports(AIRDROP_LAMPORTS)).send();
  await waitForSignature(rpc, signature);
}

function encodeForPhantom(transaction: Transaction): string {
  return getBase58Decoder().decode(getTransactionEncoder().encode(transaction));
}

export async function runFeasibility(
  provider: PhantomProvider,
  wallet: Address,
  rpcUrl: string = LOCAL_RPC_URL,
  onStage?: (message: string) => void,
): Promise<FeasibilityResult> {
  const localUrl = assertLocalRpcUrl(rpcUrl);
  const capabilities = inspectProvider(provider);
  assertSigningAvailable(capabilities);
  const rpc = createSolanaRpc(localUrl.href);

  onStage?.("Funding Phantom public key with local validator test funds");
  await fundLocally(rpc, wallet);

  onStage?.("Fetching recent blockhash from local validator");
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(wallet, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: walletSigner(wallet),
        destination: wallet,
        amount: 1n,
      }),
      m,
    ),
  );
  const unsigned = compileTransaction(message);

  onStage?.("Requesting Phantom signTransaction signature");
  let response: unknown;
  try {
    response = await provider.request({
      method: "signTransaction",
      params: { message: encodeForPhantom(unsigned) },
    });
  } catch (error) {
    if (isUserRejection(error)) {
      throw new FeasibilityError("USER_REJECTED", "The user rejected the Phantom signature request.", error);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/blockhash|expired|not found/i.test(message)) {
      throw new FeasibilityError("LOCAL_BLOCKHASH_REJECTED", "Phantom rejected the local validator blockhash.", error);
    }
    throw new FeasibilityError(
      "WALLET_REFUSED_LOCAL_TRANSACTION",
      "Phantom refused the localhost-derived transaction.",
      error,
    );
  }

  const wireBytes = signedTransactionBytes(response);
  const verified = verifySignedTransaction(unsigned, wireBytes);

  // Repeat the gate immediately before the only transaction submission call.
  assertLocalRpcUrl(rpcUrl);
  onStage?.("Submitting Phantom-signed bytes manually to local validator");
  let submitted: Signature;
  try {
    submitted = await rpc.sendTransaction(getBase64EncodedWireTransaction(verified.transaction), {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
    }).send();
  } catch (error) {
    throw new FeasibilityError("SEND_RAW_TRANSACTION_FAILURE", "Local sendRawTransaction failed.", error);
  }
  if (submitted !== verified.signature) {
    throw new FeasibilityError("SEND_RAW_TRANSACTION_FAILURE", "Local RPC returned a different transaction signature.");
  }

  onStage?.("Waiting for local RPC confirmation");
  await waitForSignature(rpc, verified.signature, blockhash.lastValidBlockHeight);
  const transaction = await rpc.getTransaction(verified.signature, {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();
  if (!transaction || transaction.meta?.err) {
    throw new FeasibilityError("LOCAL_CONFIRMATION_FAILURE", "Confirmed local transaction metadata was unavailable or failed.");
  }

  return {
    publicKey: wallet,
    rpcUrl: localUrl.origin,
    signature: verified.signature,
    slot: transaction.slot,
    signer: wallet,
    feePayer: wallet,
    signedBytesReturned: true,
    manualLocalSubmissionSucceeded: true,
    localConfirmationSucceeded: true,
    apiUsed: "provider.request({ method: \"signTransaction\" })",
  };
}
