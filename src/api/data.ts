import type { AxiosInstance } from 'axios';
import { createHttpClient } from '../proxy.js';

export class DataApiClient {
  private readonly axios: AxiosInstance;

  constructor(baseUrl: string) {
    this.axios = createHttpClient({ baseURL: baseUrl });
  }

  async getCurrentPositions(address: string): Promise<unknown> {
    const response = await this.axios.get(`/v1/data/user/${address}/positions`);
    return response.data;
  }

  async getUserActivity(address: string, params?: Record<string, unknown>): Promise<unknown> {
    const response = await this.axios.get(`/v1/data/user/${address}/activity`, { params });
    return response.data;
  }

  async getTotalValue(address: string): Promise<unknown> {
    const response = await this.axios.get(`/v1/data/user/${address}/value`);
    return response.data;
  }
}
