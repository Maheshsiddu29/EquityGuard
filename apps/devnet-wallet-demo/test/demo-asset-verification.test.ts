import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { address, appendTransactionMessageInstructions, compileTransaction, createAddressWithSeed, createTransactionMessage, generateKeyPairSigner, getBase58Decoder, getBase58Encoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type TransactionSigner } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { getCreateDestinationAtaInstruction, getCreateDemoMintInstructions, getMintToWalletInstructions, verifyDemoMintAccount, verifyDemoTokenAccountOwners } from "../src/demo-asset.ts";
import { encodePhantomTransaction, verifyWalletSignedTransaction } from "../src/live-execution.ts";

function validDemoMint(): Uint8Array {
  const data = new Uint8Array(226);
  const view = new DataView(data.buffer);
  data[44] = 6;
  data[45] = 1;
  data[165] = 1;
  view.setUint16(166, 25, true);
  view.setUint16(168, 56, true);
  view.setFloat64(202, 1, true);
  view.setBigInt64(210, 0n, true);
  view.setFloat64(218, 1, true);
  return data;
}

describe("post-confirmation demo asset verification", () => {
  it("builds a valid seeded setup transaction with only the wallet signer", async () => {
    const wallet = address("GgBaCs3NGLqX87FtL4WQ6eqR5vUtdKQeKqHHB8SNn7z");
    const signer: TransactionSigner = { address: wallet, signTransactions: async (transactions) => transactions };
    const seed = "eg-0123456789abcdef";
    const mint = await createAddressWithSeed({ baseAddress: wallet, seed, programAddress: TOKEN_2022_PROGRAM_ADDRESS });
    const recipient = await generateKeyPairSigner();
    const instructions = [
      ...getCreateDemoMintInstructions({ payer: signer, mintAddress: mint, seed, rentLamports: 2_000_000n }),
      ...await getMintToWalletInstructions({ payer: signer, mint, owner: wallet, amount: 1_000_000n }),
      await getCreateDestinationAtaInstruction({ payer: signer, mint, recipient: recipient.address }),
    ];
    const message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (value) => setTransactionMessageFeePayer(wallet, value),
      (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, value),
      (value) => appendTransactionMessageInstructions(instructions, value),
    );
    const transaction = compileTransaction(message);
    assert.deepEqual(Object.keys(transaction.signatures), [wallet]);
    assert.equal(instructions.length, 6);
    assert.equal(instructions[0]?.programAddress, "11111111111111111111111111111111");
    assert.equal(instructions[1]?.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
    assert.equal(instructions[2]?.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
    assert.ok(transaction.messageBytes.length < 1_168);
    const phantomWireBytes = getBase58Encoder().encode(encodePhantomTransaction(transaction));
    assert.equal(phantomWireBytes.length, transaction.messageBytes.length + 65);
    assert.equal(phantomWireBytes[0], 1);
    assert.deepEqual(phantomWireBytes.slice(1, 65), new Uint8Array(64));
    assert.deepEqual(phantomWireBytes.slice(65), transaction.messageBytes);

    const signedWireBytes = Uint8Array.from(phantomWireBytes);
    signedWireBytes.fill(7, 1, 65);
    assert.deepEqual(verifyWalletSignedTransaction(transaction, signedWireBytes), {
      signature: getBase58Decoder().decode(signedWireBytes.slice(1, 65)),
      guardInstructionIndex: 0,
    });
    const changedMessage = Uint8Array.from(signedWireBytes);
    changedMessage[changedMessage.length - 1] = (changedMessage.at(-1) ?? 0) ^ 1;
    assert.throws(() => verifyWalletSignedTransaction(transaction, changedMessage), /changed a protected transaction instruction/);
    assert.throws(() => verifyWalletSignedTransaction(transaction, Uint8Array.from(phantomWireBytes)), /unsigned transaction/);

    const computeLimit = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: Uint8Array.of(2, 200, 0, 0, 0) };
    const computePrice = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) };
    const walletAdjustedMessage = pipe(
      createTransactionMessage({ version: "legacy" }),
      (value) => setTransactionMessageFeePayer(wallet, value),
      (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, value),
      (value) => appendTransactionMessageInstructions([computeLimit, computePrice, ...instructions], value),
    );
    const walletAdjustedWire = Uint8Array.from(getBase58Encoder().encode(encodePhantomTransaction(compileTransaction(walletAdjustedMessage))));
    walletAdjustedWire.fill(9, 1, 65);
    assert.deepEqual(verifyWalletSignedTransaction(transaction, walletAdjustedWire), {
      signature: getBase58Decoder().decode(walletAdjustedWire.slice(1, 65)),
      guardInstructionIndex: 2,
    });
  });

  it("accepts only the expected initialized ScaledUiAmount mint", () => {
    assert.doesNotThrow(() => verifyDemoMintAccount(TOKEN_2022_PROGRAM_ADDRESS, validDemoMint()));
  });

  it("rejects a mint owned by the wrong program", () => {
    assert.throws(() => verifyDemoMintAccount("11111111111111111111111111111111", validDemoMint()), /not Token-2022/);
  });

  it("rejects a mint with no ScaledUiAmount extension", () => {
    const mint = validDemoMint().slice(0, 82);
    assert.throws(() => verifyDemoMintAccount(TOKEN_2022_PROGRAM_ADDRESS, mint), /no extensions/);
  });

  it("rejects missing or wrong Token-2022 ATA ownership", () => {
    assert.doesNotThrow(() => verifyDemoTokenAccountOwners(TOKEN_2022_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS));
    assert.throws(() => verifyDemoTokenAccountOwners("11111111111111111111111111111111", TOKEN_2022_PROGRAM_ADDRESS), /Source ATA owner/);
    assert.throws(() => verifyDemoTokenAccountOwners(TOKEN_2022_PROGRAM_ADDRESS, "11111111111111111111111111111111"), /Destination ATA owner/);
  });
});
