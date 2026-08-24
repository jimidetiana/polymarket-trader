import 'dotenv/config';
import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { privateKeyToAccount } from 'viem/accounts';

const proxyUrl = process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;

const account = privateKeyToAccount(privateKey as `0x${string}`);

// Derived credentials from L1 auth
const apiKey = '3f30e2cf-f600-56c7-48e6-ec6228bbf94b';
const secret = 'mrgFMdLaj7yp4wEIwVjFae_2fVyAL0OtPihtRab0WX4=';
const passphrase = 'e2180f802e4b4356ebf3ac89c075950a0cfac84bef11aabdf88a9210ab4a1b97';

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

async function main() {
  console.log('Signer address:', account.address);
  console.log('Proxy address:', proxyAddress);
  console.log('\n=== Testing with DERIVED credentials ===');

  const addresses = [account.address, proxyAddress].filter(Boolean);
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
