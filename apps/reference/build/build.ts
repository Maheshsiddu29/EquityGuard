#!/usr/bin/env node
/**
 * Builds the reference app into apps/reference/dist:
 *   1. derives the deterministic reference state from committed evidence,
 *   2. compiles the browser sources with the repo's TypeScript,
 *   3. writes index.html with the state embedded, plus the stylesheet.
 *
 *   npm run app:build
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveReferenceState } from "./derive-state.ts";

const APP = new URL("../", import.meta.url);
const DIST = new URL("dist/", APP);
const TSC = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", APP));
const PLACEHOLDER = "<!--EG_REFERENCE_STATE-->";

/** JSON embedded in a <script> must not be able to close it. */
export function embedState(html: string, state: unknown): string {
  if (!html.includes(PLACEHOLDER)) throw new Error("index.html has no state placeholder");
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return html.replace(PLACEHOLDER, () => `<script type="application/json" id="eg-reference-state">${json}</script>`);
}

function main() {
  const state = deriveReferenceState();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  execFileSync(process.execPath, [TSC, "--project", fileURLToPath(new URL("tsconfig.json", APP))], { stdio: "inherit" });
  const html = readFileSync(new URL("web/index.html", APP), "utf8");
  writeFileSync(new URL("index.html", DIST), embedState(html, state));
  copyFileSync(new URL("web/styles.css", APP), new URL("styles.css", DIST));
  console.log(`reference app built: ${fileURLToPath(DIST)}`);
  for (const scenario of Object.values(state.scenarios)) {
    const d = scenario.decision;
    console.log(`  ${scenario.id.padEnd(10)} ${d.type}${d.type === "ALLOW" ? "" : `: ${d.reason} (${d.guardResult})`}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
