/**
 * The same swap, twice: once as an ordinary Jupiter integration, once with
 * EquityGuard added. The difference between the two functions is the whole
 * integration.
 *
 * Neither function signs or submits anything itself: both hand an unsigned
 * transaction to the application's existing wallet.
 */

import type { GetGenesisHashApi, GetMultipleAccountsApi, Rpc } from "@solana/kit";
import { protectJupiterSwap, type ProtectionWindow } from "@equityguard/jupiter/protect";

import { buildJupiterSwap, compileUnsignedTransaction, jupiterInstructions, type SwapRequest } from "./jupiter.ts";
import type { Wallet } from "./wallet.ts";

export interface SwapOutcome {
  /** What the application did, or refused to do. */
  readonly action: "SENT_UNPROTECTED" | "SENT_PROTECTED" | "REFUSED";
  readonly detail: string;
  readonly signature: string | null;
}

// ---------------------------------------------------------------- BEFORE

/** An ordinary Jupiter integration: build, compile, sign, send. */
export async function ordinarySwap(request: SwapRequest, wallet: Wallet, apiKey: string): Promise<SwapOutcome> {
  const build = await buildJupiterSwap(request, apiKey);
  const transaction = compileUnsignedTransaction(build, wallet.publicKey, jupiterInstructions(build));
  const signature = await wallet.signAndSend(transaction);
  return { action: "SENT_UNPROTECTED", detail: "Jupiter swap", signature };
}

// ----------------------------------------------------------------- AFTER

export interface ProtectedSwapConfig {
  readonly apiKey: string;
  readonly rpc: Rpc<GetMultipleAccountsApi & GetGenesisHashApi>;
  /** How close to a scheduled corporate action this application refuses to trade. */
  readonly protectionWindow: ProtectionWindow;
}

/**
 * The same flow with EquityGuard. Six added lines carry the whole integration:
 * the import, the `protectJupiterSwap` call, and the three-way decision on
 * its result.
 *
 * The refusal branch is the point of the product. An unsupported route or
 * unreadable state must NOT fall through to `ordinarySwap`: a protected asset
 * that cannot be protected is not traded.
 */
export async function protectedSwap(request: SwapRequest, wallet: Wallet, config: ProtectedSwapConfig): Promise<SwapOutcome> {
  const build = await buildJupiterSwap(request, config.apiKey);

  const guarded = await protectJupiterSwap({
    build,
    userPublicKey: wallet.publicKey,
    rpc: config.rpc,
    protectionWindow: config.protectionWindow,
  });

  if (guarded.status === "PROTECTED") {
    const signature = await wallet.signAndSend(guarded.transaction);
    return { action: "SENT_PROTECTED", detail: `EquityGuard ${guarded.direction} of ${guarded.protectedMint}`, signature };
  }
  if (guarded.status === "NOT_APPLICABLE") {
    // No protected asset is involved: the application's existing path is correct.
    const transaction = compileUnsignedTransaction(build, wallet.publicKey, jupiterInstructions(build));
    const signature = await wallet.signAndSend(transaction);
    return { action: "SENT_UNPROTECTED", detail: guarded.reason, signature };
  }
  return { action: "REFUSED", detail: `${guarded.code}: ${guarded.message}`, signature: null };
}
