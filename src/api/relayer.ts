import type { AxiosInstance } from 'axios';
import { createHttpClient } from '../proxy.js';

export class RelayerClient {
  private readonly axios: AxiosInstance;

  constructor(baseUrl: string) {
    this.axios = createHttpClient({ baseURL: baseUrl });
  }

  async submitTransaction(payload: unknown): Promise<unknown> {
    const response = await this.axios.post('/transactions', payload);
    return response.data;
  }

  async getTransaction(id: string): Promise<unknown> {
    const response = await this.axios.get('/transactions', { params: { id } });
    return response.data;
  }
}
