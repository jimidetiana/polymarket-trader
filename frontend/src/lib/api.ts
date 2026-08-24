import type { SoccerEvent, SoccerMarket, OrderBookLevel } from '@/types'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = (await res.json()) as { success: boolean; error?: string } & T
  if (!data.success) {
    throw new Error(data.error || '请求失败')
  }
  return data
}

// ---- Soccer events ----

export async function fetchEvents(): Promise<SoccerEvent[]> {
  const data = await request<{ events: SoccerEvent[] }>('/api/soccer/events')
  return data.events
}

export async function refreshEvents(): Promise<number> {
  const data = await request<{ events: number }>('/api/soccer/refresh', {
    method: 'POST',
  })
  return data.events
}

export async function fetchEventMarkets(eventId: string): Promise<SoccerMarket[]> {
  const data = await request<{ markets: SoccerMarket[] }>(
    `/api/soccer/events/${encodeURIComponent(eventId)}/markets`,
  )
  return data.markets
}

// ---- Order book ----

export async function fetchOrderBook(tokenId: string): Promise<{
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
}> {
  const data = await request<{ book: { bids: OrderBookLevel[]; asks: OrderBookLevel[] } }>(
    `/api/soccer/orderbook/${encodeURIComponent(tokenId)}`,
  )
  return data.book
}

// ---- Orders ----

export async function submitOrder(payload: {
  market_id: string
  token_id: string
  side: 'BUY' | 'SELL'
  size: number
  price: number
  type?: 'limit' | 'market'
}): Promise<{ message: string; orderId?: number; simulated?: boolean }> {
  const data = await request<{ message: string; orderId?: number; simulated?: boolean }>('/api/soccer/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data
}

export async function cancelOrder(orderId: number): Promise<string> {
  const data = await request<{ message: string }>(`/api/soccer/orders/${orderId}/cancel`, {
    method: 'POST',
  })
  return data.message
}

export async function fetchOrders(): Promise<any[]> {
  const data = await request<{ orders: any[] }>('/api/soccer/orders')
  return data.orders
}

// ---- Translations ----

export async function fetchTranslations(): Promise<SoccerEvent[]> {
  const data = await request<{ events: SoccerEvent[] }>('/api/soccer/translations')
  return data.events
}

export async function fetchUntranslated(limit = 50): Promise<SoccerEvent[]> {
  const data = await request<{ events: SoccerEvent[] }>(
    `/api/soccer/untranslated?limit=${limit}`,
  )
  return data.events
}

export async function saveEventTranslation(payload: {
  id: string
  title_zh?: string | null
  home_team_zh?: string | null
  away_team_zh?: string | null
  league?: string | null
}): Promise<string> {
  const data = await request<{ message: string }>('/api/soccer/translations', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.message
}

export async function saveMarketTranslation(
  marketId: string,
  payload: { question_zh?: string | null; outcomes_zh?: string[] },
): Promise<string> {
  const data = await request<{ message: string }>(
    `/api/soccer/markets/${encodeURIComponent(marketId)}`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
  return data.message
}

export async function importTranslations(events: unknown[]): Promise<string> {
  const data = await request<{ message: string }>('/api/soccer/translations/import', {
    method: 'POST',
    body: JSON.stringify({ events }),
  })
  return data.message
}

// ---- Dictionary APIs ----

export interface DictTeam {
  id: number
  name_en: string
  name_zh: string | null
  league: string | null
}

export interface DictLeague {
  id: number
  name_en: string
  name_zh: string | null
}

export async function fetchDictTeams(league?: string): Promise<DictTeam[]> {
  const url = league
    ? `/api/soccer/dict/teams?league=${encodeURIComponent(league)}`
    : '/api/soccer/dict/teams'
  const data = await request<{ teams: DictTeam[] }>(url)
  return data.teams
}

export async function fetchDictUntranslatedTeams(limit = 200): Promise<DictTeam[]> {
  const data = await request<{ teams: DictTeam[] }>(
    `/api/soccer/dict/teams/untranslated?limit=${limit}`,
  )
  return data.teams
}

export async function saveDictTeam(data: {
  name_en: string
  name_zh?: string | null
  league?: string | null
}): Promise<string> {
  const res = await request<{ message: string }>('/api/soccer/dict/teams', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.message
}

export async function updateDictTeam(
  id: number,
  data: { name_zh?: string; league?: string },
): Promise<string> {
  const res = await request<{ message: string }>(`/api/soccer/dict/teams/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
  return res.message
}

export async function deleteDictTeam(id: number): Promise<string> {
  const res = await request<{ message: string }>(`/api/soccer/dict/teams/${id}`, {
    method: 'DELETE',
  })
  return res.message
}

export async function fetchDictLeagues(): Promise<DictLeague[]> {
  const data = await request<{ leagues: DictLeague[] }>('/api/soccer/dict/leagues')
  return data.leagues
}

export async function fetchDictUntranslatedLeagues(): Promise<DictLeague[]> {
  const data = await request<{ leagues: DictLeague[] }>('/api/soccer/dict/leagues/untranslated')
  return data.leagues
}

export async function saveDictLeague(data: {
  name_en: string
  name_zh?: string | null
}): Promise<string> {
  const res = await request<{ message: string }>('/api/soccer/dict/leagues', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.message
}

export async function updateDictLeague(id: number, name_zh: string): Promise<string> {
  const res = await request<{ message: string }>(`/api/soccer/dict/leagues/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name_zh }),
  })
  return res.message
}

export async function deleteDictLeague(id: number): Promise<string> {
  const res = await request<{ message: string }>(`/api/soccer/dict/leagues/${id}`, {
    method: 'DELETE',
  })
  return res.message
}

export async function syncDictFromEvents(): Promise<{ teams: number; leagues: number; message: string }> {
  const data = await request<{ teams: number; leagues: number; message: string }>(
    '/api/soccer/dict/sync',
    { method: 'POST' },
  )
  return data
}

export async function applyDictionaryToEvents(): Promise<{ events: number; message: string }> {
  const data = await request<{ events: number; message: string }>(
    '/api/soccer/dict/apply-translations',
    { method: 'POST' },
  )
  return data
}

export async function deduplicateTeams(): Promise<{ merged: number; total: number; message: string }> {
  const data = await request<{ merged: number; total: number; message: string }>(
    '/api/soccer/dict/deduplicate',
    { method: 'POST' },
  )
  return data
}

export async function importDict(payload: {
  teams?: Array<{ name_en: string; name_zh?: string; league?: string }>
  leagues?: Array<{ name_en: string; name_zh?: string }>
}): Promise<{ teams: number; leagues: number; message: string }> {
  const data = await request<{ teams: number; leagues: number; message: string }>(
    '/api/soccer/dict/import',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
  return data
}

export async function fetchDictStats(): Promise<{
  teams: { total: number; translated: number; untranslated: number }
  leagues: { total: number; translated: number; untranslated: number }
}> {
  const data = await request<{
    teams: { total: number; translated: number; untranslated: number }
    leagues: { total: number; translated: number; untranslated: number }
  }>('/api/soccer/dict/stats')
  return data
}

// ---- Wallet ----

export interface WalletInfo {
  address: string
  balance_usdc: number
  total_deposited: number
  total_withdrawn: number
  total_pnl: number
  chain_balance: number | null
  last_sync_at: string | null
}

export interface WalletTransaction {
  id: number
  tx_type: 'deposit' | 'withdraw' | 'trade_pnl' | 'fee' | 'other'
  amount: number
  balance_after: number | null
  order_id: number | null
  description: string | null
  status: 'pending' | 'completed' | 'failed'
  created_at: string
}

export async function fetchWallet(): Promise<WalletInfo> {
  const data = await request<{ wallet: WalletInfo }>('/api/soccer/wallet')
  return data.wallet
}

export async function syncWalletBalance(): Promise<{ message: string; wallet: WalletInfo }> {
  const data = await request<{ message: string; wallet: WalletInfo }>(
    '/api/soccer/wallet/sync',
    { method: 'POST' },
  )
  return data
}

export async function depositWallet(amount: number, description?: string): Promise<{
  message: string
  wallet: { address: string; balance_usdc: number }
}> {
  const data = await request<{
    message: string
    wallet: { address: string; balance_usdc: number }
  }>('/api/soccer/wallet/deposit', {
    method: 'POST',
    body: JSON.stringify({ amount, description }),
  })
  return data
}

export async function withdrawWallet(amount: number, description?: string): Promise<{
  message: string
  wallet: { address: string; balance_usdc: number }
}> {
  const data = await request<{
    message: string
    wallet: { address: string; balance_usdc: number }
  }>('/api/soccer/wallet/withdraw', {
    method: 'POST',
    body: JSON.stringify({ amount, description }),
  })
  return data
}

export async function fetchWalletTransactions(
  params: { limit?: number; offset?: number; tx_type?: string } = {},
): Promise<{ total: number; transactions: WalletTransaction[] }> {
  const q = new URLSearchParams()
  if (params.limit) q.set('limit', String(params.limit))
  if (params.offset) q.set('offset', String(params.offset))
  if (params.tx_type) q.set('tx_type', params.tx_type)
  const url = `/api/soccer/wallet/transactions${q.toString() ? `?${q.toString()}` : ''}`
  const data = await request<{ total: number; transactions: WalletTransaction[] }>(url)
  return data
}

export interface ChainBalance {
  chain: string
  symbol: string
  balance: number
}

export async function fetchChainBalances(): Promise<ChainBalance[]> {
  try {
    const data = await request<{ balances: ChainBalance[] }>('/api/soccer/wallet/balances')
    return data.balances || []
  } catch {
    return []
  }
}

// ---- Profile ----

export interface PolymarketProfile {
  createdAt: string
  proxyWallet: string
  displayUsernamePublic: boolean
  pseudonym: string
  name: string
  users: Array<{
    id: string
    creator: boolean
    mod: boolean
    communityMod: boolean
  }>
  verifiedBadge: boolean
  takerTier: number
  takerTierName: string
  weightedVolume: number
}

export async function fetchProfile(): Promise<PolymarketProfile | null> {
  const data = await request<{ profile: PolymarketProfile | null }>('/api/soccer/profile')
  return data.profile
}
