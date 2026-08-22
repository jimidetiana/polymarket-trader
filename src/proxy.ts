import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function proxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
}

export function createProxyAgent(): HttpsProxyAgent<string> | undefined {
  const url = proxyUrl();
  if (!url) return undefined;
  return new HttpsProxyAgent(url);
}

export function createHttpClient(baseConfig?: AxiosRequestConfig): AxiosInstance {
  const agent = createProxyAgent();
  return axios.create({
    ...baseConfig,
    httpsAgent: agent,
  });
}
