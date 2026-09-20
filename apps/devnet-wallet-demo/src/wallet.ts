export interface PhantomProvider {
  readonly isPhantom: boolean;
  readonly publicKey: { toBase58(): string; toBytes(): Uint8Array } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string; toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: unknown): Promise<unknown>;
  signAndSendTransaction(transaction: unknown, options?: { skipPreflight?: boolean }): Promise<{ signature: string }>;
  request(input: {
    readonly method: "signAndSendTransaction" | "signTransaction";
    readonly params: {
      readonly message: string;
      readonly options?: { readonly skipPreflight?: boolean };
    };
  }): Promise<unknown>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    phantom?: {
      solana?: PhantomProvider;
    };
  }
}

export function detectPhantom(): PhantomProvider | null {
  if (typeof window !== 'undefined' && window.phantom?.solana?.isPhantom) {
    return window.phantom.solana;
  }
  return null;
}

export async function connectPhantomWallet(): Promise<{ provider: PhantomProvider; publicKey: string }> {
  const provider = detectPhantom();
  if (!provider) {
    throw new Error('Phantom wallet not found');
  }
  const resp = await provider.connect();
  return {
    provider,
    publicKey: resp.publicKey.toBase58()
  };
}

export async function disconnectWallet(provider: PhantomProvider): Promise<void> {
  await provider.disconnect();
}

export async function getWalletPublicKey(provider: PhantomProvider): Promise<string> {
  if (provider.publicKey) {
    return provider.publicKey.toBase58();
  }
  const resp = await provider.connect({ onlyIfTrusted: true });
  return resp.publicKey.toBase58();
}
