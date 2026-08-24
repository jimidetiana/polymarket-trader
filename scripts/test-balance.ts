import 'dotenv/config';
import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { privateKeyToAccount } from 'viem/accounts';

const proxyUrl = process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const apiKey = process.env.CLOB_API_KEY!;
const secret = process.env.CLOB_API_SECRET!;
const passphrase = process.env.CLOB_API_PASSPHRASE!;
const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
const walletAddress = process.env.POLYMARKET_WALLET_ADDRESS!;
const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;

const account = privateKeyToAccount(privateKey as `0x${string}`);
console.log('Signer address:', account.address);
console.log('Wallet address:', walletAddress);
console.log('Proxy address:', proxyAddress);
console.log('API key:', apiKey);
console.log('Secret:', secret);
console.log('Passphrase:', passphrase);

function urlSafeBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function createL2Sig(secret: string, timestamp: string, method: string, path: string, body?: string): string {
  const standardB64 = secret.replace(/-/g, '+').replace(/_/g, '/');
  const key = Buffer.from(standardB64, 'base64');
  const message = body ? `${timestamp}${method}${path}${body}` : `${timestamp}${method}${path}`;
  const hmac = crypto.createHmac('sha256', key).update(message).digest();
  return urlSafeBase64(hmac);
}

async function tryBalance(address: string, assetType: string, sigType?: number) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let path = `/balance-allowance?asset_type=${assetType}`;
  if (sigType !== undefined) {
    path += `&signature_type=${sigType}`;
  }
  const method = 'GET';
  const sig = createL2Sig(secret, timestamp, method, path);

  const headers: Record<string, string> = {
    'POLY_ADDRESS': address,
    'POLY_API_KEY': apiKey,
    'POLY_PASSPHRASE': passphrase,
    'POLY_TIMESTAMP': timestamp,
    'POLY_SIGNATURE': sig,
    'Content-Type': 'application/json',
  };

  try {
    const resp = await axios.get(`https://clob.polymarket.com${path}`, {
      headers,
      httpsAgent: agent,
      timeout: 15000,
    });
    console.log(`  [OK] address=${address}, asset=${assetType}, sigType=${sigType ?? 'none'} =>`, JSON.stringify(resp.data));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [FAIL:${status}] address=${address}, asset=${assetType}, sigType=${sigType ?? 'none'} => ${errData}`);
    return null;
  }
}

async function tryDeriveKey(address: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';
  const typedData = {
    domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
    types: {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    primaryType: 'ClobAuth' as const,
    message: {
      address,
      timestamp,
      nonce: BigInt(nonce),
      message: 'This message attests that I control the given wallet',
    },
  };
  const signature = await account.signTypedData(typedData);

  const headers = {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce,
  };

  try {
    const resp = await axios.get('https://clob.polymarket.com/auth/derive-api-key', {
      headers,
      httpsAgent: agent,
      timeout: 15000,
    });
    console.log(`  [DERIVE OK] address=${address} =>`, JSON.stringify(resp.data));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [DERIVE FAIL:${status}] address=${address} => ${errData}`);
    return null;
  }
}

async function main() {
  console.log('\n=== Testing L1 derive API key ===');
  await tryDeriveKey(account.address);

  console.log('\n=== Testing L2 balance-allowance ===');
  const addresses = [account.address, walletAddress, proxyAddress].filter(Boolean) as string[];
  const assetTypes = ['COLLATERAL', 'USDC'];
  const sigTypes = [undefined, 0, 1, 2];

  for (const addr of addresses) {
    for (const asset of assetTypes) {
      for (const sigType of sigTypes) {
        await tryBalance(addr, asset, sigType);
      }
    }
  }
}

main().catch(console.error);
