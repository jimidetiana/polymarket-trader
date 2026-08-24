import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  ClobClient as V2ClobClient,
  SignatureTypeV2,
  AssetType,
  type ApiCreds,
} from '@polymarkets/clob-client-v2';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { config } from '../config.js';
import { getOrCreateClobCredentials } from '../auth.js';
import { getPublicProfile } from '../gamma.js';

let v2Client: V2ClobClient | null = null;
let v2Creds: ApiCreds | null = null;
let v2FunderAddress: string | undefined;

function createProxyTransport(): ReturnType<typeof http> {
  const proxyUrl = process.env.HTTPS_PROXY;
  if (!proxyUrl) return http();
  const agent = new HttpsProxyAgent(proxyUrl);
  return http({ fetchOptions: { dispatcher: agent as any } });
}

async function initWalletClient(): Promise<WalletClient> {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const transport = createProxyTransport();
  return createWalletClient({
    account,
    chain: polygon,
    transport,
  });
}

async function getFunderAddress(): Promise<string | undefined> {
  if (v2FunderAddress) return v2FunderAddress;
  if (config.proxyAddress) {
    v2FunderAddress = config.proxyAddress;
    return v2FunderAddress;
  }
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const profile = await getPublicProfile(account.address);
  if (profile?.proxyWallet) {
    v2FunderAddress = profile.proxyWallet;
    config.proxyAddress = v2FunderAddress;
  }
  return v2FunderAddress;
}

export async function getV2Client(): Promise<V2ClobClient> {
  if (v2Client) return v2Client;

  const walletClient = await initWalletClient();
  const funderAddress = await getFunderAddress();

  const builderConfig = config.builderCode
    ? { builderCode: config.builderCode }
    : undefined;

  v2Client = new V2ClobClient({
    host: config.clobUrl,
    chain: 137,
    signer: walletClient,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress,
    builderConfig,
  });

  return v2Client;
}

export async function getV2Creds(): Promise<ApiCreds> {
  if (v2Creds) return v2Creds;

  const client = await getV2Client();

  if (config.credentials) {
    v2Creds = {
      key: config.credentials.apiKey,
      secret: config.credentials.secret,
      passphrase: config.credentials.passphrase,
    };
  } else {
    v2Creds = await client.createOrDeriveApiKey();
    console.log('[V2 CLOB] Derived API Key:', v2Creds.key);
  }

  client.creds = v2Creds;
  return v2Creds;
}

export async function getV2Balance(): Promise<{ balance: string; allowance: string }> {
  const client = await getV2Client();
  await getV2Creds();
  const result = await client.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });
  return { balance: result.balance, allowance: result.allowance ?? '0' };
}

export async function updateV2Balance(): Promise<void> {
  const client = await getV2Client();
  await getV2Creds();
  await client.updateBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });
}

export async function getV2OpenOrders(): Promise<any[]> {
  const client = await getV2Client();
  await getV2Creds();
  return client.getOpenOrders();
}

export { SignatureTypeV2, AssetType };
