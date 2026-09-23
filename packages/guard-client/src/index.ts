/**
 * The canonical `@equityguard/guard-client` surface.
 *
 * Everything here either reads chain state or derives an economic-state
 * expectation from it. The builders that accept a caller-supplied expectation
 * are NOT here: they live in `@equityguard/guard-client/advanced`, because
 * whoever chooses those bytes chooses what the guard will accept.
 *
 * See `docs/sdk-trust-boundary.md`.
 */

export {
  ABI_VERSION_V2,
  ASSERT_SAFE_EXECUTION_V2_LEN,
  ActivationPhase,
  DownstreamAdapterKind,
  bytesEqual,
  hasScheduledChange,
  isDownstreamAdapterKind,
  isValidStoredMultiplier,
  isValidWindowSecs,
  phaseAt,
  type AssertSafeExecutionRequest,
  type AssertSafeExecutionV2Request,
  type ProtectedState,
  type ProtectionWindow,
} from "./abi.ts";
export {
  EQUITY_GUARD_ERROR_CODES,
  GuardClientError,
  equityGuardErrorName,
  type EquityGuardErrorName,
  type GuardClientErrorCode,
} from "./errors.ts";
export { checkGuardOffline } from "./offline-check.ts";
export {
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  REVIEWED_GUARD_DEPLOYMENTS,
  SOLANA_GENESIS_HASH,
  callerTrustedAttestation,
  checkGuardProgramAccount,
  clusterFromGenesisHash,
  decodeProgramDataHeader,
  deploymentAttestationDigest,
  deploymentForCluster,
  findReviewedGuardDeployment,
  sameGuardDeployment,
  verifyReviewedGuardDeployment,
  type DeploymentMutability,
  type GuardDeploymentAttestation,
  type GuardIdentityCheck,
  type GuardProgramCheck,
  type LoaderAccountView,
  type ProgramAccountView,
  type ProgramDataHeader,
  type ReviewedGuardDeployment,
  type SolanaCluster,
} from "./deployment.ts";
export {
  KNOWN_PROTECTED_ASSETS,
  PROTECTED_STATE_MODEL,
  findKnownProtectedAsset,
  resolveProtectionAdapter,
  type KnownProtectedAsset,
  type NotProtectedReason,
  type ProtectedStateModel,
  type ProtectionResolution,
  type UnsupportedAssetReason,
} from "./protection-adapter.ts";
export {
  DOWNSTREAM_COMMITMENT_DOMAIN,
  SYSVAR_INSTRUCTIONS_ADDRESS,
  asCommittedInstruction,
  assertSupportedTransferChecked,
  downstreamCommitment,
  downstreamCommitmentPreimage,
  type CommittedAccount,
  type CommittedInstruction,
  type GuardedTransferChecked,
} from "./downstream.ts";
export { expectationFromSnapshot } from "./instruction.ts";
export {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  JUPITER_EVENT_AUTHORITY,
  JUPITER_SUFFIX_COMMITMENT_DOMAIN,
  JUPITER_V6_PROGRAM_ADDRESS,
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  ROUTE_V2_ACCOUNT,
  ROUTE_V2_DISCRIMINATOR_HEX,
  SET_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_PRICE,
  SYSTEM_PROGRAM_ADDRESS,
  USDC_MINT_ADDRESS,
  canonicalAta,
  checkGuardedJupiterTransaction,
  checkJupiterSuffix,
  decodeRouteV2Prefix,
  isJupiterAdapterKind,
  JUPITER_ADAPTER_KIND_NAMES,
  jupiterSuffixCommitment,
  jupiterTradeBindingOf,
  jupiterSuffixCommitmentPreimage,
  minimumOutFromQuote,
  protectedRoleOf,
  sysvarView,
  type GuardedJupiterTrade,
  type JupiterAdapterKind,
  type JupiterAdapterKindName,
  type JupiterTradeBinding,
  type ProtectedMintRole,
  type RouteV2Prefix,
  type RouteV2Summary,
  type SuffixCheck,
} from "./jupiter.ts";
export { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "./program-id.ts";
export { TOKEN_2022_PROGRAM_ADDRESS, decodeMintMetadata, decodeProtectedState, type MintMetadata } from "./mint-state.ts";
export {
  SYSVAR_CLOCK_ADDRESS,
  decodeClock,
  fetchGuardSnapshot,
  type ChainClock,
  type GuardSnapshot,
} from "./snapshot.ts";
