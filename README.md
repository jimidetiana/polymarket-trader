# Polymarket Trader

A TypeScript starter project for automated trading on Polymarket using the official REST and WebSocket APIs directly.

## Features

- CLOB L1/L2 authentication with EIP-712 signing (via Viem) and HMAC-SHA256 request signing.
- Automatic API-key derivation/creation.
- Gamma market discovery and order-book reading.
- Signed limit and market order construction for EOA and Polymarket proxy wallets.
- Order placement, cancellation, and open-order queries.
- Real-time market and user WebSocket feeds with auto-reconnect.
- Optional HTTP/HTTPS proxy support for REST and WebSocket traffic.
- A simple market-making strategy skeleton with basic risk checks.

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and fill in your credentials:

   ```bash
   cp .env.example .env
   ```

   Required variables:

   - `POLYMARKET_PRIVATE_KEY` — private key of the signing EOA.
   - `POLYMARKET_WALLET_ADDRESS` — the Polymarket wallet/deposit address.

   Optional variables:

   - `POLYMARKET_PROXY_ADDRESS` — use a Polymarket proxy wallet.
   - `CLOB_API_KEY`, `CLOB_API_SECRET`, `CLOB_API_PASSPHRASE` — skip auto-derivation.
   - `POLYMARKET_BUILDER_CODE` — attribute trades to a builder profile.
   - `HTTPS_PROXY` / `HTTP_PROXY` — proxy URL if Polymarket APIs are blocked in your network (e.g. `http://127.0.0.1:7890`).

3. Review and adjust strategy settings in `.env`:

   - `MARKET_SLUG` — target market slug from Gamma.
   - `OUTCOME` — `YES` or `NO`.
   - `ORDER_SIZE`, `MAX_POSITION`, `SPREAD`, `POLL_INTERVAL_MS`.

4. Run in development mode:

   ```bash
   npm run dev
   ```

   Or build and start:

   ```bash
   npm run build
   npm start
   ```

## Important Notes

- This is a starter template, not a production trading system. Test thoroughly on small sizes first.
- The bot places real orders with real funds. Double-check `.env` values and risk limits.
- Deposit wallets require ERC-7739 signature wrapping, which is not implemented here. Use an EOA or Polymarket proxy wallet (`POLYMARKET_PROXY_ADDRESS`).
- Geographic restrictions may apply; ensure your jurisdiction permits Polymarket trading.
- Keep your private key and API secrets secure. Never commit `.env` to version control.

## Project Structure

```text
src/
  api/        — Gamma, CLOB, Data API, and Relayer clients
  auth.ts     — L1 signature and L2 request signing
  config.ts   — Environment configuration
  orderBuilder.ts — EIP-712 order construction and signing
  proxy.ts    — Optional HTTP/HTTPS/SOCKS5 proxy helper
  riskManager.ts  — Basic exposure checks
  strategies/ — Example trading strategy
  types.ts    — Shared TypeScript types
  utils.ts    — Precision, tick-size, and helper utilities
  ws/         — Market and user WebSocket clients
  index.ts    — Entry point
```

## Next Steps

- Replace `SimpleMarketMaker` with your own strategy.
- Add persistent logging, alerting, and PnL tracking.
- Implement position reconciliation and settlement waiting.
- Consider using the official `@polymarket/client` SDK for more advanced features.
