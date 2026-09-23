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
  | { readonly ok: true; readonly attestation: GuardDeploymentAttestation }
  | {
      readonly ok: false;
      readonly reason: "MISSING" | "NOT_EXECUTABLE" | "UNEXPECTED_LOADER" | "PROGRAM_DATA_MISMATCH" | "BINARY_MISMATCH" | "MALFORMED_PROGRAM_DATA";
      readonly message: string;
    };

/** `UpgradeableLoaderState` bincode tags and layouts. */
const LOADER_STATE_PROGRAM = 2;
const LOADER_STATE_PROGRAM_DATA = 3;
/** Tag (u32) and the ProgramData address. */
const PROGRAM_ACCOUNT_LEN = 36;
/**
 * `UpgradeableLoaderState::ProgramData` header, in bincode order:
 * tag (`u32`), `slot` (`u64`), `Option<Pubkey>` upgrade authority
 * (`u8` discriminant, then 32 bytes when `Some`).
 *
 * No canonical Solana deserializer for this state ships with the dependency
 * set (`@solana/kit` has no loader-v3 codec and the repository adds no
 * dependency for one), so the layout is spelled out here as named offsets and
 * pinned by `deployment.test.ts` rather than left as bare literals.
 */
const PROGRAMDATA_SLOT_OFFSET = 4;
const PROGRAMDATA_AUTHORITY_OPTION_OFFSET = 12;
const PROGRAMDATA_AUTHORITY_OFFSET = 13;
const PROGRAMDATA_HEADER_LEN = 45;
/** Bincode encodes `Option` as a single 0 (`None`) or 1 (`Some`) byte. */
const OPTION_NONE = 0;
const OPTION_SOME = 1;
/**
 * The all-zero pubkey, which is also the System Program address. No signer
 * exists for it, so an upgrade authority set to it can never authorize an
 * upgrade. `solana-test-validator --upgradeable-program <id> <so> none`
 * produces exactly this, rather than the canonical `Option::None`.
 */
const ZERO_AUTHORITY = "11111111111111111111111111111111";

const u32At = (data: Uint8Array, offset: number) => (data.length >= offset + 4 ? new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true) : null);

/**
 * Whether a deployment can still be replaced.
 *
 * - `IMMUTABLE`: ProgramData holds `None` for the upgrade authority. The
 *   executing bytes can never change. This is what
 *   `solana program set-upgrade-authority --final` produces.
 * - `NO_USABLE_AUTHORITY`: ProgramData holds `Some(11111111111111111111111111111111)`
 *   — the all-zero pubkey, which is the System Program address. No signer
 *   exists for it, so in practice the program cannot be upgraded, but this is
 *   *not* the canonical immutable encoding and is deliberately not reported as
 *   `IMMUTABLE`. `solana-test-validator --upgradeable-program … none` writes
 *   this, so the local reproduction lands here.
 * - `UPGRADEABLE`: ProgramData names a real upgrade authority. Whoever holds
 *   that key can replace the program at any time, including after a user has
 *   signed and while the transaction is in flight.
 * - `UNKNOWN`: ProgramData was not read, so mutability was never established.
 *
 * Only `IMMUTABLE` means "provably cannot change". Nothing else may be
 * presented as immutable.
 */
export type DeploymentMutability = "IMMUTABLE" | "NO_USABLE_AUTHORITY" | "UPGRADEABLE" | "UNKNOWN";

/** The decoded `UpgradeableLoaderState::ProgramData` header. */
export interface ProgramDataHeader {
  /** Slot of the last deploy or upgrade. */
  readonly deploymentSlot: bigint;
  /** The upgrade authority, or `null` when the deployment is immutable. */
  readonly upgradeAuthority: Address | null;
  readonly mutability: Exclude<DeploymentMutability, "UNKNOWN">;
}

/**
 * Decodes the ProgramData header, or `null` when `data` is not a well-formed
 * one. Fails closed: a short account, a wrong state tag, or an `Option`
 * discriminant that is neither 0 nor 1 all decode to `null` rather than to a
 * guessed authority.
 */
export function decodeProgramDataHeader(data: Uint8Array): ProgramDataHeader | null {
  if (data.length < PROGRAMDATA_HEADER_LEN || u32At(data, 0) !== LOADER_STATE_PROGRAM_DATA) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const deploymentSlot = view.getBigUint64(PROGRAMDATA_SLOT_OFFSET, true);
  const option = data[PROGRAMDATA_AUTHORITY_OPTION_OFFSET];
  if (option === OPTION_NONE) {
    return { deploymentSlot, upgradeAuthority: null, mutability: "IMMUTABLE" };
  }
  if (option !== OPTION_SOME) return null;
  const upgradeAuthority = getAddressDecoder().decode(data.subarray(PROGRAMDATA_AUTHORITY_OFFSET, PROGRAMDATA_HEADER_LEN));
  return {
    deploymentSlot,
    upgradeAuthority,
    // Reported distinctly rather than folded into either neighbour: it cannot
    // be upgraded, but it is not the encoding that proves so.
    mutability: upgradeAuthority === ZERO_AUTHORITY ? "NO_USABLE_AUTHORITY" : "UPGRADEABLE",
  };
}

/**
 * What a client proved about the program it built a guard against, at the slot
 * it read. Carrying the authority and mutability is the point: a reviewed
 * binary under a live upgrade authority is not the same security statement as
 * a reviewed binary that can never change.
 *
 * This is a statement about one read. It does not bind the transaction to
 * those bytes — see `reverifyGuardDeployment` in `@equityguard/jupiter/protect`.
 */
export interface GuardDeploymentAttestation {
  readonly programId: Address;
  /** The ProgramData account read, or `null` when none was read. */
  readonly programDataAddress: Address | null;
  /** SHA-256 of the reviewed ELF, when this is a reviewed deployment. */
  readonly reviewedElfSha256: string | null;
  /** Slot of the last deploy or upgrade, when ProgramData was read. */
  readonly deploymentSlot: bigint | null;
  readonly upgradeAuthority: Address | null;
  readonly mutability: DeploymentMutability;
  /** Whether the deployed bytes were verified, or trusted on the caller's word. */
  readonly identity: "REVIEWED_BINARY" | "CALLER_TRUSTED";
}

/**
 * The fields that must not change between building a guard and executing it.
 *
 * Deliberately excludes `deploymentSlot`, which is redundant once the ELF hash
 * and authority are pinned, and would otherwise make an unrelated redeploy of
 * identical bytes look like a substitution.
 */
export function deploymentAttestationDigest(attestation: GuardDeploymentAttestation): string {
  return [
    attestation.programId,
    attestation.programDataAddress ?? "-",
    attestation.reviewedElfSha256 ?? "-",
    attestation.upgradeAuthority ?? "-",
    attestation.mutability,
    attestation.identity,
  ].join("|");
}

/** Whether two attestations describe the same deployment. */
export function sameGuardDeployment(a: GuardDeploymentAttestation, b: GuardDeploymentAttestation): boolean {
  return deploymentAttestationDigest(a) === deploymentAttestationDigest(b);
}

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
  if (!program?.executable) {
    const availability = checkGuardProgramAccount(deployment.programAddress, program);
    // Unreachable when the account is executable; narrows the shared type.
    return availability.ok
      ? { ok: false, reason: "MISSING", message: `no account exists at ${deployment.programAddress} on this cluster` }
      : availability;
  }
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
  const header = decodeProgramDataHeader(programData.data);
  if (!header) {
    return { ok: false, reason: "MALFORMED_PROGRAM_DATA", message: `ProgramData ${deployment.programDataAddress} has an undecodable upgrade-authority header` };
  }
  return {
    ok: true,
    attestation: {
      programId: at,
      programDataAddress: deployment.programDataAddress,
      reviewedElfSha256: deployment.elfSha256,
      deploymentSlot: header.deploymentSlot,
      upgradeAuthority: header.upgradeAuthority,
      mutability: header.mutability,
      identity: "REVIEWED_BINARY",
    },
  };
}

/**
 * The attestation for a program this client did not review: it exists and is
 * executable, and nothing more was established. Mutability is `UNKNOWN`
 * because no ProgramData was read — reporting `IMMUTABLE` here would be a
 * guess, and guessing in this direction is the dangerous direction.
 */
export function callerTrustedAttestation(programId: Address): GuardDeploymentAttestation {
  return {
    programId,
    programDataAddress: null,
    reviewedElfSha256: null,
    deploymentSlot: null,
    upgradeAuthority: null,
    mutability: "UNKNOWN",
    identity: "CALLER_TRUSTED",
  };
}
