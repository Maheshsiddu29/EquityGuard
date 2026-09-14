/**
 * `scripts/devnet/devnet.json`: public, committed devnet metadata (program ID,
 * deployment signature, test mint addresses). Never holds secrets.
 */

import { readFile, writeFile } from "node:fs/promises";

import { address, type Address } from "@solana/kit";

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
    deployment = {
      programId: address(d.programId),
      deploySignature: d.deploySignature,
      upgradeAuthority: address(d.upgradeAuthority),
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

export function requireDeployment(state: DevnetState): DevnetDeployment {
  if (!state.deployment) throw new DevnetStateError("no devnet deployment recorded in devnet.json");
  return state.deployment;
}
