/**
 * EG-SEC-M02: the submission surface is pinned by source scan. Only the
 * transport signs or sends; only allowlisted modules import it; and inside
 * the product execution module it is reachable only from non-exported
 * helpers called by the gated entry points.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/testing/")) out.push(path);
  }
  return out;
}

const files = [...sources(join(ROOT, "scripts")), ...sources(join(ROOT, "packages"))].map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

test("only the transport signs or sends transactions", () => {
  for (const pattern of [/\.sendTransaction\(/, /signTransactionMessageWithSigners\(/, /signTransaction\(/, /sendAndConfirmTransaction/]) {
    const users = files.filter((f) => pattern.test(f.text)).map((f) => f.path);
    assert.deepEqual(users, users.length === 0 ? [] : ["scripts/devnet/send.ts"], `${pattern}: ${users.join(", ")}`);
  }
});

test("the transport is imported only by the product executor and the devnet admin/proof tooling", () => {
  // Value imports of the transport module (type-only imports of its result types are fine).
  const importers = files.filter((f) => /^import (?!type )[^;]*from "\.{1,2}\/(?:devnet\/)?send\.ts"/m.test(f.text)).map((f) => f.path).sort();
  assert.deepEqual(importers, ["scripts/demo/devnet-execution.ts", "scripts/devnet/cli.ts", "scripts/devnet/guard-v2-live-proof.ts", "scripts/devnet/scenarios.ts"]);
});

/** Name of the top-level function enclosing `index`, and whether it is exported. */
function enclosingFunction(text: string, index: number): { name: string; exported: boolean } | null {
  let found: { name: string; exported: boolean } | null = null;
  for (const match of text.matchAll(/^(export )?(?:async )?function (\w+)/gm)) {
    if ((match.index ?? 0) > index) break;
    found = { name: match[2] as string, exported: Boolean(match[1]) };
  }
  return found;
}

test("inside the product executor, sending is reachable only through the gated entry points", async () => {
  const executor = files.find((f) => f.path === "scripts/demo/devnet-execution.ts");
  assert.ok(executor);
  const senders = [...executor.text.matchAll(/sendInstructions\(/g)].map((m) => enclosingFunction(executor.text, m.index ?? 0));
  assert.deepEqual(senders.map((f) => f?.name).sort(), ["resetDemoState", "submitGuardedDelivery"]);
  assert.ok(senders.every((f) => f && !f.exported), "send helpers must not be exported");

  const deliveryCallers = [...executor.text.matchAll(/submitGuardedDelivery\(/g)]
    .map((m) => enclosingFunction(executor.text, m.index ?? 0))
    .filter((f) => f?.name !== "submitGuardedDelivery");
  assert.deepEqual(deliveryCallers.map((f) => f?.name).sort(), ["executeGuardedPlan", "submitRejectionProbe"]);
  const resetCallers = [...executor.text.matchAll(/resetDemoState\(/g)].map((m) => enclosingFunction(executor.text, m.index ?? 0)).filter((f) => f?.name !== "resetDemoState");
  assert.deepEqual(resetCallers.map((f) => f?.name), ["runDevnetDemo"]);

  // executeGuardedPlan gates before it can reach the delivery helper.
  const body = executor.text.slice(executor.text.indexOf("export async function executeGuardedPlan"));
  const order = ["verifyExecutionPlan(", "assertPlanPolicy(", "requireDevnet(", "assertPlanDownstream(", "consumeExecutionPlan(", "assertPlanFresh(", "submitGuardedDelivery("].map((token) => body.indexOf(token));
  assert.ok(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > (order[k - 1] as number)), `gate order ${order.join(",")}`);

  const exported = Object.keys(await import("../demo/devnet-execution.ts"));
  for (const hidden of ["submitGuardedDelivery", "resetDemoState", "sendInstructions", "requireDevnet"]) assert.ok(!exported.includes(hidden), hidden);
});

test("the transport itself verifies the context and re-checks genesis immediately before signing", () => {
  const transport = files.find((f) => f.path === "scripts/devnet/send.ts");
  assert.ok(transport);
  const body = transport.text.slice(transport.text.indexOf("export async function sendInstructions"));
  // Provenance first, then the genesis re-check, and only then a signature.
  const order = ["assertVerifiedDevnetContext(", 'assertDevnetGenesis(', "signTransactionMessageWithSigners(", ".sendTransaction("].map((token) => body.indexOf(token));
  assert.ok(order.every((i) => i >= 0), `a transport gate is missing: ${order.join(",")}`);
  assert.ok(order.every((i, k) => k === 0 || i > (order[k - 1] as number)), `transport gate order ${order.join(",")}`);

  // The genesis re-check must be the one done for signing, not the connect-time one.
  const recheck = body.slice(order[1], order[2]);
  assert.match(recheck, /assertDevnetGenesis\(\s*ctx\.rpc,\s*"before signing"\s*\)/);
});

test("the executor's gate set is complete, not merely ordered", () => {
  // Losing a gate is the failure this pins: the order test above would still
  // pass with any subset, so the set itself is asserted.
  const executor = files.find((f) => f.path === "scripts/demo/devnet-execution.ts");
  assert.ok(executor);
  const body = executor.text.slice(executor.text.indexOf("export async function executeGuardedPlan"));
  const gates = {
    "the plan was issued and matches the presented quote": "verifyExecutionPlan(",
    "the executor policy is the plan's": "assertPlanPolicy(",
    "the cluster is devnet": "requireDevnet(",
    "the action is the planned action": "assertPlanDownstream(",
    "the plan is unused, and is now spent": "consumeExecutionPlan(",
    "the plan is still fresh at the current slot": "assertPlanFresh(",
  };
  for (const [description, token] of Object.entries(gates)) {
    assert.ok(body.includes(token), `executeGuardedPlan no longer checks that ${description} (${token})`);
  }
  // Nothing is sent before the last gate.
  const lastGate = Math.max(...Object.values(gates).map((token) => body.indexOf(token)));
  assert.ok(body.indexOf("submitGuardedDelivery(") > lastGate, "the delivery is built or sent before the gates complete");
});

test("package code never signs, sends or builds RPC clients", () => {
  for (const f of files.filter((file) => file.path.startsWith("packages/representation-state/"))) {
    for (const forbidden of [/createSolanaRpc/, /KeyPairSigner/, /sendTransaction/, /devnet\/send/]) {
      assert.ok(!forbidden.test(f.text), `${f.path} must not match ${forbidden}`);
    }
  }
});
