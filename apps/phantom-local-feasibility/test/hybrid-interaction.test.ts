import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import * as trader from "../src/trader-flow.ts";
import * as errors from "../src/buy-error.ts";
import * as feasibility from "../src/feasibility.ts";
import * as funding from "../src/local-funding.ts";
import * as demoView from "../src/demo-view.ts";

test("stale completion and review never sign again; only explicit confirmation starts the second attempt", async () => {
  const calls: string[] = [];
  const nodes = new Map<string, { hidden: boolean; disabled: boolean; textContent: string; click?: () => void }>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, disabled: false, textContent: "" });
    return nodes.get(id)!;
  };
  const modules: Record<string, unknown> = {
    "../../devnet-wallet-demo/src/wallet.ts": {
      detectPhantom: () => true,
      connectPhantomWallet: async () => { calls.push("connect"); return { provider: {}, publicKey: funding.EXPECTED_PHANTOM }; },
    },
    "./buy-error.ts": errors, "./feasibility.ts": feasibility, "./local-funding.ts": funding,
    "./trader-flow.ts": trader, "./demo-view.ts": demoView,
    "./reproduction-view.ts": { reproductionMessage: () => "Verified result from adapter" },
    "./replay-execution.ts": { loadReplayData: async () => ({}) },
    "./local-activation.ts": {
      armLocalActivation: async () => { calls.push("arm"); return 100n; },
      recordEvidence: async () => { calls.push("evidence"); },
      runLocalActivation: async (_data: unknown, _provider: unknown, _t: unknown, stale: boolean) => {
        calls.push(stale ? "first-approval" : "second-approval"); return { outcome: { signature: "mock" } };
      },
    },
  };
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, {
    require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    window: { addEventListener: (_event: string, callback: () => void) => callback() },
    document: { getElementById: (id: string) => Object.assign(node(id), {
      addEventListener: (_event: string, callback: () => void) => { node(id).click = callback; },
    }) }, location: { hostname: "127.0.0.1" }, console,
    fetch: () => { throw new Error("Unexpected network request"); },
  });
  node("confirm-order").click!(); assert.deepEqual(calls, []);
  node("buy").click!(); await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(calls, ["connect", "arm", "first-approval", "evidence"]);
  node("confirm-order").click!(); assert.equal(calls.length, 4);
  node("review-order").click!(); assert.equal(calls.length, 4);
  node("confirm-order").click!(); await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(calls, ["connect", "arm", "first-approval", "evidence", "second-approval", "evidence"]);
  node("confirm-order").click!(); node("buy").click!(); assert.equal(calls.length, 6);
});
