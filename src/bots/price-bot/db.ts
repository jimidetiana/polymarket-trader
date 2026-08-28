/**
 * 价格监控机器人数据库层
 *
 * 管理监控规则表和触发事件记录表。
 */

import { pool, computeMatchStatus } from '../../soccer/db.js'
import type {
  PriceMonitorRule,
  PriceTriggerRecord,
  PriceBotLog,
  PriceBotConnectionEvent,
  GoalSurgeParams,
} from './types.js'

// ==================== 表结构 ====================

/**
 * 建表只需跑一次。
 *
 * ensureTables 被每个 db 函数调用，而价格采样会高频写入，
 * 每次都执行建表 + INFORMATION_SCHEMA 查询是不必要的开销。
 * 缓存 promise 而非布尔值，避免并发首次调用重复建表。
 */
let ensureTablesPromise: Promise<void> | null = null

export function ensureTables(): Promise<void> {
  if (!ensureTablesPromise) {
    ensureTablesPromise = doEnsureTables().catch((err) => {
      // 失败时清空缓存，下次调用可重试
      ensureTablesPromise = null
      throw err
    })
  }
  return ensureTablesPromise
}

async function doEnsureTables(): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_bot_rules (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      token_id VARCHAR(200) NOT NULL,
      market_id VARCHAR(100) NOT NULL,
      event_id VARCHAR(100) NOT NULL,
      outcome VARCHAR(100) NOT NULL,
      rule_type VARCHAR(30) NOT NULL COMMENT 'percent_change/price_break/price_range',
      direction VARCHAR(10) NOT NULL COMMENT 'up/down/both',
      percent_threshold DECIMAL(8,4) DEFAULT NULL,
      target_price DECIMAL(8,4) DEFAULT NULL,
      price_low DECIMAL(8,4) DEFAULT NULL,
      price_high DECIMAL(8,4) DEFAULT NULL,
      signal_type VARCHAR(20) NOT NULL DEFAULT 'alert' COMMENT 'buy_signal/sell_signal/alert',
      cooldown_seconds INT NOT NULL DEFAULT 1,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_token_rule (token_id, rule_type, direction),
      KEY idx_event (event_id),
      KEY idx_market (market_id),
      KEY idx_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  // 已存在的表补充 goal_surge 参数列（JSON，老版本 MySQL 退化 TEXT）
  await ensureRuleColumns()

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_bot_triggers (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      bot_id VARCHAR(50) NOT NULL,
      rule_id BIGINT NOT NULL,
      token_id VARCHAR(200) NOT NULL,
      market_id VARCHAR(100) NOT NULL,
      event_id VARCHAR(100) NOT NULL,
      outcome VARCHAR(100) NOT NULL,
      rule_type VARCHAR(30) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      previous_price DECIMAL(8,4) NOT NULL,
      current_price DECIMAL(8,4) NOT NULL,
      change_percent DECIMAL(8,4) NOT NULL,
      threshold DECIMAL(8,4) NOT NULL,
      signal_type VARCHAR(20) NOT NULL,
      triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_bot (bot_id),
      KEY idx_rule (rule_id),
      KEY idx_token (token_id),
      KEY idx_time (triggered_at),
      KEY idx_event (event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_bot_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      rule_id BIGINT NOT NULL,
      token_id VARCHAR(200) NOT NULL,
      event_id VARCHAR(100) NOT NULL,
      outcome VARCHAR(100) NOT NULL,
      action VARCHAR(20) NOT NULL COMMENT 'start/stop/price_update/trigger/disconnect/reconnect',
      price DECIMAL(8,4) DEFAULT NULL,
      best_bid DECIMAL(8,4) DEFAULT NULL,
      best_bid_size DECIMAL(18,4) DEFAULT NULL,
      best_ask DECIMAL(8,4) DEFAULT NULL,
      best_ask_size DECIMAL(18,4) DEFAULT NULL,
      source VARCHAR(10) DEFAULT NULL COMMENT 'ws/rest',
      detail TEXT DEFAULT NULL,
      logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_rule (rule_id),
      KEY idx_time (logged_at),
      KEY idx_event (event_id),
      KEY idx_rule_action_time (rule_id, action, logged_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  // 已存在的表需要补列（CREATE TABLE IF NOT EXISTS 不会修改现有表结构）
  await ensureLogColumns()

  // 连接事件表：记录 WS 断开/重连，用于验证断联与进球的相关性
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_bot_connection_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      bot_id VARCHAR(50) NOT NULL,
      event_type VARCHAR(20) NOT NULL COMMENT 'disconnect/reconnect',
      reason VARCHAR(40) NOT NULL COMMENT 'ws_close/pong_timeout/ws_error/resubscribe',
      close_code INT DEFAULT NULL,
      downtime_ms INT DEFAULT NULL,
      subscribed_tokens INT NOT NULL DEFAULT 0,
      token_id VARCHAR(200) DEFAULT NULL,
      price_before DECIMAL(8,4) DEFAULT NULL,
      price_after DECIMAL(8,4) DEFAULT NULL,
      price_delta DECIMAL(8,4) DEFAULT NULL,
      detail TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_bot (bot_id),
      KEY idx_type (event_type),
      KEY idx_time (created_at),
      KEY idx_reason (reason)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

/**
 * 为已存在的 price_bot_logs 表补充盘口列。
 *
 * CREATE TABLE IF NOT EXISTS 对已存在的表完全不生效，
 * 所以升级时必须显式 ADD COLUMN。按列名逐个检查，可重复执行。
 */
async function ensureLogColumns(): Promise<void> {
  const [cols] = await pool.execute<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_bot_logs'`,
  )
  const existing = new Set(cols.map((c) => String(c.COLUMN_NAME)))

  const additions: Array<[string, string]> = [
    ['best_bid', 'DECIMAL(8,4) DEFAULT NULL'],
    ['best_bid_size', 'DECIMAL(18,4) DEFAULT NULL'],
    ['best_ask', 'DECIMAL(8,4) DEFAULT NULL'],
    ['best_ask_size', 'DECIMAL(18,4) DEFAULT NULL'],
    ['source', "VARCHAR(10) DEFAULT NULL COMMENT 'ws/rest'"],
  ]

  for (const [name, ddl] of additions) {
    if (existing.has(name)) continue
    try {
      await pool.execute(`ALTER TABLE price_bot_logs ADD COLUMN ${name} ${ddl}`)
      console.log(`[PriceBot] price_bot_logs 补充列: ${name}`)
    } catch (err: any) {
      // 并发启动时可能已被其他连接加上，忽略重复列错误
      if (!/duplicate column/i.test(err.message || '')) {
        console.error(`[PriceBot] 补充列 ${name} 失败:`, err.message)
      }
    }
  }

  // 价格采样量大，补一个 (rule_id, action, logged_at) 复合索引加速查询
  const [idx] = await pool.execute<any[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_bot_logs'
       AND INDEX_NAME = 'idx_rule_action_time'`,
  )
  if (idx.length === 0) {
    try {
      await pool.execute(
        `ALTER TABLE price_bot_logs ADD INDEX idx_rule_action_time (rule_id, action, logged_at)`,
      )
      console.log('[PriceBot] price_bot_logs 补充索引: idx_rule_action_time')
    } catch (err: any) {
      if (!/duplicate key name/i.test(err.message || '')) {
        console.error('[PriceBot] 补充索引失败:', err.message)
      }
    }
  }
}

/**
 * 为已存在的 price_bot_rules 表补充 goal_surge 参数列。
 *
 * goal_surge 的多个阈值没有独立列，统一存进一个 JSON 列；
 * 老版本 MySQL(<5.7) 不支持 JSON，退化为 TEXT。按列名检查，可重复执行。
 */
async function ensureRuleColumns(): Promise<void> {
  const [cols] = await pool.execute<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_bot_rules'`,
  )
  const existing = new Set(cols.map((c) => String(c.COLUMN_NAME)))
  if (existing.has('goal_surge_params')) return

  try {
    await pool.execute(
      `ALTER TABLE price_bot_rules ADD COLUMN goal_surge_params JSON DEFAULT NULL`,
    )
    console.log('[PriceBot] price_bot_rules 补充列: goal_surge_params (JSON)')
  } catch (err: any) {
    if (/duplicate column/i.test(err.message || '')) return
    // 老版本 MySQL 不支持 JSON，退化为 TEXT
    try {
      await pool.execute(
        `ALTER TABLE price_bot_rules ADD COLUMN goal_surge_params TEXT DEFAULT NULL`,
      )
      console.log('[PriceBot] price_bot_rules 补充列: goal_surge_params (TEXT 兜底)')
    } catch (err2: any) {
      if (!/duplicate column/i.test(err2.message || '')) {
        console.error('[PriceBot] 补充列 goal_surge_params 失败:', err2.message)
      }
    }
  }
}

// ==================== 规则 CRUD ====================

export async function listRules(options: {
  enabledOnly?: boolean
  eventId?: string
  limit?: number
  offset?: number
} = {}): Promise<{ rules: PriceMonitorRule[]; total: number }> {
  await ensureTables()

  const where: string[] = []
  const params: any[] = []

  if (options.enabledOnly) {
    where.push('r.enabled = 1')
  }
  if (options.eventId) {
    where.push('r.event_id = ?')
    params.push(options.eventId)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_rules r ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit ?? 100))))
  const offset = Math.max(0, Math.floor(Number(options.offset ?? 0)))
  // LEFT JOIN 赛事/盘口，让左侧机器人列表能直接显示「主队 vs 客队」和盘口名。
  // 用 LEFT JOIN：赛事数据可能已被清理，规则本身仍要能列出来。
  const [rows] = await pool.execute<any[]>(
    `SELECT r.*,
            e.home_team_zh, e.away_team_zh,
            e.home_team_en, e.away_team_en,
            e.league, e.end_time,
            m.question_zh, m.question_en, m.market_type, m.line
       FROM price_bot_rules r
       LEFT JOIN soccer_events e ON e.id = r.event_id
       LEFT JOIN soccer_markets m ON m.id = r.market_id
     ${whereSql}
     ORDER BY r.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  const rules = rows.map(row => ({ ...rowToRule(row), ...extractContext(row) }))
  return { rules, total }
}

export async function getRule(id: number): Promise<PriceMonitorRule | null> {
  await ensureTables()
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM price_bot_rules WHERE id = ?`,
    [id],
  )
  return rows.length ? rowToRule(rows[0]) : null
}

export async function createRule(rule: Omit<PriceMonitorRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    `INSERT INTO price_bot_rules
       (token_id, market_id, event_id, outcome, rule_type, direction,
        percent_threshold, target_price, price_low, price_high, goal_surge_params,
        signal_type, cooldown_seconds, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rule.tokenId,
      rule.marketId,
      rule.eventId,
      rule.outcome,
      rule.ruleType,
      rule.direction,
      rule.percentThreshold ?? null,
      rule.targetPrice ?? null,
      rule.priceLow ?? null,
      rule.priceHigh ?? null,
      rule.goalSurgeParams ? JSON.stringify(rule.goalSurgeParams) : null,
      rule.signalType,
      rule.cooldownSeconds,
      rule.enabled ? 1 : 0,
    ],
  )
  return Number(result.insertId)
}

export async function updateRule(id: number, updates: Partial<PriceMonitorRule>): Promise<boolean> {
  await ensureTables()

  const sets: string[] = []
  const params: any[] = []

  const fieldMap: Record<string, string> = {
    ruleType: 'rule_type',
    direction: 'direction',
    percentThreshold: 'percent_threshold',
    targetPrice: 'target_price',
    priceLow: 'price_low',
    priceHigh: 'price_high',
    goalSurgeParams: 'goal_surge_params',
    signalType: 'signal_type',
    cooldownSeconds: 'cooldown_seconds',
    enabled: 'enabled',
  }

  for (const [key, col] of Object.entries(fieldMap)) {
    if (updates[key as keyof PriceMonitorRule] !== undefined) {
      sets.push(`${col} = ?`)
      const val = updates[key as keyof PriceMonitorRule]
      if (typeof val === 'boolean') {
        params.push(val ? 1 : 0)
      } else if (val !== null && typeof val === 'object') {
        // goalSurgeParams 等对象列存 JSON 文本
        params.push(JSON.stringify(val))
      } else {
        params.push(val)
      }
    }
  }

  if (!sets.length) return false

  params.push(id)
  const [result] = await pool.execute<any>(
    `UPDATE price_bot_rules SET ${sets.join(', ')} WHERE id = ?`,
    params,
  )
  return result.affectedRows > 0
}

export async function deleteRule(id: number): Promise<boolean> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    `DELETE FROM price_bot_rules WHERE id = ?`,
    [id],
  )
  return result.affectedRows > 0
}

// ==================== 触发记录 CRUD ====================

export async function recordTrigger(record: Omit<PriceTriggerRecord, 'id' | 'triggeredAt'>): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    `INSERT INTO price_bot_triggers
       (bot_id, rule_id, token_id, market_id, event_id, outcome,
        rule_type, direction, previous_price, current_price,
        change_percent, threshold, signal_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.botId,
      record.ruleId,
      record.tokenId,
      record.marketId,
      record.eventId,
      record.outcome,
      record.ruleType,
      record.direction,
      record.previousPrice,
      record.currentPrice,
      record.changePercent,
      record.threshold,
      record.signalType,
    ],
  )
  return Number(result.insertId)
}

export async function listTriggers(options: {
  ruleId?: number
  tokenId?: string
  eventId?: string
  limit?: number
  offset?: number
} = {}): Promise<{ records: PriceTriggerRecord[]; total: number }> {
  await ensureTables()

  const where: string[] = []
  const params: any[] = []

  if (options.ruleId) {
    where.push('t.rule_id = ?')
    params.push(options.ruleId)
  }
  if (options.tokenId) {
    where.push('t.token_id = ?')
    params.push(options.tokenId)
  }
  if (options.eventId) {
    where.push('t.event_id = ?')
    params.push(options.eventId)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_triggers t ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) ?? 50)))
  const offset = Math.max(0, Math.floor(Number(options.offset) ?? 0))

  // 关联赛事与盘口，让触发记录能直接看出「哪场比赛、哪个盘口」
  const [rows] = await pool.execute<any[]>(
    `SELECT t.*,
            e.home_team_zh, e.away_team_zh,
            e.home_team_en, e.away_team_en,
            e.league,
            m.question_zh, m.question_en, m.market_type, m.line
       FROM price_bot_triggers t
       LEFT JOIN soccer_events e ON e.id = t.event_id
       LEFT JOIN soccer_markets m ON m.id = t.market_id
     ${whereSql}
     ORDER BY t.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  const records = rows.map(row => rowToTrigger(row))
  return { records, total }
}

/** 获取某规则最近一次触发时间（用于冷却判断） */
export async function getLastTriggerTime(ruleId: number): Promise<string | null> {
  const [rows] = await pool.execute<any[]>(
    `SELECT triggered_at FROM price_bot_triggers WHERE rule_id = ? ORDER BY id DESC LIMIT 1`,
    [ruleId],
  )
  if (!rows.length) return null
  const t = rows[0].triggered_at
  return t instanceof Date ? t.toISOString() : String(t)
}

// ==================== 日志 CRUD ====================

export async function recordLog(log: Omit<PriceBotLog, 'id' | 'loggedAt'>): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    `INSERT INTO price_bot_logs
       (rule_id, token_id, event_id, outcome, action, price,
        best_bid, best_bid_size, best_ask, best_ask_size, source, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.ruleId,
      log.tokenId,
      log.eventId,
      log.outcome,
      log.action,
      log.price ?? null,
      log.bestBid ?? null,
      log.bestBidSize ?? null,
      log.bestAsk ?? null,
      log.bestAskSize ?? null,
      log.source ?? null,
      log.detail ?? null,
    ],
  )
  return Number(result.insertId)
}

/**
 * 批量写入日志（价格采样用）。
 *
 * 采样频率可达每秒数十条，逐条 INSERT 会拖慢评估路径，
 * 所以由调用方缓冲后批量提交。
 */
export async function recordLogsBatch(
  logs: Array<Omit<PriceBotLog, 'id' | 'loggedAt'> & { loggedAt?: string }>,
): Promise<number> {
  if (logs.length === 0) return 0
  await ensureTables()

  const placeholders = logs.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  const params: any[] = []
  for (const log of logs) {
    params.push(
      log.ruleId,
      log.tokenId,
      log.eventId,
      log.outcome,
      log.action,
      log.price ?? null,
      log.bestBid ?? null,
      log.bestBidSize ?? null,
      log.bestAsk ?? null,
      log.bestAskSize ?? null,
      log.source ?? null,
      log.detail ?? null,
      // 采样时刻由调用方给出，落库延迟不应影响时间戳
      log.loggedAt ? new Date(log.loggedAt) : new Date(),
    )
  }

  const [result] = await pool.execute<any>(
    `INSERT INTO price_bot_logs
       (rule_id, token_id, event_id, outcome, action, price,
        best_bid, best_bid_size, best_ask, best_ask_size, source, detail, logged_at)
     VALUES ${placeholders}`,
    params,
  )
  return Number(result.affectedRows ?? logs.length)
}

export async function listLogs(options: {
  ruleId?: number
  eventId?: string
  action?: string
  limit?: number
  offset?: number
} = {}): Promise<{ logs: PriceBotLog[]; total: number }> {
  await ensureTables()

  const where: string[] = []
  const params: any[] = []

  if (options.ruleId) {
    where.push('l.rule_id = ?')
    params.push(options.ruleId)
  }
  if (options.eventId) {
    where.push('l.event_id = ?')
    params.push(options.eventId)
  }
  if (options.action) {
    where.push('l.action = ?')
    params.push(options.action)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_logs l ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) ?? 100)))
  const offset = Math.max(0, Math.floor(Number(options.offset) ?? 0))

  // 关联赛事与盘口，让日志能直接看出「哪场比赛、哪个盘口」。
  // 用 LEFT JOIN：赛事数据可能已被清理，日志本身仍要能查出来。
  const [rows] = await pool.execute<any[]>(
    `SELECT l.*,
            e.home_team_zh, e.away_team_zh,
            e.home_team_en, e.away_team_en,
            e.league,
            m.question_zh, m.question_en, m.market_type, m.line
       FROM price_bot_logs l
       LEFT JOIN price_bot_rules r ON r.id = l.rule_id
       LEFT JOIN soccer_events e ON e.id = l.event_id
       LEFT JOIN soccer_markets m ON m.id = r.market_id
     ${whereSql}
     ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  const logs = rows.map(rowToLog)
  return { logs, total }
}

// ==================== 连接事件 CRUD ====================

export async function recordConnectionEvent(
  event: Omit<PriceBotConnectionEvent, 'id' | 'createdAt'>,
): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    `INSERT INTO price_bot_connection_events
       (bot_id, event_type, reason, close_code, downtime_ms, subscribed_tokens,
        price_before, price_after, price_delta, token_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.botId,
      event.eventType,
      event.reason,
      event.closeCode ?? null,
      event.downtimeMs ?? null,
      event.subscribedTokens,
      event.priceBefore ?? null,
      event.priceAfter ?? null,
      event.priceDelta ?? null,
      event.tokenId ?? null,
      event.detail ?? null,
    ],
  )
  return Number(result.insertId)
}

/**
 * 补写重连事件的重连后价格。
 *
 * 重连事件在 WS open 时就落库，但那一刻 initial_dump 还没到，
 * price_after 只能等首个价格推送到达后回填。
 */
export async function updateConnectionEventPrice(
  id: number,
  priceAfter: number,
): Promise<void> {
  await pool.execute(
    `UPDATE price_bot_connection_events
     SET price_after = ?,
         price_delta = CASE WHEN price_before IS NULL THEN NULL ELSE ? - price_before END
     WHERE id = ?`,
    [priceAfter, priceAfter, id],
  )
}

export async function listConnectionEvents(options: {
  eventType?: string
  reason?: string
  tokenId?: string
  limit?: number
  offset?: number
} = {}): Promise<{ events: PriceBotConnectionEvent[]; total: number }> {
  await ensureTables()

  const where: string[] = []
  const params: any[] = []

  if (options.eventType) {
    where.push('event_type = ?')
    params.push(options.eventType)
  }
  if (options.reason) {
    where.push('reason = ?')
    params.push(options.reason)
  }
  if (options.tokenId) {
    where.push('token_id = ?')
    params.push(options.tokenId)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_connection_events ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) ?? 100)))
  const offset = Math.max(0, Math.floor(Number(options.offset) ?? 0))
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM price_bot_connection_events ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  return { events: rows.map(rowToConnectionEvent), total }
}

/**
 * 断联统计汇总：用于回答「断联是否与进球相关」。
 *
 * 按断开原因分组统计次数、平均/最大断联时长，以及重连后价格跳变幅度。
 * 若进球引起的断联确实存在，应表现为 ws_close/pong_timeout 类别下
 * 出现明显大于其他类别的 |price_delta|。
 */
export async function getConnectionStats(): Promise<{
  byReason: Array<{
    reason: string
    count: number
    avgDowntimeMs: number | null
    maxDowntimeMs: number | null
    avgAbsPriceDelta: number | null
    maxAbsPriceDelta: number | null
  }>
  totalDisconnects: number
  totalReconnects: number
}> {
  await ensureTables()

  const [rows] = await pool.execute<any[]>(
    `SELECT reason,
            COUNT(*) AS count,
            AVG(downtime_ms) AS avg_downtime,
            MAX(downtime_ms) AS max_downtime,
            AVG(ABS(price_delta)) AS avg_abs_delta,
            MAX(ABS(price_delta)) AS max_abs_delta
       FROM price_bot_connection_events
      WHERE event_type = 'reconnect'
      GROUP BY reason
      ORDER BY count DESC`,
  )

  const [totals] = await pool.execute<any[]>(
    `SELECT event_type, COUNT(*) AS c FROM price_bot_connection_events GROUP BY event_type`,
  )
  let totalDisconnects = 0
  let totalReconnects = 0
  for (const t of totals) {
    if (t.event_type === 'disconnect') totalDisconnects = Number(t.c)
    if (t.event_type === 'reconnect') totalReconnects = Number(t.c)
  }

  return {
    byReason: rows.map((r) => ({
      reason: String(r.reason),
      count: Number(r.count),
      avgDowntimeMs: r.avg_downtime != null ? Number(r.avg_downtime) : null,
      maxDowntimeMs: r.max_downtime != null ? Number(r.max_downtime) : null,
      avgAbsPriceDelta: r.avg_abs_delta != null ? Number(r.avg_abs_delta) : null,
      maxAbsPriceDelta: r.max_abs_delta != null ? Number(r.max_abs_delta) : null,
    })),
    totalDisconnects,
    totalReconnects,
  }
}

// ==================== 行映射 ====================

/**
 * 解析 goal_surge_params 列。
 *
 * JSON 列会被 mysql2 直接解析成对象；TEXT 兜底列则是字符串，需再 parse。
 */
function parseGoalSurgeParams(raw: any): GoalSurgeParams | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'object') return raw as GoalSurgeParams
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? (parsed as GoalSurgeParams) : undefined
  } catch {
    return undefined
  }
}

function rowToRule(row: any): PriceMonitorRule {
  return {
    id: Number(row.id),
    tokenId: String(row.token_id),
    marketId: String(row.market_id),
    eventId: String(row.event_id),
    outcome: String(row.outcome),
    ruleType: row.rule_type as any,
    direction: row.direction as any,
    percentThreshold: row.percent_threshold != null ? Number(row.percent_threshold) : undefined,
    targetPrice: row.target_price != null ? Number(row.target_price) : undefined,
    priceLow: row.price_low != null ? Number(row.price_low) : undefined,
    priceHigh: row.price_high != null ? Number(row.price_high) : undefined,
    goalSurgeParams: parseGoalSurgeParams(row.goal_surge_params),
    signalType: row.signal_type as any,
    cooldownSeconds: Number(row.cooldown_seconds),
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  }
}

/**
 * 从 JOIN 出来的赛事/盘口列拼出可读标签。
 *
 * 日志和触发记录原本只有 token_id 和 outcome，看不出是哪场比赛的哪个盘口。
 * 这里补上「主队 vs 客队」和盘口名，中文优先、英文兜底。
 */
function extractContext(row: any): {
  matchName?: string
  league?: string
  marketName?: string
  marketType?: string
  line?: number
  matchStatus?: 'not_started' | 'live' | 'ended'
  endTime?: string
} {
  const home = row.home_team_zh || row.home_team_en
  const away = row.away_team_zh || row.away_team_en
  const matchName = home && away ? `${home} vs ${away}` : undefined

  const ctx: {
    matchName?: string
    league?: string
    marketName?: string
    marketType?: string
    line?: number
    matchStatus?: 'not_started' | 'live' | 'ended'
    endTime?: string
  } = {
    matchName,
    league: row.league ? String(row.league) : undefined,
    marketName: row.question_zh || row.question_en || undefined,
    marketType: row.market_type ? String(row.market_type) : undefined,
    line: row.line != null ? Number(row.line) : undefined,
  }

  // 只有 listRules 会 SELECT e.end_time；触发/日志查询未带出时保持 undefined
  if (row.end_time != null) {
    ctx.endTime = String(row.end_time)
    ctx.matchStatus = computeMatchStatus(row.end_time)
  }

  return ctx
}

function rowToTrigger(row: any): PriceTriggerRecord {
  return {
    id: Number(row.id),
    botId: String(row.bot_id),
    ruleId: Number(row.rule_id),
    tokenId: String(row.token_id),
    marketId: String(row.market_id),
    eventId: String(row.event_id),
    outcome: String(row.outcome),
    ruleType: row.rule_type as any,
    direction: row.direction as any,
    previousPrice: Number(row.previous_price),
    currentPrice: Number(row.current_price),
    changePercent: Number(row.change_percent),
    threshold: Number(row.threshold),
    signalType: String(row.signal_type),
    triggeredAt: row.triggered_at ? String(row.triggered_at) : undefined,
    ...extractContext(row),
  }
}

function rowToLog(row: any): PriceBotLog {
  return {
    id: Number(row.id),
    ruleId: Number(row.rule_id),
    tokenId: String(row.token_id),
    eventId: String(row.event_id),
    outcome: String(row.outcome),
    action: row.action as any,
    price: row.price != null ? Number(row.price) : null,
    bestBid: row.best_bid != null ? Number(row.best_bid) : null,
    bestBidSize: row.best_bid_size != null ? Number(row.best_bid_size) : null,
    bestAsk: row.best_ask != null ? Number(row.best_ask) : null,
    bestAskSize: row.best_ask_size != null ? Number(row.best_ask_size) : null,
    source: row.source ? (String(row.source) as 'ws' | 'rest') : null,
    detail: row.detail ? String(row.detail) : null,
    loggedAt: row.logged_at ? String(row.logged_at) : undefined,
    ...extractContext(row),
  }
}

function rowToConnectionEvent(row: any): PriceBotConnectionEvent {
  return {
    id: Number(row.id),
    botId: String(row.bot_id),
    eventType: row.event_type as any,
    reason: String(row.reason),
    closeCode: row.close_code != null ? Number(row.close_code) : null,
    downtimeMs: row.downtime_ms != null ? Number(row.downtime_ms) : null,
    subscribedTokens: Number(row.subscribed_tokens ?? 0),
    priceBefore: row.price_before != null ? Number(row.price_before) : null,
    priceAfter: row.price_after != null ? Number(row.price_after) : null,
    priceDelta: row.price_delta != null ? Number(row.price_delta) : null,
    tokenId: row.token_id ? String(row.token_id) : null,
    detail: row.detail ? String(row.detail) : null,
    createdAt: row.created_at ? String(row.created_at) : undefined,
  }
}
