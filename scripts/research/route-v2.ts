/**
 * M9D-A research tooling: decoding and semantic validation of a Jupiter
 * `route_v2` instruction.
 *
 * This is the host-side model of the checks an on-chain Jupiter adapter would
 * perform. It exists to answer one question — can EquityGuard prove, from the
 * swap instruction alone, that the instruction is a supported Jupiter trade of
 * the protected mint in the expected role? — before any Rust is written.
 *
 * Source of the layout: the Anchor IDL published on mainnet by the Jupiter
 * aggregator program itself (account `C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa`,
 * the `anchor:idl` account of `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`).
 * Every field asserted here was also confirmed against fresh mainnet builds.
 */

export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** `sha256("global:route_v2")[0..8]`, matching the on-chain IDL discriminator. */
export const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
/** The other v6 entrypoints, whose account order differs; see the IDL. */
export const OTHER_V6_DISCRIMINATORS: Readonly<Record<string, string>> = {
  e517cb977ae3ad2a: "route",
  "96564774a75d0e68": "route_with_token_ledger",
  c1209b3341d69c81: "shared_accounts_route",
  e6798f50779f6aaa: "shared_accounts_route_with_token_ledger",
  d033ef977b2bed5c: "exact_out_route",
  b0d169a89a7d453e: "shared_accounts_exact_out_route",
  "9d8ab85215f4f324": "exact_out_route_v2",
  d19853937cfed8e9: "shared_accounts_route_v2",
  "3560e5cad8bbfa18": "shared_accounts_exact_out_route_v2",
};

/** Fixed account positions of `route_v2`, before the venue remaining accounts. */
export const ROUTE_V2_ACCOUNTS = {
  userTransferAuthority: 0,
  userSourceTokenAccount: 1,
  userDestinationTokenAccount: 2,
  sourceMint: 3,
  destinationMint: 4,
  sourceTokenProgram: 5,
  destinationTokenProgram: 6,
  /** Anchor optional: the program id itself means `None`. */
  destinationTokenAccountOverride: 7,
  eventAuthority: 8,
  program: 9,
} as const;
export const ROUTE_V2_FIXED_ACCOUNTS = 10;
/** Fixed-size argument prefix: 8 discriminator + 8 + 8 + 2 + 2 + 2 + 4 vec length. */
export const ROUTE_V2_PREFIX_LEN = 34;

export interface AccountMetaLike {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface InstructionLike {
  readonly programId: string;
  readonly accounts: readonly AccountMetaLike[];
  readonly dataHex: string;
}

export interface RouteV2 {
  readonly userTransferAuthority: string;
  readonly userSourceTokenAccount: string;
  readonly userDestinationTokenAccount: string;
  readonly sourceMint: string;
  readonly destinationMint: string;
  readonly sourceTokenProgram: string;
  readonly destinationTokenProgram: string;
  /** null when the optional account is the `None` sentinel. */
  readonly destinationTokenAccountOverride: string | null;
  readonly inAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly slippageBps: number;
  readonly platformFeeBps: number;
  readonly positiveSlippageBps: number;
  readonly routePlanSteps: number;
  /** Everything after the fixed prefix: the route plan, left opaque here. */
  readonly routePlanTailHex: string;
  readonly venueAccountCount: number;
}

export class RouteV2DecodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RouteV2DecodeError";
    this.code = code;
  }
}

/**
 * Decodes the fixed prefix of a `route_v2` instruction. The route plan itself
 * is a `Vec<RoutePlanStepV2>` over a 188-variant enum with variable-size
 * fields; it is deliberately left as opaque bytes, because the SHA-256
 * downstream commitment already pins it exactly.
 */
export function decodeRouteV2(instruction: InstructionLike): RouteV2 {
  if (instruction.programId !== JUPITER_V6_PROGRAM_ID) {
    throw new RouteV2DecodeError("WRONG_PROGRAM", `expected ${JUPITER_V6_PROGRAM_ID}, got ${instruction.programId}`);
  }
  const data = Buffer.from(instruction.dataHex, "hex");
  if (data.length < ROUTE_V2_PREFIX_LEN) {
    throw new RouteV2DecodeError("TRUNCATED", `${data.length} bytes is shorter than the ${ROUTE_V2_PREFIX_LEN}-byte prefix`);
  }
  const discriminator = data.subarray(0, 8).toString("hex");
  if (discriminator !== ROUTE_V2_DISCRIMINATOR) {
    const known = OTHER_V6_DISCRIMINATORS[discriminator];
    throw new RouteV2DecodeError("WRONG_INSTRUCTION", known ? `${known} has a different account order` : `unknown discriminator ${discriminator}`);
  }
  if (instruction.accounts.length < ROUTE_V2_FIXED_ACCOUNTS) {
    throw new RouteV2DecodeError("TOO_FEW_ACCOUNTS", `${instruction.accounts.length} accounts, ${ROUTE_V2_FIXED_ACCOUNTS} fixed ones required`);
  }
  const at = (index: number): string => instruction.accounts[index]?.pubkey as string;
  const override = at(ROUTE_V2_ACCOUNTS.destinationTokenAccountOverride);
  return {
    userTransferAuthority: at(ROUTE_V2_ACCOUNTS.userTransferAuthority),
    userSourceTokenAccount: at(ROUTE_V2_ACCOUNTS.userSourceTokenAccount),
    userDestinationTokenAccount: at(ROUTE_V2_ACCOUNTS.userDestinationTokenAccount),
    sourceMint: at(ROUTE_V2_ACCOUNTS.sourceMint),
    destinationMint: at(ROUTE_V2_ACCOUNTS.destinationMint),
    sourceTokenProgram: at(ROUTE_V2_ACCOUNTS.sourceTokenProgram),
    destinationTokenProgram: at(ROUTE_V2_ACCOUNTS.destinationTokenProgram),
    destinationTokenAccountOverride: override === JUPITER_V6_PROGRAM_ID ? null : override,
    inAmount: data.readBigUInt64LE(8),
    quotedOutAmount: data.readBigUInt64LE(16),
    slippageBps: data.readUInt16LE(24),
    platformFeeBps: data.readUInt16LE(26),
    positiveSlippageBps: data.readUInt16LE(28),
    routePlanSteps: data.readUInt32LE(30),
    routePlanTailHex: data.subarray(ROUTE_V2_PREFIX_LEN).toString("hex"),
    venueAccountCount: instruction.accounts.length - ROUTE_V2_FIXED_ACCOUNTS,
  };
}

/**
 * Jupiter's own minimum-output rule, reproduced from the two encoded fields.
 * Matched `otherAmountThreshold` in every observed build; the on-chain
 * rounding is Jupiter's, not something this repository has verified.
 */
export function minimumOutFromQuote(quotedOutAmount: bigint, slippageBps: number): bigint {
  const numerator = quotedOutAmount * BigInt(10_000 - slippageBps);
  return numerator % 10_000n === 0n ? numerator / 10_000n : numerator / 10_000n + 1n;
}

export type TradeDirection = "BUY" | "SELL";

/** What a protected plan would declare, and an adapter would enforce. */
export interface ProtectedTrade {
  readonly protectedMint: string;
  readonly direction: TradeDirection;
  readonly counterMint: string;
  readonly userAuthority: string;
  readonly userDestinationTokenAccount: string;
  readonly inAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly slippageBps: number;
}

export type SemanticFailure =
  | "PROGRAM_NOT_JUPITER"
  | "UNSUPPORTED_JUPITER_INSTRUCTION"
  | "PROTECTED_MINT_NOT_IN_EXPECTED_ROLE"
  | "COUNTER_MINT_MISMATCH"
  | "AUTHORITY_MISMATCH"
  | "AUTHORITY_NOT_SIGNER"
  | "DESTINATION_MISMATCH"
  | "DESTINATION_OVERRIDDEN"
  | "IN_AMOUNT_MISMATCH"
  | "QUOTED_OUT_MISMATCH"
  | "SLIPPAGE_MISMATCH"
  | "PLATFORM_FEE_PRESENT";

/**
 * The semantic binding an adapter must add on top of the identity commitment:
 * this exact instruction is a Jupiter trade of the protected mint, in the
 * declared role, for the declared user, amount and threshold.
 */
export function checkSemanticBinding(instruction: InstructionLike, expected: ProtectedTrade): readonly SemanticFailure[] {
  const failures: SemanticFailure[] = [];
  let route: RouteV2;
  try {
    route = decodeRouteV2(instruction);
  } catch (error) {
    return [(error as RouteV2DecodeError).code === "WRONG_PROGRAM" ? "PROGRAM_NOT_JUPITER" : "UNSUPPORTED_JUPITER_INSTRUCTION"];
  }
  const [protectedSide, counterSide] =
    expected.direction === "BUY"
      ? ([route.destinationMint, route.sourceMint] as const)
      : ([route.sourceMint, route.destinationMint] as const);
  if (protectedSide !== expected.protectedMint) failures.push("PROTECTED_MINT_NOT_IN_EXPECTED_ROLE");
  if (counterSide !== expected.counterMint) failures.push("COUNTER_MINT_MISMATCH");
  if (route.userTransferAuthority !== expected.userAuthority) failures.push("AUTHORITY_MISMATCH");
  if (!instruction.accounts[ROUTE_V2_ACCOUNTS.userTransferAuthority]?.isSigner) failures.push("AUTHORITY_NOT_SIGNER");
  if (route.userDestinationTokenAccount !== expected.userDestinationTokenAccount) failures.push("DESTINATION_MISMATCH");
  if (route.destinationTokenAccountOverride !== null) failures.push("DESTINATION_OVERRIDDEN");
  if (route.inAmount !== expected.inAmount) failures.push("IN_AMOUNT_MISMATCH");
  if (route.quotedOutAmount !== expected.quotedOutAmount) failures.push("QUOTED_OUT_MISMATCH");
  if (route.slippageBps !== expected.slippageBps) failures.push("SLIPPAGE_MISMATCH");
  if (route.platformFeeBps !== 0) failures.push("PLATFORM_FEE_PRESENT");
  return failures;
}
