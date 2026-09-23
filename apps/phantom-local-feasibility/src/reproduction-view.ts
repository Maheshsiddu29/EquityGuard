import type { LocalActivationProof } from "./local-activation.ts";
import { assertOutcome, type ReplayOutcome } from "./replay-execution.ts";
import { formatKox, formatUsdc } from "./local-funding.ts";

type ProofView = { readonly outcome: ReplayOutcome } & Pick<LocalActivationProof, "localT" | "atSigning" | "atSubmission" | "lifetime"
  | "exactEquality" | "signedWireHashBeforeActivation" | "signedWireHashAtSubmission" | "preSign" | "signedAuthorization" | "deploymentAttestations">;

/** Renders only what the confirmed local RPC metadata proves; every status line is derived. */
export function reproductionMessage(proof: ProofView): string {
  const result = proof.outcome;
  assertOutcome(result);
  if (result.slot <= 0n || !result.signature) throw new Error("No confirmed execution proof");
  const usdc = result.after.usdc - result.before.usdc;
  const kox = result.after.kox - result.before.kox;
  if (result.kind === "STALE") {
    // EG-A-03: "valid when signed" and "signed before the state changed" are
    // shown only on the coordinator's own records. The browser's own clock
    // readings are kept as a cross-check, never as the source.
    // The stale panel claims the authorization was verified and signed BEFORE
    // the state changed, so this leg specifically requires both coordinator
    // readings to be pre-activation. The refreshed leg's own timing is the
    // mirror of this and is checked by its own record, not borrowed here.
    const preSignTiming = proof.preSign.timing;
    const receiptTiming = proof.signedAuthorization.timing;
    const attested = proof.preSign.source === "LOCAL_COORDINATOR"
      && proof.signedAuthorization.source === "LOCAL_COORDINATOR"
      && proof.signedAuthorization.signatureVerified
      && proof.signedAuthorization.messageMatchesSimulated
      && preSignTiming.clockMatchesExpectedPhase
      && receiptTiming.clockMatchesExpectedPhase
      && preSignTiming.encodedPhase === "PENDING"
      && receiptTiming.encodedPhase === "PENDING"
      && preSignTiming.clockRelationToLocalT === "BEFORE_ACTIVATION"
      && receiptTiming.clockRelationToLocalT === "BEFORE_ACTIVATION"
      && proof.signedAuthorization.messageSha256 === proof.preSign.messageSha256
      && proof.signedAuthorization.signedWireSha256 === proof.signedWireHashBeforeActivation;
    // EG-A-02: the program that executed must be the one attested before signing.
    const deploymentStable = proof.deploymentAttestations.length === 2
      && proof.deploymentAttestations.every((attestation) => attestation.matched)
      && proof.deploymentAttestations[0]?.digest === proof.deploymentAttestations[1]?.digest;
    if (!attested || !deploymentStable || !proof.exactEquality
        || proof.signedWireHashBeforeActivation !== proof.signedWireHashAtSubmission
        || proof.atSigning.unixTimestamp >= proof.localT || proof.atSubmission.unixTimestamp <= proof.localT || !proof.lifetime.valid) {
      throw new Error("Signed-before-activation proof is incomplete");
    }
    const rejectedAtGuard = result.failedInstruction === 0 && result.guardErrorName === "ActivationPhaseChanged";
    return ["STATE CHANGED", "Stale authorization rejected", "",
      "The transaction was valid when it was signed.",
      "The asset’s economic state changed before execution.",
      "EquityGuard stopped the old authorization before the swap executed.", "",
      "EquityGuard       " + (rejectedAtGuard ? "Rejected" : "Not verified"),
      "Jupiter           " + (result.jupiterInvoked ? "Invoked" : "Not invoked"),
      "Whirlpool         " + (result.whirlpoolInvoked ? "Invoked" : "Not invoked"),
      "Token movement    " + (usdc === 0n && kox === 0n ? "0" : "USDC " + usdc + ", KOx " + kox), "",
      "Exact signed transaction preserved ✓",
      "Verified before signing, and signed before the change, by the local coordinator ✓"].join("\n");
  }
  return ["Updated authorization executed", "",
    formatUsdc(-usdc) + " USDC → " + formatKox(kox) + " KOx", "",
    "EquityGuard    " + (result.error === null && result.guardInvoked ? "Passed" : "Not verified"),
    "Jupiter        " + (result.jupiterInvoked ? "Executed" : "Not invoked"),
    "Whirlpool      " + (result.whirlpoolInvoked ? "Executed" : "Not invoked"), "",
    "Local execution reproduction"].join("\n");
}
