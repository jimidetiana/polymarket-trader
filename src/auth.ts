import crypto from 'node:crypto';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Address } from 'viem';
import type { ClobCredentials } from './types.js';
import { CHAIN_ID, urlSafeBase64WithPadding } from './utils.js';
import { createHttpClient } from './proxy.js';

export function buildClobAuthTypedData(address: Address, timestamp: string, nonce: string) {
  return {
    domain: {
      name: 'ClobAuthDomain',
      version: '1',
      chainId: CHAIN_ID,
    },
    types: {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    } as const,
    primaryType: 'ClobAuth' as const,
    message: {
      address,
      timestamp,
      nonce: BigInt(nonce),
      message: 'This message attests that I control the given wallet',
    },
  };
}

export async function createL1Signature(
  signer: PrivateKeyAccount,
  timestamp: string,
  nonce: string,
): Promise<string> {
  const typedData = buildClobAuthTypedData(signer.address, timestamp, nonce);
  return signer.signTypedData(typedData);
}

export async function getOrCreateClobCredentials(
  signer: PrivateKeyAccount,
  clobUrl: string,
  nonce = 0,
): Promise<ClobCredentials> {
  const http = createHttpClient({ baseURL: clobUrl });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = nonce.toString();
  const signature = await createL1Signature(signer, timestamp, nonceStr);

  const headers = {
    POLY_ADDRESS: signer.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonceStr,
  };

  // Try to derive existing credentials first.
  try {
    const derive = await http.get('/auth/derive-api-key', { headers });
    return derive.data as ClobCredentials;
  } catch (err) {
    // Fallback to creating fresh credentials.
    const create = await http.post('/auth/api-key', {}, { headers });
    return create.data as ClobCredentials;
  }
}

export function createL2Signature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body?: string,
): string {
  const key = Buffer.from(secret, 'base64');
  const message = body ? `${timestamp}${method}${path}${body}` : `${timestamp}${method}${path}`;
  const hmac = crypto.createHmac('sha256', key).update(message).digest();
  return urlSafeBase64WithPadding(hmac);
}
