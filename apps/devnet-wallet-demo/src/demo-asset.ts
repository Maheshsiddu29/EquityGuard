/**
 * Self-contained ephemeral Token-2022 demo mint. The connected wallet creates
 * a fresh ScaledUiAmount mint where it is both payer and mint/multiplier
 * authority. No committed secret, no pre-existing authority, no faucet server.
 *
 * The ephemeral keypair is used ONLY as the mint account signer during
 * creation. It is never:
 * - used as the user's wallet
 * - persisted to any storage
 * - logged or committed
 * - stored in localStorage/sessionStorage
 *
 * After mint creation, the keypair reference is cleared.
 */

import {
  generateKeyPairSigner,
  getAddressEncoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getMintSize,
  getMintToInstruction,
  getTransferCheckedInstruction,
  extension,
} from "@solana-program/token-2022";
import { getCreateAccountInstruction } from "@solana-program/system";

export const DEMO_MINT_DECIMALS = 6;
export const DEMO_INITIAL_MULTIPLIER = 1.0;
/** Amount to mint to the wallet's ATA (in base units, 1_000_000 = 1.0 token). */
export const DEMO_MINT_AMOUNT = 1_000_000n;
/** Amount for each test transfer. */
export const DEMO_TRANSFER_AMOUNT = 1_000n;

export interface DemoAssetSetup {
  /** The new mint address (public key only — ephemeral keypair is cleared). */
  readonly mintAddress: Address;
  /** Source ATA owned by the wallet. */
  readonly sourceAta: Address;
  /** Destination ATA for a throwaway recipient. */
  readonly destinationAta: Address;
  /** Throwaway recipient public key (for destination ATA derivation only). */
  readonly recipientAddress: Address;
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
 * @param mintSigner Ephemeral keypair signer for the mint account
 * @param rentLamports Rent-exempt balance for the mint account
 */
export function getCreateDemoMintInstructions(input: {
  readonly payer: TransactionSigner;
  readonly mintSigner: TransactionSigner;
  readonly rentLamports: bigint;
}): Instruction[] {
  const { payer, mintSigner } = input;
  return [
    getCreateAccountInstruction({
      payer,
      newAccount: mintSigner,
      lamports: input.rentLamports,
      space: demoMintSpace(payer.address),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeScaledUiAmountMintInstruction({
      mint: mintSigner.address,
      authority: payer.address,
      multiplier: DEMO_INITIAL_MULTIPLIER,
    }),
    getInitializeMint2Instruction({
      mint: mintSigner.address,
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
