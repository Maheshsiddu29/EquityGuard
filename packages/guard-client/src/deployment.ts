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

import { createHash } from "node:crypto";

import { getAddressDecoder, type Address } from "@solana/kit";

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

/**
 * A deployment whose deployed bytes were reviewed: the program account, the
 * ProgramData account the upgradeable loader pairs it with, and the exact ELF
 * it must hold. The ELF length comes from the reviewed artifact and is never
 * inferred from the account (trailing zeros are not a length).
 */
export interface ReviewedGuardDeployment {
  readonly cluster: SolanaCluster;
  readonly programAddress: Address;
  readonly programDataAddress: Address;
  readonly elfLength: number;
  /** Lowercase hex SHA-256 of exactly `elfLength` bytes at ProgramData offset 45. */
  readonly elfSha256: string;
}

export const BPF_LOADER_UPGRADEABLE_ADDRESS = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;

/**
 * Every reviewed deployment. One exists: the devnet upgrade of 2026-09-17
 * (`docs/m9d-b2-devnet-deployment.md`, `scripts/devnet/devnet.json`), whose
 * first 63,840 ProgramData ELF bytes hash to the reviewed `cargo build-sbf`
 * artifact. There is no mainnet entry, and none may be added without a
 * reviewed mainnet deployment.
 */
export const REVIEWED_GUARD_DEPLOYMENTS: readonly ReviewedGuardDeployment[] = Object.freeze([
  Object.freeze({
    cluster: "devnet",
    programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    programDataAddress: "4Zc4TAEYNSXCGUkpD7y7CcEWDS8a9aQBDfYHFu55dPE3" as Address,
    elfLength: 63_840,
    elfSha256: "d7d59ccd9e96bb3eb3e16893aca638d8e5fdbfaf5032b4b39737ef16a41e4e46",
  } as const),
]);

/** The reviewed deployment at `programAddress`, on whichever cluster serves it. */
export function findReviewedGuardDeployment(programAddress: Address | string): ReviewedGuardDeployment | null {
  return REVIEWED_GUARD_DEPLOYMENTS.find((deployment) => deployment.programAddress === programAddress) ?? null;
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
 * check: it does not prove the deployed binary is the reviewed one. For a
 * reviewed deployment, {@link verifyReviewedGuardDeployment} does.
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

/** A loader-owned account as the RPC returns it. */
export interface LoaderAccountView extends ProgramAccountView {
  readonly data: Uint8Array;
}

export type GuardIdentityCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "MISSING" | "NOT_EXECUTABLE" | "UNEXPECTED_LOADER" | "PROGRAM_DATA_MISMATCH" | "BINARY_MISMATCH";
      readonly message: string;
    };

/** `UpgradeableLoaderState` bincode tags and layouts. */
const LOADER_STATE_PROGRAM = 2;
const LOADER_STATE_PROGRAM_DATA = 3;
/** Tag (u32) and the ProgramData address. */
const PROGRAM_ACCOUNT_LEN = 36;
/** Tag (u32), deployment slot (u64), `Option<Pubkey>` upgrade authority (1 + 32). */
const PROGRAMDATA_HEADER_LEN = 45;

const u32At = (data: Uint8Array, offset: number) => (data.length >= offset + 4 ? new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true) : null);

/**
 * Whether the accounts at a reviewed deployment hold exactly the reviewed
 * program: an executable upgradeable-loader Program account pointing at the
 * recorded ProgramData account, which holds the reviewed ELF bytes at offset
 * 45 followed only by zeros. Read both accounts in one RPC call so they come
 * from one slot.
 *
 * This proves what the cluster held when it was read. It does not bind the
 * transaction to that binary: an upgrade after the read changes what executes
 * (`docs/m11a-security-review.md`).
 */
export function verifyReviewedGuardDeployment(
  deployment: ReviewedGuardDeployment,
  program: LoaderAccountView | null,
  programData: LoaderAccountView | null,
): GuardIdentityCheck {
  if (!program?.executable) return checkGuardProgramAccount(deployment.programAddress, program);
  const at = deployment.programAddress;
  if (program.owner !== BPF_LOADER_UPGRADEABLE_ADDRESS || program.data.length !== PROGRAM_ACCOUNT_LEN || u32At(program.data, 0) !== LOADER_STATE_PROGRAM) {
    return { ok: false, reason: "UNEXPECTED_LOADER", message: `${at} is not an upgradeable-loader Program account (owner ${program.owner})` };
  }
  const pointer = getAddressDecoder().decode(program.data.subarray(4, PROGRAM_ACCOUNT_LEN));
  if (pointer !== deployment.programDataAddress) {
    return { ok: false, reason: "PROGRAM_DATA_MISMATCH", message: `${at} points at ProgramData ${pointer}, not the reviewed ${deployment.programDataAddress}` };
  }
  const end = PROGRAMDATA_HEADER_LEN + deployment.elfLength;
  if (!programData || programData.owner !== BPF_LOADER_UPGRADEABLE_ADDRESS || u32At(programData.data, 0) !== LOADER_STATE_PROGRAM_DATA || programData.data.length < end) {
    return { ok: false, reason: "PROGRAM_DATA_MISMATCH", message: `ProgramData ${deployment.programDataAddress} is missing, not loader-owned ProgramData, or shorter than the reviewed ELF` };
  }
  const sha256 = createHash("sha256").update(programData.data.subarray(PROGRAMDATA_HEADER_LEN, end)).digest("hex");
  if (sha256 !== deployment.elfSha256) {
    return { ok: false, reason: "BINARY_MISMATCH", message: `${at} holds ELF ${sha256}, not the reviewed ${deployment.elfSha256}` };
  }
  if (programData.data.subarray(end).some((byte) => byte !== 0)) {
    return { ok: false, reason: "BINARY_MISMATCH", message: `ProgramData ${deployment.programDataAddress} carries non-zero bytes beyond the reviewed ${deployment.elfLength}-byte ELF` };
  }
  return { ok: true };
}
