/**
 * EG-SEC-H03 / L07: devnet identity is the genesis hash, checked at connect
 * and again immediately before every signature; contexts are unforgeable.
 * All RPCs here are loopback fakes: nothing touches a network.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { AccountRole, address } from "@solana/kit";

import {
  DEVNET_GENESIS_HASH,
  DevnetConfigError,
  DevnetIdentityError,
  MAINNET_BETA_GENESIS_HASH,
  TESTNET_GENESIS_HASH,
  assertVerifiedDevnetContext,
  connectDevnet,
  readDevnetConfig,
  type DevnetContext,
} from "./config.ts";
import { sendInstructions } from "./send.ts";
import { devnetGenesis, startFakeRpc, withGenesis, writeThrowawayWallet } from "./testing/fake-rpc.ts";

let wallet: Awaited<ReturnType<typeof writeThrowawayWallet>>;
before(async () => {
  wallet = await writeThrowawayWallet();
});
after(async () => {
  await wallet.cleanup();
});

const MEMO = { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: address("11111111111111111111111111111111"), role: AccountRole.READONLY }], data: new Uint8Array([1]) };

/** Enough of an RPC for sendInstructions to reach the pre-signing check. */
function blockhashAnd(genesis: (i: number) => string) {
  return withGenesis(genesis, (method) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
    throw new Error(`unexpected ${method}`);
  });
}

test("loopback RPCs reporting mainnet, testnet or an unknown genesis are rejected at connect", async () => {
  for (const genesis of [MAINNET_BETA_GENESIS_HASH, TESTNET_GENESIS_HASH, "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC"]) {
    for (const host of ["127.0.0.1", "localhost"]) {
      const rpc = await startFakeRpc(withGenesis(() => genesis));
      try {
        const url = rpc.url.replace("127.0.0.1", host);
        await assert.rejects(connectDevnet({ rpcUrl: url, walletPath: wallet.path }), (e) => e instanceof DevnetIdentityError && e.genesisHash === genesis, `${host} ${genesis}`);
        // No wallet is read and nothing beyond the identity query happens.
        assert.deepEqual(rpc.calls, ["getGenesisHash"]);
      } finally {
        await rpc.close();
      }
    }
  }
});

test("the exact devnet genesis is accepted whatever the endpoint, and the context is frozen", async () => {
  const rpc = await startFakeRpc(withGenesis(devnetGenesis));
  try {
    const ctx = await connectDevnet({ rpcUrl: rpc.url, walletPath: wallet.path });
    assert.deepEqual([ctx.cluster, ctx.genesisHash], ["devnet", DEVNET_GENESIS_HASH]);
    assert.ok(Object.isFrozen(ctx));
    assert.doesNotThrow(() => assertVerifiedDevnetContext(ctx));
  } finally {
    await rpc.close();
  }
});

test("every signing path requires EQUITYGUARD_DEVNET_WALLET; there is no default wallet", async () => {
  assert.throws(() => readDevnetConfig({}), /EQUITYGUARD_DEVNET_WALLET is required/);
  assert.throws(() => readDevnetConfig({ EQUITYGUARD_DEVNET_RPC_URL: "https://api.devnet.solana.com" }), DevnetConfigError);
  assert.equal(readDevnetConfig({ EQUITYGUARD_DEVNET_WALLET: wallet.path }).walletPath, wallet.path);
});

test("forged contexts are rejected before any RPC call", async () => {
  const rpc = await startFakeRpc(blockhashAnd(devnetGenesis));
  try {
    const real = await connectDevnet({ rpcUrl: rpc.url, walletPath: wallet.path });
    rpc.calls.length = 0;
    const forged: DevnetContext[] = [
      { ...real },
      { rpc: real.rpc, payer: real.payer, cluster: "devnet", genesisHash: DEVNET_GENESIS_HASH },
      JSON.parse(JSON.stringify({ cluster: "devnet", genesisHash: DEVNET_GENESIS_HASH })) as DevnetContext,
    ];
    for (const ctx of forged) {
      assert.throws(() => assertVerifiedDevnetContext(ctx), DevnetConfigError);
      await assert.rejects(sendInstructions(ctx, [MEMO], { skipPreflight: true }), DevnetConfigError);
    }
    assert.deepEqual(rpc.calls, []);
  } finally {
    await rpc.close();
  }
});

test("an RPC whose identity changes after connect gets nothing signed or sent", async () => {
  for (const later of [MAINNET_BETA_GENESIS_HASH, TESTNET_GENESIS_HASH]) {
    // getGenesisHash #0 (connect) is devnet; #1 (before signing) is not.
    const rpc = await startFakeRpc(blockhashAnd((i) => (i === 0 ? DEVNET_GENESIS_HASH : later)));
    try {
      const ctx = await connectDevnet({ rpcUrl: rpc.url, walletPath: wallet.path });
      await assert.rejects(sendInstructions(ctx, [MEMO], { skipPreflight: true }), (e) => e instanceof DevnetIdentityError && /before signing/.test(e.message));
      assert.deepEqual(rpc.calls, ["getGenesisHash", "getLatestBlockhash", "getGenesisHash"]);
      assert.ok(!rpc.calls.includes("sendTransaction"));
    } finally {
      await rpc.close();
    }
  }
});

test("a verified devnet context signs and sends only after the second identity check", async () => {
  const rpc = await startFakeRpc(
    withGenesis(devnetGenesis, (method) => {
      switch (method) {
        case "getLatestBlockhash":
          return { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
        case "sendTransaction":
          return "1111111111111111111111111111111111111111111111111111111111111111";
        case "getSignatureStatuses":
          return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] };
        case "getTransaction":
          return { slot: 2, blockTime: 3, meta: { err: null, logMessages: [] }, transaction: {} };
        default:
          throw new Error(`unexpected ${method}`);
      }
    }),
  );
  try {
    const ctx = await connectDevnet({ rpcUrl: rpc.url, walletPath: wallet.path });
    const outcome = await sendInstructions(ctx, [MEMO], { skipPreflight: true });
    assert.equal(outcome.succeeded, true);
    assert.deepEqual(rpc.calls.slice(0, 4), ["getGenesisHash", "getLatestBlockhash", "getGenesisHash", "sendTransaction"]);
  } finally {
    await rpc.close();
  }
});
