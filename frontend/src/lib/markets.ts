import type { MarketType, SoccerMarket, SoccerEvent } from '@/types'

const MARKET_TYPE_KEYWORDS: Array<[string[], MarketType]> = [
  [['halftime', 'half-time', 'half time'], 'halftime'],
  [['second half', '2nd half'], 'second_half'],
  [['exact score', 'correct score'], 'exact_score'],
  [['first team to score', 'first to score', 'first goal'], 'first_scorer'],
  [['total goals', 'over/under', 'o/u'], 'total'],
  [['spread', 'handicap', 'asian handicap'], 'spread'],
  [['both teams to score', 'btts'], 'btts'],
  [['corner', 'corners'], 'corners'],
  [['moneyline', 'winner', 'win the match', 'who will win'], 'moneyline'],
]

export const MARKET_TYPE_ORDER: MarketType[] = [
  'moneyline',
  'spread',
  'total',
  'btts',
  'halftime',
  'second_half',
  'exact_score',
  'first_scorer',
  'corners',
  'other',
]

export const MARKET_TYPE_LABELS: Record<MarketType, string> = {
  moneyline: '主要盘口',
  spread: '让球盘',
  total: '大小球',
  btts: '双方进球',
  halftime: '半场',
  second_half: '下半场',
  exact_score: '正确比分',
  first_scorer: '首先进球',
  corners: '角球',
  other: '其他',
}

export function classifyMarketType(questionEn: string | null | undefined): MarketType {
  const lower = String(questionEn || '').toLowerCase()
  for (const [keywords, type] of MARKET_TYPE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return type
  }
  if (/will\s+.+\s+(win|draw|tie)/.test(lower)) return 'moneyline'
  if (/end in a draw|end in a tie/.test(lower)) return 'moneyline'
  return 'other'
}

export function getMarketType(market: SoccerMarket): MarketType {
  const stored = market.market_type as MarketType
  if (stored && stored !== 'other') return stored
  return classifyMarketType(market.question_en)
}

export function groupMarketsByType(markets: SoccerMarket[]): Record<MarketType, SoccerMarket[]> {
  const grouped: Record<MarketType, SoccerMarket[]> = {
    moneyline: [],
    spread: [],
    total: [],
    btts: [],
    halftime: [],
    second_half: [],
    exact_score: [],
    first_scorer: [],
    corners: [],
    other: [],
  }
  for (const market of markets) {
    const type = getMarketType(market)
    grouped[type].push(market)
  }
  return grouped
}

export function getOutcomeColor(
  name: string,
  idx: number,
  total: number,
): string {
  const lower = String(name).toLowerCase()
  if (lower === 'yes' || lower.endsWith('是')) return 'var(--pm-state-success)'
  if (lower === 'no' || lower.endsWith('否')) return 'var(--pm-state-error)'
  if (total === 2) {
    return idx === 0 ? 'var(--pm-state-success)' : 'var(--pm-state-error)'
  }
  if (total === 3) {
    if (idx === 0) return 'var(--pm-state-success)'
    if (idx === 2) return 'var(--pm-state-error)'
    return 'var(--pm-state-warning)'
  }
  return 'var(--pm-primary)'
}

export function getOutcomeRoundedClass(idx: number, total: number): string {
  if (total === 2) return idx === 0 ? 'rounded-l-md' : 'rounded-r-md'
  if (total === 3) {
    if (idx === 0) return 'rounded-l-md'
    if (idx === 2) return 'rounded-r-md'
    return ''
  }
  if (total === 6) {
    return idx % 2 === 0 ? 'rounded-l-md' : 'rounded-r-md'
  }
  return 'rounded-md'
}

const WILL_WIN_RE = /^will\s+(.+?)\s+win/i
const DRAW_RE = /end in a draw|end in a tie/i

export function mergeMoneylineMarkets(
  markets: SoccerMarket[],
  event: SoccerEvent | null,
): SoccerMarket[] {
  if (!event) return markets

  const homeEn = (event.home_team_en || '').toLowerCase()
  const awayEn = (event.away_team_en || '').toLowerCase()
  if (!homeEn || !awayEn) return markets

  const moneyline = markets.filter((m) => getMarketType(m) === 'moneyline')
  const drawMarkets = markets.filter(
    (m) => getMarketType(m) === 'moneyline' && DRAW_RE.test(m.question_en || ''),
  )

  let homeMarket: SoccerMarket | undefined
  let awayMarket: SoccerMarket | undefined

  for (const m of moneyline) {
    if (DRAW_RE.test(m.question_en || '')) continue
    const match = m.question_en?.match(WILL_WIN_RE)
    if (!match) continue
    const team = match[1].replace(/\s+on\s+.*$/, '').trim().toLowerCase()
    if (!homeMarket && team.includes(homeEn)) homeMarket = m
    else if (!awayMarket && team.includes(awayEn)) awayMarket = m
  }

  const drawMarket = drawMarkets[0]
  if (!homeMarket || !awayMarket) return markets

  const usedIds = new Set([homeMarket.id, awayMarket.id, drawMarket?.id].filter(Boolean) as string[])
  const remaining = markets.filter((m) => !usedIds.has(m.id))

  const homeName = event.home_team_zh || event.home_team_en || 'Home'
  const awayName = event.away_team_zh || event.away_team_en || 'Away'

  const merged: SoccerMarket = {
    ...homeMarket,
    id: `merged-ml-${homeMarket.id}`,
    question_en: 'Match Winner',
    question_zh: '主胜 / 平 / 客胜',
    market_type: 'moneyline',
    line: null,
    outcomes: [
      `${homeName} 是`, `${homeName} 否`,
      '平局 是', '平局 否',
      `${awayName} 是`, `${awayName} 否`,
    ],
    outcome_prices: [
      homeMarket.outcome_prices?.[0] ?? 0,
      homeMarket.outcome_prices?.[1] ?? 0,
      drawMarket?.outcome_prices?.[0] ?? 0,
      drawMarket?.outcome_prices?.[1] ?? 0,
      awayMarket.outcome_prices?.[0] ?? 0,
      awayMarket.outcome_prices?.[1] ?? 0,
    ],
    clob_token_ids: [
      homeMarket.clob_token_ids?.[0] ?? null,
      homeMarket.clob_token_ids?.[1] ?? null,
      drawMarket?.clob_token_ids?.[0] ?? null,
      drawMarket?.clob_token_ids?.[1] ?? null,
      awayMarket.clob_token_ids?.[0] ?? null,
      awayMarket.clob_token_ids?.[1] ?? null,
    ],
    source_market_ids: [
      homeMarket.id, homeMarket.id,
      drawMarket?.id ?? null, drawMarket?.id ?? null,
      awayMarket.id, awayMarket.id,
    ],
  }

  return [merged, ...remaining]
}
