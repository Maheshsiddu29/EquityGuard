/**
 * Composes EquityGuard (adapter kind 2 or 3) with a Jupiter `/build` response
 * into one v0 transaction. Build-only: nothing here signs or submits.
 *
 * The only supported shape, exactly as the program enforces it:
 *
 *     0 EquityGuard (kind 2 BUY / kind 3 SELL, USDC only)
 *     1 ComputeBudget SetComputeUnitPrice   (Jupiter's)
 *     2 ComputeBudget SetComputeUnitLimit   (the composer's)
 *     3 AssociatedToken CreateIdempotent    (optional, Jupiter's, this trade's destination)
 *     4 Jupiter route_v2                    (always last)
 *
 * A `/build` response carrying anything else — cleanup, other or tip
 * instructions, several setups, an unknown setup, another entrypoint, a
 * counter asset other than USDC — is refused with every reason, never
 * trimmed into shape. Adapter kinds 2 and 3 support only USDC ↔
 * protected-equity `route_v2` trades.
 */

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DownstreamAdapterKind,
  JUPITER_V6_PROGRAM_ADDRESS,
  ROUTE_V2_DISCRIMINATOR_HEX,
  SET_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_PRICE,
  USDC_MINT_ADDRESS,
  buildGuardedJupiterTrade,
  decodeRouteV2Prefix,
  jupiterTradeBindingOf,
  minimumOutFromQuote,
  sysvarView,
  type AssertSafeExecutionRequest,
  type CommittedInstruction,
  type GuardedJupiterTrade,
  type JupiterAdapterKind,
  type JupiterTradeBinding,
} from "@equityguard/guard-client";

import type { ApiInstruction, BuildResponse } from "./build-client.ts";

/** Solana's maximum serialized transaction size (PACKET_DATA_SIZE). */
export const MAX_TRANSACTION_BYTES = 1232;
export { COMPUTE_BUDGET_PROGRAM_ADDRESS };
/**
 * Jupiter's guidance is to simulate at this maximum and then set 1.2x the
 * measured units. EquityGuard is not deployed on mainnet, so a guarded
 * mainnet transaction cannot be simulated; callers choose the limit.
 */
export const UNSIMULATED_COMPUTE_UNIT_LIMIT = 1_400_000;

export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/** A `/build` response outside the supported grammar. Every reason is listed. */
export class UnsupportedJupiterBuildError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`unsupported Jupiter build: ${reasons.join("; ")}`);
    this.name = "UnsupportedJupiterBuildError";
    this.reasons = reasons;
  }
}

/** Converts one `/build` instruction into a Kit instruction. */
export function toKitInstruction(api: ApiInstruction): Instruction {
  return {
    programAddress: address(api.programId),
    accounts: api.accounts.map(
      (meta): AccountMeta => ({
        address: address(meta.pubkey),
        role: meta.isSigner
          ? meta.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : meta.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      }),
    ),
    data: Uint8Array.from(getBase64Encoder().encode(api.data)),
  };
}

/** `SetComputeUnitLimit(units)`: tag 2 followed by a u32. */
export function getSetComputeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 0 || units > 0xffffffff) throw new CompositionError(`compute unit limit ${units} is not a u32`);
  const data = new Uint8Array(SET_COMPUTE_UNIT_LIMIT.length);
  data[0] = SET_COMPUTE_UNIT_LIMIT.tag;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}

const isShape = (i: Instruction, shape: { readonly tag: number; readonly length: number }) =>
  i.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS && (i.accounts ?? []).length === 0 && i.data?.length === shape.length && i.data[0] === shape.tag;

export interface JupiterTradeRequest {
  readonly adapterKind: JupiterAdapterKind;
  readonly protectedMint: Address;
  /** The user authority the trade must be for. */
  readonly taker: Address;
  readonly computeUnitLimit: number;
}

/**
 * Refuses a `/build` response outside the supported grammar, with every
 * reason. The program rechecks all of it; this exists so a user sees a clear
 * refusal instead of an on-chain failure.
 */
export function assertSupportedJupiterBuild(build: BuildResponse, request: JupiterTradeRequest): void {
  const reasons: string[] = [];
  if (build.cleanupInstruction) reasons.push("cleanupInstruction is unsupported");
  if (build.otherInstructions.length > 0) reasons.push(`${build.otherInstructions.length} otherInstructions are unsupported`);
  if (build.tipInstruction) reasons.push("tipInstruction is unsupported");

  const budget = build.computeBudgetInstructions.map(toKitInstruction);
  const prices = budget.filter((i) => isShape(i, SET_COMPUTE_UNIT_PRICE)).length;
  const limits = budget.filter((i) => isShape(i, SET_COMPUTE_UNIT_LIMIT));
  if (prices !== 1) reasons.push(`expected exactly one SetComputeUnitPrice, got ${prices}`);
  if (budget.length !== prices + limits.length) reasons.push("unsupported ComputeBudget instruction");
  if (limits.length > 1) reasons.push("more than one SetComputeUnitLimit");
  for (const limit of limits) {
    const units = new DataView(limit.data!.buffer, limit.data!.byteOffset).getUint32(1, true);
    if (units !== request.computeUnitLimit) reasons.push(`Jupiter's compute unit limit ${units} differs from the requested ${request.computeUnitLimit}`);
  }

  if (build.setupInstructions.length > 1) reasons.push(`${build.setupInstructions.length} setup instructions; at most one is supported`);
  for (const setup of build.setupInstructions) {
    const data = getBase64Encoder().encode(setup.data);
    if (setup.programId !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS || data.length !== 1 || data[0] !== 1) {
      reasons.push(`unknown setup instruction on ${setup.programId}`);
    }
  }

  const swap = build.swapInstruction;
  const swapData = Uint8Array.from(getBase64Encoder().encode(swap.data));
  const prefix = decodeRouteV2Prefix(swapData);
  if (swap.programId !== JUPITER_V6_PROGRAM_ADDRESS) reasons.push(`swap program ${swap.programId} is not Jupiter v6`);
  if (!prefix) reasons.push(`swap entrypoint ${Buffer.from(swapData.subarray(0, 8)).toString("hex")} is not route_v2 (${ROUTE_V2_DISCRIMINATOR_HEX})`);
  if (build.swapMode !== "ExactIn") reasons.push(`swapMode ${build.swapMode} is unsupported`);

  const buy = request.adapterKind === DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC;
  const [expectedInput, expectedOutput] = buy ? [USDC_MINT_ADDRESS, request.protectedMint] : [request.protectedMint, USDC_MINT_ADDRESS];
  if (build.inputMint !== expectedInput || build.outputMint !== expectedOutput) {
    reasons.push(`${buy ? "BUY" : "SELL"} must be ${expectedInput} -> ${expectedOutput}, got ${build.inputMint} -> ${build.outputMint}`);
  }
  if (swap.accounts[0]?.pubkey !== request.taker) reasons.push("the swap authority is not the taker");

  // The quote Jupiter reports must be the trade its instruction encodes.
  if (prefix) {
    if (prefix.inAmount !== BigInt(build.inAmount)) reasons.push("inAmount differs from the encoded trade");
    if (prefix.quotedOutAmount !== BigInt(build.outAmount)) reasons.push("outAmount differs from the encoded trade");
    if (prefix.slippageBps !== build.slippageBps) reasons.push("slippageBps differs from the encoded trade");
    else if (minimumOutFromQuote(prefix.quotedOutAmount, prefix.slippageBps) !== BigInt(build.otherAmountThreshold)) {
      reasons.push("otherAmountThreshold is not the minimum the encoded trade enforces");
    }
  }
  if (reasons.length > 0) throw new UnsupportedJupiterBuildError(reasons);
}

/** `[price, limit, (setup), route_v2]` from a supported build. */
export function normalizedJupiterSuffix(build: BuildResponse, computeUnitLimit: number): Instruction[] {
  const budget = build.computeBudgetInstructions.map(toKitInstruction);
  const price = budget.find((i) => isShape(i, SET_COMPUTE_UNIT_PRICE));
  if (!price) throw new CompositionError("no SetComputeUnitPrice");
  return [price, getSetComputeUnitLimitInstruction(computeUnitLimit), ...build.setupInstructions.map(toKitInstruction), toKitInstruction(build.swapInstruction)];
}

export interface TransactionMetrics {
  readonly instructionCount: number;
  readonly staticAccountCount: number;
  readonly addressLookupTableCount: number;
  readonly lookedUpAddressCount: number;
  readonly compiledMessageBytes: number;
  /** Includes one zeroed 64-byte signature slot per required signer. */
  readonly serializedTransactionBytes: number;
  readonly requiredSignatures: number;
  readonly fitsSizeLimit: boolean;
}

function lookupTablesOf(build: BuildResponse): AddressesByLookupTableAddress {
  const tables: AddressesByLookupTableAddress = {};
  for (const [table, addresses] of Object.entries(build.addressesByLookupTableAddress)) {
    tables[address(table)] = addresses.map((a) => address(a));
  }
  return tables;
}

/** Compiles an unsigned v0 transaction using Jupiter's lookup tables and measures it. */
export function compileAndMeasure(
  build: BuildResponse,
  feePayer: Address,
  instructions: readonly Instruction[],
): { readonly wireBytes: Uint8Array; readonly metrics: TransactionMetrics } {
  const message = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: getBase58Decoder().decode(Uint8Array.from(build.blockhashWithMetadata.blockhash)) as Blockhash,
            lastValidBlockHeight: BigInt(build.blockhashWithMetadata.lastValidBlockHeight),
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
    lookupTablesOf(build),
  );

  const compiled = compileTransactionMessage(message);
  const lookups = compiled.addressTableLookups ?? [];
  const compiledMessageBytes = getCompiledTransactionMessageEncoder().encode(compiled).length;
  const wireBytes = Uint8Array.from(getTransactionEncoder().encode(compileTransaction(message)));
  return {
    wireBytes,
    metrics: {
      instructionCount: compiled.instructions.length,
      staticAccountCount: compiled.staticAccounts.length,
      addressLookupTableCount: lookups.length,
      lookedUpAddressCount: lookups.reduce((n, l) => n + l.readonlyIndexes.length + l.writableIndexes.length, 0),
      compiledMessageBytes,
      serializedTransactionBytes: wireBytes.length,
      requiredSignatures: compiled.header.numSignerAccounts,
      fitsSizeLimit: wireBytes.length <= MAX_TRANSACTION_BYTES,
    },
  };
}

/**
 * Decodes serialized wire bytes and resolves every top-level instruction the
 * way the runtime loads a v0 message: static accounts with header flags, then
 * each table's writable entries, then each table's readonly entries.
 */
export function resolveWireTransaction(wireBytes: Uint8Array, lookupTables: Readonly<Record<string, readonly string[]>>): CommittedInstruction[] {
  const { messageBytes } = getTransactionDecoder().decode(wireBytes);
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (message.version !== 0) throw new CompositionError(`expected a v0 message, got ${String(message.version)}`);
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
  const statics = message.staticAccounts;
  const keys = statics.map((key, i) => ({
    address: key,
    isSigner: i < numSignerAccounts,
    isWritable: i < numSignerAccounts ? i < numSignerAccounts - numReadonlySignerAccounts : i < statics.length - numReadonlyNonSignerAccounts,
  }));
  const lookups = "addressTableLookups" in message ? (message.addressTableLookups ?? []) : [];
  const fromTable = (table: string, index: number) => {
    const key = lookupTables[table]?.[index];
    if (!key) throw new CompositionError(`lookup ${table}#${index} does not resolve`);
    return address(key);
  };
  for (const lookup of lookups) {
    for (const index of lookup.writableIndexes) keys.push({ address: fromTable(lookup.lookupTableAddress, index), isSigner: false, isWritable: true });
  }
  for (const lookup of lookups) {
    for (const index of lookup.readonlyIndexes) keys.push({ address: fromTable(lookup.lookupTableAddress, index), isSigner: false, isWritable: false });
  }
  const key = (index: number) => {
    const found = keys[index];
    if (!found) throw new CompositionError(`account index ${index} is out of range`);
    return found;
  };
  return message.instructions.map((instruction) => ({
    programAddress: key(instruction.programAddressIndex).address,
    accounts: (instruction.accountIndices ?? []).map((index) => ({ ...key(index) })),
    data: Uint8Array.from(instruction.data ?? []),
  }));
}

const sameInstructions = (a: readonly CommittedInstruction[], b: readonly CommittedInstruction[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.programAddress === b[i]?.programAddress &&
      Buffer.from(x.data).equals(Buffer.from(b[i]?.data ?? [])) &&
      x.accounts.length === b[i]?.accounts.length &&
      x.accounts.every((m, j) => {
        const n = b[i]?.accounts[j];
        return m.address === n?.address && m.isSigner === n.isSigner && m.isWritable === n.isWritable;
      }),
  );

export interface GuardedJupiterComposition {
  readonly trade: GuardedJupiterTrade;
  readonly binding: JupiterTradeBinding;
  /** Unsigned: one zeroed signature slot per required signer. */
  readonly wireBytes: Uint8Array;
  readonly metrics: TransactionMetrics;
}

/**
 * Validates the build, normalizes the suffix, builds the guard over it,
 * compiles with Jupiter's lookup tables, and proves the compiled message
 * resolves to exactly the instructions and flags the commitment was computed
 * over. Refuses a transaction over the size limit.
 */
export async function composeGuardedJupiterTrade(input: JupiterTradeRequest & {
  readonly build: BuildResponse;
  readonly programAddress: Address;
  readonly feePayer: Address;
  readonly expectation: AssertSafeExecutionRequest;
}): Promise<GuardedJupiterComposition> {
  assertSupportedJupiterBuild(input.build, input);
  const trade = await buildGuardedJupiterTrade({
    programAddress: input.programAddress,
    feePayer: input.feePayer,
    protectedMint: input.protectedMint,
    adapterKind: input.adapterKind,
    expectation: input.expectation,
    suffix: normalizedJupiterSuffix(input.build, input.computeUnitLimit),
  });
  const { wireBytes, metrics } = compileAndMeasure(input.build, input.feePayer, trade.instructions);
  if (!metrics.fitsSizeLimit) {
    throw new CompositionError(`guarded transaction is ${metrics.serializedTransactionBytes} bytes, over ${MAX_TRANSACTION_BYTES}`);
  }
  const resolved = resolveWireTransaction(wireBytes, input.build.addressesByLookupTableAddress);
  if (!sameInstructions(resolved, sysvarView(trade.instructions, input.feePayer)) || !sameInstructions(resolved.slice(1), trade.committedSuffix)) {
    throw new CompositionError("the compiled transaction does not resolve to the committed instructions");
  }
  return { trade, binding: jupiterTradeBindingOf(trade), wireBytes, metrics };
}
