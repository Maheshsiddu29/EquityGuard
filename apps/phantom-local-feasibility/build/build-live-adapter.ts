/**
 * Bundles the proven local Phantom flow for the apps/web live demo.
 *
 * Same entry graph, same esbuild flags and same shims as `build.ts`, so the
 * adapter apps/web loads is the implementation this app already proved rather
 * than a re-expression of it. The only difference is the entry point
 * (`src/live-adapter.ts`) and the output location.
 *
 * The output is a build artifact under apps/web/public and is gitignored: it
 * exists only on a machine that has built it, which is also what keeps a
 * public production deployment free of it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = new URL("../", import.meta.url);
const ROOT = new URL("../../", APP);
const OUT = new URL("web/public/live-demo/", new URL("apps/", ROOT));

function main(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  execFileSync(
    fileURLToPath(new URL("node_modules/esbuild/bin/esbuild", ROOT)),
    [
      fileURLToPath(new URL("src/live-adapter.ts", APP)),
      "--bundle",
      `--outfile=${fileURLToPath(new URL("equityguard-live-adapter.js", OUT))}`,
      "--format=esm",
      "--target=es2023",
      "--platform=browser",
      "--sourcemap",
      `--alias:node:crypto=${fileURLToPath(new URL("../devnet-wallet-demo/src/crypto-shim.ts", APP))}`,
      `--inject:${fileURLToPath(new URL("../devnet-wallet-demo/src/buffer-shim.ts", APP))}`,
      "--define:process.env.NODE_ENV=\"production\"",
      "--define:global=window",
    ],
    { stdio: "inherit", cwd: fileURLToPath(ROOT) },
  );
  writeFileSync(new URL("README.txt", OUT), [
    "EquityGuard live-demo adapter — build output, not source.",
    "",
    "Built from apps/phantom-local-feasibility/src/live-adapter.ts by",
    "`npm run live-demo:build`. Loaded by apps/web /demo only when",
    "NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO=true and the page is on loopback.",
    "This directory is gitignored and must not be deployed publicly.",
    "",
  ].join("\n"));
  console.log(`EquityGuard live-demo adapter built: ${fileURLToPath(OUT)}`);
}

main();
