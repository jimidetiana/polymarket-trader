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
  AutoTradeParams,
  AutoOrderRecord,
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

  // 自动下单记录表：每次下单尝试都落一条，含被风控拦下的（status=skipped）。
  // 既是风控计数的事实来源（跨重启），也是复盘成交率的依据。
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_bot_orders (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      bot_id VARCHAR(50) NOT NULL,
      rule_id BIGINT NOT NULL,
      token_id VARCHAR(200) NOT NULL,
      market_id VARCHAR(100) NOT NULL,
      event_id VARCHAR(100) NOT NULL,
      outcome VARCHAR(100) NOT NULL,
      limit_price DECIMAL(8,4) NOT NULL,
      size DECIMAL(18,4) NOT NULL,
      notional DECIMAL(18,4) NOT NULL,
      size_mode VARCHAR(10) NOT NULL DEFAULT 'usdc' COMMENT 'shares/usdc',
      status VARCHAR(15) NOT NULL COMMENT 'placed/failed/skipped/simulated',
      reason VARCHAR(255) DEFAULT NULL,
      best_bid DECIMAL(8,4) DEFAULT NULL,
      best_bid_size DECIMAL(18,4) DEFAULT NULL,
      best_ask DECIMAL(8,4) DEFAULT NULL,
      best_ask_size DECIMAL(18,4) DEFAULT NULL,
      trade_order_id BIGINT DEFAULT NULL,
      clob_order_id VARCHAR(120) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_rule (rule_id),
      KEY idx_status_time (status, created_at),
      KEY idx_time (created_at),
      KEY idx_event (event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

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
 * 为已存在的 price_bot_rules 表补列。
 *
 * 多阈值参数不给独立列，统一存 JSON；老版本 MySQL(<5.7) 不支持 JSON
 * 则退化为 TEXT。逐列检查，可重复执行。
 */
async function ensureRuleColumns(): Promise<void> {
  const [cols] = await pool.execute<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_bot_rules'`,
  )
  const existing = new Set(cols.map((c) => String(c.COLUMN_NAME)))

  // [列名, 首选 DDL, JSON 不被支持时的兜底 DDL]
  const additions: Array<[string, string, string | null]> = [
    ['goal_surge_params', 'JSON DEFAULT NULL', 'TEXT DEFAULT NULL'],
    // 规则级自动下单开关。默认 0：新建/存量规则都不会因为打开总开关就突然开始下单。
    ['auto_trade_enabled', 'TINYINT(1) NOT NULL DEFAULT 0', null],
    ['auto_trade_params', 'JSON DEFAULT NULL', 'TEXT DEFAULT NULL'],
    // 手动完结时刻。不加 status 枚举列是有意的：
    // 「待结算」与 enabled=0 是两个正交的事实（被完结 vs 被手动停用），
    // 塞进同一个枚举就没法区分「完结后又被重新启用」这种状态。
    // NULL = 未完结，有值 = 已完结待链上结算。
    ['settled_at', 'DATETIME DEFAULT NULL', null],
  ]

  for (const [name, ddl, fallback] of additions) {
    if (existing.has(name)) continue
    try {
      await pool.execute(`ALTER TABLE price_bot_rules ADD COLUMN ${name} ${ddl}`)
      console.log(`[PriceBot] price_bot_rules 补充列: ${name}`)
    } catch (err: any) {
      if (/duplicate column/i.test(err.message || '')) continue
      if (!fallback) {
        console.error(`[PriceBot] 补充列 ${name} 失败:`, err.message)
        continue
      }
      try {
        await pool.execute(`ALTER TABLE price_bot_rules ADD COLUMN ${name} ${fallback}`)
        console.log(`[PriceBot] price_bot_rules 补充列: ${name} (兜底类型)`)
      } catch (err2: any) {
        if (!/duplicate column/i.test(err2.message || '')) {
          console.error(`[PriceBot] 补充列 ${name} 失败:`, err2.message)
        }
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
            e.league, e.start_time, e.end_time,
            m.question_zh, m.question_en, m.market_type, m.line
       FROM price_bot_rules r
       LEFT JOIN soccer_events e ON e.id = r.event_id
       LEFT JOIN soccer_markets m ON m.id = r.market_id
     ${whereSql}
     ORDER BY e.start_time IS NULL, e.start_time ASC, r.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
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
        auto_trade_enabled, auto_trade_params,
        signal_type, cooldown_seconds, enabled,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
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
      rule.autoTradeEnabled ? 1 : 0,
      rule.autoTradeParams ? JSON.stringify(rule.autoTradeParams) : null,
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
    autoTradeEnabled: 'auto_trade_enabled',
    autoTradeParams: 'auto_trade_params',
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
  // updated_at 显式写 UTC_TIMESTAMP()：列上的 ON UPDATE CURRENT_TIMESTAMP 走的是
  // MySQL 服务器本地时钟（UTC+8），显式赋值可以覆盖掉那个默认行为，保持库内统一 UTC。
  const [result] = await pool.execute<any>(
    `UPDATE price_bot_rules SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    params,
  )
  return result.affectedRows > 0
}

/**
 * 标记 / 取消「已完结待结算」。
 *
 * 不走 updateRule 是因为它按 `!== undefined` 判断要不要写该列，
 * 传 undefined 会被当成「不改这一列」，于是没法把 settled_at 清回 NULL。
 * 这里显式区分：settled=true 写当前时间，false 写 NULL。
 */
export async function markRuleSettled(id: number, settled: boolean): Promise<boolean> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    `UPDATE price_bot_rules SET settled_at = ${settled ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE id = ?`,
    [id],
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
    // triggered_at 显式写 UTC_TIMESTAMP()：列上的 DEFAULT CURRENT_TIMESTAMP
    // 取的是 MySQL 服务器本地时钟（这里是 UTC+8），而 recordLogsBatch 走
    // mysql2 的 timezone:'Z' 存的是 UTC，两条路径混用就差整 8 小时。
    // 读取端 toIsoUtc 无条件补 Z，本地时间被当 UTC 解析后前端再转北京时间，
    // 于是又多加 8 小时。统一以 UTC 落库是唯一不会二次踩坑的口径。
    `INSERT INTO price_bot_triggers
       (bot_id, rule_id, token_id, market_id, event_id, outcome,
        rule_type, direction, previous_price, current_price,
        change_percent, threshold, signal_type, triggered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
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
  return toIsoUtc(t) ?? null
}

// ==================== 日志 CRUD ====================

export async function recordLog(log: Omit<PriceBotLog, 'id' | 'loggedAt'>): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    // logged_at 显式写 UTC：这个函数负责 buy_signal/start/stop/trigger/
    // disconnect/reconnect，此前落列默认值（服务器本地时钟），而同表的
    // price_update 由 recordLogsBatch 以 UTC 写入——同一张表里两种基准，
    // 前端把两类日志混在一个时间轴上看就差 8 小时。
    `INSERT INTO price_bot_logs
       (rule_id, token_id, event_id, outcome, action, price,
        best_bid, best_bid_size, best_ask, best_ask_size, source, detail, logged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
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

// ==================== 自动下单记录 CRUD ====================

export async function recordAutoOrder(
  order: Omit<AutoOrderRecord, 'id' | 'createdAt'>,
): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    // created_at 显式写 UTC_TIMESTAMP()：列上的 DEFAULT CURRENT_TIMESTAMP
    // 取的是 MySQL 服务器本地时钟（UTC+8），与其他写入路径不一致
    `INSERT INTO price_bot_orders
       (bot_id, rule_id, token_id, market_id, event_id, outcome,
        limit_price, size, notional, size_mode, status, reason,
        best_bid, best_bid_size, best_ask, best_ask_size,
        trade_order_id, clob_order_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      order.botId,
      order.ruleId,
      order.tokenId,
      order.marketId,
      order.eventId,
      order.outcome,
      order.limitPrice,
      order.size,
      order.notional,
      order.sizeMode,
      order.status,
      order.reason ?? null,
      order.bestBid ?? null,
      order.bestBidSize ?? null,
      order.bestAsk ?? null,
      order.bestAskSize ?? null,
      order.tradeOrderId ?? null,
      order.clobOrderId ?? null,
    ],
  )
  return Number(result.insertId)
}

/**
 * 风控计数。
 *
 * 只统计真正占用额度的状态（placed/simulated），skipped/failed 不计——
 * 被拦下或提交失败的没有实际敞口，不该消耗配额。
 *
 * 计数走库而不是内存，这样重启不会把已用额度清零。
 * 「当日」按 UTC 自然日，与库里 DATETIME 的存储口径一致。
 */
export async function getAutoOrderCounts(ruleId: number): Promise<{
  ruleTotal: number
  dayTotal: number
  dayNotional: number
}> {
  await ensureTables()
  const [rows] = await pool.execute<any[]>(
    `SELECT
       (SELECT COUNT(*) FROM price_bot_orders
         WHERE rule_id = ? AND status IN ('placed','simulated')) AS rule_total,
       (SELECT COUNT(*) FROM price_bot_orders
         WHERE status IN ('placed','simulated') AND created_at >= UTC_DATE()) AS day_total,
       (SELECT COALESCE(SUM(notional), 0) FROM price_bot_orders
         WHERE status IN ('placed','simulated') AND created_at >= UTC_DATE()) AS day_notional`,
    [ruleId],
  )
  const r = rows[0] || {}
  return {
    ruleTotal: Number(r.rule_total || 0),
    dayTotal: Number(r.day_total || 0),
    dayNotional: Number(r.day_notional || 0),
  }
}

/**
 * 列出某规则下「还挂在盘口上」的买单。
 *
 * maker 模式（buyOrderMode='maker'）下报价不穿价，单子会真的留在盘口等成交。
 * 若规则完结/结算时它还没成交，就必须撤掉——结算后代币归零，
 * 有人拿废票来砸我们挂的买价就是全额亏损，且纯机械性、与人工止损判断无关。
 *
 * price_bot_orders.status 只记「是否提交成功」（placed/simulated），
 * 真实成交状态在 soccer_orders.order_status，由 server 里 30 秒一次的
 * runOrderSync 维护。所以判定「还挂着」必须 join 过去看 open/pending。
 *
 * 只返回带 trade_order_id 的记录：没有它就无法调 cancelOrder。
 */
export async function listRestingBuyOrders(ruleId: number): Promise<Array<{
  autoOrderId: number
  tradeOrderId: number
  limitPrice: number
  size: number
}>> {
  await ensureTables()
  const [rows] = await pool.execute<any[]>(
    `SELECT o.id, o.trade_order_id, o.limit_price, o.size
       FROM price_bot_orders o
       JOIN soccer_orders s ON s.id = o.trade_order_id
      WHERE o.rule_id = ?
        AND o.status = 'placed'
        AND o.trade_order_id IS NOT NULL
        AND s.side = 'BUY'
        AND s.order_status IN ('open', 'pending')
      ORDER BY o.id`,
    [ruleId],
  )
  return rows.map((r: any) => ({
    autoOrderId: Number(r.id),
    tradeOrderId: Number(r.trade_order_id),
    limitPrice: Number(r.limit_price),
    size: Number(r.size),
  }))
}

export async function listAutoOrders(options: {
  ruleId?: number
  status?: string
  limit?: number
  offset?: number
} = {}): Promise<{ orders: AutoOrderRecord[]; total: number }> {
  await ensureTables()

  const where: string[] = []
  const params: any[] = []
  if (options.ruleId !== undefined) {
    where.push('o.rule_id = ?')
    params.push(options.ruleId)
  }
  if (options.status) {
    where.push('o.status = ?')
    params.push(options.status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500)
  const offset = Math.max(Number(options.offset) || 0, 0)

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) AS total FROM price_bot_orders o ${whereSql}`,
    params,
  )
  const total = Number(countRows[0]?.total || 0)

  const [rows] = await pool.execute<any[]>(
    `SELECT o.*,
            e.home_team_zh, e.away_team_zh, e.home_team_en, e.away_team_en,
            e.league, e.end_time,
            m.question_zh, m.question_en, m.market_type, m.line
       FROM price_bot_orders o
       LEFT JOIN soccer_events e ON e.id = o.event_id
       LEFT JOIN soccer_markets m ON m.id = o.market_id
     ${whereSql}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  return { orders: rows.map(rowToAutoOrder), total }
}

/** 当日下单概览，给前端顶部展示已用额度 */
export async function getAutoOrderSummary(): Promise<{
  dayTotal: number
  dayNotional: number
  placed: number
  failed: number
  skipped: number
}> {
  await ensureTables()
  const [rows] = await pool.execute<any[]>(
    `SELECT
       SUM(status IN ('placed','simulated') AND created_at >= UTC_DATE()) AS day_total,
       COALESCE(SUM(CASE WHEN status IN ('placed','simulated')
                          AND created_at >= UTC_DATE() THEN notional ELSE 0 END), 0) AS day_notional,
       SUM(status IN ('placed','simulated')) AS placed,
       SUM(status = 'failed') AS failed,
       SUM(status = 'skipped') AS skipped
     FROM price_bot_orders`,
  )
  const r = rows[0] || {}
  return {
    dayTotal: Number(r.day_total || 0),
    dayNotional: Number(r.day_notional || 0),
    placed: Number(r.placed || 0),
    failed: Number(r.failed || 0),
    skipped: Number(r.skipped || 0),
  }
}

// ==================== 连接事件 CRUD ====================

export async function recordConnectionEvent(
  event: Omit<PriceBotConnectionEvent, 'id' | 'createdAt'>,
): Promise<number> {
  await ensureTables()
  const [result] = await pool.execute<any>(
    // created_at 同上，统一按 UTC 落库
    `INSERT INTO price_bot_connection_events
       (bot_id, event_type, reason, close_code, downtime_ms, subscribed_tokens,
        price_before, price_after, price_delta, token_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
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
 * 把 MySQL DATETIME 序列化成自带时区标记的 ISO 字符串。
 *
 * 连接池配了 dateStrings: true，DATETIME 原样返回 "2026-08-28 14:30:00"
 * 这种裸字符串；库里存的是 UTC（见 fetcher.ts 的 toDateTime）。
 * 直接交给前端 new Date() 会被按浏览器本地时区解析，UTC 时刻被当本地时间读，
 * 东八区就正好差 8 小时。这里补上 Z 让字符串自我描述为 UTC，
 * 前端再显式按 Asia/Shanghai 显示。
 */
function toIsoUtc(raw: any): string | undefined {
  if (raw == null) return undefined
  if (raw instanceof Date) return raw.toISOString()
  const s = String(raw).trim()
  if (!s) return undefined
  // 已带时区后缀（Z 或 ±HH:MM）的原样返回
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  return isNaN(d.getTime()) ? s : d.toISOString()
}

/**
 * 解析 JSON 参数列（goal_surge_params / auto_trade_params）。
 *
 * JSON 列会被 mysql2 直接解析成对象；TEXT 兜底列则是字符串，需再 parse。
 */
function parseJsonParams<T>(raw: any): T | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'object') return raw as T
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

function rowToAutoOrder(row: any): AutoOrderRecord {
  return {
    id: Number(row.id),
    botId: String(row.bot_id),
    ruleId: Number(row.rule_id),
    tokenId: String(row.token_id),
    marketId: String(row.market_id),
    eventId: String(row.event_id),
    outcome: String(row.outcome),
    limitPrice: Number(row.limit_price),
    size: Number(row.size),
    notional: Number(row.notional),
    sizeMode: row.size_mode as any,
    status: row.status as any,
    reason: row.reason ?? undefined,
    bestBid: row.best_bid != null ? Number(row.best_bid) : null,
    bestBidSize: row.best_bid_size != null ? Number(row.best_bid_size) : null,
    bestAsk: row.best_ask != null ? Number(row.best_ask) : null,
    bestAskSize: row.best_ask_size != null ? Number(row.best_ask_size) : null,
    tradeOrderId: row.trade_order_id != null ? Number(row.trade_order_id) : null,
    clobOrderId: row.clob_order_id ?? null,
    createdAt: toIsoUtc(row.created_at),
    ...extractContext(row),
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
    goalSurgeParams: parseJsonParams<GoalSurgeParams>(row.goal_surge_params),
    autoTradeEnabled: row.auto_trade_enabled === 1 || row.auto_trade_enabled === true,
    autoTradeParams: parseJsonParams<AutoTradeParams>(row.auto_trade_params),
    signalType: row.signal_type as any,
    cooldownSeconds: Number(row.cooldown_seconds),
    enabled: row.enabled === 1 || row.enabled === true,
    settledAt: row.settled_at != null ? toIsoUtc(row.settled_at) : undefined,
    createdAt: toIsoUtc(row.created_at),
    updatedAt: toIsoUtc(row.updated_at),
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
    ctx.endTime = toIsoUtc(row.end_time)
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
    triggeredAt: toIsoUtc(row.triggered_at),
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
    loggedAt: toIsoUtc(row.logged_at),
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
    createdAt: toIsoUtc(row.created_at),
  }
}
