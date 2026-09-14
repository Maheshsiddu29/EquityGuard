/**
 * SYNTHETIC `/build`-shaped data for unit tests of parsing, ordering and
 * binding logic. It is not a Jupiter response and carries no route or quote
 * meaning; real-response tests use the recorded fixtures instead.
 */

import { getBase58Decoder, type Address } from "@solana/kit";

import type { ApiInstruction } from "../src/index.ts";

/** Deterministic distinct address derived from a seed byte. */
export function syntheticAddress(seed: number): Address {
  const bytes = new Uint8Array(32).fill(seed);
  bytes[0] = 1; // keep it off the all-zero system program address
  return getBase58Decoder().decode(bytes) as Address;
}

export const TAKER = syntheticAddress(10);
export const INPUT_MINT = syntheticAddress(11);
export const OUTPUT_MINT = syntheticAddress(12);
const SWAP_PROGRAM = syntheticAddress(20);
const ALT = syntheticAddress(30);
const POOL_ACCOUNTS = [40, 41, 42, 43, 44, 45].map(syntheticAddress);

function ix(programId: Address, accounts: ApiInstruction["accounts"], data: number[]): ApiInstruction {
  return { programId, accounts, data: Buffer.from(data).toString("base64") };
}

export function syntheticBuild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    inAmount: "5000000",
    outAmount: "123",
    otherAmountThreshold: "122",
    swapMode: "ExactIn",
    slippageBps: 50,
    routePlan: [
      {
        percent: 100,
        bps: 10000,
        swapInfo: {
          ammKey: POOL_ACCOUNTS[0],
          label: "SyntheticDex",
          inputMint: INPUT_MINT,
          outputMint: OUTPUT_MINT,
          inAmount: "5000000",
          outAmount: "123",
        },
      },
    ],
    computeBudgetInstructions: [ix("ComputeBudget111111111111111111111111111111" as Address, [], [3, 1, 0, 0, 0, 0, 0, 0, 0])],
    setupInstructions: [ix(syntheticAddress(21), [{ pubkey: TAKER, isSigner: true, isWritable: true }], [1])],
    swapInstruction: ix(
      SWAP_PROGRAM,
      [
        { pubkey: TAKER, isSigner: true, isWritable: false },
        ...POOL_ACCOUNTS.map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i % 2 === 0 })),
      ],
      [9, 9, 9],
    ),
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: { [ALT]: POOL_ACCOUNTS },
    blockhashWithMetadata: { blockhash: Array.from({ length: 32 }, (_, i) => i + 1), lastValidBlockHeight: 1000 },
    ...overrides,
  };
}

export { POOL_ACCOUNTS, SWAP_PROGRAM };
