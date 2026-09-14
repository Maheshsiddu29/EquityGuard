/**
 * Devnet connection and wallet configuration. Everything here refuses to run
 * against any cluster other than devnet, except a loopback
 * `solana-test-validator` used to rehearse runs without spending devnet SOL.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApiDevnet,
} from "@solana/kit";

/** Solana's public devnet endpoint; rate limited, fine for manual runs. */
export const PUBLIC_DEVNET_RPC_URL = "https://api.devnet.solana.com";
/** Devnet genesis hash; the only cluster these scripts will touch. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SECRET_KEY_LEN = 64;

export class DevnetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevnetConfigError";
  }
}

export interface DevnetConfig {
  readonly rpcUrl: string;
  readonly walletPath: string;
}

export interface DevnetContext {
  readonly rpc: Rpc<SolanaRpcApiDevnet>;
  readonly payer: KeyPairSigner;
  /** Recorded in evidence so rehearsals are never presented as devnet runs. */
  readonly cluster: "devnet" | "localnet";
}

/** Reads configuration from the environment. */
export function readDevnetConfig(env: NodeJS.ProcessEnv): DevnetConfig {
  return {
    rpcUrl: env.EQUITYGUARD_DEVNET_RPC_URL ?? PUBLIC_DEVNET_RPC_URL,
    walletPath: env.EQUITYGUARD_DEVNET_WALLET ?? join(homedir(), ".config", "solana", "id.json"),
  };
}

/** A local test validator: never a public cluster holding real value. */
export function isLoopbackRpcUrl(rpcUrl: string): boolean {
  const { hostname } = new URL(rpcUrl);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Parses a Solana CLI keypair file (JSON array of 64 bytes). */
export function parseKeypairFile(contents: string, path: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new DevnetConfigError(`${path} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== SECRET_KEY_LEN ||
    !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new DevnetConfigError(`${path} is not a ${SECRET_KEY_LEN}-byte Solana keypair file`);
  }
  return Uint8Array.from(parsed as number[]);
}

/** Connects, verifies the cluster is devnet, and loads the wallet signer. */
export async function connectDevnet(config: DevnetConfig): Promise<DevnetContext> {
  const rpc = createSolanaRpc(config.rpcUrl);
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash !== DEVNET_GENESIS_HASH && !isLoopbackRpcUrl(config.rpcUrl)) {
    throw new DevnetConfigError(`RPC genesis hash ${genesisHash} is not devnet; refusing to continue`);
  }
  let contents: string;
  try {
    contents = await readFile(config.walletPath, "utf8");
  } catch {
    throw new DevnetConfigError(`wallet not found at ${config.walletPath} (set EQUITYGUARD_DEVNET_WALLET)`);
  }
  const payer = await createKeyPairSignerFromBytes(parseKeypairFile(contents, config.walletPath));
  return { rpc, payer, cluster: genesisHash === DEVNET_GENESIS_HASH ? "devnet" : "localnet" };
}
