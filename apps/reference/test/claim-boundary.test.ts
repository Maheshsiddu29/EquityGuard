/**
 * The reference app is a renderer of precomputed evidence. These scans pin
 * that it cannot sign, send or reach a network from the browser, and that its
 * copy keeps the disclosures the claim boundary requires.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { embedState } from "../build/build.ts";
import { REPOSITORY_URL, renderPage } from "../build/page.ts";

const APP = new URL("../", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(APP, rel), "utf8");
const list = (dir: string) => readdirSync(join(APP, dir)).map((f) => `${dir}/${f}`);

const browserFiles = [...list("src"), ...list("web")].map((path) => ({ path, text: read(path) }));
const allFiles = [...browserFiles, ...list("build").map((path) => ({ path, text: read(path) }))];

test("nothing in the app signs, sends or builds transactions", () => {
  const forbidden = [
    /sendTransaction/,
    /sendRawTransaction/,
    /requestAirdrop/,
    /signTransaction/,
    /partiallySign/,
    /signBytes/,
    /sendAndConfirm/,
    /createSolanaRpc/,
    /createKeyPair/,
    /scripts\/devnet\/(send|config|cli)/,
    /process\.env/,
  ];
  for (const { path, text } of allFiles) {
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${path} matches ${pattern}`);
  }
});

test("the browser code has no network access and no package imports", () => {
  for (const { path, text } of browserFiles) {
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, /@solana\//, /@equityguard\//]) {
      assert.ok(!pattern.test(text), `${path} matches ${pattern}`);
    }
    for (const [, specifier] of text.matchAll(/^import .* from "([^"]+)";$/gm)) {
      assert.match(specifier as string, /^\.\/[\w-]+\.ts$/, `${path} imports ${specifier}`);
    }
  }
});

test("the preview server listens on loopback only", () => {
  const serve = read("build/serve.ts");
  assert.deepEqual([...serve.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => (m[1] as string).split(",")[1]?.trim()), ['"127.0.0.1"']);
});

/**
 * User-visible copy now spans the page fragments and the shell that wraps
 * them, so the disclosure scans read every one of them.
 */
const pageFragments = list("web").filter((path) => path.endsWith(".html"));
const copy = [...pageFragments, "build/page.ts", "src/app.ts", "build/derive-state.ts"]
  .map(read)
  .join("\n");

test("the copy keeps the required disclosures", () => {
  for (const phrase of [
    "Real recorded KOx state. An independently captured Jupiter route.",
    "From the recorded Sep 17 route fixture",
    "Recorded Solana mainnet KOx state",
    "Sep 17 mainnet-derived Jupiter route",
    "solana-test-validator",
    "Execution did not occur on Solana mainnet.",
    "Not a mainnet purchase.",
    "View live on-chain proof",
  ]) {
    assert.ok(copy.includes(phrase), `missing disclosure: ${phrase}`);
  }
});

test("the copy makes none of the out-of-bounds claims", () => {
  for (const pattern of [
    /best execution/i,
    /production[- ]ready(?!ness)/i,
    /audited by/i,
    /live on mainnet/i,
    /executed on mainnet/i,
    /mainnet execution/i,
    /deployed (?:to|on) mainnet/i,
    /any DEX/i,
    /any corporate action/i,
    /calibrated threshold/i,
    /cross-checked against a local/i,
    /same stale-phase payload was sent/i,
  ]) {
    assert.ok(!pattern.test(copy), `forbidden claim ${pattern}`);
  }
});

test("the rendered pages link out to nothing but the repository", () => {
  const rendered = pageFragments
    .map((fragment) =>
      renderPage({
        route: "/",
        title: "t",
        description: "d",
        main: read(fragment),
        scripts: ["/site.js"],
      }),
    )
    .join("\n");
  const outbound = new Set([...rendered.matchAll(/https?:\/\/[^"'\s)]+/g)].map((match) => match[0]));
  outbound.delete("http://www.w3.org/2000/svg");
  assert.deepEqual([...outbound], [REPOSITORY_URL]);
  // Anything else the shell points at stays on loopback.
  for (const [, href] of rendered.matchAll(/href="(\/\/[^"]+)"/g)) {
    assert.match(href as string, /^\/\/127\.0\.0\.1:\d+\//);
  }
});

test("embedded state cannot break out of its script tag", () => {
  const html = embedState("<head><!--EG_REFERENCE_STATE--></head>", { text: "</script><script>alert(1)</script>", dollar: "$&" });
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  assert.ok(html.includes('"dollar":"$&"'));
  assert.throws(() => embedState("<head></head>", {}), /placeholder/);
});
