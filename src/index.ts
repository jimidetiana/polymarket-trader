import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { GammaClient } from './api/gamma.js';
import { ClobClient } from './api/clob.js';
import { DataApiClient } from './api/data.js';
import { getOrCreateClobCredentials } from './auth.js';
import { SimpleMarketMaker } from './strategies/marketMaker.js';
import { ClobMarketWebSocket } from './ws/marketWs.js';
import { ClobUserWebSocket } from './ws/userWs.js';
import { parseOutcomes } from './utils.js';

async function main() {
  const signer = privateKeyToAccount(config.privateKey as `0x${string}`);
  console.log('Signer address:', signer.address);

  const credentials = config.credentials ?? (await getOrCreateClobCredentials(signer, config.clobUrl));
  config.credentials = credentials;
  console.log('CLOB credentials loaded. API key:', credentials.apiKey.slice(0, 8) + '...');

  const gamma = new GammaClient(config.gammaUrl);
  const clob = new ClobClient(config.clobUrl, credentials, signer.address);
  const data = new DataApiClient(config.dataUrl);

  // Fetch target market from Gamma.
  const market = await gamma.getMarketBySlug(config.marketSlug);
  console.log('Market:', market.question ?? config.marketSlug);

  const outcomes = parseOutcomes(market);
  const outcome = outcomes.find((o) =>
    o.name.toLowerCase() === config.outcome.toLowerCase()
  );
  if (!outcome) {
    throw new Error(`Outcome "${config.outcome}" not found in market`);
  }
  const tokenId = outcome.tokenId ?? outcome.token_id;
  if (!tokenId) {
    throw new Error('Token ID missing for selected outcome');
  }
  console.log('Trading token:', tokenId);

  // Optional: start real-time market and user WebSockets.
  const marketWs = new ClobMarketWebSocket(
    'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    [tokenId],
  );
  marketWs.on('book', (msg) => console.log('[WS book] best bid/ask:', msg.bids[0], msg.asks[0]));
  marketWs.on('last_trade_price', (msg) => console.log('[WS trade]', msg.price, msg.size));
  marketWs.connect();

  const userWs = new ClobUserWebSocket(
    'wss://ws-subscriptions-clob.polymarket.com/ws/user',
    credentials,
    market.conditionId ? [market.conditionId] : undefined,
  );
  userWs.on('order', (msg) => console.log('[WS order]', msg.type, msg.id, msg.status));
  userWs.on('trade', (msg) => console.log('[WS trade]', msg.id, msg.status, msg.size));
  userWs.connect();

  // Start simple market-making strategy.
  const strategy = new SimpleMarketMaker(clob, signer, {
    tokenId,
    conditionId: market.conditionId,
    orderSize: config.orderSize,
    maxPosition: config.maxPosition,
    spread: config.spread,
    pollIntervalMs: config.pollIntervalMs,
  });

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    strategy.stop();
    marketWs.close();
    userWs.close();
    try {
      await clob.cancelAllOrders();
      console.log('Cancelled all open orders');
    } catch (err) {
      console.error('Failed to cancel orders during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await strategy.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
