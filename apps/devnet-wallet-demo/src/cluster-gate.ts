import { createSolanaRpc } from '@solana/kit';
import {
  SOLANA_GENESIS_HASH,
  clusterFromGenesisHash,
  REVIEWED_GUARD_DEPLOYMENTS,
  verifyReviewedGuardDeployment,
  findReviewedGuardDeployment,
  type LoaderAccountView,
  EQUITY_GUARD_DEVNET_PROGRAM_ID
} from '@equityguard/guard-client';

export {
  SOLANA_GENESIS_HASH,
  clusterFromGenesisHash,
  REVIEWED_GUARD_DEPLOYMENTS,
  verifyReviewedGuardDeployment,
  findReviewedGuardDeployment,
  type LoaderAccountView
};

export const DEVNET_GENESIS_HASH = SOLANA_GENESIS_HASH.devnet;
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export interface ClusterVerification {
  verified: boolean;
  genesisHash: string;
  cluster: string;
  reason?: string;
}

export async function verifyDevnetCluster(rpcUrl: string): Promise<ClusterVerification> {
  const rpc = createSolanaRpc(rpcUrl);
  const genesisHash = await rpc.getGenesisHash().send();
  const cluster = clusterFromGenesisHash(genesisHash) || 'unknown';

  if (genesisHash === DEVNET_GENESIS_HASH) {
    return { verified: true, genesisHash, cluster };
  }

  let reason = `Unknown cluster (genesis: ${genesisHash}) — only devnet is supported`;
  if (cluster === 'mainnet-beta') {
    reason = 'Connected to mainnet-beta — refusing all state-changing actions';
  } else if (cluster === 'testnet') {
    reason = 'Connected to testnet — only devnet is supported';
  }

  return { verified: false, genesisHash, cluster, reason };
}

export interface DeploymentVerification {
  verified: boolean;
  programAddress: string;
  reason?: string;
}

export async function verifyEquityGuardDeployment(rpcUrl: string): Promise<DeploymentVerification> {
  const deployment = findReviewedGuardDeployment(EQUITY_GUARD_DEVNET_PROGRAM_ID);
  if (!deployment) {
    return {
      verified: false,
      programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
      reason: 'No reviewed deployment found for devnet program ID'
    };
  }

  const rpc = createSolanaRpc(rpcUrl);
  const accountsResponse = await rpc.getMultipleAccounts(
    [EQUITY_GUARD_DEVNET_PROGRAM_ID as any, deployment.programDataAddress as any],
    { encoding: 'base64' }
  ).send();

  const programAccountInfo = accountsResponse.value[0];
  const programDataAccountInfo = accountsResponse.value[1];

  if (!programAccountInfo) {
    return {
      verified: false,
      programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
      reason: 'Program account not found on chain'
    };
  }
  if (!programDataAccountInfo) {
    return {
      verified: false,
      programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
      reason: 'Program data account not found on chain'
    };
  }

  const pData = programAccountInfo.data[0] as string;
  const pdData = programDataAccountInfo.data[0] as string;

  const programAccount: LoaderAccountView = {
    executable: programAccountInfo.executable,
    owner: programAccountInfo.owner,
    data: Uint8Array.from(atob(pData), c => c.charCodeAt(0))
  };

  const programDataAccount: LoaderAccountView = {
    executable: programDataAccountInfo.executable,
    owner: programDataAccountInfo.owner,
    data: Uint8Array.from(atob(pdData), c => c.charCodeAt(0))
  };

  try {
    const isVerified = await verifyReviewedGuardDeployment(deployment, programAccount, programDataAccount);
    if (isVerified) {
      return { verified: true, programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID };
    }
    return {
      verified: false,
      programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
      reason: 'Deployment verification failed: hash mismatch or invalid state'
    };
  } catch (error: any) {
    return {
      verified: false,
      programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
      reason: `Deployment verification failed with error: ${error.message}`
    };
  }
}
