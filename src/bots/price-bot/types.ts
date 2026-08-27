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
  /** 断联期间 REST 兜底轮询间隔（毫秒） */
  restFallbackIntervalMs: number
  /** 重连退避起始延迟（毫秒），失败后指数增长 */
  reconnectBaseDelayMs: number
  /** 重连退避上限（毫秒） */
  reconnectMaxDelayMs: number
  /** PONG 超时（毫秒）：发出 PING 后多久没收到 PONG 就判定连接已死 */
  pongTimeoutMs: number
  /** 重连成功后，高波动窗口持续时间（毫秒），期间抑制 percent_change 触发 */
  volatileWindowMs: number
  /** 是否在高波动窗口内抑制 percent_change 规则 */
  suppressVolatilePercentChange: boolean
}

export const DEFAULT_CONFIG: PriceBotConfig = {
  enabled: false,
  pollIntervalMs: 10_000,
  botId: 'price-bot-v1',
  restFallbackIntervalMs: 400,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 15_000,
  pongTimeoutMs: 10_000,
  volatileWindowMs: 8_000,
  suppressVolatilePercentChange: true,
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
  /** 数据来源：WebSocket 推送 / REST 兜底轮询 */
  source?: 'ws' | 'rest'
}

// ==================== 赛事上下文（JOIN 带出） ====================

/**
 * 日志/触发记录关联出的赛事与盘口信息。
 *
 * 原本这些记录只有 token_id 和 outcome，无法看出是哪场比赛的哪个盘口。
 * 查询时 LEFT JOIN soccer_events / soccer_markets 补齐，均为可选。
 */
export interface MatchContext {
  /** 「主队 vs 客队」，中文优先 */
  matchName?: string
  league?: string
  /** 盘口问题描述，如「A vs B: O/U 3.5」 */
  marketName?: string
  /** 盘口类型，如 total / spread */
  marketType?: string
  /** 盘口线，如 3.5 */
  line?: number
}

// ==================== 触发事件记录 ====================

export interface PriceTriggerRecord extends MatchContext {
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
  /**
   * 正在处理触发（同步占位标记）。
   *
   * evaluateRuleForId 内含 await，消息突发时会有大量并发调用。
   * 该标记在任何 await 之前同步置位，确保同一规则同时只有一次触发在处理，
   * 避免并发调用全部读到旧的 lastTriggerTime / baselinePrice 而重复触发。
   */
  triggerInFlight?: boolean
  /** 因处于高波动窗口而被抑制的触发次数（用于观察抑制是否过度） */
  suppressedCount?: number
}

// ==================== 监控日志 ====================

export interface PriceBotLog extends MatchContext {
  id?: number
  ruleId: number
  tokenId: string
  eventId: string
  outcome: string
  action: 'start' | 'stop' | 'price_update' | 'trigger' | 'disconnect' | 'reconnect'
  price: number | null
  detail: string | null
  loggedAt?: string
}

// ==================== 连接事件记录 ====================

/**
 * WebSocket 连接事件。
 *
 * 用于验证「进球时盘口剧烈波动导致 WS 断联」这一假设：
 * 记录每次断开/重连的时长、重连后首个价格、以及断联前后的价差，
 * 积累样本后才能判断断联与进球的相关性。
 */
export interface PriceBotConnectionEvent {
  id?: number
  botId: string
  /** disconnect（断开） / reconnect（重连成功） */
  eventType: 'disconnect' | 'reconnect'
  /** 断开原因：ws_close / pong_timeout / ws_error / resubscribe（主动重建） */
  reason: string
  /** WebSocket 关闭码 */
  closeCode?: number | null
  /** 本次断联持续毫秒数（reconnect 事件才有） */
  downtimeMs?: number | null
  /** 断联时订阅的 token 数量 */
  subscribedTokens: number
  /** 断联前最后一次收到的价格（多 token 时记录首个受影响 token） */
  priceBefore?: number | null
  /** 重连后首个价格 */
  priceAfter?: number | null
  /** 断联前后价差（priceAfter - priceBefore） */
  priceDelta?: number | null
  /** 参考的 token（priceBefore/priceAfter 对应哪个 token） */
  tokenId?: string | null
  detail?: string | null
  createdAt?: string
}

// ==================== 连接状态 ====================

/** WebSocket 连接运行时状态 */
export interface ConnectionState {
  connected: boolean
  /** 当前是否处于断联期（含 REST 兜底中） */
  disconnected: boolean
  /** 本次断联开始时间 */
  disconnectedAt: string | null
  /** 连续重连失败次数（用于指数退避） */
  reconnectAttempts: number
  /** 累计断联次数 */
  totalDisconnects: number
  /** 最近一次断联时长（毫秒） */
  lastDowntimeMs: number | null
  /** REST 兜底轮询是否运行中 */
  restFallbackActive: boolean
  /**
   * 高波动窗口截止时间戳（毫秒）。
   *
   * 断联期间及重连后一段时间内，baselinePrice 可能是断联前的陈旧价格，
   * 基于它计算的百分比变化会产生巨大的假信号（实测见过 +111% 的跳变）。
   * 该窗口内 percent_change 类规则被抑制。
   */
  volatileUntil: number | null
}

// ==================== 机器人状态 ====================

interface BotState {
  config: PriceBotConfig
  monitors: Map<number, PriceMonitorState>
}

export type { BotState }
