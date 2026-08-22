import type { SoccerEvent, SoccerMarket, OrderSubmission } from '@/types'

async function handleResponse<T>(res: Response | Promise<Response>): Promise<T> {
  const response = await res
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error')
    throw new Error(text || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export interface ApiListResponse<T> {
  success: boolean
  count?: number
  events?: T[]
  markets?: T[]
  orders?: T[]
  book?: unknown
  message?: string
  error?: string
}

export interface ClobBookLevel {
  price: string
  size: string
}

export interface ClobBook {
  market: string
  asset_id: string
  timestamp: string
  hash: string
  bids: ClobBookLevel[]
  asks: ClobBookLevel[]
  min_order_size: string
  tick_size: string
  neg_risk: boolean
  last_trade_price: string
}

export async function fetchEvents(): Promise<SoccerEvent[]> {
  const data = await handleResponse<ApiListResponse<SoccerEvent>>(
    fetch('/api/soccer/events'),
  )
  if (!data.success) throw new Error(data.error || '加载失败')
  return data.events ?? []
}

export async function refreshEvents(): Promise<number> {
  const data = await handleResponse<ApiListResponse<unknown>>(
    fetch('/api/soccer/refresh', { method: 'POST' }),
  )
  if (!data.success) throw new Error(data.error || '刷新失败')
  return (data.events as unknown as number) ?? 0
}

export async function fetchEventMarkets(eventId: string): Promise<SoccerMarket[]> {
  const data = await handleResponse<ApiListResponse<SoccerMarket>>(
    fetch(`/api/soccer/events/${encodeURIComponent(eventId)}/markets`),
  )
  if (!data.success) throw new Error(data.error || '加载盘口失败')
  return data.markets ?? []
}

export async function fetchOrderBook(tokenId: string): Promise<ClobBook> {
  const data = await handleResponse<{ success: boolean; book?: ClobBook; error?: string }>(
    fetch(`/api/soccer/orderbook/${encodeURIComponent(tokenId)}`),
  )
  if (!data.success || !data.book) throw new Error(data.error || '加载盘口深度失败')
  return data.book
}

export async function submitOrder(order: OrderSubmission): Promise<string> {
  const data = await handleResponse<{ success: boolean; orderId?: string; message?: string; error?: string }>(
    fetch('/api/soccer/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    }),
  )
  if (!data.success) throw new Error(data.error || '下单失败')
  return data.message || '下单成功'
}

export async function fetchTranslations(): Promise<SoccerEvent[]> {
  const data = await handleResponse<ApiListResponse<SoccerEvent>>(
    fetch('/api/soccer/translations'),
  )
  if (!data.success) throw new Error(data.error || '加载失败')
  return data.events ?? []
}

export async function fetchUntranslated(limit = 200): Promise<SoccerEvent[]> {
  const data = await handleResponse<ApiListResponse<SoccerEvent>>(
    fetch(`/api/soccer/untranslated?limit=${limit}`),
  )
  if (!data.success) throw new Error(data.error || '加载失败')
  return data.events ?? []
}

export async function saveEventTranslation(payload: {
  id: string
  title_zh?: string | null
  home_team_zh?: string | null
  away_team_zh?: string | null
  league?: string | null
}): Promise<string> {
  const data = await handleResponse<{ success: boolean; message?: string; error?: string }>(
    fetch('/api/soccer/translations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  if (!data.success) throw new Error(data.error || '保存失败')
  return data.message || '保存成功'
}

export async function saveMarketTranslation(
  marketId: string,
  payload: { question_zh?: string | null; outcomes_zh?: string[] | null },
): Promise<string> {
  const data = await handleResponse<{ success: boolean; message?: string; error?: string }>(
    fetch(`/api/soccer/markets/${encodeURIComponent(marketId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  if (!data.success) throw new Error(data.error || '保存失败')
  return data.message || '保存成功'
}

export async function importTranslations(events: unknown[]): Promise<string> {
  const data = await handleResponse<{ success: boolean; message?: string; error?: string }>(
    fetch('/api/soccer/translations/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    }),
  )
  if (!data.success) throw new Error(data.error || '导入失败')
  return data.message || '导入成功'
}
