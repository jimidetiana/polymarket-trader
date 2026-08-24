import axios, { type AxiosInstance } from 'axios';
import type { ClobCredentials, OrderBook, OrderResponse, OrderType, Side, SignedOrder } from '../types.js';
import { createL2Signature } from '../auth.js';
import { createProxyAgent } from '../proxy.js';

export class ClobClient {
  private readonly axios: AxiosInstance;
  // POLY_ADDRESS for L2 auth: proxy wallet (sig_type=3) or EOA (sig_type=0)
  private readonly polyAddress: string;

  constructor(
    baseUrl: string,
    private readonly credentials: ClobCredentials,
    private readonly signerAddress: string,
    funderAddress?: string,
  ) {
    const agent = createProxyAgent();
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: { 'Content-Type': 'application/json' },
      httpsAgent: agent,
    });

    // When funderAddress (proxy) is provided, L2 POLY_ADDRESS must be the proxy
    this.polyAddress = funderAddress ?? signerAddress;

    this.axios.interceptors.request.use((cfg) => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      // L2 signature covers only the bare path (no query string)
      const path = cfg.url ?? '/';
      const body = cfg.data && typeof cfg.data !== 'string' ? JSON.stringify(cfg.data) : cfg.data;
      const method = (cfg.method ?? 'GET').toUpperCase();
      const signature = createL2Signature(this.credentials.secret, timestamp, method, path, body);

      cfg.headers.set('POLY_ADDRESS', this.polyAddress);
      cfg.headers.set('POLY_API_KEY', this.credentials.apiKey);
      cfg.headers.set('POLY_PASSPHRASE', this.credentials.passphrase);
      cfg.headers.set('POLY_TIMESTAMP', timestamp);
      cfg.headers.set('POLY_SIGNATURE', signature);

      if (body && typeof cfg.data !== 'string') {
        cfg.data = body;
      }
      return cfg;
    });
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const response = await this.axios.get('/book', { params: { token_id: tokenId } });
    return response.data as OrderBook;
  }

  async getMarketPrice(tokenId: string, side: Side): Promise<string> {
    const response = await this.axios.get('/price', { params: { token_id: tokenId, side } });
    return String((response.data as { price: number | string }).price);
  }

  async getMidpoint(tokenId: string): Promise<string> {
    const response = await this.axios.get('/midpoint', { params: { token_id: tokenId } });
    return String((response.data as { price: number | string }).price);
  }

  async getOpenOrders(params?: Record<string, unknown>): Promise<unknown> {
    const response = await this.axios.get('/data/orders', { params });
    return response.data;
  }

  async placeOrder(signedOrder: SignedOrder): Promise<OrderResponse> {
    const response = await this.axios.post('/order', signedOrder);
    return response.data as OrderResponse;
  }

  async placeOrders(signedOrders: SignedOrder[]): Promise<OrderResponse[]> {
    const response = await this.axios.post('/orders', signedOrders);
    return response.data as OrderResponse[];
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    const response = await this.axios.delete('/order', { data: { orderID: orderId } });
    return response.data;
  }

  async cancelAllOrders(): Promise<unknown> {
    const response = await this.axios.delete('/cancel-all');
    return response.data;
  }

  async getTrades(params?: Record<string, unknown>): Promise<unknown> {
    const response = await this.axios.get('/data/trades', { params });
    return response.data;
  }

  async getBalanceAllowance(assetType = 'COLLATERAL'): Promise<{ balance: string; allowance: string }> {
    const response = await this.axios.get('/balance-allowance', { params: { asset_type: assetType } });
    return response.data as { balance: string; allowance: string };
  }

  async sendHeartbeat(): Promise<unknown> {
    const response = await this.axios.post('/heartbeat');
    return response.data;
  }
}
