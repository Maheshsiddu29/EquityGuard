import type { BuyStage } from "./buy-error.ts";

export const LOCAL_ACTIVATION_SOURCE = "LOCAL_EXECUTION_REPRODUCTION";
export function activationDelay(value = "15"): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 30) throw new Error("Activation delay must be 5–30 validator seconds");
  return seconds;
}
export function localActivation(clock: bigint, delay: number): bigint {
  return clock + BigInt(activationDelay(String(delay)));
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
export async function wireHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export interface ActivationClock { readonly unixTimestamp: bigint; readonly slot: bigint }
export interface LifetimeCheck { readonly valid: boolean; readonly height: bigint; readonly lastValidBlockHeight: bigint }

/**
 * Where the coordinator's Clock sat relative to the armed activation, and what
 * the authorization's own encoded phase required it to be.
 *
 * Phase-neutral: the stale leg is attested before `localT` and the refreshed
 * leg at or after it, so the evidence records the measured relation rather
 * than a boolean that is only true for one of them.
 */
export interface PhaseTiming {
  readonly encodedPhase: "PENDING" | "ACTIVATED";
  readonly clockRelationToLocalT: "BEFORE_ACTIVATION" | "AT_OR_AFTER_ACTIVATION";
  readonly requiredRelationToLocalT: "BEFORE_ACTIVATION" | "AT_OR_AFTER_ACTIVATION";
  readonly clockMatchesExpectedPhase: true;
}

/**
 * The coordinator's record that the exact unsigned message simulated cleanly
 * while its own Clock sat where this authorization's phase requires. Opaque
 * here: this module only carries it and requires its `proofId`.
 */
export interface PreSignAttestation {
  readonly proofId: string;
  readonly messageSha256: string;
  readonly timing: PhaseTiming;
  readonly source: "LOCAL_COORDINATOR";
}

/**
 * The coordinator's record that it held a valid Phantom signature over that
 * same message, with its own Clock again where the phase requires.
 */
export interface SignedAuthorizationAttestation {
  readonly proofId: string;
  readonly signedWireSha256: string;
  readonly messageSha256: string;
  readonly messageMatchesSimulated: true;
  readonly timing: PhaseTiming;
  readonly signatureVerified: true;
  readonly source: "LOCAL_COORDINATOR";
}

/** One re-read of the guard deployment, at a named point in the flow. */
export interface DeploymentAttestation {
  readonly stage: "PRE_SIGN" | "PRE_SUBMISSION";
  readonly digest: string;
  readonly matched: true;
}

export interface ActivationDependencies<Prepared, Outcome> {
  readonly build: () => Promise<Prepared>;
  /**
   * Hands the exact unsigned wire to the local coordinator, which simulates it
   * itself and refuses unless the whole guard + Jupiter + Whirlpool path
   * succeeded while its own Clock was before `localT`. Authoritative: this
   * browser asserts nothing about pre-sign validity (EG-A-03).
   */
  readonly attestPreSignSimulation: (prepared: Prepared) => Promise<PreSignAttestation>;
  readonly sign: (prepared: Prepared) => Promise<Uint8Array>;
  /**
   * Hands the exact Phantom-signed bytes to the coordinator, which verifies
   * the signature, requires the message to be the one it simulated, and reads
   * its own Clock again. Called before the activation wait, so the receipt
   * itself dates the signature (EG-A-03).
   */
  readonly attestSignedAuthorization: (proofId: string, signed: Uint8Array) => Promise<SignedAuthorizationAttestation>;
  /**
   * Re-reads the guard deployment. A pure RPC read: it must never rebuild,
   * re-sign or otherwise touch the held bytes (EG-A-02).
   */
  readonly attestDeployment: (stage: DeploymentAttestation["stage"]) => Promise<DeploymentAttestation>;
  readonly clock: () => Promise<ActivationClock>;
  readonly lifetime: (prepared: Prepared) => Promise<LifetimeCheck>;
  readonly submit: (prepared: Prepared, bytes: Uint8Array, stale: boolean) => Promise<Outcome>;
  readonly pause: () => Promise<void>;
  readonly stage: (stage: BuyStage, clock?: ActivationClock) => void;
}

/** One explicit approval, one build, one immutable signed wire, at most one submission. */
export async function executeAcrossActivation<P, O>(
  deps: ActivationDependencies<P, O>, localT: bigint, stale: boolean,
) {
  deps.stage("TRANSACTION_BUILD");
  const prepared = await deps.build();
  const beforeSimulation = await deps.clock();
  if (stale ? beforeSimulation.unixTimestamp >= localT : beforeSimulation.unixTimestamp < localT) {
    throw new Error("Authorization phase is not ready; reset the local reproduction");
  }
  deps.stage("PRE_SIGN_SIMULATION");
  // The coordinator simulates and times this, not the browser.
  const preSign = await deps.attestPreSignSimulation(prepared);
  const atSimulation = await deps.clock();
  if (stale && atSimulation.unixTimestamp >= localT) throw new Error("Activation passed during simulation; no signature requested");

  // EG-A-02: the program that would execute must still be the attested one
  // before a wallet signature is requested.
  deps.stage("DEPLOYMENT_ATTESTATION");
  const deploymentBeforeSigning = await deps.attestDeployment("PRE_SIGN");

  deps.stage("SIGN_REQUEST");
  const returned = await deps.sign(prepared);
  // The private reference and submission copy are never exposed to a builder or wallet again.
  const reference = Uint8Array.from(returned);
  const held = Uint8Array.from(returned);
  deps.stage("SIGNED_BYTES_RETURNED");
  const atSigning = await deps.clock();
  if (stale && atSigning.unixTimestamp >= localT) throw new Error("Signature returned after activation; aborting without submission or re-signing");

  // EG-A-03: the coordinator receives the exact signed bytes and dates them
  // itself, before any waiting begins. A copy is handed over for verification;
  // `held` remains the only array that is ever submitted.
  deps.stage("SIGNED_AUTHORIZATION_RECEIPT");
  const signedAuthorization = await deps.attestSignedAuthorization(preSign.proofId, Uint8Array.from(reference));
  if (signedAuthorization.messageSha256 !== preSign.messageSha256) {
    throw new Error("Coordinator attested a different message than it simulated; submission refused");
  }

  const signedWireHashBeforeActivation = await wireHash(reference);
  if (signedAuthorization.signedWireSha256 !== signedWireHashBeforeActivation) {
    throw new Error("Coordinator attested different signed bytes than the ones held; submission refused");
  }
  let atSubmission = atSigning;
  let polls = 0;
  if (stale) {
    deps.stage("WAITING_FOR_ACTIVATION", atSubmission);
    // The production guard refuses the inclusive [T,T] transition second even for a zero-width window.
    while (atSubmission.unixTimestamp <= localT) {
      if (++polls > 240) throw new Error("Validator Clock did not cross activation; transaction not submitted");
      await deps.pause();
      atSubmission = await deps.clock();
      deps.stage("WAITING_FOR_ACTIVATION", atSubmission);
    }
  }
  deps.stage("BLOCKHASH_VALIDATION");
  const lifetime = await deps.lifetime(prepared);
  if (!lifetime.valid || lifetime.height > lifetime.lastValidBlockHeight) {
    throw new Error("Original blockhash expired; aborted without rebuilding or re-signing");
  }

  // EG-A-02: and again immediately before submission. An RPC read only — the
  // held bytes are untouched by it, which the equality check below re-proves.
  deps.stage("DEPLOYMENT_ATTESTATION");
  const deploymentBeforeSubmission = await deps.attestDeployment("PRE_SUBMISSION");
  if (deploymentBeforeSubmission.digest !== deploymentBeforeSigning.digest) {
    throw new Error("EquityGuard deployment changed after signing; submission refused");
  }

  const signedWireHashAtSubmission = await wireHash(held);
  if (!equalBytes(reference, held) || signedWireHashBeforeActivation !== signedWireHashAtSubmission) {
    throw new Error("Signed transaction bytes changed; submission refused");
  }
  deps.stage("SUBMISSION");
  const outcome = await deps.submit(prepared, held, stale);
  return {
    environment: LOCAL_ACTIVATION_SOURCE, localT, beforeSimulation, atSimulation,
    preSign, signedAuthorization,
    deploymentAttestations: [deploymentBeforeSigning, deploymentBeforeSubmission] as const,
    atSigning, atSubmission, lifetime, wireLength: held.length,
    signedWireHashBeforeActivation, signedWireHashAtSubmission, exactEquality: equalBytes(reference, held), outcome,
  };
}
