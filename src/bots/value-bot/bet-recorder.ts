/**
 * 投注记录器 - 数据库读写
 */

import { pool, getEventsWithMarkets } from '../../soccer/db'
import type { InitialOdds, ValueBetRecord, CalcLogEntry } from './types'

/**
 * 初始化机器人需要的数据库表
 */
export async function ensureTables(): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS value_bot_match_state (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(100) NOT NULL,
      home_team VARCHAR(200) NOT NULL,
      away_team VARCHAR(200) NOT NULL,
      lambda_home DECIMAL(8,4) NOT NULL,
      lambda_away DECIMAL(8,4) NOT NULL,
      initial_home_prob DECIMAL(8,4) NOT NULL,
      initial_draw_prob DECIMAL(8,4) NOT NULL,
      initial_away_prob DECIMAL(8,4) NOT NULL,
      bzzoiro_event_id BIGINT DEFAULT NULL,
      bzzoiro_home_team VARCHAR(200) DEFAULT NULL,
      bzzoiro_away_team VARCHAR(200) DEFAULT NULL,
      source VARCHAR(20) DEFAULT 'polymarket',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_event (event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  // 兼容已有表：尝试添加新列（忽略已存在错误）
  try {
    await pool.execute(`ALTER TABLE value_bot_match_state ADD COLUMN bzzoiro_home_team VARCHAR(200) DEFAULT NULL`);
  } catch {}
  try {
    await pool.execute(`ALTER TABLE value_bot_match_state ADD COLUMN bzzoiro_away_team VARCHAR(200) DEFAULT NULL`);
  } catch {}
  try {
    await pool.execute(`ALTER TABLE value_bot_match_state ADD COLUMN bias_direction VARCHAR(10) DEFAULT 'none'`);
  } catch {}
  try {
    await pool.execute(`ALTER TABLE value_bot_match_state ADD COLUMN bias_coefficient DECIMAL(8,4) DEFAULT 0`);
  } catch {}

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS value_bet_records (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      bot_id VARCHAR(50) NOT NULL,
      polymarket_event_id VARCHAR(100) NOT NULL,
      bzzoiro_event_id BIGINT DEFAULT NULL,
      market_id VARCHAR(100) NOT NULL,
      market_type VARCHAR(50) NOT NULL,
      question VARCHAR(500) DEFAULT NULL,
      outcome VARCHAR(100) NOT NULL,
      handicap DECIMAL(10,3) DEFAULT NULL,
      model_probability DECIMAL(8,4) NOT NULL,
      market_price DECIMAL(8,4) NOT NULL,
      implied_probability DECIMAL(8,4) NOT NULL,
      edge DECIMAL(8,4) NOT NULL,
      match_minute INT NOT NULL,
      current_score VARCHAR(20) NOT NULL,
      lambda_home DECIMAL(8,4) NOT NULL,
      lambda_away DECIMAL(8,4) NOT NULL,
      recommendation VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'recorded',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_bot (bot_id),
      KEY idx_event (polymarket_event_id),
      KEY idx_created (created_at),
      KEY idx_edge (edge)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS value_bot_calc_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(100) NOT NULL,
      bzzoiro_event_id BIGINT DEFAULT NULL,
      calc_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      match_minute INT NOT NULL,
      home_score INT NOT NULL,
      away_score INT NOT NULL,
      market_id VARCHAR(100) NOT NULL,
      market_type VARCHAR(50) NOT NULL,
      question VARCHAR(500) DEFAULT NULL,
      outcome VARCHAR(100) NOT NULL,
      handicap DECIMAL(10,3) DEFAULT NULL,
      model_probability DECIMAL(8,4) NOT NULL,
      best_bid DECIMAL(8,4) DEFAULT NULL,
      best_bid_size DECIMAL(14,4) DEFAULT NULL,
      best_ask DECIMAL(8,4) DEFAULT NULL,
      best_ask_size DECIMAL(14,4) DEFAULT NULL,
      edge DECIMAL(8,4) NOT NULL,
      recommendation VARCHAR(20) NOT NULL,
      KEY idx_event (event_id),
      KEY idx_time (calc_time),
      KEY idx_market (market_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

/**
 * 保存或更新初盘状态
 */
export async function saveMatchState(initial: InitialOdds, bzzoiroEventId?: number): Promise<void> {
  await pool.execute(
    `INSERT INTO value_bot_match_state
      (event_id, home_team, away_team, lambda_home, lambda_away,
       initial_home_prob, initial_draw_prob, initial_away_prob, bzzoiro_event_id, source,
       bias_direction, bias_coefficient)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       lambda_home=VALUES(lambda_home), lambda_away=VALUES(lambda_away),
       initial_home_prob=VALUES(initial_home_prob), initial_draw_prob=VALUES(initial_draw_prob),
       initial_away_prob=VALUES(initial_away_prob), bzzoiro_event_id=VALUES(bzzoiro_event_id),
       bias_direction=VALUES(bias_direction), bias_coefficient=VALUES(bias_coefficient)`,
    [
      initial.eventId,
      initial.homeTeam,
      initial.awayTeam,
      initial.lambdaHome,
      initial.lambdaAway,
      initial.initialHomeProb,
      initial.initialDrawProb,
      initial.initialAwayProb,
      bzzoiroEventId ?? null,
      initial.source,
      initial.biasDirection,
      initial.biasCoefficient,
    ],
  )
}

/**
 * 获取已保存的初盘状态
 */
export async function getMatchState(eventId: string): Promise<InitialOdds | null> {
  const [rows] = await pool.execute<any[]>(
    `SELECT event_id, home_team, away_team, lambda_home, lambda_away,
            initial_home_prob, initial_draw_prob, initial_away_prob, source, created_at,
            bias_direction, bias_coefficient
     FROM value_bot_match_state WHERE event_id = ?`,
    [eventId],
  )
  if (!rows.length) return null
  const r = rows[0]
  return {
    eventId: r.event_id,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    lambdaHome: Number(r.lambda_home),
    lambdaAway: Number(r.lambda_away),
    initialHomeProb: Number(r.initial_home_prob),
    initialDrawProb: Number(r.initial_draw_prob),
    initialAwayProb: Number(r.initial_away_prob),
    source: r.source,
    createdAt: r.created_at,
    biasDirection: (r.bias_direction as 'home' | 'away' | 'none') || 'none',
    biasCoefficient: Number(r.bias_coefficient || 0),
  }
}

/**
 * 获取所有已配置初盘的比赛列表
 */
export async function getAllMatchStates(): Promise<any[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT s.*, e.title_en, e.title_zh, e.start_time, e.end_time, e.event_status
     FROM value_bot_match_state s
     LEFT JOIN soccer_events e ON s.event_id = e.id
     ORDER BY s.updated_at DESC`,
  )
  return rows
}

/**
 * 获取可用 Polymarket 比赛（进行中或即将开始的）
 */
export async function getAvailablePolymarketMatches(): Promise<any[]> {
  const events = await getEventsWithMarkets()
  return events.filter((e: any) => {
    const status = e.match_status as string
    return (status === 'live' || status === 'not_started') && e.home_team_en
  })
}

/**
 * 根据让球盘口推导比赛方向和系数
 * @param teamName 让球方队名（如 "主队" 或 "客队" 的名字）
 * @param handicap 让球线（负值表示让球，如 -1.5 表示让1.5球）
 * @param homeTeam 主队名
 * @param awayTeam 客队名
 * @returns { direction, coefficient }
 */
export function deriveBiasFromHandicap(
  teamName: string,
  handicap: number,
  homeTeam: string,
  awayTeam: string,
): { direction: 'home' | 'away' | 'none'; coefficient: number } {
  const t = teamName.trim().toLowerCase()
  const h = homeTeam.trim().toLowerCase()
  const a = awayTeam.trim().toLowerCase()

  let direction: 'home' | 'away' | 'none' = 'none'
  if (t.includes(h) && !t.includes(a)) direction = 'home'
  else if (t.includes(a) && !t.includes(h)) direction = 'away'

  // 让球线绝对值越大，系数越大
  // 0.25 → 0.02, 0.5 → 0.04, 1.0 → 0.07, 1.5 → 0.10, 2.0 → 0.13, 2.5 → 0.15
  const absHc = Math.abs(handicap)
  const coefficient = Math.min(0.2, Math.round(absHc * 0.065 * 1000) / 1000)

  return { direction, coefficient }
}

/**
 * 手动设置初盘概率（自动推导 λ）
 */
export async function setManualInitialOdds(
  eventId: string,
  homeTeam: string,
  awayTeam: string,
  homeProb: number,
  drawProb: number,
  awayProb: number,
  bzzoiroEventId?: number,
  bzzoiroHomeTeam?: string,
  bzzoiroAwayTeam?: string,
  biasDirection?: 'home' | 'away' | 'none',
  biasCoefficient?: number,
  handicapTeam?: string,
  handicapValue?: number,
): Promise<InitialOdds> {
  await ensureTables()
  const { inferLambdas } = await import('./probability-model')
  const { lambdaHome, lambdaAway } = inferLambdas(homeProb, drawProb, awayProb)

  // 如果提供了让球盘口，自动推导方向和系数
  let direction: 'home' | 'away' | 'none' = biasDirection || 'none'
  let coefficient = biasCoefficient ?? 0
  if (handicapTeam && handicapValue !== undefined) {
    const derived = deriveBiasFromHandicap(handicapTeam, handicapValue, homeTeam, awayTeam)
    direction = derived.direction
    coefficient = derived.coefficient
  }

  const initial: InitialOdds = {
    eventId,
    homeTeam,
    awayTeam,
    lambdaHome,
    lambdaAway,
    initialHomeProb: homeProb,
    initialDrawProb: drawProb,
    initialAwayProb: awayProb,
    source: 'manual',
    createdAt: new Date().toISOString(),
    biasDirection: direction,
    biasCoefficient: coefficient,
  }

  await saveMatchState(initial, bzzoiroEventId)

  await pool.execute(
    `UPDATE value_bot_match_state SET bzzoiro_home_team = ?, bzzoiro_away_team = ? WHERE event_id = ?`,
    [bzzoiroHomeTeam || null, bzzoiroAwayTeam || null, eventId],
  )

  return initial
}

/**
 * 删除初盘状态
 */
export async function deleteMatchState(eventId: string): Promise<void> {
  await pool.execute(`DELETE FROM value_bot_match_state WHERE event_id = ?`, [eventId])
}
/**
 * 记录价值投注
 */
export async function recordBet(record: ValueBetRecord): Promise<number> {
  const [result] = await pool.execute<any>(
    `INSERT INTO value_bet_records
      (bot_id, polymarket_event_id, bzzoiro_event_id, market_id, market_type, question,
       outcome, handicap, model_probability, market_price, implied_probability, edge,
       match_minute, current_score, lambda_home, lambda_away, recommendation, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.botId,
      record.polymarketEventId,
      record.bzzoiroEventId,
      record.marketId,
      record.marketType,
      record.question,
      record.outcome,
      record.handicap,
      record.modelProbability,
      record.marketPrice,
      record.impliedProbability,
      record.edge,
      record.matchMinute,
      record.currentScore,
      record.lambdaHome,
      record.lambdaAway,
      record.recommendation,
      record.status,
    ],
  )
  return result.insertId
}

/**
 * 批量记录（去重：同一比赛同一盘口同一分钟只记一条）
 */
export async function recordBets(records: ValueBetRecord[]): Promise<number> {
  let count = 0
  for (const record of records) {
    // 检查是否已存在相同记录（同一比赛、同一盘口、同一outcome、同一分钟）
    const [existing] = await pool.execute<any[]>(
      `SELECT id FROM value_bet_records
       WHERE bot_id = ? AND polymarket_event_id = ? AND market_id = ? AND outcome = ? AND match_minute = ?`,
      [record.botId, record.polymarketEventId, record.marketId, record.outcome, record.matchMinute],
    )
    if (existing.length > 0) continue
    await recordBet(record)
    count++
  }
  return count
}

/**
 * 查询价值投注记录
 */
export async function getBetRecords(options: {
  limit?: number
  offset?: number
  botId?: string
  eventId?: string
  recommendation?: string
  minEdge?: number
  orderBy?: string
}): Promise<{ records: any[]; total: number }> {
  const { limit = 50, offset = 0, botId, eventId, recommendation, minEdge } = options
  const where: string[] = []
  const params: any[] = []

  if (botId) {
    where.push('bot_id = ?')
    params.push(botId)
  }
  if (eventId) {
    where.push('polymarket_event_id = ?')
    params.push(eventId)
  }
  if (recommendation) {
    where.push('recommendation = ?')
    params.push(recommendation)
  }
  if (minEdge !== undefined) {
    where.push('ABS(edge) >= ?')
    params.push(minEdge)
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const orderClause = `ORDER BY ${options.orderBy || 'created_at DESC'}`

  const [rows] = await pool.query<any[]>(
    `SELECT * FROM value_bet_records ${whereClause} ${orderClause} LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  )

  const [countRows] = await pool.query<any[]>(
    `SELECT COUNT(*) as total FROM value_bet_records ${whereClause}`,
    params,
  )

  return { records: rows, total: countRows[0]?.total || 0 }
}

/**
 * 批量保存计算日志
 */
export async function saveCalcLogs(entries: CalcLogEntry[]): Promise<void> {
  if (!entries.length) return
  for (const e of entries) {
    await pool.execute(
      `INSERT INTO value_bot_calc_logs
        (event_id, bzzoiro_event_id, match_minute, home_score, away_score,
         market_id, market_type, question, outcome, handicap,
         model_probability, best_bid, best_bid_size, best_ask, best_ask_size,
         edge, recommendation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.eventId,
        e.bzzoiroEventId,
        e.matchMinute,
        e.homeScore,
        e.awayScore,
        e.marketId,
        e.marketType,
        e.question,
        e.outcome,
        e.handicap,
        e.modelProbability,
        e.bestBid,
        e.bestBidSize,
        e.bestAsk,
        e.bestAskSize,
        e.edge,
        e.recommendation,
      ],
    )
  }
}

/**
 * 查询某场比赛的计算日志
 */
export async function getCalcLogs(
  eventId: string,
  options: { limit?: number; offset?: number; lastOnly?: boolean } = {},
): Promise<{ logs: any[]; total: number }> {
  const { limit = 100, offset = 0, lastOnly = false } = options

  if (lastOnly) {
    const [rows] = await pool.query<any[]>(
      `SELECT * FROM value_bot_calc_logs
       WHERE event_id = ?
       ORDER BY calc_time DESC
       LIMIT ?`,
      [eventId, Number(limit)],
    )
    return { logs: rows, total: rows.length }
  }

  const [rows] = await pool.query<any[]>(
    `SELECT * FROM value_bot_calc_logs
     WHERE event_id = ?
     ORDER BY calc_time DESC
     LIMIT ? OFFSET ?`,
    [eventId, Number(limit), Number(offset)],
  )

  const [countRows] = await pool.query<any[]>(
    `SELECT COUNT(*) as total FROM value_bot_calc_logs WHERE event_id = ?`,
    [eventId],
  )

  return { logs: rows, total: countRows[0]?.total || 0 }
}

/**
 * 获取某场比赛的日志分析数据（按盘口分组）
 */
export async function getCalcLogsAnalysis(
  eventId: string,
): Promise<{
  matchInfo: { homeTeam: string; awayTeam: string; homeScore: number; awayScore: number; minute: number } | null
  markets: Array<{
    marketId: string
    marketType: string
    question: string | null
    handicap: number | null
    outcomes: Array<{
      outcome: string
      timeline: Array<{
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
      }>
    }>
  }>
}> {
  const [stateRows] = await pool.query<any[]>(
    `SELECT home_team, away_team FROM value_bot_match_state WHERE event_id = ?`,
    [eventId],
  )
  const matchInfo = stateRows.length
    ? { homeTeam: stateRows[0].home_team, awayTeam: stateRows[0].away_team, homeScore: 0, awayScore: 0, minute: 0 }
    : null

  const [rows] = await pool.query<any[]>(
    `SELECT * FROM value_bot_calc_logs WHERE event_id = ? ORDER BY calc_time ASC`,
    [eventId],
  )

  const marketMap = new Map<string, {
    marketId: string
    marketType: string
    question: string | null
    handicap: number | null
    outcomes: Map<string, {
      outcome: string
      timeline: any[]
    }>
  }>()

  for (const r of rows) {
    const key = r.market_id
    if (!marketMap.has(key)) {
      marketMap.set(key, {
        marketId: r.market_id,
        marketType: r.market_type,
        question: r.question,
        handicap: r.handicap != null ? Number(r.handicap) : null,
        outcomes: new Map(),
      })
    }
    const market = marketMap.get(key)!
    const outcomeKey = r.outcome
    if (!market.outcomes.has(outcomeKey)) {
      market.outcomes.set(outcomeKey, { outcome: outcomeKey, timeline: [] })
    }
    market.outcomes.get(outcomeKey)!.timeline.push({
      calcTime: r.calc_time,
      matchMinute: r.match_minute,
      homeScore: r.home_score,
      awayScore: r.away_score,
      modelProbability: Number(r.model_probability),
      bestBid: r.best_bid != null ? Number(r.best_bid) : null,
      bestBidSize: r.best_bid_size != null ? Number(r.best_bid_size) : null,
      bestAsk: r.best_ask != null ? Number(r.best_ask) : null,
      bestAskSize: r.best_ask_size != null ? Number(r.best_ask_size) : null,
      edge: Number(r.edge),
      recommendation: r.recommendation,
    })

    if (matchInfo) {
      matchInfo.homeScore = r.home_score
      matchInfo.awayScore = r.away_score
      matchInfo.minute = r.match_minute
    }
  }

  const markets = Array.from(marketMap.values()).map((m) => ({
    marketId: m.marketId,
    marketType: m.marketType,
    question: m.question,
    handicap: m.handicap,
    outcomes: Array.from(m.outcomes.values()),
  }))

  return { matchInfo, markets }
}
