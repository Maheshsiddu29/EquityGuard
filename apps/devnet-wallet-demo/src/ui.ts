/**
 * DOM UI controller for EquityGuard Devnet Wallet Demo.
 */

export function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) {
    throw new Error(`Element #${id} not found in document`);
  }
  return el;
}

export function updateBadge(id: string, text: string, type: 'success' | 'danger' | 'warning' | 'info'): void {
  const el = getElement<HTMLSpanElement>(id);
  el.textContent = text;
  el.className = `badge badge-${type}`;
}

export function updateWalletUI(address: string | null, balanceSol: number | null): void {
  const addressEl = getElement<HTMLSpanElement>('wallet-address');
  const balanceEl = getElement<HTMLSpanElement>('sol-balance');
  const connectBtn = getElement<HTMLButtonElement>('connect-btn');
  const faucetBtn = getElement<HTMLButtonElement>('faucet-btn');

  if (address) {
    addressEl.textContent = `${address.slice(0, 4)}...${address.slice(-4)}`;
    addressEl.title = address;
    connectBtn.textContent = 'Disconnect';
    connectBtn.className = 'btn-secondary';
    faucetBtn.disabled = false;
  } else {
    addressEl.textContent = 'Not connected';
    addressEl.title = '';
    balanceEl.textContent = '0.00';
    connectBtn.textContent = 'Connect Phantom';
    connectBtn.className = 'btn-primary';
    faucetBtn.disabled = true;
  }

  if (balanceSol !== null) {
    balanceEl.textContent = balanceSol.toFixed(4);
  }
}

export function updateAssetUI(mintAddress: string | null, tokenBalance: bigint | null, canCreate: boolean): void {
  const mintEl = getElement<HTMLSpanElement>('mint-address');
  const balanceEl = getElement<HTMLSpanElement>('token-balance');
  const createBtn = getElement<HTMLButtonElement>('create-asset-btn');
  const step1Btn = getElement<HTMLButtonElement>('step1-btn');
  const step2Btn = getElement<HTMLButtonElement>('step2-btn');
  const step3Btn = getElement<HTMLButtonElement>('step3-btn');

  if (mintAddress) {
    mintEl.textContent = `${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)}`;
    mintEl.title = mintAddress;
    createBtn.disabled = true;
    createBtn.textContent = 'Demo Asset Active';

    step1Btn.disabled = false;
    step2Btn.disabled = false;
    step3Btn.disabled = false;
  } else {
    mintEl.textContent = 'None';
    mintEl.title = '';
    balanceEl.textContent = '0';
    createBtn.disabled = !canCreate;
    createBtn.textContent = 'Create Demo Asset';

    step1Btn.disabled = true;
    step2Btn.disabled = true;
    step3Btn.disabled = true;
  }

  if (tokenBalance !== null) {
    // 6 decimals
    const whole = tokenBalance / 1_000_000n;
    const frac = (tokenBalance % 1_000_000n).toString().padStart(6, '0');
    balanceEl.textContent = `${whole}.${frac}`;
  }
}

export function renderResultCard(containerId: string, result: {
  status: 'ALLOW' | 'BLOCK' | 'REFRESH';
  signature?: string;
  error?: string;
  expectedMultiplier?: number;
  actualMultiplier?: number;
}): void {
  const container = getElement<HTMLDivElement>(containerId);
  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = `tx-result-card tx-${result.status.toLowerCase()}`;

  const header = document.createElement('div');
  header.className = 'tx-header';
  header.innerHTML = `<strong>Result:</strong> <span class="status-tag ${result.status.toLowerCase()}">${result.status}</span>`;
  card.appendChild(header);

  if (result.signature) {
    const sigDiv = document.createElement('div');
    sigDiv.className = 'tx-sig mono-text';
    sigDiv.innerHTML = `Sig: <a href="https://explorer.solana.com/tx/${result.signature}?cluster=devnet" target="_blank" rel="noopener">${result.signature.slice(0, 8)}...${result.signature.slice(-8)}</a>`;
    card.appendChild(sigDiv);
  }

  if (result.expectedMultiplier !== undefined) {
    const multDiv = document.createElement('div');
    multDiv.className = 'tx-details';
    multDiv.textContent = `Expected Multiplier: ${result.expectedMultiplier} | Actual: ${result.actualMultiplier ?? '1.0'}`;
    card.appendChild(multDiv);
  }

  if (result.error) {
    const errDiv = document.createElement('div');
    errDiv.className = 'tx-error mono-text';
    errDiv.textContent = `Error: ${result.error}`;
    card.appendChild(errDiv);
  }

  container.appendChild(card);
}

export function logActivity(msg: string, type: 'info' | 'success' | 'error' = 'info'): void {
  const logEl = getElement<HTMLDivElement>('activity-log');
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${timestamp}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}
