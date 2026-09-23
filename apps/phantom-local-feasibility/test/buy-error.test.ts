import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SOLANA_ERROR__MALFORMED_NUMBER_STRING, SolanaError } from "@solana/errors";

import { formatTechnicalDetails, reusesStaleBlockhash } from "../src/buy-error.ts";
import { ReplaySimulationError, decodeLocalRpcFailure } from "../src/rpc-failure.ts";
import { traderFacingError } from "../src/trader-flow.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const GUARD = "EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT";

test("unknown thrown objects keep their fields and Error.message is never dropped", () => {
  const wallet = new Error("Unexpected error");
  Object.defineProperty(wallet, "code", { value: -32603 });
  assert.equal(JSON.stringify(wallet), "{}");
  const technical = formatTechnicalDetails(wallet, "SIGN_REQUEST");
  assert.match(technical, /Stage: SIGN_REQUEST/);
  assert.match(technical, /Type: Error/);
  assert.match(technical, /Message: Unexpected error/);
  assert.match(technical, /Code: -32603/);
  assert.notEqual(technical, "Unexpected error");

  const named = new Error("popup failed");
  named.name = "WalletConnectionError";
  Object.defineProperty(named, "code", { value: 4100 });
  const namedTechnical = formatTechnicalDetails(named, "PHANTOM_CONNECT");
  assert.match(namedTechnical, /Type: WalletConnectionError/);
  assert.match(namedTechnical, /Message: popup failed/);
  assert.match(namedTechnical, /Code: 4100/);

  const plain = { reason: "socket closed", code: "ECONNRESET" };
  const plainTechnical = formatTechnicalDetails(plain, "SUBMISSION");
  assert.match(plainTechnical, /Type: object/);
  assert.match(plainTechnical, /Message: socket closed/);
  assert.match(plainTechnical, /Code: ECONNRESET/);
});

test("Solana error context and RPC instruction errors stay readable", () => {
  const solana = new SolanaError(SOLANA_ERROR__MALFORMED_NUMBER_STRING, {
    value: "nope",
    cause: new Error("parser failed"),
  });
  const solanaTechnical = formatTechnicalDetails(solana, "TRANSACTION_BUILD");
  assert.equal(solana.name, "SolanaError");
  assert.match(solanaTechnical, /Stage: TRANSACTION_BUILD/);
  assert.match(solanaTechnical, /Type: SolanaError/);
  assert.ok(solanaTechnical.includes(solana.message));
  assert.match(solanaTechnical, /Code: 8/);
  assert.match(solanaTechnical, /Cause: Error: parser failed/);

  const rpc = {
    code: -32002,
    message: "Transaction simulation failed",
    data: {
      err: { InstructionError: [0, { Custom: 12 }] },
      logs: [`Program ${GUARD} invoke [1]`],
    },
  };
  const rpcTechnical = formatTechnicalDetails(rpc, "SIMULATION");
  assert.match(rpcTechnical, /Stage: SIMULATION/);
  assert.match(rpcTechnical, /RPC code: -32002/);
  assert.match(rpcTechnical, /Instruction: 0/);
  assert.match(rpcTechnical, /Custom":12/);
  assert.match(rpcTechnical, new RegExp(`Program ${GUARD} invoke`));

  const failure = decodeLocalRpcFailure(rpc, "sendRawTransaction", [GUARD]);
  const submitted = formatTechnicalDetails(new ReplaySimulationError(failure), "SUBMISSION");
  assert.match(submitted, /Stage: SUBMISSION/);
  assert.match(submitted, /Type: ReplaySimulationError/);
  assert.match(submitted, /RPC code: -32002/);
  assert.match(submitted, /Instruction: 0/);
  assert.match(submitted, new RegExp(`Program: ${GUARD}`));
  assert.match(submitted, /Error: ActivationPhaseChanged \(12 \/ 0xc\)/);
});

test("wallet rejection and buy stages map to the plain headlines", () => {
  const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
  assert.equal(traderFacingError("buy", rejected, "SIGN_REQUEST").headline, "Signature request cancelled.");
  assert.equal(traderFacingError("buy", new Error("validator down"), "SIMULATION").headline, "The protected order could not be validated.");
  assert.equal(traderFacingError("buy", new Error("rpc down"), "SUBMISSION").headline, "The order could not be submitted.");
  assert.equal(traderFacingError("confirm", new Error("not confirmed"), "CONFIRMATION").headline, "The transaction could not be confirmed.");
  assert.equal(
    traderFacingError("confirm", new Error("deltas missing"), "BALANCE_VERIFICATION").headline,
    "The transaction finished, but the result could not be verified.",
  );
  const staged = traderFacingError("buy", new Error("sign failed"), "SIGNED_BYTES_RETURNED");
  assert.match(staged.technical, /Stage: SIGNED_BYTES_RETURNED/);
  assert.match(staged.technical, /Message: sign failed/);
});

test("Unexpected error is the technical text only when the thrown value has no readable fields", () => {
  assert.equal(formatTechnicalDetails(undefined, "SUBMISSION"), "Unexpected error");
  assert.equal(formatTechnicalDetails(null, "SUBMISSION"), "Unexpected error");
  assert.equal(formatTechnicalDetails({}, "SIGN_REQUEST"), "Unexpected error");
  assert.equal(formatTechnicalDetails(new Error(""), "SIGN_REQUEST"), "Unexpected error");
  const stringThrow = formatTechnicalDetails("Unexpected error", "SIGN_REQUEST");
  assert.match(stringThrow, /Type: string/);
  assert.match(stringThrow, /Message: Unexpected error/);
  assert.notEqual(stringThrow, "Unexpected error");
});

test("development details include the stack and production details omit it", () => {
  const error = new Error("with stack");
  assert.match(formatTechnicalDetails(error, "SIGN_REQUEST", true), /Stack:/);
  assert.doesNotMatch(formatTechnicalDetails(error, "SIGN_REQUEST", false), /Stack:/);
});

test("a validator reset cannot reuse a cached blockhash or message", () => {
  const cached = { blockhash: "pre-reset", lastValidBlockHeight: 10n, messageBytes: Uint8Array.of(1, 2, 3) };
  assert.equal(reusesStaleBlockhash(cached, cached, "post-reset"), true);
  assert.equal(reusesStaleBlockhash(null, cached, "post-reset"), false);
  assert.equal(reusesStaleBlockhash(cached, cached, "pre-reset"), false);
  assert.equal(reusesStaleBlockhash(cached, {
    blockhash: "post-reset",
    lastValidBlockHeight: 80n,
    messageBytes: Uint8Array.of(9),
  }, "post-reset"), false);

  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/app.ts"), "utf8");
  const execution = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/replay-execution.ts"), "utf8");
  const buyError = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/buy-error.ts"), "utf8");
  assert.match(app, /runLocalActivation\(data, provider, localT/);
  assert.doesNotMatch(app, /state\.prepared|cachedBlockhash|lastValidBlockHeight/);
  assert.match(execution, /getLatestBlockhash\(\{ commitment: "confirmed" \}\)/);
  assert.match(execution, /onStage\?\.\("SIGN_REQUEST"\)/);
  assert.match(execution, /method: "signTransaction"/);
  assert.match(execution, /skipPreflightAllowed\(prepared\.kind\)/);
  assert.doesNotMatch(`${app}\n${execution}\n${buyError}`, /setMaxListeners|ObjectMultiplex/);
});
