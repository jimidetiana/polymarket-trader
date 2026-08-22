import type { MarketType, SoccerMarket } from '@/types'

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
  return (market.market_type as MarketType) || classifyMarketType(market.question_en)
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
  if (lower === 'yes' || lower === '是') return 'var(--pm-state-success)'
  if (lower === 'no' || lower === '否') return 'var(--pm-state-error)'
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
  return 'rounded-md'
}
