export interface SoccerEvent {
  id: string
  title_en?: string | null
  title_zh?: string | null
  home_team_en?: string | null
  home_team_zh?: string | null
  away_team_en?: string | null
  away_team_zh?: string | null
  league?: string | null
  end_time?: string | null
  match_status?: 'not_started' | 'live' | 'ended' | string
  /** 全场累计成交额（USDC），所有盘口合计 */
  volume?: number | string | null
  /** 全场当前挂单深度（USDC），所有盘口合计 */
  liquidity?: number | string | null
  [key: string]: unknown
}

export interface SoccerMarket {
  id: string
  event_id?: string
  question_en?: string | null
  question_zh?: string | null
  market_type?: MarketType
  line?: number | string | null
  outcomes?: string[]
  outcome_prices?: (number | string | null)[]
  clob_token_ids?: (string | null)[]
  /** 该盘口累计成交额（USDC），判断冷热用 */
  volume?: number | string | null
  /** 该盘口当前挂单深度（USDC），判断下不下得进去用 */
  liquidity?: number | string | null
  [key: string]: unknown
}

export type MarketType =
  | 'moneyline'
  | 'spread'
  | 'total'
  | 'btts'
  | 'halftime'
  | 'second_half'
  | 'exact_score'
  | 'first_scorer'
  | 'corners'
  | 'other'

export interface LivePrice {
  bid: number | null
  ask: number | null
}

export interface SelectedOutcome {
  eventId: string
  marketId: string
  tokenId: string
  outcomeName: string
  outcomeIdx: number
  price: number
  market: SoccerMarket
  event: SoccerEvent
}

export interface OrderSubmission {
  market_id: string
  token_id: string
  side: 'BUY' | 'SELL'
  size: number
  price: number
}

export interface OrderBookLevel {
  price: number
  size: number
}

export interface OrderBook {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
}

export type WsStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed'

export interface WsMessage {
  event_type?: string
  asset_id?: string
  bids?: Array<{ price: number | string; size?: number | string }>
  asks?: Array<{ price: number | string; size?: number | string }>
  price_changes?: Array<{
    asset_id: string
    best_bid?: number | string
    best_ask?: number | string
  }>
  best_bid?: number | string
  best_ask?: number | string
}

// ---- Sports API (bzzoiro) types ----

export interface SportsTeam {
  id: number
  name: string
  short_name?: string
}

export interface SportsLeague {
  id: number
  name: string
  country?: string
}

export interface SportsLiveEvent {
  id: number
  home_team: SportsTeam
  away_team: SportsTeam
  league: SportsLeague
  home_score: number
  away_score: number
  status: 'notstarted' | 'inprogress' | 'finished' | 'cancelled' | string
  start_time: string
  minute?: number | null
  period?: string | null
  has_prediction?: boolean
  home_score_ht?: number
  away_score_ht?: number
  current_minute?: number
  live_websocket?: boolean
  has_xg?: boolean
  weather?: string | null
  attendance?: number | null
  venue?: string | null
  [key: string]: unknown
}

export interface SportsStats {
  home?: Record<string, any>
  away?: Record<string, any>
  [key: string]: unknown
}

export interface SportsIncident {
  id?: number
  type?: string
  minute?: number
  team?: 'home' | 'away' | string
  player?: string
  player_id?: number
  assist_player?: string
  assist_player_id?: number
  [key: string]: unknown
}

export interface SportsLineups {
  home?: {
    lineup?: Array<Record<string, any>>
    substitutes?: Array<Record<string, any>>
    coach?: string
  }
  away?: {
    lineup?: Array<Record<string, any>>
    substitutes?: Array<Record<string, any>>
    coach?: string
  }
  [key: string]: unknown
}
