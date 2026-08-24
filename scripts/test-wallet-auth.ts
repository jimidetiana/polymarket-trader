import 'dotenv/config';
import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { privateKeyToAccount } from 'viem/accounts';

const proxyUrl = process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
const account = privateKeyToAccount(privateKey as `0x${string}`);

// Wallet address that holds funds (smart wallet, controlled by signer)
const walletAddr = '0x24a9886579b61C8a32F809F2C7194770939EfDd3';
const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS!;

// Derive credentials via L1
async function deriveCreds(signer: any) {
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
      address: signer.address,
      timestamp,
      nonce: BigInt(nonce),
      message: 'This message attests that I control the given wallet',
    },
  };
  const signature = await signer.signTypedData(typedData);

  const headers = {
    POLY_ADDRESS: signer.address,
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
    return resp.data;
  } catch (err: any) {
    console.error('Derive failed:', err.response?.data?.error || err.message);
    throw err;
  }
}

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

async function tryBalance(creds: any, polyAddress: string, assetType: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = '/balance-allowance';
  const method = 'GET';
  const sig = createL2Sig(creds.secret, timestamp, method, path);

  const headers: Record<string, string> = {
    'POLY_ADDRESS': polyAddress,
    'POLY_API_KEY': creds.apiKey,
    'POLY_PASSPHRASE': creds.passphrase,
    'POLY_TIMESTAMP': timestamp,
    'POLY_SIGNATURE': sig,
    'Content-Type': 'application/json',
  };

  const url = `https://clob.polymarket.com${path}?asset_type=${assetType}`;

  try {
    const resp = await axios.get(url, { headers, httpsAgent: agent, timeout: 15000 });
    console.log(`  [OK] POLY_ADDRESS=${polyAddress} asset=${assetType} =>`, JSON.stringify(resp.data));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [FAIL:${status}] POLY_ADDRESS=${polyAddress} asset=${assetType} => ${errData}`);
    return null;
  }
}

async function main() {
  console.log('Signer address:', account.address);
  console.log('Wallet address:', walletAddr);
  console.log('Proxy address:', proxyAddr);

  const creds = await deriveCreds(account);
  console.log('\nDerived credentials:', JSON.stringify(creds));

  console.log('\n=== Testing balance with signer address as POLY_ADDRESS ===');
  await tryBalance(creds, account.address, 'COLLATERAL');

  console.log('\n=== Testing balance with wallet address as POLY_ADDRESS ===');
  await tryBalance(creds, walletAddr, 'COLLATERAL');

  console.log('\n=== Testing balance with proxy address as POLY_ADDRESS ===');
  await tryBalance(creds, proxyAddr, 'COLLATERAL');

  // Also check public profile
  console.log('\n=== Public profile (wallet) ===');
  try {
    const resp = await axios.get(`https://gamma-api.polymarket.com/public-profile?address=${walletAddr}`, {
      httpsAgent: agent,
      timeout: 15000,
    });
    console.log(JSON.stringify(resp.data, null, 2));
  } catch (err: any) {
    console.log('Public profile failed:', err.response?.data?.error || err.message);
  }

  console.log('\n=== Public profile (proxy/developer) ===');
  try {
    const resp = await axios.get(`https://gamma-api.polymarket.com/public-profile?address=${proxyAddr}`, {
      httpsAgent: agent,
      timeout: 15000,
    });
    console.log(JSON.stringify(resp.data, null, 2));
  } catch (err: any) {
    console.log('Public profile failed:', err.response?.data?.error || err.message);
  }
}

main().catch(console.error);
