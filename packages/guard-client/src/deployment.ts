/**
 * Which EquityGuard deployment, if any, is appropriate for the cluster a
 * caller is actually talking to.
 *
 * A guard instruction that names a program the target cluster does not run is
 * not protection: it is bytes. The transaction would fail at load time, which
 * is safe, but a client must not call it PROTECTED. This module answers "is
 * there a deployment here?" so the integration surface can fail closed before
 * it builds anything.
 *
 * There is exactly one deployment, on devnet. No mainnet deployment exists,
 * and none is invented here.
 */

import type { Address } from "@solana/kit";

import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "./program-id.ts";

/** Genesis hashes of the public Solana clusters. */
export const SOLANA_GENESIS_HASH = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

/**
 * `unknown` covers local validators and any cluster whose genesis hash is not
 * one of the three public ones. It is never treated as a deployment.
 */
export type SolanaCluster = keyof typeof SOLANA_GENESIS_HASH | "unknown";

export function clusterFromGenesisHash(genesisHash: string): SolanaCluster {
  const match = Object.entries(SOLANA_GENESIS_HASH).find(([, hash]) => hash === genesisHash);
  return (match?.[0] as SolanaCluster | undefined) ?? "unknown";
}

/**
 * The reviewed EquityGuard deployment for a cluster, or `null` when this
 * project has none there. `null` is a refusal, never a reason to fall back to
 * another cluster's program.
 */
export function deploymentForCluster(cluster: SolanaCluster): Address | null {
  return cluster === "devnet" ? EQUITY_GUARD_DEVNET_PROGRAM_ID : null;
}

/** Enough of an account to decide whether a program can execute. */
export interface ProgramAccountView {
  readonly executable: boolean;
  readonly owner: string;
}

export type GuardProgramCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "MISSING" | "NOT_EXECUTABLE"; readonly message: string };

/**
 * Whether `account` — the program account read from the target cluster — can
 * actually execute the guard. This is an availability check, not an identity
 * check: it does not prove the deployed binary is the reviewed one. Callers
 * that need that compare the ProgramData SHA-256, as
 * `scripts/replay/execute-replay.ts` does before a local replay.
 */
export function checkGuardProgramAccount(programAddress: Address, account: ProgramAccountView | null): GuardProgramCheck {
  if (!account) {
    return { ok: false, reason: "MISSING", message: `no account exists at ${programAddress} on this cluster` };
  }
  if (!account.executable) {
    return { ok: false, reason: "NOT_EXECUTABLE", message: `${programAddress} exists but is not executable (owner ${account.owner})` };
  }
  return { ok: true };
}
