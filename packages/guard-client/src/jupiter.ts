/**
 * Adapter kinds 2 and 3: a guarded Jupiter `route_v2` trade between canonical
 * USDC and the protected Token-2022 mint. Mirrors
 * `programs/equity_guard/src/jupiter.rs`, which documents the grammar.
 *
 * Adapter kinds 2 and 3 support only USDC ↔ protected-equity `route_v2`
 * trades. The supported transaction is exactly
 *
 *     0 guard | SetComputeUnitPrice | SetComputeUnitLimit | [CreateIdempotent] | route_v2
 *
 * The suffix commitment is not semantic validation: a builder that writes the
 * transaction also writes its commitment. `checkJupiterSuffix` is the client's
 * copy of the program's semantic rules, at the program's error granularity and
 * in its order, so the client never builds a guard the program would refuse.
 *
 * What neither side knows: the user's intended amount, quoted output,
 * slippage, route, compute-unit price or limit. Those are bound to exact bytes
 * here and checked against the execution plan before signing.
 */

import { createHash } from "node:crypto";

import { AccountRole, address, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction } from "@solana/kit";

import { DownstreamAdapterKind, type AssertSafeExecutionRequest } from "./abi.ts";
import { getAssertSafeExecutionV2Instruction, type CommittedAccount, type CommittedInstruction } from "./downstream.ts";
import { GuardClientError, type EquityGuardErrorName } from "./errors.ts";
import { TOKEN_2022_PROGRAM_ADDRESS } from "./mint-state.ts";

export const JUPITER_SUFFIX_COMMITMENT_DOMAIN = "EQUITYGUARD_JUPITER_SUFFIX_V1";
export const JUPITER_V6_PROGRAM_ADDRESS = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/** Anchor event authority of Jupiter v6, as its published IDL pins it. */
export const JUPITER_EVENT_AUTHORITY = address("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
/** `sha256("global:route_v2")[0..8]`. */
export const ROUTE_V2_DISCRIMINATOR_HEX = "bb64facc31c4af14";
export const USDC_MINT_ADDRESS = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const LEGACY_TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = address("ComputeBudget111111111111111111111111111111");
export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

/** `ComputeBudgetInstruction` tags and encoded lengths (tag + LE value). */
export const SET_COMPUTE_UNIT_LIMIT = { tag: 2, length: 5 } as const;
export const SET_COMPUTE_UNIT_PRICE = { tag: 3, length: 9 } as const;
const CREATE_IDEMPOTENT_TAG = 1;
const CREATE_IDEMPOTENT_ACCOUNTS = 6;
const ROUTE_V2_PREFIX_LENGTH = 34;
const ROUTE_V2_FIXED_ACCOUNTS = 10;
const MAX_SLIPPAGE_BPS = 10_000;

/** `route_v2` fixed accounts, in IDL order. */
export const ROUTE_V2_ACCOUNT = {
  authority: 0,
  source: 1,
  destination: 2,
  sourceMint: 3,
  destinationMint: 4,
  sourceTokenProgram: 5,
  destinationTokenProgram: 6,
  /** Anchor optional: the program id itself encodes `None`. */
  destinationOverride: 7,
  eventAuthority: 8,
  program: 9,
} as const;

export type JupiterAdapterKind = typeof DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC | typeof DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC;
export type ProtectedMintRole = "SOURCE" | "DESTINATION";

export function isJupiterAdapterKind(kind: unknown): kind is JupiterAdapterKind {
  return kind === DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC || kind === DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC;
}

export function protectedRoleOf(kind: JupiterAdapterKind): ProtectedMintRole {
  return kind === DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC ? "DESTINATION" : "SOURCE";
}

// ------------------------------------------------------------ route_v2 data

export interface RouteV2Prefix {
  readonly inAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly slippageBps: number;
  readonly platformFeeBps: number;
  readonly positiveSlippageBps: number;
  readonly routePlanSteps: number;
}

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The fixed argument prefix, or `null` if the data is not `route_v2`. */
export function decodeRouteV2Prefix(data: Uint8Array): RouteV2Prefix | null {
  if (data.length < ROUTE_V2_PREFIX_LENGTH || hexOf(data.subarray(0, 8)) !== ROUTE_V2_DISCRIMINATOR_HEX) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    inAmount: view.getBigUint64(8, true),
    quotedOutAmount: view.getBigUint64(16, true),
    slippageBps: view.getUint16(24, true),
    platformFeeBps: view.getUint16(26, true),
    positiveSlippageBps: view.getUint16(28, true),
    routePlanSteps: view.getUint32(30, true),
  };
}

/**
 * Jupiter's minimum output from the two encoded fields:
 * `ceil(quotedOut × (10000 − slippageBps) / 10000)`. It matched Jupiter's
 * reported `otherAmountThreshold` on every recorded build; Jupiter enforces it.
 */
export function minimumOutFromQuote(quotedOutAmount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new GuardClientError("UnsupportedJupiterTrade", `slippageBps ${slippageBps} is outside [0, 10000]`);
  }
  const numerator = quotedOutAmount * BigInt(MAX_SLIPPAGE_BPS - slippageBps);
  return (numerator + 9_999n) / 10_000n;
}

// ------------------------------------------------ transaction-level flags

const isSignerRole = (role: AccountRole) => role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;
const isWritableRole = (role: AccountRole) => role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER;

/**
 * Accounts the runtime never lets a transaction write (builtins, sysvars): it
 * silently demotes them to read-only in the Instructions sysvar. Rather than
 * model that, the client refuses any transaction that asks for it.
 */
const RESERVED_ACCOUNTS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "Feature111111111111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "ZkE1Gama1Proof11111111111111111111111111111",
  "ZkTokenProof1111111111111111111111111111111",
]);

/**
 * `instructions` exactly as the Instructions sysvar exposes them inside a
 * transaction paid by `feePayer`: each account's signer and writable flags
 * merged across the whole message, the fee payer a writable signer.
 */
export function sysvarView(instructions: readonly Instruction[], feePayer: Address): CommittedInstruction[] {
  const signers = new Set<string>([feePayer]);
  const writable = new Set<string>([feePayer]);
  const invoked = new Set<string>(instructions.map((i) => i.programAddress));
  for (const instruction of instructions) {
    for (const meta of instruction.accounts ?? []) {
      if (isSignerRole(meta.role)) signers.add(meta.address);
      if (isWritableRole(meta.role)) writable.add(meta.address);
    }
  }
  for (const key of writable) {
    if (invoked.has(key) || RESERVED_ACCOUNTS.has(key) || key.startsWith("Sysvar")) {
      throw new GuardClientError("InvalidDownstream", `${key} is writable but the runtime would demote it; refusing to commit to flags it will not expose`);
    }
  }
  return instructions.map((instruction) => ({
    programAddress: instruction.programAddress,
    accounts: (instruction.accounts ?? []).map((meta): CommittedAccount => ({
      address: meta.address,
      isSigner: signers.has(meta.address),
      isWritable: writable.has(meta.address),
    })),
    data: Uint8Array.from(instruction.data ?? []),
  }));
}

// ------------------------------------------------------ suffix commitment

const u32le = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new GuardClientError("InvalidDownstream", "length does not fit u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

/** The canonical suffix encoding, before hashing. */
export function jupiterSuffixCommitmentPreimage(suffix: readonly CommittedInstruction[]): Uint8Array {
  const encoder = getAddressEncoder();
  const parts: Uint8Array[] = [new TextEncoder().encode(JUPITER_SUFFIX_COMMITMENT_DOMAIN), u32le(suffix.length)];
  for (const instruction of suffix) {
    parts.push(Uint8Array.from(encoder.encode(instruction.programAddress)), u32le(instruction.accounts.length));
    for (const account of instruction.accounts) {
      parts.push(Uint8Array.from(encoder.encode(account.address)), Uint8Array.of(account.isSigner ? 1 : 0, account.isWritable ? 1 : 0));
    }
    parts.push(u32le(instruction.data.length), instruction.data);
  }
  return Buffer.concat(parts);
}

export function jupiterSuffixCommitment(suffix: readonly CommittedInstruction[]): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(jupiterSuffixCommitmentPreimage(suffix)).digest());
}

// -------------------------------------------------------------- semantics

export async function canonicalAta(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [encoder.encode(owner), encoder.encode(tokenProgram), encoder.encode(mint)],
  });
  return pda;
}

type Verdict = EquityGuardErrorName | null;

function computeBudgetVerdict(instruction: CommittedInstruction, shape: { readonly tag: number; readonly length: number }): Verdict {
  const canonical = instruction.accounts.length === 0 && instruction.data.length === shape.length && instruction.data[0] === shape.tag;
  return canonical ? null : "InvalidComputeBudgetInstruction";
}

/** The fixed accounts and prefix of a `route_v2` that passed the checks. */
export interface RouteV2Summary {
  readonly authority: Address;
  readonly source: Address;
  readonly destination: Address;
  readonly sourceMint: Address;
  readonly destinationMint: Address;
  readonly sourceTokenProgram: Address;
  readonly destinationTokenProgram: Address;
  readonly prefix: RouteV2Prefix;
}

function routeVerdict(trade: CommittedInstruction, kind: JupiterAdapterKind, protectedMint: Address): { verdict: Verdict; route: RouteV2Summary | null } {
  const fail = (verdict: EquityGuardErrorName) => ({ verdict, route: null });
  if (trade.accounts.length < ROUTE_V2_FIXED_ACCOUNTS) return fail("InvalidJupiterInstruction");
  const prefix = decodeRouteV2Prefix(trade.data);
  if (!prefix) return fail("InvalidJupiterInstruction");
  const account = (index: number) => trade.accounts[index] as CommittedAccount;
  const key = (index: number) => account(index).address;
  const A = ROUTE_V2_ACCOUNT;

  if (key(A.program) !== JUPITER_V6_PROGRAM_ADDRESS) return fail("InvalidJupiterProgram");
  const structurallyValid =
    key(A.eventAuthority) === JUPITER_EVENT_AUTHORITY &&
    account(A.authority).isSigner &&
    prefix.inAmount > 0n &&
    prefix.quotedOutAmount > 0n &&
    prefix.slippageBps <= MAX_SLIPPAGE_BPS &&
    prefix.routePlanSteps > 0;
  if (!structurallyValid) return fail("InvalidJupiterInstruction");
  if (key(A.destinationOverride) !== JUPITER_V6_PROGRAM_ADDRESS) return fail("DestinationOverrideUnsupported");

  const route: RouteV2Summary = {
    authority: key(A.authority),
    source: key(A.source),
    destination: key(A.destination),
    sourceMint: key(A.sourceMint),
    destinationMint: key(A.destinationMint),
    sourceTokenProgram: key(A.sourceTokenProgram),
    destinationTokenProgram: key(A.destinationTokenProgram),
    prefix,
  };
  const buy = protectedRoleOf(kind) === "DESTINATION";
  const [protectedSide, protectedProgram, counter, counterProgram] = buy
    ? [route.destinationMint, route.destinationTokenProgram, route.sourceMint, route.sourceTokenProgram]
    : [route.sourceMint, route.sourceTokenProgram, route.destinationMint, route.destinationTokenProgram];
  if (protectedSide !== protectedMint) return fail("InvalidJupiterDirection");
  if (counter !== USDC_MINT_ADDRESS) return fail("InvalidCounterMint");
  if (protectedProgram !== TOKEN_2022_PROGRAM_ADDRESS || counterProgram !== LEGACY_TOKEN_PROGRAM_ADDRESS) return fail("InvalidTokenProgram");
  if (prefix.platformFeeBps !== 0 || prefix.positiveSlippageBps !== 0) return fail("UnsupportedJupiterFee");
  return { verdict: null, route };
}

function setupVerdict(setup: CommittedInstruction, route: RouteV2Summary): Verdict {
  if (setup.accounts.length !== CREATE_IDEMPOTENT_ACCOUNTS || setup.data.length !== 1 || setup.data[0] !== CREATE_IDEMPOTENT_TAG) {
    return "InvalidAtaSetup";
  }
  const [payer, ata, owner, mint, systemProgram, tokenProgram] = setup.accounts as readonly CommittedAccount[];
  const forThisTrade =
    payer?.isSigner === true &&
    ata?.address === route.destination &&
    owner?.address === route.authority &&
    mint?.address === route.destinationMint &&
    systemProgram?.address === SYSTEM_PROGRAM_ADDRESS &&
    tokenProgram?.address === route.destinationTokenProgram;
  return forThisTrade ? null : "InvalidAtaSetup";
}

export interface SuffixCheck {
  /** `null` when the program would accept the suffix's semantics. */
  readonly verdict: EquityGuardErrorName | null;
  /** The validated trade, when every check passed. */
  readonly route: RouteV2Summary | null;
}

/**
 * The program's grammar and semantic checks (`check_suffix`), in its order.
 * `suffix` is every instruction after the guard, with transaction-level flags.
 */
export async function checkJupiterSuffix(suffix: readonly CommittedInstruction[], kind: JupiterAdapterKind, protectedMint: Address): Promise<SuffixCheck> {
  const fail = (verdict: EquityGuardErrorName): SuffixCheck => ({ verdict, route: null });
  if (suffix.length !== 3 && suffix.length !== 4) return fail("UnsupportedTransactionGrammar");
  const [price, limit] = suffix as readonly [CommittedInstruction, CommittedInstruction];
  const setup = suffix.length === 4 ? (suffix[2] as CommittedInstruction) : null;
  const trade = suffix[suffix.length - 1] as CommittedInstruction;

  if (
    price.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    limit.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    (setup !== null && setup.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS)
  ) {
    return fail("UnsupportedTransactionGrammar");
  }
  if (trade.programAddress !== JUPITER_V6_PROGRAM_ADDRESS) return fail("InvalidJupiterProgram");

  const budget = computeBudgetVerdict(price, SET_COMPUTE_UNIT_PRICE) ?? computeBudgetVerdict(limit, SET_COMPUTE_UNIT_LIMIT);
  if (budget) return fail(budget);

  const { verdict, route } = routeVerdict(trade, kind, protectedMint);
  if (verdict || !route) return fail(verdict ?? "InvalidJupiterInstruction");
  if (setup) {
    const setupFailure = setupVerdict(setup, route);
    if (setupFailure) return fail(setupFailure);
  }
  if ((await canonicalAta(route.authority, route.sourceMint, route.sourceTokenProgram)) !== route.source) {
    return fail("NonCanonicalSourceAccount");
  }
  if ((await canonicalAta(route.authority, route.destinationMint, route.destinationTokenProgram)) !== route.destination) {
    return fail("NonCanonicalDestinationAccount");
  }
  return { verdict: null, route };
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The program's whole kind 2/3 downstream verdict for a transaction whose
 * top-level instructions (sysvar view) are `instructions`, with this guard at
 * `guardIndex` already proven to be the executing instruction.
 */
export async function checkGuardedJupiterTransaction(input: {
  readonly instructions: readonly CommittedInstruction[];
  readonly guardIndex: number;
  readonly adapterKind: JupiterAdapterKind;
  readonly protectedMint: Address;
  readonly commitment: Uint8Array;
}): Promise<EquityGuardErrorName | null> {
  if (input.guardIndex !== 0) return "GuardNotFirst";
  const suffix = input.instructions.slice(1);
  const { verdict } = await checkJupiterSuffix(suffix, input.adapterKind, input.protectedMint);
  if (verdict) return verdict;
  return bytesEqual(jupiterSuffixCommitment(suffix), input.commitment) ? null : "DownstreamCommitmentMismatch";
}

// ---------------------------------------------------------------- building

export interface GuardedJupiterTrade {
  /** `[guard, price, limit, (setup), route_v2]`. */
  readonly instructions: readonly Instruction[];
  readonly guard: Instruction;
  readonly adapterKind: JupiterAdapterKind;
  /** The suffix exactly as the program will hash it. */
  readonly committedSuffix: readonly CommittedInstruction[];
  readonly commitment: Uint8Array;
  readonly route: RouteV2Summary;
}

/**
 * Builds `[guard, ...suffix]` for kind 2 or 3.
 *
 * Order: validate the suffix as the program will see it; build a guard with a
 * zero commitment; derive the transaction-level flags of the whole list; hash
 * the suffix; rebuild the guard with that commitment. The guard's accounts do
 * not depend on its data, so the last step cannot change what was hashed —
 * which is re-checked rather than assumed.
 */
export async function buildGuardedJupiterTrade(input: {
  readonly programAddress: Address;
  readonly feePayer: Address;
  readonly protectedMint: Address;
  readonly adapterKind: JupiterAdapterKind;
  readonly expectation: AssertSafeExecutionRequest;
  readonly suffix: readonly Instruction[];
}): Promise<GuardedJupiterTrade> {
  if (!isJupiterAdapterKind(input.adapterKind)) {
    throw new GuardClientError("InvalidDownstream", `adapter kind ${String(input.adapterKind)} is not a Jupiter kind`);
  }
  const guardFor = (commitment: Uint8Array) =>
    getAssertSafeExecutionV2Instruction({
      programAddress: input.programAddress,
      mint: input.protectedMint,
      expectation: input.expectation,
      downstreamCommitment: commitment,
      adapterKind: input.adapterKind,
    });

  const provisional = sysvarView([guardFor(new Uint8Array(32)), ...input.suffix], input.feePayer);
  const committedSuffix = provisional.slice(1);
  const { verdict, route } = await checkJupiterSuffix(committedSuffix, input.adapterKind, input.protectedMint);
  if (verdict || !route) {
    throw new GuardClientError("UnsupportedJupiterTrade", `the program would reject this trade with ${verdict ?? "an unknown error"}`, verdict);
  }
  const commitment = jupiterSuffixCommitment(committedSuffix);
  const guard = guardFor(commitment);
  const instructions = [guard, ...input.suffix];

  const final = sysvarView(instructions, input.feePayer);
  const recheck = await checkGuardedJupiterTransaction({ instructions: final, guardIndex: 0, adapterKind: input.adapterKind, protectedMint: input.protectedMint, commitment });
  if (recheck !== null) {
    throw new GuardClientError("UnsupportedJupiterTrade", `the final transaction no longer verifies: ${recheck}`, recheck);
  }
  return { instructions, guard, adapterKind: input.adapterKind, committedSuffix, commitment, route };
}

// ------------------------------------------------------------ plan binding

/** Plan-level names of the Jupiter adapter kinds. */
export const JUPITER_ADAPTER_KIND_NAMES = {
  [DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC]: "JUPITER_ROUTE_V2_BUY_USDC",
  [DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC]: "JUPITER_ROUTE_V2_SELL_USDC",
} as const;
export type JupiterAdapterKindName = (typeof JUPITER_ADAPTER_KIND_NAMES)[JupiterAdapterKind];

/**
 * Everything an execution plan binds about a guarded Jupiter trade. Plain
 * data: the plan compares it field for field against the final build before
 * signing.
 */
export interface JupiterTradeBinding {
  readonly adapterKind: JupiterAdapterKindName;
  readonly jupiterProgramId: string;
  readonly routeDiscriminatorHex: string;
  readonly protectedMintRole: ProtectedMintRole;
  readonly protectedMint: string;
  /** Always canonical USDC for kinds 2 and 3. */
  readonly counterMint: string;
  readonly authority: string;
  readonly sourceMint: string;
  readonly destinationMint: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly inAmountRaw: bigint;
  readonly quotedOutRaw: bigint;
  readonly slippageBps: number;
  /** Jupiter's enforced minimum, derived from `quotedOutRaw` and `slippageBps`. */
  readonly minOutRaw: bigint;
  readonly suffixCommitmentHex: string;
  readonly suffixInstructionCount: number;
}

export function jupiterTradeBindingOf(trade: GuardedJupiterTrade): JupiterTradeBinding {
  const { route, adapterKind } = trade;
  const role = protectedRoleOf(adapterKind);
  const { prefix } = route;
  return {
    adapterKind: JUPITER_ADAPTER_KIND_NAMES[adapterKind],
    jupiterProgramId: JUPITER_V6_PROGRAM_ADDRESS,
    routeDiscriminatorHex: ROUTE_V2_DISCRIMINATOR_HEX,
    protectedMintRole: role,
    protectedMint: role === "DESTINATION" ? route.destinationMint : route.sourceMint,
    counterMint: role === "DESTINATION" ? route.sourceMint : route.destinationMint,
    authority: route.authority,
    sourceMint: route.sourceMint,
    destinationMint: route.destinationMint,
    sourceTokenAccount: route.source,
    destinationTokenAccount: route.destination,
    inAmountRaw: prefix.inAmount,
    quotedOutRaw: prefix.quotedOutAmount,
    slippageBps: prefix.slippageBps,
    minOutRaw: minimumOutFromQuote(prefix.quotedOutAmount, prefix.slippageBps),
    suffixCommitmentHex: hexOf(trade.commitment),
    suffixInstructionCount: trade.committedSuffix.length,
  };
}
