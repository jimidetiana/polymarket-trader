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

/** EV 面板默认算哪一档。历史数据只有这一档，保持默认视图不变。 */
export const DEFAULT_EV_LINE = 0.5

/**
 * 面板要展示的档位。与 DEFAULT_MONITOR_CONFIG.lines 对齐。
 *
 * 注意：多档**不是**同一个问题的更多样本。0.5 问「会不会进球」，
 * 1.5 问「会不会进第 2 个」——各自要独立攒够 MIN_EVENTS_FOR_EV 场。
 * 加档增加的是问题数（广度），不是任一问题的样本量（深度）。
 */
export const EV_LINES = [0.5, 1.5, 2.5]

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
  /** 这一格算的是哪个档。多档同采后必须带上，否则数字没有含义 */
  line: number
  /** 入场时机：每场取第一个可成交行，限定在这个分钟窗口内 */
  minuteFrom: number
  minuteTo: number
  cells: EvCell[]
  /** 该侧的自然基线胜率（全部已定局场次） */
  baseRate: number | null
  baseEvents: number
}

export type SelectionBiasRow = {
  /** 哪一档。可成交率各档差很多（实测 0.5 档 43.7% vs 1.5 档 69.3%），不能混算 */
  line: number
  outcome: string
  rows: number
  validRows: number
  validRate: number
  /** 观测数 = DISTINCT (event_id, line) */
  observations: number
}

/** 每档一行的结算统计。**不提供跨档合计**：见 SettlementRow 的注释。 */
export type SettlementRow = {
  line: number
  overWon: number
  underWon: number
  undecided: number
  /** Over 胜率（已定局为分母）。0.5 档 92.4%、1.5 档 75.0%、2.5 档 44.0% */
  overRate: number | null
}

export type EvReport = {
  /**
   * 结算口径统计，**每档一行**。
   * 为什么没有合计行：跨档相加得到的「Over 胜率 83.2%」既不是任何一档的胜率，
   * 也不随足球规律变——它只反映各档的采样比例，多采几晚 2.5 就会自己往下走。
   */
  settlement: { rows: SettlementRow[]; threshold: number }
  /** 选择偏差证据表 */
  selectionBias: SelectionBiasRow[]
  /** 自相关证据：行级 n vs 观测级 n（按档） */
  autocorrelation: Array<{
    line: number
    band: string
    rows: number
    observations: number
    rowsPerObservation: number
  }>
  /** 本次报告实际算了哪些档（库里有数据的那些） */
  lines: number[]
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

/**
 * 结算统计，**按档分开**。
 * 不分档相加会得到「Over 胜率 83.2%」这种不存在的数字：实测 0.5 档 92.4%、
 * 1.5 档 75.0%、2.5 档 44.0%，合计值只是这三个的采样加权平均，
 * 会随「今晚多采了哪档」自己漂移，不能当结论用。
 */
export async function fetchSettlement(pool: Pool): Promise<EvReport['settlement']> {
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT line, SUM(over_won = 1) over_won, SUM(over_won = 0) under_won,
           SUM(over_won IS NULL) undecided
    FROM outcome GROUP BY line ORDER BY line`)
  return {
    rows: rows.map((r) => {
      const ow = num(r.over_won)
      const uw = num(r.under_won)
      const decided = ow + uw
      return {
        line: num(r.line),
        overWon: ow,
        underWon: uw,
        undecided: num(r.undecided),
        overRate: decided > 0 ? ow / decided : null,
      }
    }),
    threshold: SETTLE_THRESHOLD,
  }
}

/**
 * 选择偏差证据：可成交率是否随最终结果变化。**按档分开**。
 * 各档的可成交率本身差很多（实测 0.5 档 Over 赢 43.7% / 1.5 档 69.3%），
 * 混算的话档间差异会盖住「同一档内、赢和输的可成交率不同」这个真正要看的信号。
 * 注意 Under 赢那一侧的观测数很小（0.5 档只有 8 个），不要在小样本上下结论。
 */
export async function fetchSelectionBias(pool: Pool): Promise<SelectionBiasRow[]> {
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT s.line, o.over_won, COUNT(*) rows_all, SUM(s.book_valid) valid_rows,
           COUNT(DISTINCT s.event_id, s.line) observations
    FROM price_bot_line_monitor s
    JOIN outcome o ON o.event_id = s.event_id AND o.line = s.line
    WHERE o.over_won IS NOT NULL AND s.match_minute BETWEEN 0 AND 90
    GROUP BY s.line, o.over_won ORDER BY s.line, o.over_won DESC`)
  return rows.map((r) => {
    const total = num(r.rows_all)
    const line = num(r.line)
    // 「0-0」只对 0.5 档成立。1.5 档的 Under 赢是「最多 1 球」，2.5 档是「最多 2 球」。
    // 用 floor(line) 表达上限，避免把三档都写成 0-0。
    const underLabel = line < 1 ? '0-0' : `最多 ${Math.floor(line)} 球`
    return {
      line,
      outcome: num(r.over_won) === 1 ? 'Over 赢（有进球）' : `Under 赢（${underLabel}）`,
      rows: total,
      validRows: num(r.valid_rows),
      validRate: total > 0 ? num(r.valid_rows) / total : 0,
      observations: num(r.observations),
    }
  })
}

/** 自相关证据：同一场被采了多少行 */
export async function fetchAutocorrelation(
  pool: Pool,
): Promise<EvReport['autocorrelation']> {
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT s.line, CASE WHEN s.best_ask < 0.60 THEN '<0.60'
                WHEN s.best_ask < 0.80 THEN '0.60-0.80'
                WHEN s.best_ask < 0.95 THEN '0.80-0.95'
                ELSE '>=0.95' END band,
           COUNT(*) rows_all,
           -- DISTINCT event_id 会把多档场次的行数摊到 1 个「场」上，
           -- 实测虚高 47%（385 行/场 vs 261 行/观测），把自相关说得比实际严重。
           COUNT(DISTINCT s.event_id, s.line) observations
    FROM price_bot_line_monitor s
    JOIN outcome o ON o.event_id = s.event_id AND o.line = s.line
    WHERE s.book_valid = 1 AND s.side = 'over' AND o.over_won IS NOT NULL
      AND s.match_minute BETWEEN 0 AND 90
    GROUP BY s.line, band ORDER BY s.line, band`)
  return rows.map((r) => ({
    line: num(r.line),
    band: String(r.band),
    rows: num(r.rows_all),
    observations: num(r.observations),
    rowsPerObservation: num(r.observations) > 0 ? num(r.rows_all) / num(r.observations) : 0,
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
  line: number = DEFAULT_EV_LINE,
): Promise<EvBreakdown> {
  // 赢的条件随侧翻转：买 Over 要 over_won=1，买 Under 要 over_won=0
  const winExpr = side === 'over' ? 'o.over_won' : '(1 - o.over_won)'
  const [rows] = await pool.query<any[]>(`${OUTCOME_CTE},
    first_valid AS (
      SELECT s.event_id, s.best_ask, ${winExpr} won,
             -- PARTITION 必须带 line。只按 event_id 分区的话，一场比赛在
             -- 多档同采时会被压成 1 个观测（line 排序最前的那档），其余档
             -- 的样本被静默丢掉。0.5 单档时这个 bug 不显形。
             ROW_NUMBER() OVER (
               PARTITION BY s.event_id, s.line ORDER BY s.match_minute, s.snapshot_at
             ) rn
      FROM price_bot_line_monitor s
      JOIN outcome o ON o.event_id = s.event_id AND o.line = s.line
      WHERE s.book_valid = 1 AND s.side = ? AND o.over_won IS NOT NULL
        AND s.best_ask IS NOT NULL
        AND s.line = ?
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
    [side, line, minuteFrom, minuteTo])

  // 基线也必须按档筛：outcome 是 per (event, line)，不筛档的话 0.5 的
  // 94.6% 会和 2.5 的胜率混成一个没有含义的平均数。
  const [base] = await pool.query<any[]>(`${OUTCOME_CTE}
    SELECT COUNT(*) events, SUM(${side === 'over' ? 'over_won' : '1 - over_won'}) wins
    FROM outcome WHERE over_won IS NOT NULL AND line = ?`, [line])
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
    line,
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

/**
 * 库里真正有数据的档位，与 EV_LINES 求交集。
 *
 * 为什么先查一次而不是直接按 EV_LINES 全算：每个 (档,侧,窗口) 是 2 条查询，
 * 3 档 × 2 侧 × 3 窗口 = 36 条。刚开采时 1.5/2.5 一行数据都没有，
 * 那 24 条查询全是空转，而面板每 20 秒刷一次。
 */
export async function fetchLinesWithData(pool: Pool): Promise<number[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT DISTINCT line FROM price_bot_line_monitor ORDER BY line`,
  )
  const present = new Set(rows.map((r) => Number(r.line)))
  const out = EV_LINES.filter((l) => present.has(l))
  // 一行数据都没有时也要给默认档，否则面板拿不到任何结构
  return out.length ? out : [DEFAULT_EV_LINE]
}

export async function fetchEvReport(pool: Pool): Promise<EvReport> {
  const lines = await fetchLinesWithData(pool)
  const [settlement, selectionBias, autocorrelation, ...breakdowns] = await Promise.all([
    fetchSettlement(pool),
    fetchSelectionBias(pool),
    fetchAutocorrelation(pool),
    ...lines.flatMap((line) =>
      MINUTE_WINDOWS.flatMap((w) => [
        fetchEvBreakdown(pool, 'over', w.from, w.to, line),
        fetchEvBreakdown(pool, 'under', w.from, w.to, line),
      ]),
    ),
  ])
  const bds = breakdowns as EvBreakdown[]
  return {
    settlement,
    selectionBias,
    autocorrelation,
    lines,
    breakdowns: bds,
    anyAdequate: bds.some((b) => b.cells.some((c) => c.adequate)),
  }
}
