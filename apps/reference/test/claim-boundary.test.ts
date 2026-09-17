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
    /scripts\/replay\//,
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

const copy = [read("web/index.html"), read("src/app.ts"), read("build/derive-state.ts")].join("\n");

test("the copy keeps the required disclosures", () => {
  for (const phrase of [
    "Reference integration",
    "nothing is signed",
    "What this demo does not prove",
    "EquityGuard running on mainnet, or a real purchase. It is deployed on devnet only.",
    "A guarded Jupiter trade on devnet",
    "A real cross-issuer reroute",
    "Not a real reroute",
    "Not the Sep 15 event.",
    "A trade that crossed the Sep 15 event. The local replay ran two days later.",
    "Separate test",
    "uncalibrated demo value",
    "has not been externally audited",
    "Illustrative",
    "Recorded read-only from Solana mainnet",
    "local validator",
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

test("embedded state cannot break out of its script tag", () => {
  const html = embedState("<head><!--EG_REFERENCE_STATE--></head>", { text: "</script><script>alert(1)</script>", dollar: "$&" });
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  assert.ok(html.includes('"dollar":"$&"'));
  assert.throws(() => embedState("<head></head>", {}), /placeholder/);
});
