import type { Pool } from 'mysql2/promise'

/**
 * 实单统计的唯一口径：
 *
 * price_bot_orders.status='placed' 只代表 API 接单；真正持仓必须看
 * soccer_orders.order_status。千万不要把 skipped（从未提交）或 placed（可能取消）
 * 当成已成交，否则会把理论反事实伪装成实盘收益。
 */
export const FILLED_ORDER_STATUSES = ['filled', 'settled'] as const
export const PARTIAL_ORDER_STATUSES = ['partial', 'partial_cancelled'] as const

export type RealOrderReportFilters = {
  league?: string
  marketType?: string
  line?: number
  from?: string
  to?: string
}

export type RealOrderRow = {
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
}

export type SettledSample = {
  orderId: number
  ruleId: number
  size: number
  price: number
  won: boolean
}

export type OutcomeStats = {
  /** 独立结算个数；默认主口径时等于盘口/规则数。 */
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

export type KellyStats = {
  point: number | null
  conservative: number | null
  fractional: number | null
  /** 以观测样本的价格边际估算的 95% 下界过 0 所需独立盘口数。 */
  requiredRules: number | null
  sampleAdequate: boolean
}

export type ReportGroup = OutcomeStats & {
  key: string
  label: string
  kelly: number | null
  sampleAdequate: boolean
}

export type ReportTimelinePoint = {
  date: string
  orders: number
  rules: number
  invested: number
  net: number
  cumulativeNet: number
}

export type ExecutionFunnel = {
  skipped: number
  failed: number
  submitted: number
  cancelled: number
  partial: number
  filled: number
  settled: number
}

export type RealOrderReport = {
  funnel: ExecutionFunnel
  overall: {
    /** 每个 rule 聚成一笔独立二元结果；是胜率/凯莉默认口径。 */
    byRule: OutcomeStats
    /** 每笔实际成交单；用于资金和执行层面的订单口径。 */
    byOrder: OutcomeStats
    /** 已实际成交、但 outcome 还没回填。 */
    unsettled: { n: number; invested: number }
  }
  kelly: KellyStats
  byLeague: ReportGroup[]
  byMarket: ReportGroup[]
  byPriceBand: ReportGroup[]
  timeline: ReportTimelinePoint[]
  rows: Array<RealOrderRow & { pnl: number | null }>
}

const Z_95 = 1.959963984540054
const MIN_KELLY_SAMPLE = 30
const MIN_GROUP_KELLY_SAMPLE = 10

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Wilson 95% 胜率区间。小样本、全胜或全败时仍然稳定；不可退化成 normal interval。
 */
export function wilsonInterval(wins: number, total: number, z = Z_95): [number, number] | null {
  if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0 || wins < 0 || wins > total) return null
  const n = total
  const p = wins / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denom
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

/**
 * 二元合约凯莉：price 是买一份的成本，赢时净赚 1-price，输时损失 price。
 * b=(1-price)/price；f*=(p*b-(1-p))/b。负边际永远返回 0，不鼓励反向交易。
 */
export function computeKelly(winRate: number | null, averagePrice: number | null): number | null {
  if (!finite(winRate) || !finite(averagePrice) || winRate < 0 || winRate > 1 || averagePrice <= 0 || averagePrice >= 1) return null
  const b = (1 - averagePrice) / averagePrice
  if (!(b > 0)) return null
  return Math.max(0, (winRate * b - (1 - winRate)) / b)
}

/**
 * 按真实成交量/价聚合收益；同一 rule 的多笔单聚成一个独立结算，不虚增胜率样本。
 */
export function aggregateOutcomeStats(samples: SettledSample[], unit: 'rule' | 'order'): OutcomeStats {
  if (!samples.length) {
    return {
      n: 0, wins: 0, winRate: null, winRateCI: null, invested: 0, net: 0,
      roi: null, averagePrice: null, decimalOdds: null,
    }
  }

  type Bucket = { size: number; cost: number; proceeds: number; won: boolean }
  const buckets = new Map<string | number, Bucket>()
  for (const sample of samples) {
    if (!finite(sample.size) || sample.size <= 0 || !finite(sample.price) || sample.price <= 0 || sample.price >= 1) continue
    const key = unit === 'rule' ? sample.ruleId : sample.orderId
    const existing = buckets.get(key)
    const cost = sample.size * sample.price
    const proceeds = sample.won ? sample.size : 0
    if (existing) {
      // 一个 rule 只有一个 outcome；理论上不会冲突，取前者可让坏数据不把统计翻转。
      existing.size += sample.size
      existing.cost += cost
      existing.proceeds += proceeds
    } else {
      buckets.set(key, { size: sample.size, cost, proceeds, won: sample.won })
    }
  }

  const values = [...buckets.values()]
  const n = values.length
  const wins = values.filter((v) => v.won).length
  const invested = values.reduce((total, v) => total + v.cost, 0)
  const net = values.reduce((total, v) => total + v.proceeds - v.cost, 0)
  const totalSize = values.reduce((total, v) => total + v.size, 0)
  const averagePrice = totalSize > 0 ? invested / totalSize : null
  const winRate = n > 0 ? wins / n : null
  return {
    n,
    wins,
    winRate,
    winRateCI: winRate == null ? null : wilsonInterval(wins, n),
    invested,
    net,
    roi: invested > 0 ? net / invested : null,
    averagePrice,
    decimalOdds: averagePrice != null && averagePrice > 0 ? 1 / averagePrice : null,
  }
}

/**
 * 估算在观测到的边际不变时，让 win-rate 95% 区间下界越过市场隐含概率所需样本。
 * 这是提醒用的规模读数，不是对未来收益的承诺。
 */
export function requiredRulesForConfidence(stats: OutcomeStats): number | null {
  if (!stats.n || stats.winRate == null || stats.averagePrice == null) return null
  const edge = stats.winRate - stats.averagePrice
  if (!(edge > 0) || stats.winRate <= 0 || stats.winRate >= 1) return null
  return Math.ceil((Z_95 * Math.sqrt(stats.winRate * (1 - stats.winRate)) / edge) ** 2)
}

function priceBand(price: number): { key: string; label: string } {
  if (price < 0.7) return { key: 'under-0.70', label: '< 0.70' }
  if (price < 0.8) return { key: '0.70-0.79', label: '0.70–0.79' }
  if (price < 0.9) return { key: '0.80-0.89', label: '0.80–0.89' }
  if (price < 0.95) return { key: '0.90-0.94', label: '0.90–0.94' }
  return { key: '0.95-plus', label: '≥ 0.95' }
}

function groupStats(samples: Array<SettledSample & { key: string; label: string }>): ReportGroup[] {
  const groups = new Map<string, { label: string; values: SettledSample[] }>()
  for (const sample of samples) {
    const current = groups.get(sample.key) ?? { label: sample.label, values: [] }
    current.values.push(sample)
    groups.set(sample.key, current)
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const stats = aggregateOutcomeStats(group.values, 'rule')
      const sampleAdequate = stats.n >= MIN_GROUP_KELLY_SAMPLE
      return {
        key,
        label: group.label,
        ...stats,
        kelly: sampleAdequate ? computeKelly(stats.winRate, stats.averagePrice) : null,
        sampleAdequate,
      }
    })
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh-CN'))
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '')
}

function queryFilter(filters: RealOrderReportFilters, alias = 'o'): { where: string[]; params: any[] } {
  const where: string[] = ["r.rule_type = 'goal_surge'"]
  const params: any[] = []
  if (filters.league) { where.push('e.league = ?'); params.push(filters.league) }
  if (filters.marketType) { where.push('m.market_type = ?'); params.push(filters.marketType) }
  if (filters.line != null && Number.isFinite(filters.line)) { where.push('m.line = ?'); params.push(filters.line) }
  if (filters.from) { where.push(`${alias}.created_at >= ?`); params.push(filters.from) }
  if (filters.to) { where.push(`${alias}.created_at < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(filters.to) }
  return { where, params }
}

/**
 * 拉取实单分析：所有收益字段只来自 filled/settled + 已回填 outcome。
 * 查询量很小（当前数百条），明细随报告一起返回，避免前端分两次取而产生口径差。
 */
export async function fetchRealOrderReport(pool: Pool, filters: RealOrderReportFilters = {}): Promise<RealOrderReport> {
  const { where, params } = queryFilter(filters)
  const whereSql = where.join(' AND ')

  const [rawRows] = await pool.execute<any[]>(
    `SELECT o.id, o.rule_id, o.event_id, o.market_id, o.token_id, o.outcome,
            o.status AS bot_status, o.created_at AS bot_created_at,
            s.order_status, s.size AS order_size, s.price AS order_price, s.created_at AS order_created_at,
            r.settled_outcome,
            e.league, e.home_team_zh, e.away_team_zh, e.home_team_en, e.away_team_en,
            m.question_zh, m.question_en, m.market_type, m.line
       FROM price_bot_orders o
       JOIN price_bot_rules r ON r.id = o.rule_id
       LEFT JOIN soccer_orders s ON s.id = o.trade_order_id
       LEFT JOIN soccer_events e ON e.id = r.event_id
       LEFT JOIN soccer_markets m ON m.id = r.market_id
      WHERE ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC`,
    params,
  )

  const funnel: ExecutionFunnel = { skipped: 0, failed: 0, submitted: 0, cancelled: 0, partial: 0, filled: 0, settled: 0 }
  const rows: Array<RealOrderRow & { pnl: number | null }> = []
  const settled: Array<SettledSample & { league: string; marketKey: string; marketLabel: string; bandKey: string; bandLabel: string; date: string }> = []
  const unsettled = { n: 0, invested: 0 }

  for (const raw of rawRows) {
    const botStatus = String(raw.bot_status ?? '')
    const executionStatus = String(raw.order_status ?? '')
    if (botStatus === 'skipped') funnel.skipped++
    else if (botStatus === 'failed') funnel.failed++
    else if (botStatus === 'placed') funnel.submitted++

    if (executionStatus === 'cancelled') funnel.cancelled++
    else if ((PARTIAL_ORDER_STATUSES as readonly string[]).includes(executionStatus)) funnel.partial++
    else if (executionStatus === 'filled') funnel.filled++
    else if (executionStatus === 'settled') funnel.settled++

    const size = Number(raw.order_size)
    const price = Number(raw.order_price)
    const isRealFill = (FILLED_ORDER_STATUSES as readonly string[]).includes(executionStatus)
    const outcome = raw.settled_outcome === 'yes' || raw.settled_outcome === 'no' ? raw.settled_outcome : null
    const pnl = isRealFill && outcome && finite(size) && finite(price)
      ? outcome === 'yes' ? size * (1 - price) : -size * price
      : null
    const homeTeam = raw.home_team_zh || raw.home_team_en || null
    const awayTeam = raw.away_team_zh || raw.away_team_en || null
    rows.push({
      id: Number(raw.id), ruleId: Number(raw.rule_id), eventId: String(raw.event_id), marketId: String(raw.market_id),
      tokenId: String(raw.token_id), createdAt: normalizeDate(raw.order_created_at ?? raw.bot_created_at),
      executionStatus: executionStatus || botStatus, orderSize: finite(size) ? size : 0, orderPrice: finite(price) ? price : 0,
      settledOutcome: outcome, outcome: String(raw.outcome), league: raw.league ?? null, homeTeam, awayTeam,
      marketName: raw.question_zh || raw.question_en || null, marketType: raw.market_type ?? null,
      line: raw.line == null ? null : Number(raw.line), pnl,
    })

    if (!isRealFill || !finite(size) || !finite(price) || size <= 0 || price <= 0 || price >= 1) continue
    if (!outcome) {
      unsettled.n++
      unsettled.invested += size * price
      continue
    }
    const band = priceBand(price)
    const marketLabel = raw.market_type === 'total'
      ? `大小球 ${raw.line ?? '—'}`
      : raw.market_type === 'first_scorer' ? '谁先进球' : String(raw.market_type || '未分类')
    settled.push({
      orderId: Number(raw.id), ruleId: Number(raw.rule_id), size, price, won: outcome === 'yes',
      league: raw.league || '未标联赛', marketKey: `${raw.market_type ?? 'unknown'}:${raw.line ?? ''}`,
      marketLabel, bandKey: band.key, bandLabel: band.label,
      date: normalizeDate(raw.order_created_at ?? raw.bot_created_at).slice(0, 10),
    })
  }

  const byRule = aggregateOutcomeStats(settled, 'rule')
  const byOrder = aggregateOutcomeStats(settled, 'order')
  const point = computeKelly(byRule.winRate, byRule.averagePrice)
  const conservative = computeKelly(byRule.winRateCI?.[0] ?? null, byRule.averagePrice)
  const requiredRules = requiredRulesForConfidence(byRule)
  const kelly: KellyStats = {
    point,
    conservative,
    fractional: point == null ? null : point / 4,
    requiredRules,
    sampleAdequate: byRule.n >= MIN_KELLY_SAMPLE && conservative != null && conservative > 0,
  }

  const timelineGroups = new Map<string, SettledSample[]>()
  for (const row of settled) {
    const current = timelineGroups.get(row.date) ?? []
    current.push(row)
    timelineGroups.set(row.date, current)
  }
  let cumulativeNet = 0
  const timeline = [...timelineGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => {
      const stats = aggregateOutcomeStats(values, 'order')
      cumulativeNet += stats.net
      return {
        date,
        orders: stats.n,
        rules: aggregateOutcomeStats(values, 'rule').n,
        invested: stats.invested,
        net: stats.net,
        cumulativeNet,
      }
    })

  return {
    funnel,
    overall: { byRule, byOrder, unsettled },
    kelly,
    byLeague: groupStats(settled.map((row) => ({ ...row, key: row.league, label: row.league }))),
    byMarket: groupStats(settled.map((row) => ({ ...row, key: row.marketKey, label: row.marketLabel }))),
    byPriceBand: groupStats(settled.map((row) => ({ ...row, key: row.bandKey, label: row.bandLabel }))),
    timeline,
    rows,
  }
}

export async function listRealOrderReportLeagues(pool: Pool): Promise<Array<{ league: string; count: number }>> {
  const [rows] = await pool.execute<any[]>(`
    SELECT COALESCE(NULLIF(e.league, ''), '未标联赛') AS league, COUNT(DISTINCT o.rule_id) AS count
      FROM price_bot_orders o
      JOIN price_bot_rules r ON r.id = o.rule_id
      JOIN soccer_orders s ON s.id = o.trade_order_id
      LEFT JOIN soccer_events e ON e.id = r.event_id
     WHERE r.rule_type = 'goal_surge'
       AND s.order_status IN ('filled', 'settled')
       AND r.settled_outcome IN ('yes', 'no')
     GROUP BY league
     ORDER BY count DESC, league ASC
  `)
  return rows.map((row) => ({ league: String(row.league), count: Number(row.count) }))
}
