/**
 * 价格监控机器人数据库层
 *
 * 管理监控规则表和触发事件记录表。
 */

import { pool } from '../../soccer/db.js'
import type { PriceMonitorRule, PriceTriggerRecord, PriceBotLog } from './types.js'

// ==================== 表结构 ====================

export async function ensureTables(): Promise<void> {
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
      cooldown_seconds INT NOT NULL DEFAULT 300,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_token_rule (token_id, rule_type, direction),
      KEY idx_event (event_id),
      KEY idx_market (market_id),
      KEY idx_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

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
      action VARCHAR(20) NOT NULL COMMENT 'start/stop/price_update/trigger',
      price DECIMAL(8,4) DEFAULT NULL,
      detail TEXT DEFAULT NULL,
      logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_rule (rule_id),
      KEY idx_time (logged_at),
      KEY idx_event (event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
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
    where.push('enabled = 1')
  }
  if (options.eventId) {
    where.push('event_id = ?')
    params.push(options.eventId)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_rules ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) ?? 100)))
  const offset = Math.max(0, Math.floor(Number(options.offset) ?? 0))
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM price_bot_rules ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  const rules = rows.map(row => rowToRule(row))
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
        percent_threshold, target_price, price_low, price_high,
        signal_type, cooldown_seconds, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    signalType: 'signal_type',
    cooldownSeconds: 'cooldown_seconds',
    enabled: 'enabled',
  }

  for (const [key, col] of Object.entries(fieldMap)) {
    if (updates[key as keyof PriceMonitorRule] !== undefined) {
      sets.push(`${col} = ?`)
      const val = updates[key as keyof PriceMonitorRule]
      params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val)
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
    where.push('rule_id = ?')
    params.push(options.ruleId)
  }
  if (options.tokenId) {
    where.push('token_id = ?')
    params.push(options.tokenId)
  }
  if (options.eventId) {
    where.push('event_id = ?')
    params.push(options.eventId)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_triggers ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) ?? 50)))
  const offset = Math.max(0, Math.floor(Number(options.offset) ?? 0))
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM price_bot_triggers ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
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
       (rule_id, token_id, event_id, outcome, action, price, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      log.ruleId,
      log.tokenId,
      log.eventId,
      log.outcome,
      log.action,
      log.price ?? null,
      log.detail ?? null,
    ],
  )
  return Number(result.insertId)
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
    where.push('rule_id = ?')
    params.push(options.ruleId)
  }
  if (options.eventId) {
    where.push('event_id = ?')
    params.push(options.eventId)
  }
  if (options.action) {
    where.push('action = ?')
    params.push(options.action)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [countRows] = await pool.execute<any[]>(
    `SELECT COUNT(*) as total FROM price_bot_logs ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) ?? 100)))
  const offset = Math.max(0, Math.floor(Number(options.offset) ?? 0))
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM price_bot_logs ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  const logs = rows.map(rowToLog)
  return { logs, total }
}

// ==================== 行映射 ====================

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
    signalType: row.signal_type as any,
    cooldownSeconds: Number(row.cooldown_seconds),
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  }
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
    detail: row.detail ? String(row.detail) : null,
    loggedAt: row.logged_at ? String(row.logged_at) : undefined,
  }
}
