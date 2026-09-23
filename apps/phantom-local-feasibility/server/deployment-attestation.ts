/**
 * EG-A-02, demo side: attest the EquityGuard program the local validator is
 * actually running, and re-attest it at each point the flow commits to it.
 *
 * `scripts/replay/start-validator.sh` loads the reviewed
 * `target/deploy/equity_guard.so` with `--upgradeable-program … none`. Read
 * back from a running validator, that keyword writes
 * `Some(11111111111111111111111111111111)` — the all-zero pubkey — not
 * `Option::None`, so the local deployment reports `NO_USABLE_AUTHORITY`: it
 * cannot be upgraded, because no signer for that address exists, but it is
 * not the encoding that proves immutability and is never called immutable.
 * The devnet deployment at the same address is `UPGRADEABLE`. One
 * `verifyReviewedGuardDeployment` covers both; only the reported mutability
 * differs, which is the point of surfacing it.
 *
 * Read-only. Nothing here builds, rebuilds, signs or submits anything.
 */

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  callerTrustedAttestation,
  checkGuardProgramAccount,
  deploymentAttestationDigest,
  findReviewedGuardDeployment,
  verifyReviewedGuardDeployment,
  type GuardDeploymentAttestation,
  type LoaderAccountView,
} from "../../../packages/guard-client/src/index.ts";

export interface AttestedDeployment {
  readonly digest: string;
  readonly attestation: GuardDeploymentAttestation;
  readonly readAtSlot: string | null;
}

/** Just enough of `getMultipleAccounts` to read the two loader accounts. */
export type AccountReader = (addresses: readonly string[]) => Promise<{
  readonly contextSlot: bigint | null;
  readonly accounts: readonly (LoaderAccountView | null)[];
}>;

export class DeploymentAttestationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "DeploymentAttestationError";
    this.reason = reason;
  }
}

/**
 * Reads the guard program and its ProgramData in one call and returns what was
 * proven. Throws rather than degrading: a deployment that cannot be attested
 * is not a deployment this flow will sign against.
 */
export async function attestGuardDeployment(
  read: AccountReader,
  programId: string = EQUITY_GUARD_DEVNET_PROGRAM_ID,
): Promise<AttestedDeployment> {
  const reviewed = findReviewedGuardDeployment(programId);
  const addresses = reviewed ? [programId, reviewed.programDataAddress] : [programId];
  const { contextSlot, accounts } = await read(addresses);
  const readAtSlot = contextSlot === null ? null : contextSlot.toString();

  if (reviewed) {
    const check = verifyReviewedGuardDeployment(reviewed, accounts[0] ?? null, accounts[1] ?? null);
    if (!check.ok) throw new DeploymentAttestationError(check.reason, check.message);
    return { digest: deploymentAttestationDigest(check.attestation), attestation: check.attestation, readAtSlot };
  }
  const check = checkGuardProgramAccount(programId as GuardDeploymentAttestation["programId"], accounts[0] ?? null);
  if (!check.ok) throw new DeploymentAttestationError(check.reason, check.message);
  const attestation = callerTrustedAttestation(programId as GuardDeploymentAttestation["programId"]);
  return { digest: deploymentAttestationDigest(attestation), attestation, readAtSlot };
}

/**
 * Re-reads the deployment and refuses unless it is still the one `expected`
 * describes.
 *
 * Called immediately before the wallet signature request and again
 * immediately before submission. It is an RPC read: it never rebuilds,
 * re-signs or otherwise touches the transaction, so the byte-preservation
 * guarantee is unaffected by it.
 */
export async function reattestGuardDeployment(
  read: AccountReader,
  expected: string,
  programId: string = EQUITY_GUARD_DEVNET_PROGRAM_ID,
): Promise<AttestedDeployment> {
  const current = await attestGuardDeployment(read, programId);
  if (current.digest !== expected) {
    throw new DeploymentAttestationError(
      "DEPLOYMENT_CHANGED",
      `the EquityGuard deployment changed: expected ${expected}, found ${current.digest}`,
    );
  }
  return current;
}
