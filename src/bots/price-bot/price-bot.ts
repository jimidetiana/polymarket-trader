/**
 * 价格监控机器人（WebSocket 实时模式 + REST 兜底）
 *
 * 监控指定 token 的价格变化，当满足设定条件时记录买卖信号。
 * 与 value-bot 不同，不需要关联比分数据，仅基于 CLOB 价格本身。
 * 纯信号记录模式，不执行自动买入卖出操作。
 *
 * 架构：
 * - 全局共享一个 WebSocket 连接，订阅所有活跃规则的 token
 * - 收到价格推送时，实时评估相关规则
 * - 规则启停动态调整订阅列表（重建连接）
 * - 断联时自动切换 REST 轮询取价，指数退避重连
 * - 断联事件落库，用于验证「进球导致断联」的假设
 */

import WebSocket from 'ws';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  ensureTables,
  listRules,
  getRule,
  createRule as dbCreateRule,
  updateRule as dbUpdateRule,
  deleteRule as dbDeleteRule,
  recordTrigger,
  listTriggers,
  getLastTriggerTime,
  recordLog,
  listLogs,
  recordConnectionEvent,
  updateConnectionEventPrice,
  listConnectionEvents,
  getConnectionStats,
} from './db.js';
import { DEFAULT_CONFIG } from './types.js';
import type {
  PriceBotConfig,
  PriceMonitorRule,
  PriceMonitorState,
  PriceSnapshot,
  ConnectionState,
  BotState,
  PriceRuleType,
  PriceDirection,
} from './types.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_BASE = 'https://clob.polymarket.com';
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
/** 主动重建连接标志：用于区分「订阅列表变化导致的重建」和「真实异常断联」 */
let resubscribeInProgress = false;

/** 连接状态（断联统计 + 高波动窗口） */
const connState: ConnectionState = {
  connected: false,
  disconnected: false,
  disconnectedAt: null,
  reconnectAttempts: 0,
  totalDisconnects: 0,
  lastDowntimeMs: null,
  restFallbackActive: false,
  volatileUntil: null,
};

// 价格缓存：tokenId → 最新价格快照
const priceCache = new Map<string, PriceSnapshot>();

/**
 * 规则配置缓存：ruleId → 规则。
 *
 * 评估路径必须是同步的（见 evaluateRuleForId 的并发说明），
 * 所以规则配置不能在评估时 await 数据库读取。
 */
const ruleCache = new Map<number, PriceMonitorRule>();

/** 断联前的价格快照（用于计算断联前后价差） */
const preDisconnectPrices = new Map<string, number>();

/**
 * 待补全价格的重连事件。
 *
 * 重连事件在 WS `open` 时就落库，但那一刻 `initial_dump` 还没到，
 * priceAfter 仍是断联前的旧值。所以先落库拿到 id，等重连后
 * 第一个真实价格到达时再回填 price_after / price_delta。
 */
interface PendingReconnectEvent {
  eventId: number
  tokenId: string
  priceBefore: number | null
}
const pendingReconnectEvents: PendingReconnectEvent[] = [];

const restAxios = axios.create({
  baseURL: CLOB_BASE,
  timeout: 5000,
  ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
});

// ==================== 工具函数 ====================

function getWsAgent() {
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

/** 当前是否处于高波动窗口（断联中或刚重连） */
function isVolatileWindow(): boolean {
  if (connState.disconnected) return true;
  return connState.volatileUntil != null && Date.now() < connState.volatileUntil;
}

/** 刷新单条规则缓存 */
async function refreshRuleCache(ruleId: number): Promise<void> {
  try {
    const rule = await getRule(ruleId);
    if (rule) ruleCache.set(ruleId, rule);
    else ruleCache.delete(ruleId);
  } catch (err: any) {
    console.error(`[PriceBot] 刷新规则 #${ruleId} 缓存失败:`, err.message);
  }
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
      resubscribeInProgress = true;
      ws.close();
      ws = null;
    }
    return;
  }

  // 如果已有连接，先关闭再重连（用于订阅列表变化时）
  // 标记为主动重建，避免被记成异常断联污染断联统计
  if (ws) {
    resubscribeInProgress = true;
    ws.close();
    ws = null;
  }

  console.log(`[PriceBot] 连接 WebSocket，订阅 ${tokenIds.length} 个 token`);

  const agent = getWsAgent();
  ws = new WebSocket(WS_URL, { agent } as any);
  const thisWs = ws;
  wsConnected = false;

  ws.on('open', () => {
    // 忽略已被替换的旧连接的事件
    if (thisWs !== ws) return;

    wsConnected = true;
    connState.connected = true;
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

    // 结束断联期：记录重连事件、停止 REST 兜底、开启高波动窗口
    onReconnected();
  });

  ws.on('message', (data) => {
    if (thisWs !== ws) return;

    const text = data.toString();
    if (text === 'PONG') {
      // 收到 PONG，清除超时计时器（半开连接检测）
      clearPongTimeout();
      return;
    }
    try {
      const msg = JSON.parse(text);
      handleWsMessage(msg);
    } catch {
      // 忽略无法解析的消息
    }
  });

  ws.on('error', (err: Error) => {
    if (thisWs !== ws) return;
    console.error('[PriceBot] WebSocket 错误:', err.message);
    lastCloseReason = 'ws_error';
  });

  ws.on('close', (code: number) => {
    if (thisWs !== ws) return;

    wsConnected = false;
    connState.connected = false;
    stopHeartbeat();

    const wasResubscribe = resubscribeInProgress;
    resubscribeInProgress = false;

    console.log(`[PriceBot] WebSocket 已断开 (code=${code}${wasResubscribe ? ', 主动重建' : ''})`);

    // 主动关闭（停止 bot）不做断联处理
    if (wsCloseRequested) return;

    // 主动重建订阅：不记为异常断联，connectWs 会立即重连
    if (wasResubscribe) return;

    // 真实异常断联
    onDisconnected(lastCloseReason || 'ws_close', code);
    lastCloseReason = null;

    scheduleReconnect();
  });
}

/** 安排重连：指数退避，起步快（默认 500ms），上限 15s */
function scheduleReconnect(): void {
  if (wsCloseRequested) return;
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);

  const attempt = connState.reconnectAttempts;
  const base = state.config.reconnectBaseDelayMs;
  const max = state.config.reconnectMaxDelayMs;
  const delay = Math.min(base * Math.pow(2, attempt), max);
  connState.reconnectAttempts = attempt + 1;

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (!wsCloseRequested) {
      console.log(`[PriceBot] 尝试重连 WebSocket... (第 ${attempt + 1} 次, 延迟 ${delay}ms)`);
      connectWs();
    }
  }, delay);
}

function closeWs(): void {
  wsCloseRequested = true;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  stopRestFallback();
  stopHeartbeat();
  connState.disconnected = false;
  connState.disconnectedAt = null;
  connState.reconnectAttempts = 0;
  if (ws) {
    ws.close();
    ws = null;
  }
  wsConnected = false;
  connState.connected = false;
}

// ==================== 心跳 / 半开连接检测 ====================

let pingTimer: NodeJS.Timeout | null = null;
let pongTimeoutTimer: NodeJS.Timeout | null = null;
/** 最近一次断开的原因，由 error / pong 超时写入，供 close 事件读取 */
let lastCloseReason: string | null = null;

function startHeartbeat(): void {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (ws && wsConnected) {
      ws.send('PING');
      // 经本地 HTTP 代理时半开连接很常见：socket 已死但 close 事件不触发。
      // 发出 PING 后启动超时，超时未收到 PONG 就主动 terminate 触发重连。
      startPongTimeout();
    }
  }, 10000);
}

function stopHeartbeat(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  clearPongTimeout();
}

function startPongTimeout(): void {
  clearPongTimeout();
  pongTimeoutTimer = setTimeout(() => {
    pongTimeoutTimer = null;
    if (ws && wsConnected) {
      console.warn(`[PriceBot] PONG 超时 (${state.config.pongTimeoutMs}ms)，判定连接已死，强制重连`);
      lastCloseReason = 'pong_timeout';
      // terminate 而非 close：半开连接的优雅关闭握手不会完成
      ws.terminate();
    }
  }, state.config.pongTimeoutMs);
}

function clearPongTimeout(): void {
  if (pongTimeoutTimer) {
    clearTimeout(pongTimeoutTimer);
    pongTimeoutTimer = null;
  }
}

// ==================== 断联 / 重连处理 ====================

/**
 * 进入断联期。
 *
 * 记录断联事件并立刻启动 REST 兜底轮询 —— WS 断开不等于 REST 不可用，
 * 这两条链路独立，所以断联期间仍能取到价格。
 */
function onDisconnected(reason: string, closeCode?: number): void {
  if (connState.disconnected) return; // 已在断联期，避免重复记录

  connState.disconnected = true;
  connState.disconnectedAt = new Date().toISOString();
  connState.totalDisconnects++;

  // 快照断联前的价格，用于重连后计算价差
  preDisconnectPrices.clear();
  for (const tokenId of getActiveTokenIds()) {
    const cached = priceCache.get(tokenId);
    if (cached?.lastPrice != null) {
      preDisconnectPrices.set(tokenId, cached.lastPrice);
    }
  }

  const tokenIds = getActiveTokenIds();
  const refToken = tokenIds[0] ?? null;
  const priceBefore = refToken ? preDisconnectPrices.get(refToken) ?? null : null;

  recordConnectionEvent({
    botId: state.config.botId,
    eventType: 'disconnect',
    reason,
    closeCode: closeCode ?? null,
    subscribedTokens: tokenIds.length,
    priceBefore,
    tokenId: refToken,
    detail: `断联，订阅 ${tokenIds.length} 个 token，启动 REST 兜底轮询`,
  }).catch((err) => {
    console.error('[PriceBot] 记录断联事件失败:', err.message);
  });

  // 同时写入监控日志，方便在现有日志界面查看
  for (const ruleId of getRunningRuleIds()) {
    const monitor = state.monitors.get(ruleId);
    const rule = ruleCache.get(ruleId);
    recordLog({
      ruleId,
      tokenId: monitor?.tokenId ?? '',
      eventId: rule?.eventId ?? '',
      outcome: rule?.outcome ?? '',
      action: 'disconnect',
      price: monitor?.lastPrice ?? null,
      detail: `WS 断联 (${reason}${closeCode != null ? `, code=${closeCode}` : ''})，转 REST 兜底`,
    }).catch(() => {});
  }

  startRestFallback();
}

/** 断联结束：记录重连事件、停止 REST 兜底、开启高波动窗口 */
function onReconnected(): void {
  connState.reconnectAttempts = 0;

  if (!connState.disconnected) return; // 首次连接，不是从断联中恢复

  const downtimeMs = connState.disconnectedAt
    ? Date.now() - new Date(connState.disconnectedAt).getTime()
    : null;

  connState.disconnected = false;
  connState.disconnectedAt = null;
  connState.lastDowntimeMs = downtimeMs;

  stopRestFallback();

  // 开启高波动窗口：重连后 initial_dump 的价格可能与断联前基准差异巨大，
  // 此窗口内抑制 percent_change 触发，避免产生假信号
  connState.volatileUntil = Date.now() + state.config.volatileWindowMs;

  const tokenIds = getActiveTokenIds();
  const refToken = tokenIds[0] ?? null;
  const priceBefore = refToken ? preDisconnectPrices.get(refToken) ?? null : null;

  console.log(`[PriceBot] 重连成功，断联 ${downtimeMs ?? '?'}ms（价差待重连后首个价格确认）`);

  // 先落库拿到 id，price_after / price_delta 等重连后第一个真实价格到达时回填。
  // 此刻 initial_dump 尚未到达，priceCache 里还是断联前的旧值，直接算价差会恒为 0。
  recordConnectionEvent({
    botId: state.config.botId,
    eventType: 'reconnect',
    reason: 'reconnected',
    downtimeMs,
    subscribedTokens: tokenIds.length,
    priceBefore,
    tokenId: refToken,
    detail: `重连成功，断联 ${downtimeMs ?? '?'}ms，高波动窗口 ${state.config.volatileWindowMs}ms`,
  })
    .then((eventId) => {
      if (refToken) {
        pendingReconnectEvents.push({ eventId, tokenId: refToken, priceBefore });
      }
    })
    .catch((err) => {
      console.error('[PriceBot] 记录重连事件失败:', err.message);
    });

  for (const ruleId of getRunningRuleIds()) {
    const monitor = state.monitors.get(ruleId);
    const rule = ruleCache.get(ruleId);
    recordLog({
      ruleId,
      tokenId: monitor?.tokenId ?? '',
      eventId: rule?.eventId ?? '',
      outcome: rule?.outcome ?? '',
      action: 'reconnect',
      price: monitor?.lastPrice ?? null,
      detail: `WS 重连成功，断联 ${downtimeMs ?? '?'}ms`,
    }).catch(() => {});
  }
}

/**
 * 重连后首个真实价格到达，回填断联前后价差。
 *
 * 这个价差是判断「断联是否与进球相关」的核心指标：
 * 若进球导致断联的假设成立，应能看到断联事件的 |price_delta| 显著大于常规断联。
 */
async function settleReconnectPrice(tokenId: string, priceAfter: number): Promise<void> {
  const idx = pendingReconnectEvents.findIndex((p) => p.tokenId === tokenId);
  if (idx < 0) return;

  const [pending] = pendingReconnectEvents.splice(idx, 1);
  const priceDelta =
    pending.priceBefore != null ? priceAfter - pending.priceBefore : null;

  console.log(
    `[PriceBot] 断联价差确认: ${pending.priceBefore?.toFixed(4) ?? '?'} → ${priceAfter.toFixed(4)}` +
    (priceDelta != null ? ` (${priceDelta >= 0 ? '+' : ''}${priceDelta.toFixed(4)})` : ''),
  );

  try {
    await updateConnectionEventPrice(pending.eventId, priceAfter);
  } catch (err: any) {
    console.error('[PriceBot] 回填断联价差失败:', err.message);
  }
}

/** 当前运行中的规则 ID 列表 */
function getRunningRuleIds(): number[] {
  const ids: number[] = [];
  for (const [ruleId, m] of state.monitors.entries()) {
    if (m.running) ids.push(Number(ruleId));
  }
  return ids;
}

// ==================== REST 兜底轮询 ====================

let restFallbackTimer: NodeJS.Timeout | null = null;
let restPollInFlight = false;

/**
 * 断联期间用 REST /book 取价。
 *
 * WS 与 REST 是独立链路，WS 断开时 REST 通常仍可用，
 * 所以断联期间不必"瞎着"，轮询频率（默认 400ms）甚至高于部分 WS 推送。
 */
function startRestFallback(): void {
  if (restFallbackTimer) return;
  if (wsCloseRequested) return;

  connState.restFallbackActive = true;
  console.log(`[PriceBot] 启动 REST 兜底轮询 (${state.config.restFallbackIntervalMs}ms)`);

  restFallbackTimer = setInterval(() => {
    void pollBooksViaRest();
  }, state.config.restFallbackIntervalMs);

  // 立即拉一次，不等第一个间隔
  void pollBooksViaRest();
}

function stopRestFallback(): void {
  if (restFallbackTimer) {
    clearInterval(restFallbackTimer);
    restFallbackTimer = null;
    console.log('[PriceBot] 停止 REST 兜底轮询');
  }
  connState.restFallbackActive = false;
}

async function pollBooksViaRest(): Promise<void> {
  // 上一轮还没回来就跳过，避免请求堆积
  if (restPollInFlight) return;
  const tokenIds = getActiveTokenIds();
  if (tokenIds.length === 0) return;

  restPollInFlight = true;
  try {
    const results = await Promise.allSettled(
      tokenIds.map((tokenId) =>
        restAxios.get('/book', { params: { token_id: tokenId } })
          .then((resp) => ({ tokenId, data: resp.data })),
      ),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { tokenId, data } = r.value;
      if (!data) continue;
      handleBookSnapshot({ asset_id: tokenId, bids: data.bids, asks: data.asks }, 'rest');
    }
  } catch (err: any) {
    console.error('[PriceBot] REST 兜底轮询出错:', err.message);
  } finally {
    restPollInFlight = false;
  }
}

/**
 * 刷新 WS 订阅（当 token 列表变化时调用）。
 *
 * wantConnection=true 表示调用方明确要求建立连接（规则启动）。
 * 此时必须清除 wsCloseRequested —— 否则上一次 closeWs()（例如停掉最后一条规则）
 * 留下的"主动关闭"意图会永久阻止后续所有重连。
 */
function refreshWsSubscription(wantConnection = false): void {
  if (wsCloseRequested && !wantConnection) return;

  const activeTokens = getActiveTokenIds();

  if (activeTokens.length === 0) {
    // 没有活跃 token，关闭连接
    closeWs();
    return;
  }

  if (wantConnection) wsCloseRequested = false;

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

function handleBookSnapshot(msg: any, source: 'ws' | 'rest' = 'ws'): void {
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

  updatePriceAndEvaluate(tokenId, bestBid, bestBidSize, bestAsk, bestAskSize, source);
}

function handleBestBidAsk(msg: any, source: 'ws' | 'rest' = 'ws'): void {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  const bestBid = msg.best_bid !== undefined && msg.best_bid !== null ? Number(msg.best_bid) : null;
  const bestAsk = msg.best_ask !== undefined && msg.best_ask !== null ? Number(msg.best_ask) : null;
  const bestBidSize = msg.best_bid_size !== undefined ? Number(msg.best_bid_size) : null;
  const bestAskSize = msg.best_ask_size !== undefined ? Number(msg.best_ask_size) : null;

  updatePriceAndEvaluate(tokenId, bestBid, bestBidSize, bestAsk, bestAskSize, source);
}

function updatePriceAndEvaluate(
  tokenId: string,
  bestBid: number | null,
  bestBidSize: number | null,
  bestAsk: number | null,
  bestAskSize: number | null,
  source: 'ws' | 'rest' = 'ws',
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
    source,
  };

  // 更新缓存
  priceCache.set(tokenId, snapshot);

  // 重连后首个价格：补全断联事件的 price_after / price_delta
  if (pendingReconnectEvents.length > 0 && lastPrice != null) {
    void settleReconnectPrice(tokenId, lastPrice);
  }

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

/**
 * 评估单条规则。
 *
 * 并发安全说明：本函数含 await（读规则、写触发记录），而 WS 消息突发时
 * 同一规则会被并发调用几十次。所有「读取判据 → 决定触发 → 写回判据」的
 * 步骤必须在同一个同步块内完成，不能跨 await，否则并发调用会全部读到
 * 旧的 lastTriggerTime / baselinePrice 而重复触发（实测一秒内产生过 17 条
 * 完全相同的触发记录）。
 *
 * 做法：
 * 1. 规则配置改为进程内缓存，评估路径上不再 await 数据库；
 * 2. 冷却判断 + lastTriggerTime/baselinePrice 写回在 await 之前同步完成；
 * 3. triggerInFlight 作为额外保险，确保同一规则的落库不重入。
 */
async function evaluateRuleForId(ruleId: number, snapshot: PriceSnapshot): Promise<void> {
  const monitor = state.monitors.get(ruleId);
  if (!monitor || !monitor.running) return;

  // 从缓存读规则，避免在评估路径上 await
  const rule = ruleCache.get(ruleId);
  if (!rule) {
    // 缓存缺失（例如刚创建的规则），异步补齐，本次跳过
    void refreshRuleCache(ruleId);
    return;
  }
  if (!rule.enabled) {
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
  monitor.lastError = null;

  // 首次获取价格，设置基准价
  if (monitor.baselinePrice == null) {
    monitor.baselinePrice = currentPrice;
    return;
  }

  // ===== 以下为同步临界区，不得插入 await =====

  // 高波动窗口内抑制 percent_change：断联期间 baselinePrice 已陈旧，
  // 基于它算出的百分比是假信号（断联跨越进球时见过 +111% 的跳变）
  if (
    state.config.suppressVolatilePercentChange &&
    rule.ruleType === 'percent_change' &&
    isVolatileWindow()
  ) {
    // 窗口内持续把基准价推进到最新，窗口结束后从真实价位重新计算
    monitor.baselinePrice = currentPrice;
    monitor.suppressedCount = (monitor.suppressedCount ?? 0) + 1;
    return;
  }

  const evaluation = evaluateRule(rule, monitor.baselinePrice, currentPrice);
  if (!evaluation.triggered || !evaluation.direction) return;

  // 冷却检查与状态写回必须原子完成
  if (monitor.triggerInFlight) return;

  const now = Date.now();
  const lastTriggerMs = monitor.lastTriggerTime ? new Date(monitor.lastTriggerTime).getTime() : 0;
  const cooldownMs = rule.cooldownSeconds * 1000;
  if (now - lastTriggerMs < cooldownMs) return;

  // 抢占：先写回判据，后续并发调用会在上面的冷却检查处被拦下
  monitor.triggerInFlight = true;
  monitor.lastTriggerTime = new Date(now).toISOString();
  monitor.baselinePrice = currentPrice;
  monitor.triggerCount++;

  // ===== 临界区结束，以下可以 await =====

  const triggeredEval = evaluation as RuleEvaluation & { direction: PriceDirection };
  try {
    await handleTrigger(rule, triggeredEval, snapshot);
    console.log(
      `[PriceBot] 规则 #${rule.id} 触发: ${rule.outcome} ${evaluation.direction} ` +
      `${(evaluation.changePercent * 100).toFixed(2)}%, 当前价 $${currentPrice.toFixed(4)}` +
      `${snapshot.source === 'rest' ? ' [REST兜底]' : ''}`,
    );
  } finally {
    monitor.triggerInFlight = false;
  }
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

  // 规则配置写入缓存：评估路径是同步的，不能在那里读数据库
  ruleCache.set(ruleId, rule)

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
  // wantConnection=true：明确要求连接，清除此前 closeWs() 留下的主动关闭意图
  refreshWsSubscription(true)
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
    const cachedRule = ruleCache.get(ruleId)
    recordLog({
      ruleId,
      tokenId: monitor.tokenId,
      eventId: cachedRule?.eventId ?? '',
      outcome: cachedRule?.outcome ?? '',
      action: 'stop',
      price: stopPrice,
      detail: `监控停止, 最后价格: ${stopPrice ?? 'N/A'}`,
    }).catch(() => {})
  }

  ruleCache.delete(ruleId)

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
      ruleCache.set(rule.id, rule)
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
    if (m) {
      m.running = false
      m.triggerInFlight = false
    }
  }
  state.config.enabled = false
  ruleCache.clear()
  closeWs()

  // 重置连接状态，避免下次启动时残留断联标记导致规则被误抑制
  connState.disconnected = false
  connState.disconnectedAt = null
  connState.reconnectAttempts = 0
  connState.volatileUntil = null

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
    connection: {
      connected: connState.connected,
      disconnected: connState.disconnected,
      disconnectedAt: connState.disconnectedAt,
      reconnectAttempts: connState.reconnectAttempts,
      totalDisconnects: connState.totalDisconnects,
      lastDowntimeMs: connState.lastDowntimeMs,
      restFallbackActive: connState.restFallbackActive,
      volatileWindow: isVolatileWindow(),
      volatileUntil: connState.volatileUntil,
    },
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

/** 连接状态快照（断联统计 + 高波动窗口） */
export function getConnectionState() {
  return {
    connected: connState.connected,
    disconnected: connState.disconnected,
    disconnectedAt: connState.disconnectedAt,
    reconnectAttempts: connState.reconnectAttempts,
    totalDisconnects: connState.totalDisconnects,
    lastDowntimeMs: connState.lastDowntimeMs,
    restFallbackActive: connState.restFallbackActive,
    volatileWindow: isVolatileWindow(),
    volatileUntil: connState.volatileUntil,
    subscribedTokens: getActiveTokenIds().length,
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

// ==================== 测试辅助 ====================

/**
 * 注入合成价格，走与 WS 推送完全相同的评估路径。
 *
 * 用于在没有真实 WS 连接的情况下复现消息突发场景，
 * 验证并发触发去重逻辑。仅供测试脚本使用。
 */
export function __injectPriceForTest(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  source: 'ws' | 'rest' = 'ws',
): void {
  updatePriceAndEvaluate(tokenId, bestBid, null, bestAsk, null, source)
}

/** 注册一个内存态监控（不读数据库），供测试使用 */
export function __registerMonitorForTest(
  rule: PriceMonitorRule & { id: number },
  baselinePrice: number | null = null,
): void {
  ruleCache.set(rule.id, rule)
  state.monitors.set(rule.id, {
    ruleId: rule.id,
    tokenId: rule.tokenId,
    running: true,
    lastPollTime: null,
    lastError: null,
    cyclesRun: 0,
    triggerCount: 0,
    baselinePrice,
    lastTriggerTime: null,
    lastPrice: null,
  })
}

/** 读取测试中的监控内部状态 */
export function __getMonitorStateForTest(ruleId: number): PriceMonitorState | undefined {
  return state.monitors.get(ruleId)
}

/** 强制进入/退出高波动窗口，供测试使用 */
export function __setVolatileForTest(disconnected: boolean, volatileMs = 0): void {
  connState.disconnected = disconnected
  connState.volatileUntil = volatileMs > 0 ? Date.now() + volatileMs : null
}

/** 清空测试状态 */
export function __resetForTest(): void {
  state.monitors.clear()
  ruleCache.clear()
  priceCache.clear()
  pendingReconnectEvents.length = 0
  preDisconnectPrices.clear()
  connState.disconnected = false
  connState.volatileUntil = null
  connState.reconnectAttempts = 0
  connState.totalDisconnects = 0
}

// ==================== 规则 CRUD 导出 ====================

/**
 * 规则写操作需要同步失效本地缓存。
 *
 * 评估路径从 ruleCache 同步读取规则（不能 await），
 * 所以规则改动后必须显式更新缓存，否则会继续用旧配置评估。
 */

export async function createRule(
  ...args: Parameters<typeof dbCreateRule>
): Promise<number> {
  const id = await dbCreateRule(...args)
  await refreshRuleCache(id)
  return id
}

export async function updateRule(
  id: number,
  updates: Parameters<typeof dbUpdateRule>[1],
): Promise<boolean> {
  const ok = await dbUpdateRule(id, updates)
  await refreshRuleCache(id)

  // 规则被禁用时同步停掉监控，避免继续占用订阅
  const rule = ruleCache.get(id)
  if (rule && !rule.enabled) {
    const monitor = state.monitors.get(id)
    if (monitor?.running) stopMonitor(id)
  }
  return ok
}

export async function deleteRule(id: number): Promise<boolean> {
  const ok = await dbDeleteRule(id)
  ruleCache.delete(id)
  state.monitors.delete(id)
  return ok
}

export {
  getRule,
  listRules,
  listTriggers,
  listLogs,
  listConnectionEvents,
  getConnectionStats,
}
