/**
 * 价格监控机器人类型定义
 *
 * 监控指定市场/结果的价格变化，当价格满足设定条件时触发告警或交易。
 * 与 value-bot 不同，不需要关联比分数据，仅基于 CLOB 价格本身。
 */

// ==================== 配置类型 ====================

export interface PriceBotConfig {
  enabled: boolean
  pollIntervalMs: number
  botId: string
}

export const DEFAULT_CONFIG: PriceBotConfig = {
  enabled: false,
  pollIntervalMs: 10_000,
  botId: 'price-bot-v1',
}

// ==================== 监控规则类型 ====================

/** 规则类型：价格变化百分比 / 价格绝对值突破 / 价格区间 */
export type PriceRuleType = 'percent_change' | 'price_break' | 'price_range'

/** 监控方向：上涨 / 下跌 / 双向 */
export type PriceDirection = 'up' | 'down' | 'both'

/**
 * 价格监控规则配置
 * 每个被监控的 token 对应一条规则
 */
export interface PriceMonitorRule {
  id?: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  ruleType: PriceRuleType
  direction: PriceDirection
  /** 百分比阈值（ruleType=percent_change 时使用），如 0.05 表示 5% */
  percentThreshold?: number
  /** 目标价格（ruleType=price_break 时使用） */
  targetPrice?: number
  /** 价格区间下限（ruleType=price_range 时使用） */
  priceLow?: number
  /** 价格区间上限（ruleType=price_range 时使用） */
  priceHigh?: number
  /** 信号类型：买入信号 / 卖出信号 / 双向信号告警 */
  signalType: 'buy_signal' | 'sell_signal' | 'alert'
  /** 冷却时间（秒），防止同一规则频繁触发 */
  cooldownSeconds: number
  enabled: boolean
  createdAt?: string
  updatedAt?: string
}

// ==================== 价格快照 ====================

export interface PriceSnapshot {
  tokenId: string
  bestBid: number | null
  bestBidSize: number | null
  bestAsk: number | null
  bestAskSize: number | null
  lastPrice: number | null
  timestamp: string
}

// ==================== 触发事件记录 ====================

export interface PriceTriggerRecord {
  id?: number
  botId: string
  ruleId: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  ruleType: PriceRuleType
  direction: PriceDirection
  previousPrice: number
  currentPrice: number
  changePercent: number
  threshold: number
  signalType: string
  triggeredAt?: string
}

// ==================== 监控状态 ====================

export interface PriceMonitorState {
  ruleId: number
  tokenId: string
  running: boolean
  lastPollTime: string | null
  lastError: string | null
  cyclesRun: number
  triggerCount: number
  /** 基准价格（用于计算涨跌幅） */
  baselinePrice: number | null
  /** 上次触发时间（用于冷却） */
  lastTriggerTime: string | null
  /** 最近一次价格 */
  lastPrice: number | null
}

// ==================== 监控日志 ====================

export interface PriceBotLog {
  id?: number
  ruleId: number
  tokenId: string
  eventId: string
  outcome: string
  action: 'start' | 'stop' | 'price_update' | 'trigger'
  price: number | null
  detail: string | null
  loggedAt?: string
}

// ==================== 机器人状态 ====================

interface BotState {
  config: PriceBotConfig
  monitors: Map<number, PriceMonitorState>
}

export type { BotState }
