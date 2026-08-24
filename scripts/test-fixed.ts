import 'dotenv/config';
import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { privateKeyToAccount } from 'viem/accounts';

const proxyUrl = process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
const account = privateKeyToAccount(privateKey as `0x${string}`);

// Test with both .env creds and derived creds
const envApiKey = process.env.CLOB_API_KEY!;
const envSecret = process.env.CLOB_API_SECRET!;
const envPassphrase = process.env.CLOB_API_PASSPHRASE!;

// Derived creds (from L1 derive-api-key)
const derivedApiKey = '3f30e2cf-f600-56c7-48e6-ec6228bbf94b';
const derivedSecret = 'mrgFMdLaj7yp4wEIwVjFae_2fVyAL0OtPihtRab0WX4=';
const derivedPassphrase = 'e2180f802e4b4356ebf3ac89c075950a0cfac84bef11aabdf88a9210ab4a1b97';

function urlSafeBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function createL2Sig(secret: string, timestamp: string, method: string, path: string, body?: string): string {
  const standardB64 = secret.replace(/-/g, '+').replace(/_/g, '/');
  const key = Buffer.from(standardB64, 'base64');
  // FIX: sign ONLY the bare path, no query string
  const message = body ? `${timestamp}${method}${path}${body}` : `${timestamp}${method}${path}`;
  const hmac = crypto.createHmac('sha256', key).update(message).digest();
  return urlSafeBase64(hmac);
}

async function tryBalance(label: string, creds: {apiKey: string, secret: string, passphrase: string}, address: string, assetType: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // FIX: sign only the bare path
  const path = '/balance-allowance';
  const method = 'GET';
  const sig = createL2Sig(creds.secret, timestamp, method, path);

  const headers: Record<string, string> = {
    'POLY_ADDRESS': address,
    'POLY_API_KEY': creds.apiKey,
    'POLY_PASSPHRASE': creds.passphrase,
    'POLY_TIMESTAMP': timestamp,
    'POLY_SIGNATURE': sig,
    'Content-Type': 'application/json',
  };

  // Query params sent separately, NOT in the signed path
  const url = `https://clob.polymarket.com${path}?asset_type=${assetType}`;

  try {
    const resp = await axios.get(url, { headers, httpsAgent: agent, timeout: 15000 });
    console.log(`  [${label}] OK address=${address} asset=${assetType} =>`, JSON.stringify(resp.data));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [${label}] FAIL:${status} address=${address} asset=${assetType} => ${errData}`);
    return null;
  }
}

async function main() {
  console.log('Signer address:', account.address);
  console.log('\n=== Testing with DERIVED credentials (bare path) ===');
  const addresses = [account.address];
  for (const addr of addresses) {
    for (const asset of ['COLLATERAL', 'USDC']) {
      await tryBalance('DERIVED', {apiKey: derivedApiKey, secret: derivedSecret, passphrase: derivedPassphrase}, addr, asset);
    }
  }

  console.log('\n=== Testing with .ENV credentials (bare path) ===');
  for (const asset of ['COLLATERAL', 'USDC']) {
    await tryBalance('ENV', {apiKey: envApiKey, secret: envSecret, passphrase: envPassphrase}, account.address, asset);
  }
}

main().catch(console.error);
