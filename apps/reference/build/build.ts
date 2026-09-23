#!/usr/bin/env node
/**
 * Builds the reference site into apps/reference/dist:
 *   1. derives the deterministic reference state from committed evidence,
 *   2. compiles the browser sources with the repo's TypeScript,
 *   3. renders every route through the shared shell, embedding the state in
 *      the one page that reads it,
 *   4. writes the concatenated stylesheet and the self-hosted typeface.
 *
 *   npm run app:build
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveReferenceState } from "./derive-state.ts";
import { ROUTES, STATE_PLACEHOLDER, renderPage } from "./page.ts";

const APP = new URL("../", import.meta.url);
const DESIGN_SYSTEM = new URL("../shared/design-system/", APP);
const DIST = new URL("dist/", APP);
const TSC = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", APP));

/** Cascade order: tokens, then the layers that read them, then page styles. */
const DESIGN_SYSTEM_CSS = ["tokens.css", "base.css", "layout.css", "components.css", "motion.css"];
const PAGE_CSS = ["pages.css", "demo.css"];
const FONTS = ["geist-sans-latin.woff2", "geist-mono-latin.woff2"];

/** JSON embedded in a <script> must not be able to close it. */
export function embedState(html: string, state: unknown): string {
  if (!html.includes(STATE_PLACEHOLDER)) throw new Error("index.html has no state placeholder");
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return html.replace(
    STATE_PLACEHOLDER,
    () => `<script type="application/json" id="eg-reference-state">${json}</script>`,
  );
}

interface PageDefinition {
  readonly route: string;
  readonly fragment: string;
  readonly title: string;
  readonly description: string;
  readonly scripts: readonly string[];
  readonly withStateSlot?: boolean;
}

/**
 * The three primary routes. `/demo` is the only page that reads derived
 * evidence, so it is the only one carrying the state slot and app.js.
 */
const PAGES: readonly PageDefinition[] = [
  {
    route: "/",
    fragment: "index.html",
    title: "EquityGuard · Corporate-action-aware execution",
    description:
      "EquityGuard checks a tokenized equity's economic state at execution time, in the same transaction as the trade.",
    scripts: ["/site.js"],
  },
  {
    route: "/demo",
    fragment: "demo.html",
    title: "EquityGuard · Protected KOx Trade Replay",
    description:
      "Replay an evidence-linked protected KOx purchase through EquityGuard, Jupiter, and Whirlpool.",
    scripts: ["/site.js", "/app.js"],
    withStateSlot: true,
  },
  {
    route: "/docs",
    fragment: "docs.html",
    title: "EquityGuard · Documentation",
    description: "Technical documentation for integrating EquityGuard.",
    scripts: ["/site.js"],
  },
];

function outputFor(route: string): string {
  const match = ROUTES.find((candidate) => candidate.path === route);
  if (!match) throw new Error(`page ${route} is not a declared route`);
  return match.output;
}

function writeStylesheet(): void {
  const parts = [
    ...DESIGN_SYSTEM_CSS.map((file) => readFileSync(new URL(file, DESIGN_SYSTEM), "utf8")),
    ...PAGE_CSS.map((file) => readFileSync(new URL(`web/${file}`, APP), "utf8")),
  ];
  writeFileSync(new URL("styles.css", DIST), parts.join("\n"));
}

function copyFonts(): void {
  mkdirSync(new URL("fonts/", DIST), { recursive: true });
  for (const font of FONTS) {
    copyFileSync(new URL(`fonts/${font}`, DESIGN_SYSTEM), new URL(`fonts/${font}`, DIST));
  }
}

function main() {
  const state = deriveReferenceState();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  execFileSync(process.execPath, [TSC, "--project", fileURLToPath(new URL("tsconfig.json", APP))], {
    stdio: "inherit",
  });

  for (const page of PAGES) {
    const shell = renderPage({
      route: page.route,
      title: page.title,
      description: page.description,
      main: readFileSync(new URL(`web/${page.fragment}`, APP), "utf8"),
      scripts: page.scripts,
      ...(page.withStateSlot === true ? { withStateSlot: true } : {}),
    });
    const html = page.withStateSlot === true ? embedState(shell, state) : shell;
    const target = new URL(outputFor(page.route), DIST);
    mkdirSync(dirname(fileURLToPath(target)), { recursive: true });
    writeFileSync(target, html);
  }

  writeStylesheet();
  copyFonts();
  console.log(`reference site built: ${fileURLToPath(DIST)}`);
  console.log(`  routes     ${ROUTES.map((route) => route.path).join("  ")}`);
  console.log(`  stale      ${state.staleExecution.equityGuard} · Jupiter ${state.staleExecution.jupiter}`);
  console.log(`  refreshed  ${state.refreshedExecution.equityGuard} · Jupiter ${state.refreshedExecution.jupiter}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
