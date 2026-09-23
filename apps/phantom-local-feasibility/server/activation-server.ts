/** Local setup coordinator. Its ephemeral signer never signs either user trade. */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, cp, symlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import {
  generateKeyPairSigner, createSolanaRpc, appendTransactionMessageInstructions,
  createTransactionMessage, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, getBase64EncodedWireTransaction, getSignatureFromTransaction,
} from "@solana/kit";
import { getUpdateMultiplierScaledUiMintInstruction } from "@solana-program/token-2022";
import { fetchGuardSnapshot, decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS } from "../../../packages/guard-client/src/index.ts";
import { deriveLocalMint } from "./local-mint.ts";
import { activationDelay, localActivation } from "../src/activation-proof.ts";
import { KOX_MINT } from "../src/replay-model.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "../src/feasibility.ts";

const root = resolve(new URL("../../../", import.meta.url).pathname);
const source = resolve(root, "tmp/m9d-c1");
const dir = resolve(root, "tmp/phantom-activation");
const dist = resolve(root, "apps/phantom-local-feasibility/dist");
const delay = activationDelay(process.env.DEMO_ACTIVATION_DELAY_SECONDS);
const setup = await generateKeyPairSigner();
const rpc = createSolanaRpc(assertLocalRpcUrl(LOCAL_RPC_URL).href);
const measuredClock = (await fetchGuardSnapshot(rpc, KOX_MINT)).clock;
await mkdir(dir, { recursive: true });
await rm(resolve(dir, "accounts"), { recursive: true, force: true });
await rm(resolve(dir, "local-accounts"), { recursive: true, force: true });
await cp(resolve(source, "accounts"), resolve(dir, "accounts"), { recursive: true });
await cp(resolve(source, "local-accounts"), resolve(dir, "local-accounts"), { recursive: true });
await cp(resolve(source, "route-fixture.json"), resolve(dir, "route-fixture.json"));
try { await symlink(resolve(source, "programs"), resolve(dir, "programs")); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const mintPath = resolve(source, "accounts", KOX_MINT + ".json");
const captured = JSON.parse(await readFile(mintPath, "utf8")) as { pubkey: string; account: { data: [string, string]; owner: string } };
const original = Buffer.from(captured.account.data[0], "base64");
const parkedT = measuredClock.unixTimestamp + 86_400n;
const derived = deriveLocalMint(original, setup.address, parkedT);
captured.account.data[0] = Buffer.from(derived).toString("base64");
await writeFile(resolve(dir, "accounts", KOX_MINT + ".json"), JSON.stringify(captured));
await writeFile(resolve(dir, "accounts", setup.address + ".json"), JSON.stringify({
  pubkey: setup.address, account: { lamports: 1_000_000_000, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, data: ["", "base64"] },
}));
const provenance = { sourceMintSha256: createHash("sha256").update(original).digest("hex"),
  derivedMintSha256: createHash("sha256").update(derived).digest("hex"),
  setupAuthority: setup.address, measuredClock, parkedT, configuredDelay: delay,
  changedFields: ["local ScaledUiAmount authority", "local effective timestamp"],
};
const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2);
await writeFile(resolve(dir, "provenance.json"), json(provenance));
await new Promise<void>((resolveDone, reject) => {
  const child = spawn(process.execPath, ["apps/phantom-local-feasibility/scripts/prepare-local.ts", "--reset-validator"], {
    cwd: root, env: { ...process.env, EQUITYGUARD_REPLAY_DIR: dir }, stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolveDone() : reject(new Error("Local fixture preparation failed")));
});
let armed: unknown = null;
let arming = false;
async function arm() {
  if (armed || arming) throw new Error("Activation already scheduled; reset before a new reproduction");
  arming = true;
  const snapshot = await fetchGuardSnapshot(rpc, KOX_MINT);
  const localT = localActivation(snapshot.clock.unixTimestamp, delay);
  if (snapshot.state.newMultiplierEffectiveTimestamp !== parkedT) throw new Error("Local mint was already changed");
  const multiplier = new DataView(snapshot.state.newMultiplier.buffer, snapshot.state.newMultiplier.byteOffset, 8).getFloat64(0, true);
  const ix = getUpdateMultiplierScaledUiMintInstruction({ mint: KOX_MINT, authority: setup, multiplier, effectiveTimestamp: localT });
  const latest = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
  const message = appendTransactionMessageInstructions([ix], setTransactionMessageLifetimeUsingBlockhash(latest,
    setTransactionMessageFeePayerSigner(setup, createTransactionMessage({ version: 0 }))));
  const signed = await signTransactionMessageWithSigners(message);
  assertLocalRpcUrl(LOCAL_RPC_URL);
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", skipPreflight: false }).send();
  for (let i = 0; i < 60; i++) {
    const statuses = await rpc.getSignatureStatuses([signature]).send();
    const status = statuses.value[0];
    if (status?.err) throw new Error("Local activation setup transaction failed");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
    if (i === 59) throw new Error("Local activation setup did not confirm");
    await new Promise(r => setTimeout(r, 250));
  }
  const after = await fetchGuardSnapshot(rpc, KOX_MINT);
  const originalState = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, original);
  if (after.state.newMultiplierEffectiveTimestamp !== localT ||
      !Buffer.from(after.state.multiplier).equals(Buffer.from(originalState.multiplier)) ||
      !Buffer.from(after.state.newMultiplier).equals(Buffer.from(originalState.newMultiplier))) {
    throw new Error("Setup changed captured multiplier bytes; reproduction refused");
  }
  armed = { localT, configuredDelay: delay, clock: snapshot.clock, confirmedClock: after.clock,
    setupSignature: getSignatureFromTransaction(signed), setupAuthority: setup.address,
    environment: "LOCAL_EXECUTION_REPRODUCTION" };
  await writeFile(resolve(dir, "activation.json"), json(armed));
  return armed;
}
const localOrigin = (origin: string | undefined) => origin === "http://127.0.0.1:4175" || origin === "http://localhost:4175";
async function body(req: import("node:http").IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error("Evidence payload too large");
  }
  return text;
}
/** Stores the browser proof beside the validator's own metadata for each signature. */
async function recordEvidence(payload: string) {
  const proof = JSON.parse(payload) as { stale?: { outcome?: { signature?: string } } | null; refreshed?: { outcome?: { signature?: string } } | null };
  const signatures = [proof.stale?.outcome?.signature, proof.refreshed?.outcome?.signature].filter((s): s is string => typeof s === "string");
  const ledger: Record<string, unknown> = {};
  for (const signature of signatures) {
    const response = await fetch(assertLocalRpcUrl(LOCAL_RPC_URL), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }) });
    ledger[signature] = ((await response.json()) as { result?: unknown }).result ?? null;
  }
  const file = resolve(dir, "run-" + new Date().toISOString().replace(/[:.]/g, "") + ".json");
  await writeFile(file, json({ environment: "LOCAL_EXECUTION_REPRODUCTION", armed, provenance, browserProof: proof, validatorMetadata: ledger }), { mode: 0o600 });
  return { file };
}
createServer(async (req, res) => {
  try {
    if (req.url === "/api/status") {
      res.setHeader("Content-Type", "application/json"); res.end(json({ ready: true, armed, provenance })); return;
    }
    if (req.url === "/api/arm" && req.method === "POST") {
      if (!localOrigin(req.headers.origin)) throw new Error("Local demo origin required");
      res.setHeader("Content-Type", "application/json"); res.end(json(await arm())); return;
    }
    if (req.url === "/api/evidence" && req.method === "POST") {
      if (!localOrigin(req.headers.origin)) throw new Error("Local demo origin required");
      res.setHeader("Content-Type", "application/json"); res.end(json(await recordEvidence(await body(req)))); return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(dist + "/")) throw new Error("Invalid path");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(json({ error: error instanceof Error ? error.message : "Local setup failed" }));
  }
}).listen(4175, "127.0.0.1", () => console.log("Local activation reproduction ready at http://127.0.0.1:4175"));
