/**
 * Test support only: a loopback JSON-RPC server with scripted responses and a
 * throwaway keypair file. Lets tests exercise the real `connectDevnet` and
 * `sendInstructions` paths (URL-based RPC, genesis checks, signing) without
 * any network. Never used by product code.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

import { DEVNET_GENESIS_HASH } from "../config.ts";

export type RpcHandler = (method: string, params: unknown[], callIndex: number) => unknown;

export interface FakeRpc {
  readonly url: string;
  /** Methods in call order. */
  readonly calls: string[];
  close(): Promise<void>;
}

/** Throw this from a handler to answer with a JSON-RPC error. */
export class FakeRpcError extends Error {}

export async function startFakeRpc(handler: RpcHandler): Promise<FakeRpc> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      calls.push(method);
      res.setHeader("content-type", "application/json");
      try {
        const result = handler(method, params ?? [], calls.filter((c) => c === method).length - 1);
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (error) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Handler answering getGenesisHash with `genesis(n)` for the n-th call and delegating everything else. */
export function withGenesis(genesis: (callIndex: number) => string, rest: RpcHandler = () => { throw new FakeRpcError("unexpected method"); }): RpcHandler {
  return (method, params, index) => (method === "getGenesisHash" ? genesis(index) : rest(method, params, index));
}

export const devnetGenesis = () => DEVNET_GENESIS_HASH;

/** Writes a random, never-funded 64-byte keypair file to a fresh temp dir. */
export async function writeThrowawayWallet(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "equityguard-test-wallet-"));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signer.keyPair.publicKey));
  const path = join(dir, "throwaway.json");
  await writeFile(path, JSON.stringify([...seed, ...publicKey]));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
