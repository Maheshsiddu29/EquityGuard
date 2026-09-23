/** Starts the local reproduction coordinator; no wallet key is read or persisted. */
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(new URL("../../../", import.meta.url).pathname);
try {
  for (const pid of execFileSync("lsof", ["-tiTCP:4175", "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)) process.kill(Number(pid), "SIGTERM");
} catch (error) {
  if (!(error instanceof Error)) throw error;
}
// Bootstrap from the unmodified reviewed fixture to read an authoritative Clock.
await new Promise<void>((done, reject) => {
  const child = spawn(process.execPath, ["apps/phantom-local-feasibility/scripts/prepare-local.ts", "--reset-validator"], { cwd: root, stdio: "inherit" });
  child.on("error", reject); child.on("exit", code => code === 0 ? done() : reject(new Error("Bootstrap failed")));
});
await mkdir(resolve(root, "tmp/phantom-activation"), { recursive: true });
const log = openSync(resolve(root, "tmp/phantom-activation/server.log"), "w", 0o600);
const server = spawn(process.execPath, ["apps/phantom-local-feasibility/server/activation-server.ts"], { cwd: root, env: process.env, detached: true, stdio: ["ignore", log, log] });
server.unref(); closeSync(log);
for (let i = 0; i < 480; i++) {
  try {
    const result = await fetch("http://127.0.0.1:4175/api/status").then(r => r.json()) as { ready?: boolean };
    if (result.ready) { console.log("Local reproduction ready: http://127.0.0.1:4175; activation begins only on Start."); process.exit(0); }
  } catch { /* wait for local validator reset */ }
  await new Promise(r => setTimeout(r, 500));
}
throw new Error("Local reproduction did not start; inspect tmp/phantom-activation/server.log");
