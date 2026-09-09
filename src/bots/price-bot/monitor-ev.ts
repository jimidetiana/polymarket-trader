import type { Pool } from 'mysql2/promise'

/**
 * 从采集器数据推「买入方案 + 盈利可能」的唯一口径。
 *
 * 这个模块的大部分复杂度用在**不让数字骗人**上。四个必须守住的前提：
 *
 * 1. **样本单位是「场」，不是「行」。** 采集器每 20 秒写一行，同一场 130 分钟能出
 *    上百行，且相邻行高度自相关。实测某价带 446 行只对应 5 场（89 行/场）。
 *    按行算胜率会把 n 虚增 ~70 倍，置信区间假窄。所以一律 per-event 聚合，
 *    每场只贡献 1 个观测。
 *
 * 2. **book_valid=1 是 outcome-dependent 的，必须显式披露。** 0.5 档进球后赢家钉
 *    0.999、卖档空 → 该行判 invalid。于是「可成交」偏向**还没进球**的场次：
 *    实测 Under 赢的场次可成交率 90.3%，Over 赢的只有 30.5%。只看可成交样本
 *    等于偏向 0-0，会系统性高估 Under、低估 Over。这不是能修掉的 bug，
 *    是这条线的结构性质，只能标出来。
 *
 * 3. **EV 必须用真实卖价（best_ask），不能用中价。** 历史回测里价差把 +2.1pp 的
 *    edge 直接吃成每美元 −27%。中价 EV 一律不出。
 *
 * 4. **结算口径来自终局价，不是猜的。** 每场最后一拍谁的买价 ≥0.99 就是谁赢；
 *    两边都没到就是**未定局**，必须排除，不能当成输（同「滤掉 skipped」的道理）。
 *
 * 另外：Over 0.5 的自然胜率本来就极高（实测 35/37 = 94.6%），所以「买 Over 赢多」
 *  本身不是发现。有意义的只有「胜率 − 隐含概率」这个差，且要过显著性。
 */

/** 终局价判定阈值。赢家会被推到 1.0，0.99 留出一档余量 */
const SETTLE_THRESHOLD = 0.99

/**
 * 一个格子至少要多少场才给出 EV 数字。低于这个数只显示「样本不足」。
 * 取 30：当前最大格子只有 18 场，宁可全部显示不足，也不给假精度。
 */
export const MIN_EVENTS_FOR_EV = 30

export type EvCell = {
  /** 分组标签，如 '0.80-0.95' */
  band: string
  /** 独立场次数（真实样本量） */
  events: number
  wins: number
  /** 胜率点估计 */
  winRate: number | null
  /** Wilson 95% 区间下界/上界 */
  ciLow: number | null
  ciHigh: number | null
  /** 平均真实买入价（best_ask） */
  avgAsk: number | null
  /** 每美元 EV = winRate/avgAsk - 1，按真实卖价 */
  evPerDollar: number | null
  /** EV 区间（用胜率 CI 两端算），跨零就说明方向都定不下来 */
  evLow: number | null
  evHigh: number | null
  /** 样本是否够到能出数 */
  adequate: boolean
  /** 要把 ±3pp 钉死还差多少场 */
  eventsNeeded: number
}

export type EvBreakdown = {
  side: 'over' | 'under'
  /** 入场时机：每场取第一个可成交行，限定在这个分钟窗口内 */
  minuteFrom: number
  minuteTo: number
  cells: EvCell[]
  /** 该侧的自然基线胜率（全部已定局场次） */
  baseRate: number | null
  baseEvents: number
}

export type SelectionBiasRow = {
  outcome: string
  rows: number
  validRows: number
  validRate: number
  events: number
}

export type EvReport = {
  /** 结算口径统计：定出多少场、多少场未定局 */
  settlement: { overWon: number; underWon: number; undecided: number; threshold: number }
  /** 选择偏差证据表 */
  selectionBias: SelectionBiasRow[]
  /** 自相关证据：行级 n vs 场级 n */
  autocorrelation: Array<{ band: string; rows: number; events: number; rowsPerEvent: number }>
  breakdowns: EvBreakdown[]
  /** 结论能不能用。任一格子样本够才为 true */
  anyAdequate: boolean
}

const num = (v: unknown): number => Number(v ?? 0)
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

/**
 * Wilson score 区间。小样本下比正态近似可靠，且 p=0 或 1 时不会退化成零宽区间
 * ——18 胜 0 负给出的上界仍是 1、下界约 0.82，这正是要展示的信息。
 */
export function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1]
  const p = wins / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (centre - half) / d), Math.min(1, (centre + half) / d)]
}

/** 把胜率钉到 ±margin 需要多少独立样本（最坏情况 p=0.5 时的保守估计） */
export function eventsForMargin(p: number, margin = 0.03, z = 1.96): number {
  const variance = Math.max(p * (1 - p), 0.01)
  return Math.ceil((z * z * variance) / (margin * margin))
}

/**
 * 结算结果的公共 CTE。每场每档取最后一拍，谁的买价 ≥ 阈值谁赢。
 * over_won: 1=Over 赢, 0=Under 赢, NULL=未定局（必须排除）
 */
const OUTCOME_CTE = `
  WITH last_snap AS (
    SELECT event_id, line, MAX(snapshot_at) ls
    FROM price_bot_line_monitor GROUP BY event_id, line
  ),
  outcome AS (
    SELECT m.event_id, m.line,
           CASE WHEN MAX(CASE WHEN m.side='over'  THEN m.best_bid END) >= ${SETTLE_THRESHOLD} THEN 1
                WHEN MAX(CASE WHEN m.side='under' THEN m.best_bid END) >= ${SETTLE_THRESHOLD} THEN 0
                ELSE NULL END over_won
    FROM price_bot_line_monitor m
    JOIN last_snap l
      ON l.event_id = m.event_id AND l.line = m.line AND l.ls = m.snapshot_at
    GROUP BY m.event_id, m.line
  )`

export async function fetchSettlement(pool: Pool): Promise<EvReport['settlement']> {
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT SUM(over_won = 1) over_won, SUM(over_won = 0) under_won,
           SUM(over_won IS NULL) undecided
    FROM outcome`)
  const r = rows[0] ?? {}
  return {
    overWon: num(r.over_won),
    underWon: num(r.under_won),
    undecided: num(r.undecided),
    threshold: SETTLE_THRESHOLD,
  }
}

/** 选择偏差证据：可成交率是否随最终结果变化 */
export async function fetchSelectionBias(pool: Pool): Promise<SelectionBiasRow[]> {
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT o.over_won, COUNT(*) rows_all, SUM(s.book_valid) valid_rows,
           COUNT(DISTINCT s.event_id) events
    FROM price_bot_line_monitor s
    JOIN outcome o ON o.event_id = s.event_id AND o.line = s.line
    WHERE o.over_won IS NOT NULL AND s.match_minute BETWEEN 0 AND 90
    GROUP BY o.over_won ORDER BY o.over_won DESC`)
  return rows.map((r) => {
    const total = num(r.rows_all)
    return {
      outcome: num(r.over_won) === 1 ? 'Over 赢（有进球）' : 'Under 赢（0-0）',
      rows: total,
      validRows: num(r.valid_rows),
      validRate: total > 0 ? num(r.valid_rows) / total : 0,
      events: num(r.events),
    }
  })
}

/** 自相关证据：同一场被采了多少行 */
export async function fetchAutocorrelation(
  pool: Pool,
): Promise<EvReport['autocorrelation']> {
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT CASE WHEN s.best_ask < 0.60 THEN '<0.60'
                WHEN s.best_ask < 0.80 THEN '0.60-0.80'
                WHEN s.best_ask < 0.95 THEN '0.80-0.95'
                ELSE '>=0.95' END band,
           COUNT(*) rows_all, COUNT(DISTINCT s.event_id) events
    FROM price_bot_line_monitor s
    JOIN outcome o ON o.event_id = s.event_id AND o.line = s.line
    WHERE s.book_valid = 1 AND s.side = 'over' AND o.over_won IS NOT NULL
      AND s.match_minute BETWEEN 0 AND 90
    GROUP BY band ORDER BY band`)
  return rows.map((r) => ({
    band: String(r.band),
    rows: num(r.rows_all),
    events: num(r.events),
    rowsPerEvent: num(r.events) > 0 ? num(r.rows_all) / num(r.events) : 0,
  }))
}

/**
 * 某一侧的买入方案 EV。**每场只取一个观测**：分钟窗口内第一个可成交行，
 * 模拟「策略在该窗口首次出现可成交盘口时入场」。这样 n 就是真实场次数。
 *
 * 买入价一律用 best_ask（真实要付的价），赢了拿 1，所以
 *   每美元 EV = 胜率 / 平均买入价 − 1
 */
export async function fetchEvBreakdown(
  pool: Pool,
  side: 'over' | 'under',
  minuteFrom: number,
  minuteTo: number,
): Promise<EvBreakdown> {
  // 赢的条件随侧翻转：买 Over 要 over_won=1，买 Under 要 over_won=0
  const winExpr = side === 'over' ? 'o.over_won' : '(1 - o.over_won)'
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE},
    first_valid AS (
      SELECT s.event_id, s.best_ask, ${winExpr} won,
             ROW_NUMBER() OVER (
               PARTITION BY s.event_id ORDER BY s.match_minute, s.snapshot_at
             ) rn
      FROM price_bot_line_monitor s
      JOIN outcome o ON o.event_id = s.event_id AND o.line = s.line
      WHERE s.book_valid = 1 AND s.side = ? AND o.over_won IS NOT NULL
        AND s.best_ask IS NOT NULL
        AND s.match_minute BETWEEN ? AND ?
    )
    SELECT CASE WHEN best_ask < 0.30 THEN '<0.30'
                WHEN best_ask < 0.60 THEN '0.30-0.60'
                WHEN best_ask < 0.80 THEN '0.60-0.80'
                WHEN best_ask < 0.95 THEN '0.80-0.95'
                ELSE '>=0.95' END band,
           COUNT(*) events, SUM(won) wins, AVG(best_ask) avg_ask
    FROM first_valid WHERE rn = 1
    GROUP BY band ORDER BY band`,
    [side, minuteFrom, minuteTo])

  const [base] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT COUNT(*) events, SUM(${side === 'over' ? 'over_won' : '1 - over_won'}) wins
    FROM outcome WHERE over_won IS NOT NULL`)
  const b = base[0] ?? {}
  const baseEvents = num(b.events)

  const cells: EvCell[] = rows.map((r) => {
    const events = num(r.events)
    const wins = num(r.wins)
    const avgAsk = numOrNull(r.avg_ask)
    const winRate = events > 0 ? wins / events : null
    const [ciLow, ciHigh] = wilson(wins, events)
    const adequate = events >= MIN_EVENTS_FOR_EV
    const ev = winRate != null && avgAsk != null && avgAsk > 0 ? winRate / avgAsk - 1 : null
    return {
      band: String(r.band),
      events,
      wins,
      winRate,
      ciLow: events > 0 ? ciLow : null,
      ciHigh: events > 0 ? ciHigh : null,
      avgAsk,
      evPerDollar: ev,
      evLow: avgAsk != null && avgAsk > 0 ? ciLow / avgAsk - 1 : null,
      evHigh: avgAsk != null && avgAsk > 0 ? ciHigh / avgAsk - 1 : null,
      adequate,
      eventsNeeded: Math.max(0, eventsForMargin(winRate ?? 0.5) - events),
    }
  })

  return {
    side,
    minuteFrom,
    minuteTo,
    cells,
    baseRate: baseEvents > 0 ? num(b.wins) / baseEvents : null,
    baseEvents,
  }
}

/** 入场时机网格：赛前、上半场、下半场各算一遍，看时机是否影响 EV */
export const MINUTE_WINDOWS: Array<{ label: string; from: number; to: number }> = [
  { label: '赛前', from: -60, to: -1 },
  { label: '上半场 0-45', from: 0, to: 45 },
  { label: '下半场 46-90', from: 46, to: 90 },
]

export async function fetchEvReport(pool: Pool): Promise<EvReport> {
  const [settlement, selectionBias, autocorrelation, ...breakdowns] = await Promise.all([
    fetchSettlement(pool),
    fetchSelectionBias(pool),
    fetchAutocorrelation(pool),
    ...MINUTE_WINDOWS.flatMap((w) => [
      fetchEvBreakdown(pool, 'over', w.from, w.to),
      fetchEvBreakdown(pool, 'under', w.from, w.to),
    ]),
  ])
  const bds = breakdowns as EvBreakdown[]
  return {
    settlement,
    selectionBias,
    autocorrelation,
    breakdowns: bds,
    anyAdequate: bds.some((b) => b.cells.some((c) => c.adequate)),
  }
}
