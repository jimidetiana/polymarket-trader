import type { Pool } from 'mysql2/promise'

/**
 * 采集器（price_bot_line_monitor）的统一分析口径。
 *
 * 这张表是**纯观测**时间序列：每轮对窗口内每场的 over/under 两个 token 各写一行，
 * 同一轮共享一个 snapshot_at，所以同一时刻的 O/U 可以按 (snapshot_at,event_id,line) 配对。
 *
 * 三个必须记住的坑，否则读数会反：
 *
 * 1. **snapshot_at 存 UTC，但 MySQL 的 NOW() 返回服务器本地时（UTC+8）。**
 *    用 NOW() 判新鲜度会凭空多出 28800 秒，看起来像采集器挂了。一律用 UTC_TIMESTAMP()。
 *
 * 2. **match_minute 是相对「计划开哨」（soccer_events.end_time）算的，不是实际比赛钟。**
 *    负数=赛前。开哨时间有 ±30 分钟 slop，所以 match_minute=8 有可能实际还没开哨，
 *    match_minute=112 也不等于真的踢到 112 分钟。任何按分钟切的结论都得带这个误差。
 *
 * 3. **单边盘不是 bug。** over 与 under 是互补 token，p_under = 1 - p_over 逐档成立，
 *    所以 over(5档买/0档卖) 必然镜像成 under(0档买/5档卖)。0.5 大小球一旦进球就成定局，
 *    赢家钉在 0.999 且卖档全空 —— 这是真实盘面，正是采集器要记的分母。
 */

/** 有效（可成交）行的判定列。采集时已算好，这里只复用，避免两套口径。 */
const VALID = 'book_valid = 1'

export type MonitorOverview = {
  rows: number
  events: number
  tokens: number
  snapshots: number
  firstSnapshot: string | null
  lastSnapshot: string | null
  spanMinutes: number
  /** 距最后一轮多少秒（UTC 口径）。> 120 基本可判采集器停了 */
  staleSeconds: number | null
  validRows: number
  validPct: number
}

export type PhaseBucket = {
  phase: string
  rows: number
  valid: number
  validPct: number
  events: number
}

export type ReasonBucket = { reason: string; rows: number; pct: number }

export type BandBucket = {
  band: string
  rows: number
  minMinute: number | null
  maxMinute: number | null
}

export type PairShape = { shape: string; pairs: number }

export type MatchRow = {
  eventId: string
  title: string | null
  liquidity: number | null
  volume: number | null
  rows: number
  valid: number
  minMinute: number | null
  maxMinute: number | null
  reasons: string | null
}

export type ReversalParams = {
  /**
   * 算哪一档的反转。**必须筛档**：反转是「同一档」早端高位、晚端翻面，
   * 跨档比对没有意义。不筛的实测后果（143 场库）：分母是 0.5 档早盘命中的
   * 112 场，分子却接受任意档晚端 Under≥0.9——1-0 的比赛 Under 2.5 一直是
   * 0.999，于是 16 场「反转」里 10 场其实进了球，反转率从 5.4% 虚高到 14.3%。
   * 单档采集时这个 bug 不显形，1.5/2.5 进库后才暴露。
   */
  line: number
  /** 早端：over best_bid 高于此值 */
  earlyBid: number
  /** 早端分钟上界（不含） */
  earlyBefore: number
  /** 早端分钟下界（含）。设 0 可排除赛前样本 */
  earlyFrom: number | null
  /** 晚端：under best_bid 高于此值 */
  lateBid: number
  /** 晚端分钟下界（不含） */
  lateAfter: number
  /** 只算双边可成交的样本 */
  validOnly: boolean
}

export const DEFAULT_REVERSAL: ReversalParams = {
  line: 0.5,
  earlyBid: 0.9,
  earlyBefore: 10,
  earlyFrom: null,
  lateBid: 0.9,
  lateAfter: 100,
  validOnly: false,
}

export type ReversalResult = {
  params: ReversalParams
  /** 早端命中场次（分母之一） */
  earlyEvents: number
  /** 晚端命中场次（分母之二） */
  lateEvents: number
  /** 两端都命中 = 反转场次 */
  reversals: number
  /** 反转率 = reversals / earlyEvents */
  rate: number | null
  matches: ReversalMatch[]
}

export type ReversalMatch = {
  eventId: string
  title: string | null
  liquidity: number | null
  volume: number | null
  earlyMinMinute: number | null
  earlyMaxMinute: number | null
  earlyRows: number
  earlyMaxBid: number | null
  lateMinMinute: number | null
  lateMaxMinute: number | null
  lateRows: number
  lateMaxBid: number | null
}

export type MonitorReport = {
  overview: MonitorOverview
  phases: PhaseBucket[]
  reasons: ReasonBucket[]
  bands: BandBucket[]
  shapes: PairShape[]
  matches: MatchRow[]
  reversal: ReversalResult
  /** 闸门核对：入库场次里有多少在 liquidity 阈值之下 */
  gate: { events: number; belowGate: number; aboveGate: number; nullLiquidity: number; threshold: number }
}

const num = (v: unknown): number => Number(v ?? 0)
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v))

/** 比赛阶段的 SQL 分桶。赛前/场中/90分后 三段，NULL 单列。 */
const PHASE_SQL = `
  CASE WHEN match_minute IS NULL THEN '未知'
       WHEN match_minute < 0 THEN '赛前'
       WHEN match_minute <= 90 THEN '场中 0-90'
       ELSE '90分后' END`

/** 价格带分桶，与实单分析的带口径保持一致 */
const BAND_SQL = `
  CASE WHEN best_ask < 0.10 THEN '<0.10'
       WHEN best_ask < 0.30 THEN '0.10-0.30'
       WHEN best_ask < 0.70 THEN '0.30-0.70'
       WHEN best_ask < 0.90 THEN '0.70-0.90'
       ELSE '>=0.90' END`

export async function fetchMonitorOverview(pool: Pool): Promise<MonitorOverview> {
  const [rows] = await pool.query<any[]>(`
    SELECT COUNT(*) rows_all,
           COUNT(DISTINCT event_id) events,
           COUNT(DISTINCT token_id) tokens,
           COUNT(DISTINCT snapshot_at) snaps,
           MIN(snapshot_at) first_snap,
           MAX(snapshot_at) last_snap,
           TIMESTAMPDIFF(MINUTE, MIN(snapshot_at), MAX(snapshot_at)) span_min,
           TIMESTAMPDIFF(SECOND, MAX(snapshot_at), UTC_TIMESTAMP()) stale_sec,
           SUM(${VALID}) valid_rows
    FROM price_bot_line_monitor`)
  const r = rows[0] ?? {}
  const total = num(r.rows_all)
  const valid = num(r.valid_rows)
  return {
    rows: total,
    events: num(r.events),
    tokens: num(r.tokens),
    snapshots: num(r.snaps),
    firstSnapshot: strOrNull(r.first_snap),
    lastSnapshot: strOrNull(r.last_snap),
    spanMinutes: num(r.span_min),
    staleSeconds: numOrNull(r.stale_sec),
    validRows: valid,
    validPct: total > 0 ? valid / total : 0,
  }
}

export async function fetchPhaseBuckets(pool: Pool): Promise<PhaseBucket[]> {
  const [rows] = await pool.query<any[]>(`
    SELECT ${PHASE_SQL} phase,
           COUNT(*) rows_all,
           SUM(${VALID}) valid,
           COUNT(DISTINCT event_id) events,
           MIN(COALESCE(match_minute, 99999)) ord
    FROM price_bot_line_monitor
    GROUP BY phase ORDER BY ord`)
  return rows.map((r) => {
    const total = num(r.rows_all)
    const valid = num(r.valid)
    return {
      phase: String(r.phase),
      rows: total,
      valid,
      validPct: total > 0 ? valid / total : 0,
      events: num(r.events),
    }
  })
}

export async function fetchReasonBuckets(pool: Pool): Promise<ReasonBucket[]> {
  const [rows] = await pool.query<any[]>(`
    SELECT COALESCE(invalid_reason, '(有效)') reason, COUNT(*) rows_all
    FROM price_bot_line_monitor GROUP BY reason ORDER BY rows_all DESC`)
  const total = rows.reduce((s, r) => s + num(r.rows_all), 0)
  return rows.map((r) => ({
    reason: String(r.reason),
    rows: num(r.rows_all),
    pct: total > 0 ? num(r.rows_all) / total : 0,
  }))
}

export async function fetchBandBuckets(pool: Pool): Promise<BandBucket[]> {
  const [rows] = await pool.query<any[]>(`
    SELECT ${BAND_SQL} band, COUNT(*) rows_all,
           MIN(match_minute) mn, MAX(match_minute) mx
    FROM price_bot_line_monitor
    WHERE ${VALID} AND best_ask IS NOT NULL
    GROUP BY band ORDER BY rows_all DESC`)
  return rows.map((r) => ({
    band: String(r.band),
    rows: num(r.rows_all),
    minMinute: numOrNull(r.mn),
    maxMinute: numOrNull(r.mx),
  }))
}

/**
 * O/U 盘口形态配对。用来验证「单边盘是互补 token 的必然结果」而不是采集 bug：
 * 正常情况下 over(5b/0a) 必然对应 under(0b/5a)。
 */
export async function fetchPairShapes(pool: Pool, limit = 12): Promise<PairShape[]> {
  const [rows] = await pool.query<any[]>(`
    SELECT shape, COUNT(*) pairs FROM (
      SELECT snapshot_at, event_id, line,
        CONCAT(
          'over(', MAX(CASE WHEN side='over' THEN CONCAT(
            JSON_LENGTH(COALESCE(bid_depth,'[]')),'买/',
            JSON_LENGTH(COALESCE(ask_depth,'[]')),'卖') END), ') ',
          'under(', MAX(CASE WHEN side='under' THEN CONCAT(
            JSON_LENGTH(COALESCE(bid_depth,'[]')),'买/',
            JSON_LENGTH(COALESCE(ask_depth,'[]')),'卖') END), ')'
        ) shape
      FROM price_bot_line_monitor
      GROUP BY snapshot_at, event_id, line
    ) t GROUP BY shape ORDER BY pairs DESC LIMIT ?`, [limit])
  return rows.map((r) => ({ shape: String(r.shape), pairs: num(r.pairs) }))
}

export async function fetchMatchRows(pool: Pool, limit = 60): Promise<MatchRow[]> {
  const [rows] = await pool.query<any[]>(`
    SELECT m.event_id, e.title_zh, e.title_en, e.liquidity, e.volume,
           COUNT(*) rows_all, SUM(m.${VALID}) valid,
           MIN(m.match_minute) mn, MAX(m.match_minute) mx,
           GROUP_CONCAT(DISTINCT m.invalid_reason) reasons
    FROM price_bot_line_monitor m
    LEFT JOIN soccer_events e ON e.id = m.event_id
    GROUP BY m.event_id, e.title_zh, e.title_en, e.liquidity, e.volume
    ORDER BY rows_all DESC LIMIT ?`, [limit])
  return rows.map((r) => ({
    eventId: String(r.event_id),
    title: strOrNull(r.title_zh) ?? strOrNull(r.title_en),
    liquidity: numOrNull(r.liquidity),
    volume: numOrNull(r.volume),
    rows: num(r.rows_all),
    valid: num(r.valid),
    minMinute: numOrNull(r.mn),
    maxMinute: numOrNull(r.mx),
    reasons: strOrNull(r.reasons),
  }))
}

/**
 * 「反转」= 早端 over 高价（看多进球）→ 晚端 under 高价（最终没进够）。
 *
 * 口径注意，这三点直接决定数字大小：
 *
 * - `earlyFrom=null` 时早端含**赛前**样本（match_minute 为负）。足球 Over 0.5 赛前
 *   隐含概率本来就常在 0.9 以上，所以不设下界时早端会大量命中「赛前热门」，
 *   而不是「开场 N 分钟内已打出」。要只看场中，把 earlyFrom 设成 0。
 * - 晚端 under 顶到 0.999 通常是**单边钉死盘**（卖档空），不是双边可成交的反转。
 *   要排除就开 validOnly。
 * - 两端都受 match_minute 的 ±30 分钟开哨 slop 影响，见文件头第 2 条。
 */
export async function fetchReversal(
  pool: Pool,
  params: ReversalParams = DEFAULT_REVERSAL,
): Promise<ReversalResult> {
  const validClause = params.validOnly ? ` AND ${VALID}` : ''
  const earlyFromClause = params.earlyFrom == null ? '' : ' AND match_minute >= ?'

  // 两端都必须带 line，且是同一个 line：见 ReversalParams.line 的注释。
  // 参数顺序：line, bid, before, [from]
  const earlyArgs: number[] = [params.line, params.earlyBid, params.earlyBefore]
  if (params.earlyFrom != null) earlyArgs.push(params.earlyFrom)

  const earlySql = `
    SELECT DISTINCT event_id FROM price_bot_line_monitor
    WHERE line = ? AND side='over' AND best_bid > ? AND match_minute < ?${earlyFromClause}${validClause}`
  const lateSql = `
    SELECT DISTINCT event_id FROM price_bot_line_monitor
    WHERE line = ? AND side='under' AND best_bid > ? AND match_minute > ?${validClause}`
  const lateArgs: number[] = [params.line, params.lateBid, params.lateAfter]

  const [counts] = await pool.query<any[]>(
    `SELECT (SELECT COUNT(*) FROM (${earlySql}) a) early_events,
            (SELECT COUNT(*) FROM (${lateSql}) b) late_events,
            (SELECT COUNT(*) FROM (${lateSql}) c
              WHERE c.event_id IN (${earlySql})) reversals`,
    [...earlyArgs, ...lateArgs, ...lateArgs, ...earlyArgs],
  )
  const c = counts[0] ?? {}
  const earlyEvents = num(c.early_events)
  const reversals = num(c.reversals)

  // 反转场的两端明细。分别聚合早/晚端再按 event 合并，避免一次 GROUP BY 把两段混在一起
  const [matches] = await pool.query<any[]>(
    `SELECT m.event_id, e.title_zh, e.title_en, e.liquidity, e.volume,
            MIN(CASE WHEN m.side='over'  AND m.best_bid > ? AND m.match_minute < ?
                     THEN m.match_minute END) early_mn,
            MAX(CASE WHEN m.side='over'  AND m.best_bid > ? AND m.match_minute < ?
                     THEN m.match_minute END) early_mx,
            SUM(m.side='over'  AND m.best_bid > ? AND m.match_minute < ?) early_rows,
            MAX(CASE WHEN m.side='over'  AND m.match_minute < ? THEN m.best_bid END) early_max_bid,
            MIN(CASE WHEN m.side='under' AND m.best_bid > ? AND m.match_minute > ?
                     THEN m.match_minute END) late_mn,
            MAX(CASE WHEN m.side='under' AND m.best_bid > ? AND m.match_minute > ?
                     THEN m.match_minute END) late_mx,
            SUM(m.side='under' AND m.best_bid > ? AND m.match_minute > ?) late_rows,
            MAX(CASE WHEN m.side='under' AND m.match_minute > ? THEN m.best_bid END) late_max_bid
       FROM price_bot_line_monitor m
       LEFT JOIN soccer_events e ON e.id = m.event_id
      WHERE m.line = ?
        AND m.event_id IN (${lateSql}) AND m.event_id IN (${earlySql})
      GROUP BY m.event_id, e.title_zh, e.title_en, e.liquidity, e.volume
      ORDER BY late_rows DESC`,
    [
      params.earlyBid, params.earlyBefore,
      params.earlyBid, params.earlyBefore,
      params.earlyBid, params.earlyBefore,
      params.earlyBefore,
      params.lateBid, params.lateAfter,
      params.lateBid, params.lateAfter,
      params.lateBid, params.lateAfter,
      params.lateAfter,
      params.line,
      ...lateArgs, ...earlyArgs,
    ],
  )

  return {
    params,
    earlyEvents,
    lateEvents: num(c.late_events),
    reversals,
    rate: earlyEvents > 0 ? reversals / earlyEvents : null,
    matches: matches.map((r) => ({
      eventId: String(r.event_id),
      title: strOrNull(r.title_zh) ?? strOrNull(r.title_en),
      liquidity: numOrNull(r.liquidity),
      volume: numOrNull(r.volume),
      earlyMinMinute: numOrNull(r.early_mn),
      earlyMaxMinute: numOrNull(r.early_mx),
      earlyRows: num(r.early_rows),
      earlyMaxBid: numOrNull(r.early_max_bid),
      lateMinMinute: numOrNull(r.late_mn),
      lateMaxMinute: numOrNull(r.late_mx),
      lateRows: num(r.late_rows),
      lateMaxBid: numOrNull(r.late_max_bid),
    })),
  }
}

export async function fetchGateCheck(
  pool: Pool,
  threshold: number,
): Promise<MonitorReport['gate']> {
  const [rows] = await pool.query<any[]>(`
    SELECT COUNT(*) events,
           SUM(e.liquidity < ?) below_gate,
           SUM(e.liquidity >= ?) above_gate,
           SUM(e.liquidity IS NULL) null_liq
    FROM (SELECT DISTINCT event_id FROM price_bot_line_monitor) m
    LEFT JOIN soccer_events e ON e.id = m.event_id`, [threshold, threshold])
  const r = rows[0] ?? {}
  return {
    events: num(r.events),
    belowGate: num(r.below_gate),
    aboveGate: num(r.above_gate),
    nullLiquidity: num(r.null_liq),
    threshold,
  }
}

/** 一次取全。各段互不依赖，并发发出去。 */
export async function fetchMonitorReport(
  pool: Pool,
  opts: { reversal?: ReversalParams; gateThreshold?: number } = {},
): Promise<MonitorReport> {
  const reversalParams = opts.reversal ?? DEFAULT_REVERSAL
  const [overview, phases, reasons, bands, shapes, matches, reversal, gate] = await Promise.all([
    fetchMonitorOverview(pool),
    fetchPhaseBuckets(pool),
    fetchReasonBuckets(pool),
    fetchBandBuckets(pool),
    fetchPairShapes(pool),
    fetchMatchRows(pool),
    fetchReversal(pool, reversalParams),
    fetchGateCheck(pool, opts.gateThreshold ?? 5000),
  ])
  return { overview, phases, reasons, bands, shapes, matches, reversal, gate }
}

/** 把 query string 解析成反转参数，非法值退回默认而不是静默变 0 */
export function parseReversalParams(q: Record<string, unknown>): ReversalParams {
  const numParam = (raw: unknown, fallback: number): number => {
    if (raw == null || String(raw).trim() === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  const earlyFromRaw = q.earlyFrom
  return {
    line: numParam(q.line, DEFAULT_REVERSAL.line),
    earlyBid: numParam(q.earlyBid, DEFAULT_REVERSAL.earlyBid),
    earlyBefore: numParam(q.earlyBefore, DEFAULT_REVERSAL.earlyBefore),
    earlyFrom:
      earlyFromRaw == null || String(earlyFromRaw).trim() === ''
        ? null
        : numParam(earlyFromRaw, 0),
    lateBid: numParam(q.lateBid, DEFAULT_REVERSAL.lateBid),
    lateAfter: numParam(q.lateAfter, DEFAULT_REVERSAL.lateAfter),
    validOnly: q.validOnly === '1' || q.validOnly === 'true' || q.validOnly === true,
  }
}
