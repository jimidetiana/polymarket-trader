/**
 * 价格监控机器人（WebSocket 实时模式）
 *
 * 监控指定 token 的价格变化，当满足设定条件时记录买卖信号。
 * 与 value-bot 不同，不需要关联比分数据，仅基于 CLOB 价格本身。
 * 纯信号记录模式，不执行自动买入卖出操作。
 *
 * 架构：
 * - 全局共享一个 WebSocket 连接，订阅所有活跃规则的 token
 * - 收到价格推送时，实时评估相关规则
 * - 规则启停动态调整订阅列表（重建连接）
 * - 自动重连机制
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  ensureTables,
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  recordTrigger,
  listTriggers,
  getLastTriggerTime,
  recordLog,
  listLogs,
} from './db.js';
import { DEFAULT_CONFIG } from './types.js';
import type {
  PriceBotConfig,
  PriceMonitorRule,
  PriceMonitorState,
  PriceSnapshot,
  BotState,
  PriceRuleType,
  PriceDirection,
} from './types.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// ==================== 状态 ====================

const state: BotState = {
  config: { ...DEFAULT_CONFIG },
  monitors: new Map(),
};

// WebSocket 相关状态
let ws: WebSocket | null = null;
let wsConnected = false;
let wsReconnectTimer: NodeJS.Timeout | null = null;
let wsCloseRequested = false;

// 价格缓存：tokenId → 最新价格快照
const priceCache = new Map<string, PriceSnapshot>();

// ==================== 工具函数 ====================

function getWsAgent() {
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

/** 获取当前所有活跃规则对应的 tokenId 集合 */
function getActiveTokenIds(): string[] {
  const tokenSet = new Set<string>();
  for (const monitor of state.monitors.values()) {
    if (monitor.running) {
      tokenSet.add(monitor.tokenId);
    }
  }
  return Array.from(tokenSet);
}

/** 根据 tokenId 找到所有关联的规则 ID */
function getRuleIdsForToken(tokenId: string): number[] {
  const ids: number[] = [];
  for (const [ruleId, monitor] of state.monitors.entries()) {
    if (monitor.running && monitor.tokenId === tokenId) {
      ids.push(Number(ruleId));
    }
  }
  return ids;
}

// ==================== WebSocket 连接管理 ====================

/** （重新）建立 WebSocket 连接，订阅所有活跃 token */
function connectWs(): void {
  if (wsCloseRequested) return;

  const tokenIds = getActiveTokenIds();
  if (tokenIds.length === 0) {
    // 没有活跃 token，不建立连接
    if (ws) {
      ws.close();
      ws = null;
    }
    return;
  }

  // 如果已有连接，先关闭再重连（用于订阅列表变化时）
  if (ws) {
    wsCloseRequested = false; // 重置标志，因为我们要重建
    ws.close();
    ws = null;
  }

  console.log(`[PriceBot] 连接 WebSocket，订阅 ${tokenIds.length} 个 token`);

  const agent = getWsAgent();
  ws = new WebSocket(WS_URL, { agent } as any);
  wsConnected = false;

  ws.on('open', () => {
    wsConnected = true;
    console.log('[PriceBot] WebSocket 已连接');
    // 订阅 market 频道，level 2 只推送最优买卖价（消息量少）
    ws?.send(JSON.stringify({
      type: 'market',
      assets_ids: tokenIds,
      initial_dump: true,
      level: 2,
    }));
    // 心跳
    startHeartbeat();
  });

  ws.on('message', (data) => {
    const text = data.toString();
    if (text === 'PONG') return;
    try {
      const msg = JSON.parse(text);
      handleWsMessage(msg);
    } catch {
      // 忽略无法解析的消息
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[PriceBot] WebSocket 错误:', err.message);
  });

  ws.on('close', () => {
    wsConnected = false;
    stopHeartbeat();
    console.log('[PriceBot] WebSocket 已断开');

    // 如果不是主动关闭，自动重连
    if (!wsCloseRequested) {
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        if (!wsCloseRequested) {
          console.log('[PriceBot] 尝试重连 WebSocket...');
          connectWs();
        }
      }, 5000);
    }
  });
}

function closeWs(): void {
  wsCloseRequested = true;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

let pingTimer: NodeJS.Timeout | null = null;
function startHeartbeat(): void {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (ws && wsConnected) {
      ws.send('PING');
    }
  }, 10000);
}
function stopHeartbeat(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/** 刷新 WS 订阅（当 token 列表变化时调用） */
function refreshWsSubscription(): void {
  if (wsCloseRequested) return;

  const activeTokens = getActiveTokenIds();

  if (activeTokens.length === 0) {
    // 没有活跃 token，关闭连接
    closeWs();
    return;
  }

  // 有活跃 token，（重）连接
  // 如果已连接，为了简化订阅管理，直接重建连接
  // （Polymarket WS 发送多次订阅消息的行为不确定，重建最可靠）
  connectWs();
}

// ==================== WS 消息处理 ====================

function handleWsMessage(msg: any): void {
  // 初始快照（无 event_type，有 asset_id + bids/asks）
  if (msg.asset_id && (msg.bids || msg.asks) && !msg.event_type) {
    handleBookSnapshot(msg);
    return;
  }

  // 盘口更新事件
  if (msg.event_type === 'book' && msg.asset_id) {
    handleBookSnapshot(msg);
    return;
  }

  // 最优买卖价变化
  if (msg.event_type === 'best_bid_ask' && msg.asset_id) {
    handleBestBidAsk(msg);
    return;
  }

  // 批量价格变化
  if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
    for (const pc of msg.price_changes) {
      handleBestBidAsk(pc);
    }
    return;
  }
}

function handleBookSnapshot(msg: any): void {
  const tokenId = msg.asset_id;
  const bids: any[] = msg.bids || [];
  const asks: any[] = msg.asks || [];

  let bestBid: number | null = null;
  let bestBidSize: number | null = null;
  if (bids.length > 0) {
    const sorted = bids
      .map((b) => ({ price: Number(b.price), size: Number(b.size ?? 0) }))
      .filter((b) => b.price > 0 && b.size > 0)
      .sort((a, b) => b.price - a.price);
    if (sorted.length > 0) {
      bestBid = sorted[0].price;
      bestBidSize = sorted[0].size;
    }
  }

  let bestAsk: number | null = null;
  let bestAskSize: number | null = null;
  if (asks.length > 0) {
    const sorted = asks
      .map((a) => ({ price: Number(a.price), size: Number(a.size ?? 0) }))
      .filter((a) => a.price > 0 && a.size > 0)
      .sort((a, b) => a.price - b.price);
    if (sorted.length > 0) {
      bestAsk = sorted[0].price;
      bestAskSize = sorted[0].size;
    }
  }

  updatePriceAndEvaluate(tokenId, bestBid, bestBidSize, bestAsk, bestAskSize);
}

function handleBestBidAsk(msg: any): void {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  const bestBid = msg.best_bid !== undefined && msg.best_bid !== null ? Number(msg.best_bid) : null;
  const bestAsk = msg.best_ask !== undefined && msg.best_ask !== null ? Number(msg.best_ask) : null;
  const bestBidSize = msg.best_bid_size !== undefined ? Number(msg.best_bid_size) : null;
  const bestAskSize = msg.best_ask_size !== undefined ? Number(msg.best_ask_size) : null;

  updatePriceAndEvaluate(tokenId, bestBid, bestBidSize, bestAsk, bestAskSize);
}

function updatePriceAndEvaluate(
  tokenId: string,
  bestBid: number | null,
  bestBidSize: number | null,
  bestAsk: number | null,
  bestAskSize: number | null,
): void {
  // 计算中间价
  let lastPrice: number | null = null;
  if (bestBid != null && bestAsk != null) {
    lastPrice = (bestBid + bestAsk) / 2;
  } else if (bestAsk != null) {
    lastPrice = bestAsk;
  } else if (bestBid != null) {
    lastPrice = bestBid;
  }

  const snapshot: PriceSnapshot = {
    tokenId,
    bestBid,
    bestBidSize,
    bestAsk,
    bestAskSize,
    lastPrice,
    timestamp: new Date().toISOString(),
  };

  // 更新缓存
  priceCache.set(tokenId, snapshot);

  // 找到该 token 对应的所有规则并评估
  const ruleIds = getRuleIdsForToken(tokenId);
  for (const ruleId of ruleIds) {
    evaluateRuleForId(ruleId, snapshot).catch((err) => {
      console.error(`[PriceBot] 评估规则 #${ruleId} 出错:`, err.message);
    });
  }
}

// ==================== 规则评估 ====================

interface RuleEvaluation {
  triggered: boolean
  direction?: PriceDirection
  previousPrice: number
  currentPrice: number
  changePercent: number
  threshold: number
  reason?: string
}

async function evaluateRuleForId(ruleId: number, snapshot: PriceSnapshot): Promise<void> {
  const monitor = state.monitors.get(ruleId);
  if (!monitor || !monitor.running) return;

  const rule = await getRule(ruleId);
  if (!rule || !rule.enabled) {
    monitor.running = false;
    monitor.lastError = '规则不存在或已禁用';
    return;
  }

  const currentPrice = snapshot.lastPrice;
  if (currentPrice == null) {
    monitor.lastError = '价格数据无效';
    return;
  }

  monitor.lastPrice = currentPrice;
  monitor.lastPollTime = snapshot.timestamp;
  monitor.cyclesRun++;

  // 首次获取价格，设置基准价
  if (monitor.baselinePrice == null) {
    monitor.baselinePrice = currentPrice;
    monitor.lastError = null;
    return;
  }

  // 评估规则
  const evaluation = evaluateRule(rule, monitor.baselinePrice, currentPrice);

  if (evaluation.triggered && evaluation.direction) {
    // 检查冷却
    const lastTriggerTime = monitor.lastTriggerTime;
    const now = Date.now();
    const lastTriggerMs = lastTriggerTime ? new Date(lastTriggerTime).getTime() : 0;
    const cooldownMs = rule.cooldownSeconds * 1000;

    if (now - lastTriggerMs >= cooldownMs) {
      // 触发！
      const triggeredEval = evaluation as RuleEvaluation & { direction: PriceDirection };
      await handleTrigger(rule, triggeredEval, snapshot);
      monitor.triggerCount++;
      monitor.lastTriggerTime = new Date().toISOString();
      // 触发后更新基准价为当前价格（避免连续触发）
      monitor.baselinePrice = currentPrice;
      console.log(
        `[PriceBot] 规则 #${rule.id} 触发: ${rule.outcome} ${evaluation.direction} ` +
        `${(evaluation.changePercent * 100).toFixed(2)}%, 当前价 $${currentPrice.toFixed(4)}`,
      );
    }
  }

  monitor.lastError = null;
}

/**
 * 评估一条规则是否触发
 */
function evaluateRule(
  rule: PriceMonitorRule,
  baselinePrice: number | null,
  currentPrice: number | null,
): RuleEvaluation {
  if (currentPrice == null) {
    return { triggered: false, previousPrice: baselinePrice ?? 0, currentPrice: 0, changePercent: 0, threshold: 0 }
  }

  const prev = baselinePrice ?? currentPrice

  switch (rule.ruleType) {
    case 'percent_change':
      return evaluatePercentChange(rule, prev, currentPrice)
    case 'price_break':
      return evaluatePriceBreak(rule, prev, currentPrice)
    case 'price_range':
      return evaluatePriceRange(rule, prev, currentPrice)
    default:
      return { triggered: false, previousPrice: prev, currentPrice, changePercent: 0, threshold: 0 }
  }
}

function evaluatePercentChange(
  rule: PriceMonitorRule,
  prev: number,
  current: number,
): RuleEvaluation {
  const threshold = rule.percentThreshold ?? 0
  if (prev <= 0 || threshold <= 0) {
    return { triggered: false, previousPrice: prev, currentPrice: current, changePercent: 0, threshold }
  }

  const changePercent = (current - prev) / prev

  let triggered = false
  let direction: PriceDirection | undefined

  if (rule.direction === 'up' || rule.direction === 'both') {
    if (changePercent >= threshold) {
      triggered = true
      direction = 'up'
    }
  }
  if (rule.direction === 'down' || rule.direction === 'both') {
    if (changePercent <= -threshold) {
      triggered = true
      direction = direction || 'down'
    }
  }

  return {
    triggered,
    direction,
    previousPrice: prev,
    currentPrice: current,
    changePercent,
    threshold,
  }
}

function evaluatePriceBreak(
  rule: PriceMonitorRule,
  prev: number,
  current: number,
): RuleEvaluation {
  const target = rule.targetPrice
  if (target == null || target <= 0) {
    return { triggered: false, previousPrice: prev, currentPrice: current, changePercent: 0, threshold: 0 }
  }

  let triggered = false
  let direction: PriceDirection | undefined

  // 向上突破：之前在目标价下方，现在在上方
  if (rule.direction === 'up' || rule.direction === 'both') {
    if (prev < target && current >= target) {
      triggered = true
      direction = 'up'
    }
  }
  // 向下突破：之前在目标价上方，现在在下方
  if (rule.direction === 'down' || rule.direction === 'both') {
    if (prev > target && current <= target) {
      triggered = true
      direction = direction || 'down'
    }
  }

  const changePercent = prev > 0 ? (current - prev) / prev : 0

  return {
    triggered,
    direction,
    previousPrice: prev,
    currentPrice: current,
    changePercent,
    threshold: target,
  }
}

function evaluatePriceRange(
  rule: PriceMonitorRule,
  prev: number,
  current: number,
): RuleEvaluation {
  const low = rule.priceLow
  const high = rule.priceHigh
  if (low == null || high == null || low >= high) {
    return { triggered: false, previousPrice: prev, currentPrice: current, changePercent: 0, threshold: 0 }
  }

  let triggered = false
  let direction: PriceDirection | undefined

  const wasInside = prev >= low && prev <= high
  const isInside = current >= low && current <= high

  // 从区间内向上突破
  if (wasInside && !isInside && current > high) {
    if (rule.direction === 'up' || rule.direction === 'both') {
      triggered = true
      direction = 'up'
    }
  }
  // 从区间内向下突破
  if (wasInside && !isInside && current < low) {
    if (rule.direction === 'down' || rule.direction === 'both') {
      triggered = true
      direction = 'down'
    }
  }

  const changePercent = prev > 0 ? (current - prev) / prev : 0
  const threshold = direction === 'up' ? high : direction === 'down' ? low : (high + low) / 2

  return {
    triggered,
    direction,
    previousPrice: prev,
    currentPrice: current,
    changePercent,
    threshold,
  }
}

// ==================== 触发处理 ====================

/**
 * 处理触发事件：记录买卖信号
 */
async function handleTrigger(
  rule: PriceMonitorRule,
  evaluation: RuleEvaluation & { direction: PriceDirection },
  _snapshot: PriceSnapshot,
): Promise<void> {
  // 根据规则配置的信号类型和触发方向确定具体信号
  let signal: string
  if (rule.signalType === 'buy_signal') {
    signal = 'BUY_SIGNAL'
  } else if (rule.signalType === 'sell_signal') {
    signal = 'SELL_SIGNAL'
  } else {
    // alert 模式根据方向标注
    signal = evaluation.direction === 'up' ? 'PRICE_UP_ALERT' : 'PRICE_DOWN_ALERT'
  }

  // 记录信号事件
  await recordTrigger({
    botId: state.config.botId,
    ruleId: rule.id!,
    tokenId: rule.tokenId,
    marketId: rule.marketId,
    eventId: rule.eventId,
    outcome: rule.outcome,
    ruleType: rule.ruleType,
    direction: evaluation.direction,
    previousPrice: evaluation.previousPrice,
    currentPrice: evaluation.currentPrice,
    changePercent: evaluation.changePercent,
    threshold: evaluation.threshold,
    signalType: signal,
  })

  // 记录触发日志
  await recordLog({
    ruleId: rule.id!,
    tokenId: rule.tokenId,
    eventId: rule.eventId,
    outcome: rule.outcome,
    action: 'trigger',
    price: evaluation.currentPrice,
    detail: `${signal} ${evaluation.direction} ${rule.outcome}, 价格 ${evaluation.previousPrice.toFixed(4)} → ${evaluation.currentPrice.toFixed(4)} (${(evaluation.changePercent * 100).toFixed(2)}%)`,
  }).catch(() => {})
}

// ==================== 启停控制 ====================

/** 启动单个规则监控 */
export async function startMonitor(ruleId: number): Promise<void> {
  await ensureTables()

  const rule = await getRule(ruleId)
  if (!rule) {
    throw new Error(`规则 #${ruleId} 不存在`)
  }
  if (!rule.enabled) {
    throw new Error(`规则 #${ruleId} 已禁用，请先启用`)
  }

  let monitor = state.monitors.get(ruleId)
  if (!monitor) {
    monitor = {
      ruleId,
      tokenId: rule.tokenId,
      running: false,
      lastPollTime: null,
      lastError: null,
      cyclesRun: 0,
      triggerCount: 0,
      baselinePrice: null,
      lastTriggerTime: null,
      lastPrice: null,
    }
    state.monitors.set(ruleId, monitor)
  }

  if (monitor.running) return
  monitor.running = true

  // 加载上次触发时间
  const lastTrigger = await getLastTriggerTime(ruleId)
  if (lastTrigger) {
    monitor.lastTriggerTime = lastTrigger
  }

  // 如果价格缓存里已有该 token 的价格，直接用做基准价
  const cached = priceCache.get(rule.tokenId)
  let startPrice: number | null = null
  if (cached?.lastPrice != null && monitor.baselinePrice == null) {
    monitor.baselinePrice = cached.lastPrice
    monitor.lastPrice = cached.lastPrice
    monitor.lastPollTime = cached.timestamp
    startPrice = cached.lastPrice
  }

  const startTime = new Date().toISOString()
  console.log(`[PriceBot] 规则 #${ruleId} 启动于 ${startTime}, 价格: ${startPrice ?? '待获取'}`)

  // 记录启动日志
  await recordLog({
    ruleId,
    tokenId: rule.tokenId,
    eventId: rule.eventId,
    outcome: rule.outcome,
    action: 'start',
    price: startPrice,
    detail: `监控启动, 基准价格: ${startPrice ?? '待获取'}`,
  }).catch((err) => {
    console.error(`[PriceBot] 记录启动日志失败:`, err.message)
  })

  console.log(`[PriceBot] 启动价格监控: 规则 #${ruleId} (${rule.outcome})`)

  // 刷新 WS 订阅（如果是新 token，需要加入订阅）
  refreshWsSubscription()
}

/** 停止单个规则监控 */
export function stopMonitor(ruleId: number): void {
  const monitor = state.monitors.get(ruleId)
  if (monitor) {
    monitor.running = false
    const stopPrice = monitor.lastPrice
    const stopTime = new Date().toISOString()
    console.log(`[PriceBot] 规则 #${ruleId} 停止于 ${stopTime}, 最后价格: ${stopPrice ?? 'N/A'}`)

    // 记录停止日志（fire-and-forget）
    recordLog({
      ruleId,
      tokenId: monitor.tokenId,
      eventId: '',
      outcome: '',
      action: 'stop',
      price: stopPrice,
      detail: `监控停止, 最后价格: ${stopPrice ?? 'N/A'}`,
    }).catch(() => {})
  }

  // 刷新 WS 订阅
  refreshWsSubscription()
}

/** 启动机器人（启动所有启用的规则） */
export async function startBot(config?: Partial<PriceBotConfig>): Promise<void> {
  if (config) state.config = { ...state.config, ...config }
  state.config.enabled = true
  wsCloseRequested = false

  const { rules } = await listRules({ enabledOnly: true })
  for (const rule of rules) {
    if (rule.id !== undefined) {
      // 先加入 monitors 但不启动 WS，最后统一连接
      const existing = state.monitors.get(rule.id)
      if (!existing) {
        const lastTrigger = await getLastTriggerTime(rule.id)
        state.monitors.set(rule.id, {
          ruleId: rule.id,
          tokenId: rule.tokenId,
          running: true,
          lastPollTime: null,
          lastError: null,
          cyclesRun: 0,
          triggerCount: 0,
          baselinePrice: null,
          lastTriggerTime: lastTrigger ?? null,
          lastPrice: null,
        })
      } else {
        existing.running = true
      }
    }
  }

  // 统一建立 WS 连接
  connectWs()

  console.log(`[PriceBot] 机器人已启动，共 ${rules.length} 条规则`)
}

/** 停止机器人（停止所有监控） */
export function stopBot(): void {
  for (const [ruleId] of state.monitors) {
    const m = state.monitors.get(ruleId)
    if (m) m.running = false
  }
  state.config.enabled = false
  closeWs()
  console.log('[PriceBot] 机器人已停止')
}

// ==================== 配置管理 ====================

export function updateConfig(config: Partial<PriceBotConfig>): PriceBotConfig {
  state.config = { ...state.config, ...config }
  // pollIntervalMs 在 WS 模式下不再使用，但保留配置字段
  return state.config
}

// ==================== 状态查询 ====================

export function getBotStatus() {
  const monitors = getMonitorList()
  return {
    running: monitors.some((m: any) => m.running),
    wsConnected,
    lastPollTime: monitors.length ? monitors[0].lastPollTime : null,
    config: state.config,
    monitors,
    totalMonitors: monitors.length,
    runningCount: monitors.filter((m: any) => m.running).length,
    mode: 'websocket',
  }
}

export function getMonitorList() {
  const result: any[] = []
  for (const [ruleId, m] of state.monitors) {
    result.push({
      ruleId,
      tokenId: m.tokenId,
      running: m.running,
      lastPollTime: m.lastPollTime,
      lastError: m.lastError,
      cyclesRun: m.cyclesRun,
      triggerCount: m.triggerCount,
      baselinePrice: m.baselinePrice,
      lastTriggerTime: m.lastTriggerTime,
      lastPrice: m.lastPrice,
    })
  }
  return result
}

export function getMonitor(ruleId: number) {
  const m = state.monitors.get(ruleId)
  if (!m) return null
  return {
    ruleId,
    tokenId: m.tokenId,
    running: m.running,
    lastPollTime: m.lastPollTime,
    lastError: m.lastError,
    cyclesRun: m.cyclesRun,
    triggerCount: m.triggerCount,
    baselinePrice: m.baselinePrice,
    lastTriggerTime: m.lastTriggerTime,
    lastPrice: m.lastPrice,
  }
}

// ==================== 手动触发（保留 API 兼容） ====================

export async function triggerCycle(): Promise<void> {
  // WS 模式下无轮询概念，手动触发一次所有规则的评估（使用缓存价格）
  for (const [ruleId, monitor] of state.monitors.entries()) {
    if (monitor.running) {
      const cached = priceCache.get(monitor.tokenId)
      if (cached) {
        await evaluateRuleForId(Number(ruleId), cached).catch(() => {})
      }
    }
  }
}

export async function triggerMonitorCycle(ruleId: number): Promise<void> {
  const monitor = state.monitors.get(ruleId)
  if (!monitor) return
  const cached = priceCache.get(monitor.tokenId)
  if (cached) {
    await evaluateRuleForId(ruleId, cached)
  }
}

// ==================== 规则 CRUD 导出 ====================

export { createRule, updateRule, deleteRule, getRule, listRules, listTriggers, listLogs }
