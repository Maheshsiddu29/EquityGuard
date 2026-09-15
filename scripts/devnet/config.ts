/**
 * Devnet connection and wallet configuration for every signing path.
 *
 * Chain identity is the genesis hash reported by the RPC, never the RPC URL,
 * hostname or any label: only the exact Solana devnet genesis hash is
 * accepted, whatever the endpoint looks like (loopback included). The hash is
 * re-verified immediately before every signature (`send.ts`).
 *
 * A `DevnetContext` is an opaque capability: only `connectDevnet` can mint
 * one, and signing paths reject structurally identical objects that did not
 * come from it. There is no localnet signing path.
 *
 * Residual trust: the RPC endpoint itself. A malicious RPC can lie about its
 * genesis hash; point `EQUITYGUARD_DEVNET_RPC_URL` only at endpoints you trust.
 */

import { readFile } from "node:fs/promises";

import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type GetGenesisHashApi,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApiDevnet,
} from "@solana/kit";

/** Solana's public devnet endpoint; rate limited, fine for manual runs. */
export const PUBLIC_DEVNET_RPC_URL = "https://api.devnet.solana.com";
/** Devnet genesis hash; the only cluster these scripts will sign for. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Known public clusters, named in rejections so a misconfiguration is obvious. */
export const MAINNET_BETA_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
const SECRET_KEY_LEN = 64;

export class DevnetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevnetConfigError";
  }
}

/** The RPC is not devnet (or its identity changed). Nothing was signed. */
export class DevnetIdentityError extends Error {
  readonly genesisHash: string;

  constructor(genesisHash: string, when: string) {
    const name =
      genesisHash === MAINNET_BETA_GENESIS_HASH ? "mainnet-beta" : genesisHash === TESTNET_GENESIS_HASH ? "testnet" : "an unknown cluster";
    super(`${when}: RPC genesis hash ${genesisHash} is ${name}, not devnet; refusing to sign`);
    this.name = "DevnetIdentityError";
    this.genesisHash = genesisHash;
  }
}

export interface DevnetConfig {
  readonly rpcUrl: string;
  readonly walletPath: string;
}

export interface DevnetContext {
  readonly rpc: Rpc<SolanaRpcApiDevnet>;
  readonly payer: KeyPairSigner;
  readonly cluster: "devnet";
  readonly genesisHash: typeof DEVNET_GENESIS_HASH;
}

/** Contexts minted by `connectDevnet`; nothing else is a valid signing context. */
const verifiedContexts = new WeakSet<object>();

/**
 * Reads configuration from the environment. The wallet must be named
 * explicitly: there is no fallback to the Solana CLI default keypair.
 */
export function readDevnetConfig(env: NodeJS.ProcessEnv): DevnetConfig {
  const walletPath = env.EQUITYGUARD_DEVNET_WALLET;
  if (!walletPath) {
    throw new DevnetConfigError("EQUITYGUARD_DEVNET_WALLET is required for every signing path; there is no default wallet");
  }
  return { rpcUrl: env.EQUITYGUARD_DEVNET_RPC_URL ?? PUBLIC_DEVNET_RPC_URL, walletPath };
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

/** Queries the RPC's genesis hash and throws unless it is exactly devnet. */
export async function assertDevnetGenesis(rpc: Rpc<GetGenesisHashApi>, when: string): Promise<void> {
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash !== DEVNET_GENESIS_HASH) throw new DevnetIdentityError(genesisHash, when);
}

/** Connects, verifies the chain is devnet by genesis hash, and loads the wallet signer. */
export async function connectDevnet(config: DevnetConfig): Promise<DevnetContext> {
  if (!config.walletPath) throw new DevnetConfigError("a wallet path is required");
  const rpc = createSolanaRpc(config.rpcUrl);
  await assertDevnetGenesis(rpc, "connect");
  let contents: string;
  try {
    contents = await readFile(config.walletPath, "utf8");
  } catch {
    throw new DevnetConfigError(`wallet not found at ${config.walletPath}`);
  }
  const payer = await createKeyPairSignerFromBytes(parseKeypairFile(contents, config.walletPath));
  const ctx: DevnetContext = Object.freeze({ rpc, payer, cluster: "devnet", genesisHash: DEVNET_GENESIS_HASH });
  verifiedContexts.add(ctx);
  return ctx;
}

/** Throws unless `ctx` is the exact object `connectDevnet` returned. Makes no RPC call. */
export function assertVerifiedDevnetContext(ctx: DevnetContext): void {
  if (typeof ctx !== "object" || ctx === null || !verifiedContexts.has(ctx)) {
    throw new DevnetConfigError("not a verified devnet context: signing contexts can only come from connectDevnet");
  }
}
