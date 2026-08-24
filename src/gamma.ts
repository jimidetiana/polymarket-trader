import { createHttpClient } from './proxy.js';
import { config } from './config.js';

const http = createHttpClient({
  baseURL: config.gammaUrl,
  timeout: 10000,
});

const dataHttp = createHttpClient({
  baseURL: config.dataUrl,
  timeout: 10000,
});

export interface PublicProfile {
  createdAt: string;
  proxyWallet: string;
  displayUsernamePublic: boolean;
  pseudonym: string;
  name: string;
  users: Array<{
    id: string;
    creator: boolean;
    mod: boolean;
    communityMod: boolean;
  }>;
  verifiedBadge: boolean;
  takerTier: number;
  takerTierName: string;
  weightedVolume: number;
}

export async function getPublicProfile(address: string): Promise<PublicProfile | null> {
  try {
    const resp = await http.get('/public-profile', { params: { address } });
    return resp.data as PublicProfile;
  } catch (err: any) {
    if (err.response?.status === 404) return null;
    console.warn('[Gamma API] public-profile 查询失败:', err.message?.slice(0, 100));
    return null;
  }
}

export async function getUserValue(user: string): Promise<number> {
  try {
    const resp = await dataHttp.get('/value', { params: { user: user.toLowerCase() } });
    const data = resp.data;
    if (Array.isArray(data) && data.length > 0) {
      return Number(data[0]?.value || 0);
    }
    return 0;
  } catch (err: any) {
    console.warn('[Data API] value 查询失败:', err.message?.slice(0, 100));
    return 0;
  }
}
