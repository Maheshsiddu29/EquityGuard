import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expectationView, loadKoxTradeEvidence } from "../../../scripts/demo/kox-trade-evidence.ts";
import {
  KOX_DECIMALS,
  REFRESHED_AUTHORIZATION_SOURCE,
  STALE_AUTHORIZATION_SOURCE,
} from "../src/local-funding.ts";

const APP = new URL("../", import.meta.url);
const ROOT = new URL("../../", APP);
const DIST = new URL("dist/", APP);

function writeSealedAuthorizations(): void {
  const evidence = loadKoxTradeEvidence();
  if (evidence.asset.decimals !== KOX_DECIMALS) throw new Error("sealed KOx decimals are not 8");
  const payload = {
    stale: {
      source: STALE_AUTHORIZATION_SOURCE,
      authorization: expectationView(evidence.pre.expectation),
      slot: String(evidence.pre.source.slot),
      blockTime: evidence.pre.source.blockTime,
      observedAt: evidence.pre.source.wallclock,
    },
    refreshed: {
      source: REFRESHED_AUTHORIZATION_SOURCE,
      authorization: expectationView(evidence.post.expectation),
      slot: String(evidence.post.source.slot),
      blockTime: evidence.post.source.blockTime,
      observedAt: evidence.post.source.wallclock,
    },
    asset: evidence.asset,
    scheduledActivation: evidence.pre.expectation.expected.newMultiplierEffectiveTimestamp.toString(),
  };
  writeFileSync(new URL("sealed-authorizations.json", DIST), `${JSON.stringify(payload, null, 2)}\n`);
}

function main(): void {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  execFileSync(
    fileURLToPath(new URL("node_modules/esbuild/bin/esbuild", ROOT)),
    [
      fileURLToPath(new URL("src/app.ts", APP)),
      "--bundle",
      `--outfile=${fileURLToPath(new URL("app.js", DIST))}`,
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
  copyFileSync(new URL("web/index.html", APP), new URL("index.html", DIST));
  copyFileSync(new URL("../../tmp/m9d-c1/route-fixture.json", APP), new URL("route-fixture.json", DIST));
  writeSealedAuthorizations();
  const shared = readFileSync(new URL("../shared/equityguard.css", APP), "utf8");
  const local = readFileSync(new URL("web/styles.css", APP), "utf8");
  writeFileSync(new URL("styles.css", DIST), `${shared}\n${local}`);
  console.log(`Phantom local feasibility app built: ${fileURLToPath(DIST)}`);
}

main();
