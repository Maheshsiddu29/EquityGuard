/**
 * Instruction builders for DEVNET Token-2022 test mints that reproduce the
 * ScaledUiAmount primitive EquityGuard protects. Builders are pure so their
 * validation is testable without a cluster.
 */

import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getMintSize,
  getMintToInstruction,
  getUpdateMultiplierScaledUiMintInstruction,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";

/** Mint extensions the tooling can request. ScaledUiAmount is always present. */
export type TestMintExtraExtension = "InterestBearingConfig";

export interface TestMintSpec {
  /** Demo label, e.g. `EQ-A`. Not written on-chain. */
  readonly label: string;
  readonly decimals: number;
  readonly initialMultiplier: number;
  readonly extraExtensions?: readonly TestMintExtraExtension[];
}

/** Thrown before any transaction is built for a forbidden extension set. */
export class InvalidTestMintExtensionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTestMintExtensionsError";
  }
}

/**
 * Rejects extension sets Token-2022 forbids on a ScaledUiAmount mint.
 * Token-2022 would also fail at initialization, but only with a generic
 * `InvalidExtensionCombination` after fees; this fails early and explains why.
 */
export function assertValidTestMintExtensions(spec: TestMintSpec): void {
  if (spec.extraExtensions?.includes("InterestBearingConfig")) {
    throw new InvalidTestMintExtensionsError(
      `${spec.label}: ScaledUiAmount cannot be combined with InterestBearingConfig. ` +
        "Both rescale UI amounts, so Token-2022 forbids the pair and EquityGuard would " +
        "not protect interest accrual.",
    );
  }
  if (!Number.isFinite(spec.initialMultiplier) || spec.initialMultiplier <= 0) {
    throw new InvalidTestMintExtensionsError(`${spec.label}: initial multiplier must be positive and finite`);
  }
}

/** Account size for the requested mint. */
export function testMintSpace(spec: TestMintSpec, authority: Address): number {
  assertValidTestMintExtensions(spec);
  return getMintSize([
    extension("ScaledUiAmountConfig", {
      authority,
      multiplier: spec.initialMultiplier,
      newMultiplierEffectiveTimestamp: 0n,
      newMultiplier: spec.initialMultiplier,
    }),
  ]);
}

/**
 * Instructions creating and initializing a ScaledUiAmount mint. The payer is
 * both mint authority and multiplier authority; no freeze authority.
 */
export function getCreateTestMintInstructions(input: {
  readonly spec: TestMintSpec;
  readonly payer: TransactionSigner;
  readonly mint: TransactionSigner;
  readonly rentLamports: bigint;
}): Instruction[] {
  const { spec, payer, mint } = input;
  assertValidTestMintExtensions(spec);
  return [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: input.rentLamports,
      space: testMintSpace(spec, payer.address),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeScaledUiAmountMintInstruction({
      mint: mint.address,
      authority: payer.address,
      multiplier: spec.initialMultiplier,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals: spec.decimals,
      mintAuthority: payer.address,
    }),
  ];
}

/**
 * Schedules `newMultiplier` at chain time `effectiveTimestamp`. A timestamp at
 * or before the current chain time applies it immediately (Token-2022 then
 * rewrites `multiplier` as well).
 */
export function getScheduleMultiplierInstruction(input: {
  readonly mint: Address;
  readonly authority: TransactionSigner;
  readonly newMultiplier: number;
  readonly effectiveTimestamp: bigint;
}): Instruction {
  return getUpdateMultiplierScaledUiMintInstruction({
    mint: input.mint,
    authority: input.authority,
    multiplier: input.newMultiplier,
    effectiveTimestamp: input.effectiveTimestamp,
  });
}

/** Instructions giving `owner` a small test balance in its associated token account. */
export async function getMintTestBalanceInstructions(input: {
  readonly payer: TransactionSigner;
  readonly mint: Address;
  readonly owner: Address;
  readonly amount: bigint;
}): Promise<Instruction[]> {
  const [token] = await findAssociatedTokenPda({
    owner: input.owner,
    mint: input.mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.payer,
      owner: input.owner,
      mint: input.mint,
    }),
    getMintToInstruction({ mint: input.mint, token, mintAuthority: input.payer, amount: input.amount }),
  ];
}
