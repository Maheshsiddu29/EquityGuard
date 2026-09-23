import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeInstructionError, decodeLocalRpcFailure, formatFailureHeadline } from "../src/rpc-failure.ts";

const PROGRAMS = [
  "EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT",
  "ComputeBudget111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
];

test("decodes Jupiter InsufficientFunds from local -32002 simulation data", () => {
  const failure = decodeLocalRpcFailure({
    code: -32002,
    message: "Transaction simulation failed",
    data: {
      err: { InstructionError: [4, { Custom: 6024 }] },
      logs: [
        "Program EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT invoke [1]",
        "Program log: EquityGuard: safe",
        "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
        "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1788",
      ],
      unitsConsumed: 16693,
      replacementBlockhash: null,
    },
  }, "simulation", PROGRAMS);
  assert.equal(failure.rpcCode, -32002);
  assert.equal(failure.failedInstruction, 4);
  assert.equal(failure.program, PROGRAMS[4]);
  assert.equal(failure.customCode, 6024);
  assert.equal(failure.customName, "InsufficientFunds");
  assert.match(formatFailureHeadline(failure), /Instruction: 4/);
  assert.match(formatFailureHeadline(failure), /InsufficientFunds \(6024 \/ 0x1788\)/);
});

test("maps EquityGuard custom 12 without collapsing it into a generic RPC error", () => {
  const decoded = decodeInstructionError({ InstructionError: [0, { Custom: 12 }] }, PROGRAMS);
  assert.equal(decoded.failedInstruction, 0);
  assert.equal(decoded.customName, "ActivationPhaseChanged");
});
