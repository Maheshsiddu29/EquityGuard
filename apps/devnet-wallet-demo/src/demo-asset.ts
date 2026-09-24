/**
 * Self-contained ephemeral Token-2022 demo mint. The connected wallet creates
 * a fresh ScaledUiAmount mint where it is both payer and mint/multiplier
 * authority. No committed secret, no pre-existing authority, no faucet server.
 *
 * The mint address is derived from the connected wallet plus a fresh random
 * seed. This lets Phantom remain the transaction's only signer. The seed is
 * used only to derive and create the mint account; it is not an authority or
 * secret and is never persisted.
 */

import { type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { bytesEqual, decodeMintMetadata, decodeProtectedState } from "@equityguard/guard-client";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getMintSize,
  getMintToInstruction,
  getTransferCheckedInstruction,
  getUpdateMultiplierScaledUiMintInstruction,
  extension,
} from "@solana-program/token-2022";
import { getCreateAccountWithSeedInstruction } from "@solana-program/system";
import { storedMultiplier, type EquityScenario } from "./scenarios.ts";

export const DEMO_MINT_DECIMALS = 6;
export const DEMO_INITIAL_MULTIPLIER = 1.0;
/** Amount to mint to the wallet's ATA (in base units, 1_000_000 = 1.0 token). */
export const DEMO_MINT_AMOUNT = 1_000_000n;
/** Amount for each test transfer. */
export const DEMO_TRANSFER_AMOUNT = 100_000n;

export interface DemoAssetSetup {
  /** The new mint address derived from the connected wallet and random seed. */
  readonly mintAddress: Address;
  /** Source ATA owned by the wallet. */
  readonly sourceAta: Address;
  /** Destination ATA for a throwaway recipient. */
  readonly destinationAta: Address;
  /** Throwaway recipient public key (for destination ATA derivation only). */
  readonly recipientAddress: Address;
}

const EXPECTED_MULTIPLIER = (() => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, DEMO_INITIAL_MULTIPLIER, true);
  return bytes;
})();

export function verifyDemoMintAccount(owner: string, data: Uint8Array): void {
  const protectedState = decodeProtectedState(owner, data);
  const metadata = decodeMintMetadata(owner, data);
  if (metadata.decimals !== DEMO_MINT_DECIMALS) throw new Error(`Demo mint decimals were ${metadata.decimals}, expected ${DEMO_MINT_DECIMALS}`);
  if (!bytesEqual(protectedState.multiplier, EXPECTED_MULTIPLIER) || !bytesEqual(protectedState.newMultiplier, EXPECTED_MULTIPLIER)) {
    throw new Error("Demo mint ScaledUiAmount multiplier did not match the expected state");
  }
  if (protectedState.newMultiplierEffectiveTimestamp !== 0n) throw new Error("Demo mint ScaledUiAmount activation timestamp was not zero");
}

/**
 * Confirms the session mint is still the selected template's pending
 * schedule: current multiplier unchanged, target multiplier stored, and the
 * activation timestamp exactly the one this attempt armed.
 */
export function verifyScheduledDemoMint(
  owner: string,
  data: Uint8Array,
  scenario: EquityScenario,
  effectiveTimestamp: bigint,
): void {
  const protectedState = decodeProtectedState(owner, data);
  const metadata = decodeMintMetadata(owner, data);
  if (metadata.decimals !== DEMO_MINT_DECIMALS) throw new Error(`Demo mint decimals were ${metadata.decimals}, expected ${DEMO_MINT_DECIMALS}`);
  if (!bytesEqual(protectedState.multiplier, storedMultiplier(scenario.initialMultiplier))) {
    throw new Error("Demo mint current multiplier does not match the selected scenario");
  }
  if (!bytesEqual(protectedState.newMultiplier, storedMultiplier(scenario.newMultiplier))) {
    throw new Error("Demo mint scheduled multiplier does not match the selected scenario");
  }
  if (protectedState.newMultiplierEffectiveTimestamp !== effectiveTimestamp) {
    throw new Error("Demo mint activation timestamp does not match this attempt");
  }
}

export function verifyDemoTokenAccountOwners(sourceOwner: string, destinationOwner: string): void {
  if (sourceOwner !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error("Source ATA owner is not Token-2022");
  if (destinationOwner !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error("Destination ATA owner is not Token-2022");
}

/**
 * Computes the rent-exempt account size for a Token-2022 mint with the
 * ScaledUiAmount extension.
 */
export function demoMintSpace(authority: Address): number {
  return getMintSize([
    extension("ScaledUiAmountConfig", {
      authority,
      multiplier: DEMO_INITIAL_MULTIPLIER,
      newMultiplierEffectiveTimestamp: 0n,
      newMultiplier: DEMO_INITIAL_MULTIPLIER,
    }),
  ]);
}

/**
 * Instructions to create a new Token-2022 mint with ScaledUiAmount.
 * The payer is both mint authority and multiplier authority.
 *
 * @param payer Wallet signer (payer + authority)
 * @param mintAddress Address derived from the connected wallet and seed
 * @param rentLamports Rent-exempt balance for the mint account
 */
export function getCreateDemoMintInstructions(input: {
  readonly payer: TransactionSigner;
  readonly mintAddress: Address;
  readonly seed: string;
  readonly rentLamports: bigint;
}): Instruction[] {
  const { payer, mintAddress } = input;
  return [
    getCreateAccountWithSeedInstruction({
      payer,
      newAccount: mintAddress,
      base: payer.address,
      baseAccount: payer,
      seed: input.seed,
      amount: input.rentLamports,
      space: demoMintSpace(payer.address),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeScaledUiAmountMintInstruction({
      mint: mintAddress,
      authority: payer.address,
      multiplier: DEMO_INITIAL_MULTIPLIER,
    }),
    getInitializeMint2Instruction({
      mint: mintAddress,
      decimals: DEMO_MINT_DECIMALS,
      mintAuthority: payer.address,
    }),
  ];
}

/**
 * Instructions to create an ATA and mint demo tokens to it.
 */
export async function getMintToWalletInstructions(input: {
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
    getMintToInstruction({
      mint: input.mint,
      token,
      mintAuthority: input.payer,
      amount: input.amount,
    }),
  ];
}

/**
 * Creates a destination ATA for a throwaway recipient.
 */
export async function getCreateDestinationAtaInstruction(input: {
  readonly payer: TransactionSigner;
  readonly mint: Address;
  readonly recipient: Address;
}): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: input.payer,
    owner: input.recipient,
    mint: input.mint,
  });
}

/**
 * Schedules `newMultiplier` at a chain timestamp that is still in the future.
 *
 * Token-2022 applies the new multiplier immediately when the timestamp is at
 * or before the Clock in the same instruction. A later timestamp keeps the
 * initialized multiplier and writes only the scheduled multiplier and `T`.
 * The mint must already be initialized earlier in the same transaction:
 * `UpdateMultiplier` unpacks an initialized mint.
 */
export function getArmCorporateActionInstruction(input: {
  readonly mint: Address;
  readonly authority: TransactionSigner;
  readonly newMultiplier: number;
  readonly effectiveTimestamp: bigint;
  readonly chainUnixTimestamp: bigint;
}): Instruction {
  if (input.effectiveTimestamp <= input.chainUnixTimestamp) {
    throw new Error("Activation timestamp must be after the chain clock");
  }
  if (!Number.isFinite(input.newMultiplier) || input.newMultiplier <= 0) {
    throw new Error("Scheduled multiplier must be a positive finite number");
  }
  return getUpdateMultiplierScaledUiMintInstruction({
    mint: input.mint,
    authority: input.authority,
    multiplier: input.newMultiplier,
    effectiveTimestamp: input.effectiveTimestamp,
  });
}

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

/** Stable labels for the combined setup transaction, in execution order. */
export function classifyPrepareInstruction(instruction: Instruction): string {
  if (instruction.programAddress === SYSTEM_PROGRAM_ADDRESS) return "create-mint";
  const data = instruction.data;
  if (instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS && data instanceof Uint8Array) {
    if (data[0] === 20) return "initialize-mint";
    if (data[0] === 7) return "mint-to";
    if (data[0] === 43 && data[1] === 0) return "initialize-scaled-ui";
    if (data[0] === 43 && data[1] === 1) return "schedule-multiplier";
  }
  return "create-ata";
}

/**
 * One Phantom signature creates the session mint, its token accounts, the
 * demo balance, and the future corporate-action timestamp.
 */
export async function getPrepareSessionInstructions(input: {
  readonly payer: TransactionSigner;
  readonly mintAddress: Address;
  readonly seed: string;
  readonly rentLamports: bigint;
  readonly recipient: Address;
  readonly scenario: EquityScenario;
  readonly effectiveTimestamp: bigint;
  readonly chainUnixTimestamp: bigint;
}): Promise<Instruction[]> {
  if (input.scenario.initialMultiplier !== DEMO_INITIAL_MULTIPLIER) {
    throw new Error("Session mint must start at the demo multiplier");
  }
  return [
    ...getCreateDemoMintInstructions({
      payer: input.payer,
      mintAddress: input.mintAddress,
      seed: input.seed,
      rentLamports: input.rentLamports,
    }),
    getArmCorporateActionInstruction({
      mint: input.mintAddress,
      authority: input.payer,
      newMultiplier: input.scenario.newMultiplier,
      effectiveTimestamp: input.effectiveTimestamp,
      chainUnixTimestamp: input.chainUnixTimestamp,
    }),
    ...await getMintToWalletInstructions({
      payer: input.payer,
      mint: input.mintAddress,
      owner: input.payer.address,
      amount: DEMO_MINT_AMOUNT,
    }),
    await getCreateDestinationAtaInstruction({
      payer: input.payer,
      mint: input.mintAddress,
      recipient: input.recipient,
    }),
  ];
}

/**
 * Derives the ATA address for an owner and mint (Token-2022).
 */
export async function deriveAta(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  return ata;
}

/**
 * Builds a standard Token-2022 TransferChecked instruction.
 */
export function buildTransferCheckedInstruction(input: {
  readonly source: Address;
  readonly mint: Address;
  readonly destination: Address;
  readonly authority: TransactionSigner;
  readonly amount: bigint;
  readonly decimals: number;
}): Instruction {
  return getTransferCheckedInstruction({
    source: input.source,
    mint: input.mint,
    destination: input.destination,
    authority: input.authority,
    amount: input.amount,
    decimals: input.decimals,
  });
}
