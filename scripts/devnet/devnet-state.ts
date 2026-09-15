/**
 * `scripts/devnet/devnet.json`: public, committed devnet metadata (program ID,
 * deployment signature, test mint addresses). Never holds secrets.
 */

import { readFile, writeFile } from "node:fs/promises";

import { address, type Address } from "@solana/kit";
import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "@equityguard/guard-client";

/** Committed devnet metadata; `EQUITYGUARD_DEVNET_STATE` redirects local rehearsals. */
export function devnetStatePath(env: NodeJS.ProcessEnv = process.env): string | URL {
  return env.EQUITYGUARD_DEVNET_STATE ?? new URL("./devnet.json", import.meta.url);
}

/** Shown wherever test assets are listed, so they are never mistaken for issuer assets. */
export const TEST_ASSET_DISCLOSURE =
  "DEVNET TEST ASSET created by EquityGuard tooling. Not an xStocks, Ondo or any issuer asset; no real-world value.";

export interface TestAsset {
  readonly label: string;
  readonly mint: Address;
  readonly decimals: number;
  /** Both assets represent this same fictional stock in demo metadata. */
  readonly conceptualStock: string;
  readonly disclosure: string;
}

export interface DevnetDeployment {
  readonly programId: Address;
  readonly deploySignature: string;
  readonly upgradeAuthority: Address;
  /**
   * `assert_safe_execution` ABI the deployed binary accepts. This client only
   * builds ABI v2; update this record (to 2) only after the program upgrade
   * and only once the deployed ELF hash has been verified.
   */
  readonly abiVersion: 1 | 2;
  /** SHA-256 of the deployed ProgramData ELF, verified after the upgrade. */
  readonly sbfSha256?: string;
  readonly programDataAddress?: Address;
  /** Signature of the upgrade that put `sbfSha256` on chain. */
  readonly upgradeSignature?: string;
  readonly deploymentSlot?: number;
  /** When the deployed binary was last verified against the reviewed candidate. */
  readonly verifiedAt?: string;
}

export interface DevnetState {
  readonly cluster: "devnet";
  readonly deployment: DevnetDeployment | null;
  readonly assets: readonly TestAsset[];
}

export class DevnetStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevnetStateError";
  }
}

/** Validates parsed `devnet.json` contents. */
export function parseDevnetState(value: unknown): DevnetState {
  if (typeof value !== "object" || value === null) throw new DevnetStateError("devnet.json must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.cluster !== "devnet") throw new DevnetStateError('devnet.json cluster must be "devnet"');
  if (!Array.isArray(raw.assets)) throw new DevnetStateError("devnet.json assets must be an array");

  const assets = raw.assets.map((entry, index): TestAsset => {
    const a = entry as Record<string, unknown>;
    if (typeof a.label !== "string" || typeof a.mint !== "string" || typeof a.decimals !== "number") {
      throw new DevnetStateError(`asset ${index} is malformed`);
    }
    if (typeof a.conceptualStock !== "string" || a.disclosure !== TEST_ASSET_DISCLOSURE) {
      throw new DevnetStateError(`asset ${index} must carry the test-asset disclosure`);
    }
    return {
      label: a.label,
      mint: address(a.mint),
      decimals: a.decimals,
      conceptualStock: a.conceptualStock,
      disclosure: a.disclosure,
    };
  });

  let deployment: DevnetDeployment | null = null;
  if (raw.deployment !== null && raw.deployment !== undefined) {
    const d = raw.deployment as Record<string, unknown>;
    if (typeof d.programId !== "string" || typeof d.deploySignature !== "string" || typeof d.upgradeAuthority !== "string") {
      throw new DevnetStateError("deployment is malformed");
    }
    const abiVersion = d.abiVersion ?? 1;
    if (abiVersion !== 1 && abiVersion !== 2) throw new DevnetStateError("deployment abiVersion must be 1 or 2");
    for (const [key, kind] of [["sbfSha256", "string"], ["upgradeSignature", "string"], ["verifiedAt", "string"], ["deploymentSlot", "number"], ["programDataAddress", "string"]] as const) {
      if (d[key] !== undefined && typeof d[key] !== kind) throw new DevnetStateError(`deployment ${key} must be a ${kind}`);
    }
    if (d.sbfSha256 !== undefined && !/^[0-9a-f]{64}$/.test(d.sbfSha256 as string)) {
      throw new DevnetStateError("deployment sbfSha256 must be 64 lowercase hex digits");
    }
    deployment = {
      programId: address(d.programId),
      deploySignature: d.deploySignature,
      upgradeAuthority: address(d.upgradeAuthority),
      abiVersion,
      ...(d.sbfSha256 === undefined ? {} : { sbfSha256: d.sbfSha256 as string }),
      ...(d.programDataAddress === undefined ? {} : { programDataAddress: address(d.programDataAddress as string) }),
      ...(d.upgradeSignature === undefined ? {} : { upgradeSignature: d.upgradeSignature as string }),
      ...(d.deploymentSlot === undefined ? {} : { deploymentSlot: d.deploymentSlot as number }),
      ...(d.verifiedAt === undefined ? {} : { verifiedAt: d.verifiedAt as string }),
    };
  }
  return { cluster: "devnet", deployment, assets };
}

export async function loadDevnetState(): Promise<DevnetState> {
  return parseDevnetState(JSON.parse(await readFile(devnetStatePath(), "utf8")));
}

export async function saveDevnetState(state: DevnetState): Promise<void> {
  await writeFile(devnetStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function findAsset(state: DevnetState, label: string): TestAsset {
  const asset = state.assets.find((a) => a.label === label);
  if (!asset) throw new DevnetStateError(`no test asset labelled ${label}; run create-mints first`);
  return asset;
}

/** The recorded deployment, which must be the pinned program ID. */
export function requireDeployment(state: DevnetState): DevnetDeployment {
  if (!state.deployment) throw new DevnetStateError("no devnet deployment recorded in devnet.json");
  if (state.deployment.programId !== EQUITY_GUARD_DEVNET_PROGRAM_ID) {
    throw new DevnetStateError(
      `devnet.json program ID ${state.deployment.programId} diverges from the pinned ${EQUITY_GUARD_DEVNET_PROGRAM_ID}`,
    );
  }
  return state.deployment;
}

/** The only guard ABI this client builds. */
export const CLIENT_GUARD_ABI_VERSION = 2;

/**
 * The recorded deployment, which must be the pinned program ID AND accept the
 * ABI this client builds. Refuses before any network call when devnet.json
 * still records an ABI v1 deployment.
 */
export function requireGuardAbiV2Deployment(state: DevnetState): DevnetDeployment {
  const deployment = requireDeployment(state);
  if (deployment.abiVersion !== CLIENT_GUARD_ABI_VERSION) {
    throw new DevnetStateError(
      `devnet.json records the deployed program as ABI v${deployment.abiVersion}; this client builds ABI v${CLIENT_GUARD_ABI_VERSION} guards. Upgrade the program (human-reviewed) and update the record first.`,
    );
  }
  return deployment;
}
