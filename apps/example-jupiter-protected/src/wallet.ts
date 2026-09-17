/**
 * The application's wallet, which EquityGuard never touches.
 *
 * `protectJupiterSwap` returns unsigned bytes; signing and sending stay behind
 * this interface, in the application's existing code. The implementation
 * shipped here deliberately does neither: this repository never submits a
 * transaction from an example.
 */

import type { Address } from "@solana/kit";

export interface Wallet {
  readonly publicKey: Address;
  /** In a real application: `wallet.signAndSendTransaction(transaction)`. */
  signAndSend(transaction: Uint8Array): Promise<string>;
}

/** A wallet that records what it was asked to sign and sends nothing. */
export class DryRunWallet implements Wallet {
  readonly publicKey: Address;
  /** Every transaction handed to the wallet, in order. */
  readonly signed: Uint8Array[] = [];

  constructor(publicKey: Address) {
    this.publicKey = publicKey;
  }

  signAndSend(transaction: Uint8Array): Promise<string> {
    this.signed.push(transaction);
    return Promise.resolve(`dry-run:${transaction.length}-bytes-unsent`);
  }
}
