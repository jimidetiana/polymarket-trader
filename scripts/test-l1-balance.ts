import 'dotenv/config';
import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { privateKeyToAccount } from 'viem/accounts';

const proxyUrl = process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const privateKey = process.env.POLYMARKET_PRIVATE_KEY!;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const walletAddr = '0x24a9886579b61C8a32F809F2C7194770939EfDd3';
const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS!;

// Build L1 auth headers for a given address
async function buildL1Headers(signer: any, address: string) {
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
  const signature = await signer.signTypedData(typedData);
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce,
  };
}

async function tryL1Balance(address: string, assetType: string) {
  try {
    const headers = await buildL1Headers(account, address);
    const url = `https://clob.polymarket.com/balance-allowance?asset_type=${assetType}`;
    const resp = await axios.get(url, { headers, httpsAgent: agent, timeout: 15000 });
    console.log(`  [L1 OK] ${address} ${assetType} =>`, JSON.stringify(resp.data));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [L1 FAIL:${status}] ${address} ${assetType} => ${errData}`);
    return null;
  }
}

async function tryGammaApi(endpoint: string) {
  try {
    const url = `https://gamma-api.polymarket.com/${endpoint}`;
    const resp = await axios.get(url, { httpsAgent: agent, timeout: 15000 });
    console.log(`  [OK] ${endpoint}`);
    console.log('  ', JSON.stringify(resp.data).slice(0, 500));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [FAIL:${status}] ${endpoint} => ${errData.slice(0, 100)}`);
    return null;
  }
}

async function tryDataApi(endpoint: string) {
  try {
    const url = `https://data-api.polymarket.com/${endpoint}`;
    const resp = await axios.get(url, { httpsAgent: agent, timeout: 15000 });
    console.log(`  [OK] ${endpoint}`);
    console.log('  ', JSON.stringify(resp.data).slice(0, 500));
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data?.error || err.message;
    console.log(`  [FAIL:${status}] ${endpoint} => ${errData.slice(0, 100)}`);
    return null;
  }
}

async function main() {
  console.log('Signer:', account.address);
  console.log('Wallet:', walletAddr);
  console.log('Proxy (dev):', proxyAddr);

  console.log('\n=== L1 auth balance queries ===');
  // Try L1 auth with signer address
  await tryL1Balance(account.address, 'COLLATERAL');
  // Try L1 auth with wallet address (if signer can sign for it)
  await tryL1Balance(walletAddr, 'COLLATERAL');
  // Try L1 auth with proxy address
  await tryL1Balance(proxyAddr, 'COLLATERAL');

  console.log('\n=== Gamma API public profiles ===');
  await tryGammaApi(`public-profile?address=${walletAddr}`);
  await tryGammaApi(`public-profile?address=${proxyAddr}`);
  await tryGammaApi(`public-profile?address=${account.address}`);

  console.log('\n=== Data API queries ===');
  await tryDataApi(`positions?user=${walletAddr.toLowerCase()}`);
  await tryDataApi(`positions?user=${proxyAddr.toLowerCase()}`);
  await tryDataApi(`positions?user=${account.address.toLowerCase()}`);
  await tryDataApi(`value?user=${walletAddr.toLowerCase()}`);
  await tryDataApi(`value?user=${proxyAddr.toLowerCase()}`);
  await tryDataApi(`value?user=${account.address.toLowerCase()}`);

  console.log('\n=== Trading history (data-api) ===');
  await tryDataApi(`trades?user=${walletAddr.toLowerCase()}&limit=5`);
  await tryDataApi(`trades?user=${proxyAddr.toLowerCase()}&limit=5`);
}

main().catch(console.error);
