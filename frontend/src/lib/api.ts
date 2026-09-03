import type { SoccerEvent, SoccerMarket, OrderBookLevel, SportsLiveEvent, SportsStats, SportsIncident, SportsLineups } from '@/types'

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

export interface Position {
  token_id: string
  market_id: string
  question_zh: string
  event_title: string
  outcome_name: string
  market_type: string
  line: number | null
  total_bought: number
  total_sold: number
  total_cost: number
  total_income: number
  net_size: number
  avg_buy_price: number
  net_cost: number
  buy_count: number
  sell_count: number
  current_bid: number
  current_bid_size: number
  current_ask: number
  current_ask_size: number
  unrealized_pnl: number
  estimated_value: number
  first_buy_at: string | null
  last_order_at: string | null
  is_settled?: boolean
  is_closed?: boolean
  settled_won?: boolean
  settled_lost?: boolean
}

export async function fetchPositions(): Promise<Position[]> {
  const data = await request<{ positions: Position[] }>('/api/soccer/positions')
  return data.positions
}

export async function quickSell(tokenId: string, size: number, price: number, type?: 'limit' | 'market'): Promise<{ message: string; orderId?: number; finalStatus?: string; simulated?: boolean }> {
  const data = await request<{ message: string; orderId?: number; finalStatus?: string; simulated?: boolean }>(
    `/api/soccer/positions/${encodeURIComponent(tokenId)}/sell`,
    { method: 'POST', body: JSON.stringify({ size, price, type }) },
  )
  return data
}

export async function syncOrders(): Promise<{ message: string; total: number; matched: number; updated: number; imported: number }> {
  const data = await request<{ message: string; total: number; matched: number; updated: number; imported: number }>(
    '/api/soccer/orders/sync',
    { method: 'POST' },
  )
  return data
}

// ---- 挂单对账 ----

/**
 * 一笔挂单的三种归属：
 *   live    本地有 + 交易所有 → 真挂单，走正常撤单
 *   stale   本地有 + 交易所无 → 残留记录，只能本地消除
 *   unknown 交易所不可达 → 不做判定（避免网络抖动把真挂单标成残留）
 */
export type RestingOrderKind = 'live' | 'stale' | 'unknown'

export interface RestingOrder {
  id: number
  clobOrderId: string | null
  marketId: string
  eventId: string | null
  tokenId: string
  side: 'BUY' | 'SELL'
  size: number
  price: number
  status: string
  createdAt: string
  questionZh: string | null
  titleZh: string | null
  kind: RestingOrderKind
}

/** 交易所有、本地没登记的挂单。有真实敞口 */
export interface OrphanOrder {
  clobOrderId: string
  tokenId: string | null
  side: string | null
  price: number | null
  size: number | null
  sizeMatched: number | null
}

export interface ReconcileResult {
  exchangeReachable: boolean
  exchangeCount: number
  items: RestingOrder[]
  orphans: OrphanOrder[]
  counts: { live: number; stale: number; unknown: number; orphan: number }
}

export async function fetchOrderReconcile(): Promise<ReconcileResult> {
  return await request<ReconcileResult>('/api/soccer/orders/reconcile')
}

/** 消除残留记录（只改本地状态，后端会自己再验一遍交易所） */
export async function forceCloseOrder(orderId: number): Promise<string> {
  const data = await request<{ message: string }>(
    `/api/soccer/orders/${orderId}/force-close`,
    { method: 'POST' },
  )
  return data.message
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

// ---- Sports live monitoring ----

export async function fetchSportsLiveEvents(): Promise<SportsLiveEvent[]> {
  const data = await request<{ events: SportsLiveEvent[] }>('/api/sports/live')
  return data.events
}

export async function fetchSportsEvents(params?: {
  status?: string
  limit?: number
  offset?: number
  date_from?: string
  date_to?: string
}): Promise<{ count: number; events: SportsLiveEvent[] }> {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.offset) q.set('offset', String(params.offset))
  if (params?.date_from) q.set('date_from', params.date_from)
  if (params?.date_to) q.set('date_to', params.date_to)
  const url = `/api/sports/events${q.toString() ? `?${q.toString()}` : ''}`
  const data = await request<{ count: number; events: SportsLiveEvent[] }>(url)
  return { count: data.count, events: data.events }
}

export async function fetchSportsEventDetail(eventId: number): Promise<SportsLiveEvent> {
  const data = await request<{ event: SportsLiveEvent }>(`/api/sports/events/${eventId}`)
  return data.event
}

export async function fetchSportsEventStats(eventId: number): Promise<SportsStats> {
  const data = await request<{ stats: SportsStats }>(`/api/sports/events/${eventId}/stats`)
  return data.stats
}

export async function fetchSportsEventIncidents(eventId: number): Promise<SportsIncident[]> {
  const data = await request<{ incidents: SportsIncident[] }>(`/api/sports/events/${eventId}/incidents`)
  return data.incidents
}

export async function fetchSportsEventLineups(eventId: number): Promise<SportsLineups> {
  const data = await request<{ lineups: SportsLineups }>(`/api/sports/events/${eventId}/lineups`)
  return data.lineups
}

export interface SportsLeagueInfo {
  id: number
  name: string
  country?: string
  is_active?: boolean
}

export async function fetchSportsLeagues(): Promise<SportsLeagueInfo[]> {
  const data = await request<{ leagues: SportsLeagueInfo[] }>('/api/sports/leagues?limit=200')
  return data.leagues
}

export async function fetchSportsTranslations(): Promise<{
  teams: Record<string, string>
  leagues: Record<string, string>
}> {
  const data = await request<{ teams: Record<string, string>; leagues: Record<string, string> }>(
    '/api/sports/translations',
  )
  return { teams: data.teams, leagues: data.leagues }
}

// ---- Value Bet Bot ----

export interface ValueBotStatus {
  running: boolean
  lastPollTime: string | null
  lastError: string | null
  totalRecords: number
  cyclesRun: number
  config: {
    enabled: boolean
    pollIntervalMs: number
    edgeThreshold: number
    maxGoals: number
    timeDecayExponent: number
    totalMatchMinutes: number
    botId: string
  }
}

export interface ValueBetRecord {
  id: number
  bot_id: string
  polymarket_event_id: string
  bzzoiro_event_id: number | null
  market_id: string
  market_type: string
  question: string | null
  outcome: string
  handicap: number | null
  model_probability: number
  market_price: number
  implied_probability: number
  edge: number
  match_minute: number
  current_score: string
  lambda_home: number
  lambda_away: number
  recommendation: string
  status: string
  created_at: string
}

export async function fetchValueBotStatus(): Promise<ValueBotStatus> {
  const data = await request<ValueBotStatus>('/api/bots/value-bet/status')
  return data
}

export async function startValueBot(config?: Record<string, unknown>): Promise<ValueBotStatus> {
  const data = await request<ValueBotStatus>('/api/bots/value-bet/start', {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
  return data
}

export async function stopValueBot(): Promise<ValueBotStatus> {
  const data = await request<ValueBotStatus>('/api/bots/value-bet/stop', {
    method: 'POST',
  })
  return data
}

export async function updateValueBotConfig(config: Record<string, unknown>): Promise<ValueBotStatus> {
  const data = await request<ValueBotStatus & { config: ValueBotStatus['config'] }>(
    '/api/bots/value-bet/config',
    { method: 'POST', body: JSON.stringify(config) },
  )
  return data
}

export async function triggerValueBotCycle(): Promise<ValueBotStatus> {
  const data = await request<ValueBotStatus>('/api/bots/value-bet/trigger', {
    method: 'POST',
  })
  return data
}

export async function fetchValueBetRecords(params?: {
  limit?: number
  offset?: number
  recommendation?: string
  minEdge?: number
}): Promise<{ records: ValueBetRecord[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  if (params?.recommendation) qs.set('recommendation', params.recommendation)
  if (params?.minEdge !== undefined) qs.set('minEdge', String(params.minEdge))
  const data = await request<{ records: ValueBetRecord[]; total: number }>(
    `/api/bots/value-bet/records?${qs}`,
  )
  return { records: data.records, total: data.total }
}

export interface MatchState {
  event_id: string
  home_team: string
  away_team: string
  lambda_home: number
  lambda_away: number
  initial_home_prob: number
  initial_draw_prob: number
  initial_away_prob: number
  bzzoiro_event_id: number | null
  bzzoiro_home_team: string | null
  bzzoiro_away_team: string | null
  source: string
  title_en: string | null
  title_zh: string | null
  start_time: string | null
  end_time: string | null
  event_status: string | null
  created_at: string
  updated_at: string
}

export interface AvailableMatch {
  id: string
  title_en: string
  title_zh: string | null
  home_team_en: string | null
  away_team_en: string | null
  home_team_zh: string | null
  away_team_zh: string | null
  start_time: string | null
  end_time: string | null
  event_status: string
  league: string | null
  match_status: string | null
}

export interface BzzoiroMatch {
  id: number
  home_team: string
  away_team: string
  home_team_zh: string | null
  away_team_zh: string | null
  league: string
  status: 'live' | 'upcoming'
  minute: number
  home_score: number
  away_score: number
  start_time: string | null
}

export async function fetchMatchStates(): Promise<MatchState[]> {
  const data = await request<{ matches: MatchState[] }>('/api/bots/value-bet/matches')
  return data.matches
}

export async function setInitialOdds(
  eventId: string,
  homeTeam: string,
  awayTeam: string,
  homeProb: number,
  drawProb: number,
  awayProb: number,
  bzzoiroEventId?: number,
  bzzoiroHomeTeam?: string,
  bzzoiroAwayTeam?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { homeTeam, awayTeam, homeProb, drawProb, awayProb }
  if (bzzoiroEventId !== undefined) body.bzzoiroEventId = bzzoiroEventId
  if (bzzoiroHomeTeam) body.bzzoiroHomeTeam = bzzoiroHomeTeam
  if (bzzoiroAwayTeam) body.bzzoiroAwayTeam = bzzoiroAwayTeam
  const data = await request<{ match: Record<string, unknown> }>(
    `/api/bots/value-bet/matches/${eventId}/initial-odds`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
  return data.match
}

export async function deleteInitialOdds(eventId: string): Promise<void> {
  await request<{ success: boolean }>(
    `/api/bots/value-bet/matches/${eventId}/initial-odds`,
    { method: 'DELETE' },
  )
}

export async function fetchAvailableMatches(): Promise<AvailableMatch[]> {
  const data = await request<{ events: AvailableMatch[] }>('/api/bots/value-bet/available-matches')
  return data.events
}

export async function fetchBzzoiroMatches(): Promise<BzzoiroMatch[]> {
  const data = await request<{ matches: BzzoiroMatch[] }>('/api/bots/value-bet/bzzoiro-matches')
  return data.matches
}

export interface RuleMeta {
  marketType: string
  marketTypeName: string
  description: string
  formula: string
}

export async function fetchRuleMetas(): Promise<RuleMeta[]> {
  const data = await request<{ rules: RuleMeta[] }>('/api/bots/value-bet/rules')
  return data.rules
}

export interface MatchMonitor {
  eventId: string
  running: boolean
  lastPollTime: string | null
  lastError: string | null
  cyclesRun: number
  totalLogs: number
}

export interface CalcLog {
  id: number
  event_id: string
  bzzoiro_event_id: number | null
  calc_time: string
  match_minute: number
  home_score: number
  away_score: number
  market_id: string
  market_type: string
  question: string | null
  outcome: string
  handicap: number | null
  model_probability: number
  best_bid: number | null
  best_bid_size: number | null
  best_ask: number | null
  best_ask_size: number | null
  edge: number
  recommendation: string
}

export async function startMatchMonitor(eventId: string): Promise<MatchMonitor> {
  const data = await request<{ monitor: MatchMonitor }>(
    `/api/bots/value-bet/matches/${eventId}/start`,
    { method: 'POST' },
  )
  return data.monitor
}

export async function stopMatchMonitor(eventId: string): Promise<MatchMonitor> {
  const data = await request<{ monitor: MatchMonitor }>(
    `/api/bots/value-bet/matches/${eventId}/stop`,
    { method: 'POST' },
  )
  return data.monitor
}

export async function triggerMatchMonitor(eventId: string): Promise<MatchMonitor> {
  const data = await request<{ monitor: MatchMonitor }>(
    `/api/bots/value-bet/matches/${eventId}/trigger`,
    { method: 'POST' },
  )
  return data.monitor
}

export async function fetchMatchMonitors(): Promise<MatchMonitor[]> {
  const data = await request<{ monitors: MatchMonitor[] }>('/api/bots/value-bet/monitors')
  return data.monitors
}

export async function fetchCalcLogs(
  eventId: string,
  params?: { limit?: number; lastOnly?: boolean },
): Promise<{ logs: CalcLog[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.lastOnly) qs.set('last', '1')
  const data = await request<{ logs: CalcLog[]; total: number }>(
    `/api/bots/value-bet/matches/${eventId}/logs?${qs}`,
  )
  return { logs: data.logs, total: data.total }
}

export interface LogTimelineEntry {
  calcTime: string
  matchMinute: number
  homeScore: number
  awayScore: number
  modelProbability: number
  bestBid: number | null
  bestBidSize: number | null
  bestAsk: number | null
  bestAskSize: number | null
  edge: number
  recommendation: string
}

export interface LogMarketOutcome {
  outcome: string
  timeline: LogTimelineEntry[]
}

export interface LogMarket {
  marketId: string
  marketType: string
  question: string | null
  handicap: number | null
  outcomes: LogMarketOutcome[]
}

export interface LogAnalysis {
  matchInfo: { homeTeam: string; awayTeam: string; homeScore: number; awayScore: number; minute: number } | null
  markets: LogMarket[]
}

export async function fetchCalcLogsAnalysis(eventId: string): Promise<LogAnalysis> {
  const data = await request<LogAnalysis>(
    `/api/bots/value-bet/matches/${eventId}/logs/analysis`,
  )
  return data
}

// ==================== Price Bot API ====================

export interface PriceBotStatus {
  running: boolean
  config: {
    enabled: boolean
    pollIntervalMs: number
    botId: string
  }
  monitorCount: number
  activeMonitorCount: number
  wsConnected: boolean
}

/** 进球买入信号（goal_surge）参数，全部可选，留空由后端用默认值回退 */
export interface GoalSurgeParams {
  surgeWindowMs?: number
  surgeMinRise?: number
  jumpThreshold?: number
  minBidSize?: number
  minAskSize?: number
  askCeiling?: number
  confirmMin?: number
  confirmHoldMs?: number
}

export type OrderSizeMode = 'shares' | 'usdc'

/** 自动下单参数。全局默认 + 每盘口可覆盖 */
export interface AutoTradeParams {
  /** 下单规模口径：按份数 或 按金额 */
  sizeMode?: OrderSizeMode
  /** 标准下单规模：sizeMode=shares 为份数，=usdc 为金额 */
  baseSize?: number
  /** 单笔最大下单规模（与 baseSize 同口径） */
  maxSize?: number
  /** 穿价缓冲：在 bestAsk 之上再让的价格，换成交确定性 */
  slippageBuffer?: number
  /** 买入价硬上限，超过则放弃下单 */
  maxBuyPrice?: number
  /** 买入价硬下限（判 bestBid）：低于此价说明该线离结算尚远，不下单。0 = 不校验 */
  minBuyPrice?: number
  /** 最大可接受买卖价差，超过判薄盘不下单。0 = 不校验 */
  maxSpread?: number
  /** 相对 bestBid 的最大溢价，限制穿价能让到多高。0 = 不校验 */
  maxPremiumOverBid?: number
  /** 每盘口累计最多下单笔数 */
  maxOrdersPerRule?: number
  /** 全局每日最多下单笔数 */
  maxOrdersPerDay?: number
  /** 全局每日累计名义额上限（USDC） */
  maxDailyNotional?: number
  /** 价格 tick */
  tickSize?: number
  /**
   * 买入报价方式。taker = 穿价立即成交；maker = 挂在盘口上等成交。
   *
   * maker 每笔省 +0.0822（见 docs/price-bot-analysis.md 第 9.14 节），
   * 代价是成交率从 94.8% 掉到 55.8%，且没成交的那一半里藏着逆向选择。
   * 默认 taker。
   */
  buyOrderMode?: BuyOrderMode
  /** maker 模式下报价高出 bestBid 几个 tick。1 = 自己占一档（推荐），0 = 并到 bid 排队尾 */
  makerTickOffset?: number
  /**
   * 比赛时钟下限：开哨后不足该分钟数就不买，0 = 不启用。
   *
   * 冲的是资金周转不是胜率（见 docs/price-bot-analysis.md 第 9.24 节）：
   * 开哨前 30 分钟买入付最贵的价、锁最久的资金、每笔还是亏的。
   * 开哨时间用取整后的 end_time，有 ±30 分钟误差。
   */
  minMatchMinute?: number
  /**
   * 买入前摇 [0,1) 随机数，小于该阈值才下单（0 = 不启用，0.6 = 六成放行）。
   *
   * ⚠ 是节流阀不是筛选器：阈值 0.6 回测只保住 53% 的净利，但每笔 EV 几乎不变
   * （ROI +7.2% → +6.1%）。见 docs/price-bot-analysis.md 9.26。
   */
  buyDiceThreshold?: number
  /**
   * 连续被筛子拦下时每次把阈值抬高多少（0 = 不放宽）。抬到 1.0 必然放行，
   * 所以最多被连续拦 ceil((1−阈值)/ramp) 次。计数是全局连续的，不按盘口。
   */
  buyDiceRamp?: number
}

/** 买入报价方式，见 AutoTradeParams.buyOrderMode */
export type BuyOrderMode = 'taker' | 'maker'

export type AutoOrderStatus = 'placed' | 'failed' | 'skipped' | 'simulated'

export interface AutoOrderRecord {
  id?: number
  botId: string
  ruleId: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  limitPrice: number
  size: number
  notional: number
  sizeMode: OrderSizeMode
  status: AutoOrderStatus
  /** skipped/failed 的原因 */
  reason?: string
  bestBid?: number | null
  bestBidSize?: number | null
  bestAsk?: number | null
  bestAskSize?: number | null
  tradeOrderId?: number | null
  clobOrderId?: string | null
  createdAt?: string
  matchName?: string
  marketName?: string
  league?: string
}

export interface AutoTradeStatus {
  /** 总开关 */
  globalEnabled: boolean
  /** 生效中的全局默认参数 */
  defaults: Required<AutoTradeParams>
  /** 已开启自动下单的盘口数 */
  enabledRules: number
  totalRules: number
  /** 当日剩余额度 */
  remainingToday: { orders: number; notional: number }
  dayTotal: number
  dayNotional: number
  placed: number
  failed: number
  skipped: number
}

export interface PriceMonitorRule {
  id?: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  ruleType: 'percent_change' | 'price_break' | 'price_range' | 'goal_surge'
  direction: 'up' | 'down' | 'both'
  percentThreshold?: number
  targetPrice?: number
  priceLow?: number
  priceHigh?: number
  /** ruleType=goal_surge 时使用，留空回退后端默认 */
  goalSurgeParams?: GoalSurgeParams
  /** 该盘口是否允许自动下单（与全局总开关取「与」） */
  autoTradeEnabled?: boolean
  /** 该盘口的自动下单参数覆盖，留空回退全局默认 */
  autoTradeParams?: AutoTradeParams
  signalType: 'buy_signal' | 'sell_signal' | 'alert'
  cooldownSeconds: number
  enabled: boolean
  /** 手动完结时刻。有值 = 已完结、等待链上结算 */
  settledAt?: string
  createdAt?: string
  updatedAt?: string
  // listRules LEFT JOIN 带出的比赛/盘口上下文（与 MatchContext 一致，均可选）
  matchName?: string
  league?: string
  marketName?: string
  marketType?: string
  line?: number
  /** 比赛状态（后端由 end_time 现算），供左侧列表过滤 */
  matchStatus?: 'not_started' | 'live' | 'ended'
  /** 比赛 end_time（作 kickoff 代理），供排序/过滤 */
  endTime?: string
}

export interface PriceMonitorState {
  ruleId: number
  tokenId: string
  running: boolean
  lastPollTime: string | null
  lastError: string | null
  cyclesRun: number
  triggerCount: number
  baselinePrice: number | null
  lastTriggerTime: string | null
  lastPrice: number | null
}

/** 日志/触发记录 LEFT JOIN 带出的赛事与盘口信息，均可能缺失 */
export interface MatchContext {
  matchName?: string
  league?: string
  marketName?: string
  marketType?: string
  line?: number
}

export interface PriceTriggerRecord extends MatchContext {
  id?: number
  botId: string
  ruleId: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  ruleType: string
  direction: string
  previousPrice: number
  currentPrice: number
  changePercent: number
  threshold: number
  signalType: string
  triggeredAt?: string
}

export interface PriceBotLog extends MatchContext {
  id?: number
  ruleId: number
  tokenId: string
  eventId: string
  outcome: string
  action: 'start' | 'stop' | 'price_update' | 'trigger' | 'buy_signal' | 'disconnect' | 'reconnect'
  price: number | null
  detail: string | null
  loggedAt?: string
}

export async function fetchPriceBotStatus(): Promise<PriceBotStatus> {
  const data = await request<PriceBotStatus>('/api/bots/price-bot/status')
  return data
}

export async function startPriceBot(config?: Record<string, unknown>): Promise<PriceBotStatus> {
  const data = await request<PriceBotStatus>('/api/bots/price-bot/start', {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
  return data
}

export async function stopPriceBot(): Promise<PriceBotStatus> {
  const data = await request<PriceBotStatus>('/api/bots/price-bot/stop', {
    method: 'POST',
  })
  return data
}

export async function updatePriceBotConfig(config: Record<string, unknown>): Promise<{ config: PriceBotStatus['config'] }> {
  const data = await request<{ config: PriceBotStatus['config'] }>(
    '/api/bots/price-bot/config',
    { method: 'POST', body: JSON.stringify(config) },
  )
  return data
}

export async function triggerPriceBotCycle(): Promise<PriceBotStatus> {
  const data = await request<PriceBotStatus>('/api/bots/price-bot/trigger', {
    method: 'POST',
  })
  return data
}

export async function fetchPriceBotRules(params?: {
  limit?: number
  offset?: number
  eventId?: string
  enabledOnly?: boolean
}): Promise<{ rules: PriceMonitorRule[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  if (params?.eventId) qs.set('eventId', params.eventId)
  if (params?.enabledOnly) qs.set('enabledOnly', '1')
  const data = await request<{ rules: PriceMonitorRule[]; total: number }>(
    `/api/bots/price-bot/rules?${qs}`,
  )
  return { rules: data.rules, total: data.total }
}

export async function createPriceBotRule(rule: Omit<PriceMonitorRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<PriceMonitorRule> {
  const data = await request<{ rule: PriceMonitorRule }>('/api/bots/price-bot/rules', {
    method: 'POST',
    body: JSON.stringify(rule),
  })
  return data.rule
}

/** 一键批量创建：未来 5 场比赛的大小球(Over) + 首球(Yes) goal_surge 监控机器人 */
export interface QuickCreateResult {
  success: boolean
  created: Array<{
    ruleId: number
    eventId: string
    marketId: string
    marketType: string
    line: number | null
    outcome: string
  }>
  skipped: Array<{
    eventId: string
    marketId: string
    marketType: string
    line: number | null
    reason: string
  }>
  eventsScanned: number
}

export async function quickCreatePriceBotRules(): Promise<QuickCreateResult> {
  return await request<QuickCreateResult>('/api/bots/price-bot/rules/batch-quick', {
    method: 'POST',
  })
}

/**
 * 手动完结一个盘口，可选接上下一档。
 *
 * 不等链上结算：Over 0.5 多在比赛结束才结算，等它就整场用不上 1.5。
 * 看到进球点一下最及时。next=false 则只完结不递进。
 */
export interface SettleRuleResult {
  success: boolean
  settled: { ruleId: number; line: number | null }
  next: null | { ruleId: number; marketId: string; line: number; outcome: string; started: boolean }
  reason?: string
}

export async function settlePriceBotRule(
  id: number,
  opts: { next?: boolean; startNext?: boolean } = {},
): Promise<SettleRuleResult> {
  return await request<SettleRuleResult>(`/api/bots/price-bot/rules/${id}/settle`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

export async function updatePriceBotRule(id: number, rule: Partial<PriceMonitorRule>): Promise<PriceMonitorRule> {
  const data = await request<{ rule: PriceMonitorRule }>(`/api/bots/price-bot/rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(rule),
  })
  return data.rule
}

export async function deletePriceBotRule(id: number): Promise<void> {
  await request(`/api/bots/price-bot/rules/${id}`, { method: 'DELETE' })
}

export async function fetchPriceBotMonitors(): Promise<PriceMonitorState[]> {
  const data = await request<{ monitors: PriceMonitorState[] }>('/api/bots/price-bot/monitors')
  return data.monitors
}

export async function startPriceBotMonitor(ruleId: number): Promise<PriceMonitorState> {
  const data = await request<{ monitor: PriceMonitorState }>(`/api/bots/price-bot/monitors/${ruleId}/start`, {
    method: 'POST',
  })
  return data.monitor
}

export interface BatchStartResult {
  started: number[]
  alreadyRunning: number[]
  failed: Array<{ ruleId: number; error: string }>
  monitors: PriceMonitorState[]
}

/**
 * 批量启动监控。
 *
 * 不要用循环调 startPriceBotMonitor 代替：后端每次单条启动都会重建 WS 连接，
 * 并触发一次高波动抑制窗口，逐条启动会让窗口被反复推后。
 * ruleIds 省略时后端启动全部已启用规则。
 */
export async function startPriceBotMonitorsBatch(ruleIds?: number[]): Promise<BatchStartResult> {
  return await request<BatchStartResult>('/api/bots/price-bot/monitors/batch-start', {
    method: 'POST',
    body: JSON.stringify(ruleIds ? { ruleIds } : {}),
  })
}

// ==================== 自动下单 ====================

export async function fetchAutoTradeStatus(): Promise<AutoTradeStatus> {
  return await request<AutoTradeStatus>('/api/bots/price-bot/auto-trade')
}

/** 设置总开关 / 全局默认参数 */
export async function updateAutoTrade(payload: {
  enabled?: boolean
  defaults?: AutoTradeParams
}): Promise<AutoTradeStatus> {
  return await request<AutoTradeStatus>('/api/bots/price-bot/auto-trade', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 单个盘口的自动下单开关 */
export async function setRuleAutoTrade(
  ruleId: number,
  enabled: boolean,
  params?: AutoTradeParams,
): Promise<{ rule: PriceMonitorRule }> {
  return await request<{ rule: PriceMonitorRule }>(`/api/bots/price-bot/auto-trade/${ruleId}`, {
    method: 'POST',
    body: JSON.stringify(params ? { enabled, params } : { enabled }),
  })
}

/** 批量开关盘口自动下单。不传 ruleIds 则作用于所有已启用规则 */
export async function setAutoTradeBatch(
  enabled: boolean,
  ruleIds?: number[],
): Promise<AutoTradeStatus & { updated: number[] }> {
  return await request<AutoTradeStatus & { updated: number[] }>(
    '/api/bots/price-bot/auto-trade/batch',
    { method: 'POST', body: JSON.stringify(ruleIds ? { enabled, ruleIds } : { enabled }) },
  )
}

export async function fetchAutoOrders(params?: {
  ruleId?: number
  status?: string
  limit?: number
  offset?: number
}): Promise<{ orders: AutoOrderRecord[]; total: number }> {
  const q = new URLSearchParams()
  if (params?.ruleId !== undefined) q.set('ruleId', String(params.ruleId))
  if (params?.status) q.set('status', params.status)
  if (params?.limit !== undefined) q.set('limit', String(params.limit))
  if (params?.offset !== undefined) q.set('offset', String(params.offset))
  const qs = q.toString()
  return await request<{ orders: AutoOrderRecord[]; total: number }>(
    `/api/bots/price-bot/orders${qs ? `?${qs}` : ''}`,
  )
}

// ==================== 实单分析 ====================
// filled / settled 均以 soccer_orders.order_status 为准；placed 只表示提交成功。
export interface RealOrderReportFilters {
  league?: string
  marketType?: string
  line?: number
  from?: string
  to?: string
}

export interface OutcomeStats {
  n: number
  wins: number
  winRate: number | null
  winRateCI: [number, number] | null
  invested: number
  net: number
  roi: number | null
  averagePrice: number | null
  decimalOdds: number | null
}

export interface ExecutionFunnel {
  skipped: number
  failed: number
  submitted: number
  cancelled: number
  partial: number
  filled: number
  settled: number
}

export interface ReportGroup extends OutcomeStats {
  key: string
  label: string
  kelly: number | null
  sampleAdequate: boolean
}

export interface RealOrderReportRow {
  id: number
  ruleId: number
  eventId: string
  marketId: string
  tokenId: string
  createdAt: string
  executionStatus: string
  orderSize: number
  orderPrice: number
  settledOutcome: 'yes' | 'no' | null
  outcome: string
  league: string | null
  homeTeam: string | null
  awayTeam: string | null
  marketName: string | null
  marketType: string | null
  line: number | null
  pnl: number | null
}

export interface RealOrderReport {
  funnel: ExecutionFunnel
  overall: {
    byRule: OutcomeStats
    byOrder: OutcomeStats
    unsettled: { n: number; invested: number }
  }
  kelly: {
    point: number | null
    conservative: number | null
    fractional: number | null
    requiredRules: number | null
    sampleAdequate: boolean
  }
  byLeague: ReportGroup[]
  byMarket: ReportGroup[]
  byPriceBand: ReportGroup[]
  timeline: Array<{
    date: string
    orders: number
    rules: number
    invested: number
    net: number
    cumulativeNet: number
  }>
  rows: RealOrderReportRow[]
}

export async function fetchRealOrderReport(filters: RealOrderReportFilters = {}): Promise<RealOrderReport> {
  const query = new URLSearchParams()
  if (filters.league) query.set('league', filters.league)
  if (filters.marketType) query.set('marketType', filters.marketType)
  if (filters.line !== undefined) query.set('line', String(filters.line))
  if (filters.from) query.set('from', filters.from)
  if (filters.to) query.set('to', filters.to)
  const suffix = query.toString()
  const data = await request<{ report: RealOrderReport }>(
    `/api/bots/price-bot/report${suffix ? `?${suffix}` : ''}`,
  )
  return data.report
}

export async function fetchRealOrderReportLeagues(): Promise<Array<{ league: string; count: number }>> {
  const data = await request<{ leagues: Array<{ league: string; count: number }> }>('/api/bots/price-bot/report/leagues')
  return data.leagues
}

export interface RealOrderReportSync {
  orders: { updated: number; imported: number; message?: string }
  settlements: { settledCount: number; message?: string }
  outcomes: { pending: number; resolved: number; stillOpen: number; notFound: number; failed: number }
}

/** 先同步交易所订单/结算和规则 outcome，再返回最新报表。 */
export async function refreshRealOrderReport(): Promise<{ report: RealOrderReport; sync: RealOrderReportSync }> {
  return await request<{ report: RealOrderReport; sync: RealOrderReportSync }>(
    '/api/bots/price-bot/report/refresh',
    { method: 'POST' },
  )
}

export async function stopPriceBotMonitor(ruleId: number): Promise<PriceMonitorState> {
  const data = await request<{ monitor: PriceMonitorState }>(`/api/bots/price-bot/monitors/${ruleId}/stop`, {
    method: 'POST',
  })
  return data.monitor
}

export async function triggerPriceBotMonitor(ruleId: number): Promise<PriceMonitorState> {
  const data = await request<{ monitor: PriceMonitorState }>(`/api/bots/price-bot/monitors/${ruleId}/trigger`, {
    method: 'POST',
  })
  return data.monitor
}

export async function fetchPriceBotTriggers(params?: {
  limit?: number
  offset?: number
  ruleId?: number
  eventId?: string
  tokenId?: string
}): Promise<{ triggers: PriceTriggerRecord[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  if (params?.ruleId) qs.set('ruleId', String(params.ruleId))
  if (params?.eventId) qs.set('eventId', params.eventId)
  if (params?.tokenId) qs.set('tokenId', params.tokenId)
  // 后端 listTriggers 返回的字段名是 records
  const data = await request<{ records: PriceTriggerRecord[]; total: number }>(
    `/api/bots/price-bot/triggers?${qs}`,
  )
  return { triggers: data.records ?? [], total: data.total ?? 0 }
}

export async function fetchPriceBotLogs(params?: {
  limit?: number
  offset?: number
  ruleId?: number
  eventId?: string
  action?: string
}): Promise<{ logs: PriceBotLog[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  if (params?.ruleId) qs.set('ruleId', String(params.ruleId))
  if (params?.eventId) qs.set('eventId', params.eventId)
  if (params?.action) qs.set('action', params.action)
  const data = await request<{ logs: PriceBotLog[]; total: number }>(
    `/api/bots/price-bot/logs?${qs}`,
  )
  return { logs: data.logs ?? [], total: data.total ?? 0 }
}

