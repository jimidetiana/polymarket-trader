import 'dotenv/config';
import type { AppConfig, ClobCredentials } from './types.js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalCredentials(): ClobCredentials | undefined {
  const apiKey = process.env.CLOB_API_KEY;
  const secret = process.env.CLOB_API_SECRET;
  const passphrase = process.env.CLOB_API_PASSPHRASE;
  if (apiKey && secret && passphrase) {
    return { apiKey, secret, passphrase };
  }
  return undefined;
}

export const config: AppConfig = {
  privateKey: requireEnv('POLYMARKET_PRIVATE_KEY'),
  walletAddress: requireEnv('POLYMARKET_WALLET_ADDRESS'),
  proxyAddress: process.env.POLYMARKET_PROXY_ADDRESS,
  builderCode: process.env.POLYMARKET_BUILDER_CODE,
  credentials: optionalCredentials(),
  marketSlug: process.env.MARKET_SLUG || 'will-the-us-confirm-that-aliens-exist-before-2027-789-924-249',
  outcome: process.env.OUTCOME || 'YES',
  orderSize: Number(process.env.ORDER_SIZE || '10'),
  maxPosition: Number(process.env.MAX_POSITION || '100'),
  spread: Number(process.env.SPREAD || '0.02'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || '5000'),
  gammaUrl: process.env.GAMMA_URL || 'https://gamma-api.polymarket.com',
  clobUrl: process.env.CLOB_URL || 'https://clob.polymarket.com',
  dataUrl: process.env.DATA_URL || 'https://data-api.polymarket.com',
  relayerUrl: process.env.RELAYER_URL || 'https://relayer-v2.polymarket.com',
};
