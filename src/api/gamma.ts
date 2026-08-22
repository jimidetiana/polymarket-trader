import type { AxiosInstance } from 'axios';
import { createHttpClient } from '../proxy.js';
import type { Market } from '../types.js';

export class GammaClient {
  private readonly axios: AxiosInstance;

  constructor(baseUrl: string) {
    this.axios = createHttpClient({ baseURL: baseUrl });
  }

  async getMarkets(params?: Record<string, unknown>): Promise<Market[]> {
    const response = await this.axios.get('/markets', { params });
    return response.data as Market[];
  }

  async getMarketBySlug(slug: string): Promise<Market> {
    const response = await this.axios.get('/markets', {
      params: { slug },
    });
    const markets = response.data as Market[];
    if (!markets.length) {
      throw new Error(`Market not found for slug: ${slug}`);
    }
    return markets[0];
  }

  async getMarketById(id: string): Promise<Market> {
    const response = await this.axios.get(`/markets/${id}`);
    return response.data as Market;
  }

  async getEventBySlug(slug: string): Promise<unknown> {
    const response = await this.axios.get('/events', {
      params: { slug },
    });
    return response.data;
  }
}
