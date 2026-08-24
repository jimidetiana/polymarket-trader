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
  funderAddress?: Address,
): Promise<string> {
  const address = funderAddress ?? signer.address;
  const typedData = buildClobAuthTypedData(address, timestamp, nonce);
  return signer.signTypedData(typedData);
}

export async function getOrCreateClobCredentials(
  signer: PrivateKeyAccount,
  clobUrl: string,
  nonce = 0,
  funderAddress?: Address,
): Promise<ClobCredentials> {
  const http = createHttpClient({ baseURL: clobUrl });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = nonce.toString();
  const signature = await createL1Signature(signer, timestamp, nonceStr, funderAddress);

  // When funderAddress (proxy wallet) is provided, POLY_ADDRESS must be the proxy
  // so the API key gets bound to the proxy address (POLY_1271 / sig_type=3).
  const polyAddress = funderAddress ?? signer.address;

  const headers = {
    POLY_ADDRESS: polyAddress,
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
  // Convert URL-safe base64 to standard base64 before decoding
  const standardBase64 = secret.replace(/-/g, '+').replace(/_/g, '/');
  const key = Buffer.from(standardBase64, 'base64');
  const message = body ? `${timestamp}${method}${path}${body}` : `${timestamp}${method}${path}`;
  const hmac = crypto.createHmac('sha256', key).update(message).digest();
  return urlSafeBase64WithPadding(hmac);
}
