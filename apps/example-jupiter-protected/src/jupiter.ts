/**
 * ORDINARY JUPITER CODE. Nothing here is EquityGuard-specific.
 *
 * A minimal version of what an application that already integrates Jupiter
 * Swap V2 `/build` does today: ask Jupiter for the instructions, then compile
 * them into an unsigned v0 transaction using Jupiter's address lookup tables.
 */

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { fetchBuild, toKitInstruction, type BuildResponse } from "@equityguard/jupiter";

export interface SwapRequest {
  readonly inputMint: Address;
  readonly outputMint: Address;
  /** Smallest units of the input token. */
  readonly amount: bigint;
  readonly taker: Address;
  readonly slippageBps: number;
}

/** Jupiter's `/build` response for this swap. */
export function buildJupiterSwap(request: SwapRequest, apiKey: string): Promise<BuildResponse> {
  return fetchBuild(
    {
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      taker: request.taker,
      slippageBps: request.slippageBps,
    },
    { apiKey },
  );
}

/** Jupiter's instructions, in the order Jupiter returns them. */
export function jupiterInstructions(build: BuildResponse): Instruction[] {
  return [
    ...build.computeBudgetInstructions.map(toKitInstruction),
    ...build.setupInstructions.map(toKitInstruction),
    toKitInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toKitInstruction(build.cleanupInstruction)] : []),
  ];
}

/** Compiles instructions into an unsigned v0 transaction, using Jupiter's lookup tables. */
export function compileUnsignedTransaction(build: BuildResponse, feePayer: Address, instructions: readonly Instruction[]): Uint8Array {
  const tables: AddressesByLookupTableAddress = {};
  for (const [table, addresses] of Object.entries(build.addressesByLookupTableAddress)) {
    tables[address(table)] = addresses.map((entry) => address(entry));
  }
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
    tables,
  );
  return Uint8Array.from(getTransactionEncoder().encode(compileTransaction(message)));
}
