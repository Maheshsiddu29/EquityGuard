/**
 * Agreement between the public web demo and the reviewed guard client.
 *
 * The web module is loaded at runtime. A static import would pull
 * apps/web/lib/devnet-public.ts into this package's TypeScript project, which
 * treats that file as CommonJS because apps/web does not set "type": "module".
 * These checks still run under root `npm test`, which installs workspace
 * dependencies. The apps/web test file must not import this package.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token-2022";

import { ActivationPhase, EQUITY_GUARD_DEVNET_PROGRAM_ID, SOLANA_GENESIS_HASH, type AssertSafeExecutionRequest } from "../src/index.ts";
import { buildGuardedTransferChecked } from "../src/downstream.ts";

const COMPONENT = new URL("../../../apps/web/components/demo/live-devnet-experience.tsx", import.meta.url);
const POLICY = new URL("../../../apps/web/lib/devnet-public.ts", import.meta.url);

interface WebDemo {
  readonly ActivationPhase: { readonly Pending: 0; readonly Activated: 1 };
  readonly DEMO_TRANSFER_RAW: bigint;
  readonly PUBLIC_GENESIS: {
    readonly "mainnet-beta": string;
    readonly devnet: string;
    readonly testnet: string;
  };
  bindReviewedProgram: (programId: Address) => void;
  buildPublicGuardedTransfer: (input: {
    readonly feePayer: Address;
    readonly mint: Address;
    readonly expectation: AssertSafeExecutionRequest;
    readonly transferChecked: Instruction;
  }) => { readonly instructions: readonly Instruction[]; readonly guard: Instruction };
  expectationForSnapshot: (snapshot: {
    readonly mint: Address;
    readonly contextSlot: bigint;
    readonly clock: { readonly slot: bigint; readonly unixTimestamp: bigint };
    readonly state: {
      readonly multiplier: Uint8Array;
      readonly newMultiplier: Uint8Array;
      readonly newMultiplierEffectiveTimestamp: bigint;
    };
    readonly phase: 0 | 1;
    readonly hasScheduledChange: boolean;
  }) => AssertSafeExecutionRequest;
  storedMultiplier: (value: number) => Uint8Array;
}

async function loadWebDemo(): Promise<WebDemo> {
  return import(POLICY.href) as Promise<WebDemo>;
}

test("the public web demo uses the reviewed Devnet genesis and program", async () => {
  const web = await loadWebDemo();
  assert.deepEqual(web.PUBLIC_GENESIS, SOLANA_GENESIS_HASH);
  assert.deepEqual(web.ActivationPhase, ActivationPhase);
  assert.equal(EQUITY_GUARD_DEVNET_PROGRAM_ID.length > 30, true);

  const component = readFileSync(COMPONENT, "utf8");
  const policy = readFileSync(POLICY, "utf8");
  const bound = component.match(/bindReviewedProgram\(address\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)\)/);
  assert.ok(bound, "Live Devnet component does not bind a reviewed program");
  assert.equal(bound[1], EQUITY_GUARD_DEVNET_PROGRAM_ID);
  assert.equal(policy.includes(EQUITY_GUARD_DEVNET_PROGRAM_ID), false);
});

test("the public guarded transfer matches the reviewed Token-2022 builder", async () => {
  const web = await loadWebDemo();
  web.bindReviewedProgram(EQUITY_GUARD_DEVNET_PROGRAM_ID);
  const wallet = address("GgBaCs3NGLqX87FtL4WQ6eqR5vUtdKQeKqHHB8SNn7z");
  const source = address("7w2MRSqKByxbNkYoXWR7vNC2D8yaZ3iPfZCVd4FcrBgT");
  const destination = address("ECrVumzWbWA4c352fohUimkUmRkYm6ubAuyU8hb3Yr3y");
  const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const activation = 90n;
  const view = {
    mint,
    contextSlot: 1n,
    clock: { slot: 1n, unixTimestamp: activation - 10n },
    state: {
      multiplier: web.storedMultiplier(1),
      newMultiplier: web.storedMultiplier(2),
      newMultiplierEffectiveTimestamp: activation,
    },
    phase: ActivationPhase.Pending,
    hasScheduledChange: true,
  };
  const transfer = getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: { address: wallet, signTransactions: async <T extends readonly unknown[]>(transactions: T) => transactions },
    amount: web.DEMO_TRANSFER_RAW,
    decimals: 6,
  });
  const expectation = web.expectationForSnapshot(view);
  const proven = buildGuardedTransferChecked({
    programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    feePayer: wallet,
    mint,
    expectation,
    transferChecked: transfer,
  });
  const pub = web.buildPublicGuardedTransfer({ feePayer: wallet, mint, expectation, transferChecked: transfer });
  assert.equal(pub.instructions.length, proven.instructions.length);
  assert.deepEqual(pub.guard.data, proven.guard.data);
  assert.equal(pub.guard.programAddress, EQUITY_GUARD_DEVNET_PROGRAM_ID);
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (value) => setTransactionMessageFeePayer(wallet, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, value),
    (value) => appendTransactionMessageInstructions(pub.instructions, value),
  );
  assert.equal(compileTransaction(message).messageBytes.length > 0, true);
});
