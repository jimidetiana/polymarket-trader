import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WebSocketServer, WebSocket } from 'ws';
import { fetchTodaysSoccerEvents, fetchEventMarketsFromGamma } from './fetcher.js';
import { startBot, stopBot, getBotStatus, updateConfig, triggerCycle, getBetRecords, getAllMatchStates, getAvailablePolymarketMatches, setManualInitialOdds, deleteMatchState, getRuleMetas, startMatch, stopMatch, getMatchMonitors, getMatchMonitor, triggerMatchCycle, getCalcLogs, getCalcLogsAnalysis } from '../bots/value-bot/value-bot.js';
import {
  getEventsWithMarkets,
  getAllEvents,
  getUntranslatedEvents,
  batchImportTranslations,
  updateEventTranslation,
  updateMarketTranslation,
  getMarketsForEvent,
  insertOrder,
  getOrders,
  updateOrderStatus,
  pool,
} from './db.js';
import {
  getAllTeams,
  getTeamsByLeague,
  getUntranslatedTeams,
  upsertTeam,
  updateTeam,
  deleteTeam,
  getAllLeagues,
  getUntranslatedLeagues,
  upsertLeague,
  updateLeague,
  deleteLeague,
  batchImportTeams,
  batchImportLeagues,
  syncDictFromEvents,
  applyDictionaryToEvents,
  deduplicateTeams,
  getTeamTranslationMap,
  getLeagueTranslationMap,
} from './dict.js';
import {
  getOrCreateWallet,
  deposit,
  withdraw,
  getWalletTransactions,
  syncOnChainBalance,
  getPolymarketProfile,
} from './wallet.js';
import { placeOrder, cancelOrder, cancelAllOrders, syncOrderStatus, syncSettlements, getOpenOrders } from './trading.js';
import {
  startBot as startPriceBot,
  stopBot as stopPriceBot,
  getBotStatus as getPriceBotStatus,
  updateConfig as updatePriceBotConfig,
  triggerCycle as triggerPriceBotCycle,
  startMonitor,
  startMonitors,
  stopMonitor,
  getMonitorList,
  getMonitor,
  triggerMonitorCycle,
  createRule,
  updateRule,
  deleteRule,
  markRuleSettled,
  getRule,
  listRules,
  listTriggers,
  listLogs,
  listConnectionEvents,
  getConnectionStats,
  listAutoOrders,
  getAutoTradeStatus,
  setRuleAutoTrade,
  setAutoTradeBatch,
  getConnectionState,
  cancelRestingBuyOrders,
  muteSurgeSignals,
} from '../bots/price-bot/price-bot.js';
import { syncRuleOutcomes } from '../bots/price-bot/outcome-sync.js';
import {
  TOTAL_GOAL_LINES,
  FIRST_TOTAL_LINE,
  extractTotalGoalLine,
  matchMinuteFrom,
} from '../bots/price-bot/goal-lines.js';
import { decideNextLineOpening, buyGateReason } from '../bots/price-bot/next-line.js';
import { saveLineSnapshots, getLineSnapshots } from '../bots/price-bot/db.js';
import type { LineSnapshot } from '../bots/price-bot/db.js';
import { fetchRealOrderReport, listRealOrderReportLeagues } from '../bots/price-bot/report.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SOCCER_UI_PORT || 3000);
const FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');
const isDev = process.env.NODE_ENV === 'development';

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const clobClient = axios.create({
  baseURL: CLOB_BASE,
  timeout: 30000,
  ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
});
const gammaAxios = axios.create({
  baseURL: GAMMA_BASE,
  timeout: 15000,
  ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
});

async function gammaGet(path: string): Promise<any> {
  const MAX_RETRIES = 3;
  let lastErr: any;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: false }) : undefined;
      const response = await axios.get(`${GAMMA_BASE}${path}`, {
        timeout: 15000,
        ...(agent ? { httpsAgent: agent } : {}),
      });
      return response.data;
    } catch (err: any) {
      lastErr = err;
      const msg = err.message || '';
      if (/aborted|reset|timeout|econnreset|etimedout/i.test(msg) && i < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
    }
  }
  throw lastErr;
}

async function clobGet(path: string, params?: Record<string, string>): Promise<any> {
  const MAX_RETRIES = 3;
  let lastErr: any;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: false }) : undefined;
      const response = await axios.get(`${CLOB_BASE}${path}`, {
        params,
        timeout: 10000,
        ...(agent ? { httpsAgent: agent } : {}),
      });
      return response.data;
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

function asyncHandler(fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// API routes
app.get('/api/soccer/events', asyncHandler(async (_req, res) => {
  const events = await getEventsWithMarkets();
  res.json({ success: true, count: events.length, events });
}));

app.post('/api/soccer/refresh', asyncHandler(async (_req, res) => {
  const result = await fetchTodaysSoccerEvents();
  res.json({ success: true, message: '刷新完成', events: result.events });
}));

app.get('/api/soccer/orders', asyncHandler(async (_req, res) => {
  const orders = await getOrders();
  res.json({ success: true, orders });
}));

// 诊断：对比链上和本地订单
app.get('/api/soccer/orders/diagnostic', asyncHandler(async (_req, res) => {
  try {
    const { getV2Client, getV2Creds } = await import('../api/clob-v2.js');
    const client = await getV2Client();
    await getV2Creds();

    // 获取链上挂单
    let clobOpenOrders: any[] = [];
    try {
      const resp = await client.getOpenOrders();
      clobOpenOrders = Array.isArray(resp) ? resp : [];
    } catch (e: any) {
      clobOpenOrders = [];
    }

    // 获取链上成交记录
    let clobTrades: any[] = [];
    try {
      let nextCursor: string | undefined = undefined;
      for (let i = 0; i < 5; i++) {
        let resp: any;
        if (nextCursor) {
          resp = await client.getTradesPaginated({}, nextCursor);
        } else {
          resp = await client.getTradesPaginated();
        }
        const trades = resp?.trades || (Array.isArray(resp) ? resp : []);
        if (trades.length) clobTrades.push(...trades);
        nextCursor = resp?.next_cursor || undefined;
        if (!nextCursor || nextCursor === 'LTE=' || nextCursor === '-1') break;
      }
    } catch (e: any) {
      clobTrades = [];
    }

    // 获取本地订单
    const [localOrders] = await pool.execute<any[]>(
      `SELECT id, market_id, token_id, side, size, price, order_status, memo, created_at
       FROM soccer_orders ORDER BY created_at DESC`,
    );

    // 本地 CLOB ID → 本地订单 映射
    const localClobMap = new Map<string, any>();
    for (const o of localOrders) {
      const m = o.memo?.match(/订单ID:\s*(\S+)/);
      if (m) localClobMap.set(m[1], o);
    }

    // 对比分析
    const clobOpenIds = new Set<string>();
    for (const o of clobOpenOrders) {
      const oid = o.id || o.orderID || '';
      if (oid) clobOpenIds.add(oid);
    }

    const clobTradeIds = new Set<string>();
    for (const t of clobTrades) {
      if (t.taker_order_id) clobTradeIds.add(t.taker_order_id);
      if (t.maker_order_id) clobTradeIds.add(t.maker_order_id);
    }

    const localClobIds = new Set(localClobMap.keys());

    // 链上有但本地没有的订单
    const missingLocal = [...clobOpenIds, ...clobTradeIds]
      .filter(id => !localClobIds.has(id))
      .map(id => {
        const openOrder = clobOpenOrders.find(o => (o.id || o.orderID) === id);
        const trade = clobTrades.find(t => t.taker_order_id === id || t.maker_order_id === id);
        return {
          clobOrderId: id,
          inOpenOrders: !!openOrder,
          inTrades: !!trade,
          openOrderDetails: openOrder ? {
            status: openOrder.status,
            side: openOrder.side,
            size: openOrder.original_size,
            matched: openOrder.size_matched,
            price: openOrder.price,
            asset_id: openOrder.asset_id,
          } : null,
          tradeDetails: trade ? {
            side: trade.side,
            size: trade.size,
            price: trade.price,
            asset_id: trade.asset_id,
          } : null,
        };
      });

    // 本地有但链上找不到的订单（排除 cancelled/failed/settled — 这些终态不在链上是正常的）
    const terminalStatuses = new Set(['cancelled', 'failed', 'settled']);
    const missingClob = [...localClobIds]
      .filter(id => !clobOpenIds.has(id) && !clobTradeIds.has(id))
      .map(id => {
        const local = localClobMap.get(id);
        return {
          clobOrderId: id,
          localId: local.id,
          localStatus: local.order_status,
          side: local.side,
          size: local.size,
          price: local.price,
        };
      })
      .filter(item => !terminalStatuses.has(item.localStatus));

    // 状态不一致的订单（排除 settled/failed — settled 是 filled 之后的正确终态）
    const statusMismatch: any[] = [];
    for (const [clobId, local] of localClobMap) {
      if (local.order_status === 'settled' || local.order_status === 'failed') continue;

      const openOrder = clobOpenOrders.find(o => (o.id || o.orderID) === clobId);
      const trades = clobTrades.filter(t => t.taker_order_id === clobId || t.maker_order_id === clobId);

      if (openOrder) {
        const clobStatus = openOrder.status;
        const matched = Number(openOrder.size_matched || 0);
        const original = Number(openOrder.original_size || 0);
        let expectedStatus = local.order_status;
        if (matched >= original && original > 0) expectedStatus = 'filled';
        else if (matched > 0) expectedStatus = 'partial';
        else expectedStatus = 'open';

        if (expectedStatus !== local.order_status) {
          statusMismatch.push({
            clobOrderId: clobId,
            localId: local.id,
            localStatus: local.order_status,
            expectedStatus,
            clobStatus,
            sizeMatched: openOrder.size_matched,
            originalSize: openOrder.original_size,
          });
        }
      } else if (trades.length > 0) {
        const totalMatched = trades.reduce((sum, t) => sum + Number(t.size || 0), 0);
        const expectedStatus = totalMatched >= Number(local.size) ? 'filled' : 'partial';
        if (expectedStatus !== local.order_status) {
          statusMismatch.push({
            clobOrderId: clobId,
            localId: local.id,
            localStatus: local.order_status,
            expectedStatus,
            tradeSize: totalMatched,
            localSize: local.size,
          });
        }
      }
    }

    res.json({
      success: true,
      summary: {
        clobOpenCount: clobOpenOrders.length,
        clobTradeCount: clobTrades.length,
        localCount: localOrders.length,
        localWithClobId: localClobIds.size,
        missingLocal: missingLocal.length,
        missingClob: missingClob.length,
        statusMismatch: statusMismatch.length,
      },
      missingLocal,
      missingClob,
      statusMismatch,
      rawTrades: clobTrades,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '诊断失败' });
  }
}));

app.post('/api/soccer/orders', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const marketId = String(body.market_id ?? body.marketId ?? '');
  const tokenId = String(body.token_id ?? body.tokenId ?? '');
  const side = String(body.side ?? '').toUpperCase() as 'BUY' | 'SELL';
  const size = Number(body.size ?? 0);
  const price = Number(body.price ?? 0);
  const type = (body.type === 'market' ? 'market' : 'limit') as 'limit' | 'market';

  if (!marketId || !tokenId || !['BUY', 'SELL'].includes(side) || !size || !price) {
    res.status(400).json({ success: false, error: '缺少必要参数：market_id/token_id/side/size/price' });
    return;
  }

  const result = await placeOrder({
    market_id: marketId,
    token_id: tokenId,
    side,
    size,
    price,
    type,
  });

  if (!result.success) {
    res.status(400).json({ success: false, error: result.message, orderId: result.orderId });
    return;
  }

  res.json({
    success: true,
    orderId: result.orderId,
    clobOrderId: result.clobOrderId,
    message: result.message,
    simulated: result.simulated,
  });
}));

app.post('/api/soccer/orders/:id/cancel', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ success: false, error: '无效的订单 ID' });
    return;
  }
  const result = await cancelOrder(id);
  if (!result.success) {
    res.status(400).json({ success: false, error: result.message });
    return;
  }
  res.json({ success: true, message: result.message });
}));

/**
 * 挂单对账：把「本地以为挂着的」和「交易所真的挂着的」摆在一起。
 *
 * 为什么需要这个：本地 order_status 是 syncOrderStatus 维护的，而它在
 * 「不在 open 列表 + 无成交记录 + getOrder 查不到」时会原样保留旧状态
 * （trading.ts:606-626），于是一笔已经从交易所消失的单子会永远卡在 open。
 * 这种残留在订单列表里和真挂单长得一模一样，点「取消」还会失败——
 * 交易所根本不认识它。必须先分清，才谈得上处理。
 *
 * 三类：
 *   live    本地有 + 交易所有 → 真挂单，可正常撤
 *   stale   本地有 + 交易所无 → 残留记录，只能本地消除
 *   orphan  交易所有 + 本地无 → 没登记的挂单，有真实敞口，要能撤
 */
app.get('/api/soccer/orders/reconcile', asyncHandler(async (_req, res) => {
  const [localRows] = await pool.execute<any[]>(
    `SELECT o.id, o.market_id, o.token_id, o.side, o.size, o.price,
            o.order_status, o.memo, o.created_at,
            m.question_zh, m.event_id, e.title_zh
       FROM soccer_orders o
       LEFT JOIN soccer_markets m ON m.id = o.market_id
       LEFT JOIN soccer_events e ON e.id = m.event_id
      WHERE o.order_status IN ('open', 'pending')
      ORDER BY o.id DESC`,
  );

  // 交易所侧。拿不到就不猜：exchangeReachable=false 时前端不显示「残留」判定，
  // 否则一次网络抖动会把所有真挂单标成残留，诱导用户把有敞口的单子消掉。
  let exchangeOrders: any[] = [];
  let exchangeReachable = true;
  try {
    const raw = await getOpenOrders();
    exchangeOrders = Array.isArray(raw) ? raw : [];
  } catch {
    exchangeReachable = false;
  }

  const exchangeIds = new Set<string>();
  for (const o of exchangeOrders) {
    const oid = o?.id || o?.orderID || o?.order_id;
    if (oid) exchangeIds.add(String(oid));
  }

  // clob id 存在 memo 里（口径同 trading.ts:558）
  const clobIdOf = (memo: string | null): string | null =>
    memo?.match(/订单ID:\s*(\S+)/)?.[1] ?? null;

  const matchedClobIds = new Set<string>();
  const items = localRows.map((r) => {
    const clobOrderId = clobIdOf(r.memo);
    if (clobOrderId) matchedClobIds.add(clobOrderId);
    // 没有 clob id 说明这笔从没真正上链（模拟单 / 下单即失败），必然是残留
    const onExchange = clobOrderId != null && exchangeIds.has(clobOrderId);
    return {
      id: r.id,
      clobOrderId,
      marketId: r.market_id,
      eventId: r.event_id ?? null,
      tokenId: r.token_id,
      side: r.side,
      size: Number(r.size),
      price: Number(r.price),
      status: r.order_status,
      createdAt: r.created_at,
      questionZh: r.question_zh ?? null,
      titleZh: r.title_zh ?? null,
      // 交易所不可达时一律按 unknown，不做残留判定
      kind: !exchangeReachable ? 'unknown' : onExchange ? 'live' : 'stale',
    };
  });

  const orphans = exchangeOrders
    .filter((o) => {
      const oid = String(o?.id || o?.orderID || o?.order_id || '');
      return oid && !matchedClobIds.has(oid);
    })
    .map((o) => ({
      clobOrderId: String(o?.id || o?.orderID || o?.order_id),
      tokenId: o?.asset_id ?? o?.token_id ?? null,
      side: o?.side ?? null,
      price: o?.price != null ? Number(o.price) : null,
      size: o?.original_size != null ? Number(o.original_size) : null,
      sizeMatched: o?.size_matched != null ? Number(o.size_matched) : null,
    }));

  res.json({
    success: true,
    exchangeReachable,
    exchangeCount: exchangeOrders.length,
    items,
    orphans,
    counts: {
      live: items.filter((i) => i.kind === 'live').length,
      stale: items.filter((i) => i.kind === 'stale').length,
      unknown: items.filter((i) => i.kind === 'unknown').length,
      orphan: orphans.length,
    },
  });
}));

/**
 * 手动消除残留记录：只改本地状态，不碰交易所。
 *
 * 和 /cancel 的区别：/cancel 会向交易所发撤单请求，对残留记录必然失败
 * （交易所不认识这个 id），失败后本地状态也就一直留在 open。这个接口是
 * 给「交易所已经没有、本地还挂着」的记录收尾用的。
 *
 * 落到 cancelled 而不是删除记录：cancelled 是有语义的终态（一份没成交），
 * 下单配额的统计正是按它排除的（price-bot/db.ts getAutoOrderCounts），
 * 删掉行反而会让历史对不上账。
 *
 * 安全约束：先自己查一遍交易所，确认这笔真的不在挂单列表里才动手。
 * 只信前端传来的判定，等于把「撤掉有敞口的真挂单」的风险交给界面状态。
 */
app.post('/api/soccer/orders/:id/force-close', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ success: false, error: '无效的订单 ID' });
    return;
  }

  const [rows] = await pool.execute<any[]>(
    `SELECT id, order_status, memo FROM soccer_orders WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) {
    res.status(404).json({ success: false, error: '订单不存在' });
    return;
  }
  const order = rows[0];
  if (order.order_status !== 'open' && order.order_status !== 'pending') {
    res.status(400).json({
      success: false,
      error: `只能消除 open/pending 的残留记录，当前状态：${order.order_status}`,
    });
    return;
  }

  const clobOrderId = order.memo?.match(/订单ID:\s*(\S+)/)?.[1] ?? null;
  if (clobOrderId) {
    // 有 clob id 就必须验证。交易所不可达时拒绝操作——
    // 「查不到」不等于「不存在」，宁可让用户稍后重试。
    let exchangeOrders: any[];
    try {
      const raw = await getOpenOrders();
      exchangeOrders = Array.isArray(raw) ? raw : [];
    } catch (err: any) {
      res.status(503).json({
        success: false,
        error: `无法确认交易所挂单状态，已中止：${err?.message ?? err}`,
      });
      return;
    }
    const stillOpen = exchangeOrders.some((o) => {
      const oid = String(o?.id || o?.orderID || o?.order_id || '');
      return oid === clobOrderId;
    });
    if (stillOpen) {
      res.status(409).json({
        success: false,
        error: '这笔挂单在交易所仍然存在，不是残留记录。请用「取消」走正常撤单。',
      });
      return;
    }
  }

  await updateOrderStatus(id, 'cancelled', '手动消除残留记录（交易所已无此单）');
  res.json({ success: true, message: `订单 #${id} 的残留记录已消除` });
}));

app.delete('/api/soccer/orders/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json('无效的订单 ID');
    return;
  }
  const [result] = await pool.query('DELETE FROM soccer_orders WHERE id = ?', [id]);
  if ((result as any).affectedRows === 0) {
    res.status(404).json('订单不存在');
    return;
  }
  res.json('订单已删除');
}));

app.post('/api/soccer/orders/cancel-all', asyncHandler(async (_req, res) => {
  const result = await cancelAllOrders();
  if (!result.success) {
    res.status(400).json({ success: false, error: result.message });
    return;
  }
  res.json({ success: true, message: result.message, count: result.count });
}));

// 从 Polymarket 平台同步订单状态
app.post('/api/soccer/orders/sync', asyncHandler(async (_req, res) => {
  const result = await syncOrderStatus();
  if (!result.success) {
    res.status(400).json({ success: false, error: result.message });
    return;
  }
  res.json({
    success: true,
    message: result.message,
    total: result.total,
    matched: result.matched,
    updated: result.updated,
    imported: result.imported,
    unverified: result.unverified,
    openOrdersRead: result.openOrdersRead,
    tradesRead: result.tradesRead,
    tradesTruncated: result.tradesTruncated,
    openOrdersError: result.openOrdersError,
    tradesError: result.tradesError,
    details: result.details,
  });
}));

app.post('/api/soccer/orders/sync-settlements', asyncHandler(async (_req, res) => {
  const result = await syncSettlements();
  if (!result.success) {
    res.status(400).json({ success: false, error: result.message });
    return;
  }
  res.json({
    success: true,
    message: result.message,
    settledCount: result.settledCount,
    details: result.details,
  });
}));

// ---- Positions APIs ----

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try { return JSON.parse(val) as string[]; } catch { return val.split(',').map(s => s.trim()).filter(Boolean); }
  }
  return [];
}

/**
 * 抓一场比赛的初盘大小球梯度。
 *
 * 只在赛前调用。soccer_markets.outcome_prices 是实时价，进球后会被覆盖，
 * 所以「开哨时这档多少钱」必须在开哨前另存一份（见 price_bot_line_snapshots）。
 * 写入是 INSERT IGNORE，首次写入即定稿，重复调用不会污染。
 */
async function captureLineSnapshots(eventId: string, markets: any[]): Promise<number> {
  const rows: LineSnapshot[] = [];
  for (const m of markets) {
    if (String(m.market_type) !== 'total') continue;
    const line = extractTotalGoalLine(m);
    if (line == null) continue;

    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcome_prices);
    const idx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === 'over');
    const overPrice = idx >= 0 && prices[idx] != null ? Number(prices[idx]) : null;

    rows.push({
      eventId,
      marketId: String(m.id),
      line,
      overPrice: overPrice != null && Number.isFinite(overPrice) ? overPrice : null,
      // 盘口行上的 best_bid/best_ask 也是实时列，但赛前它们就等于初盘
      bestBid: m.best_bid != null ? Number(m.best_bid) : null,
      bestAsk: m.best_ask != null ? Number(m.best_ask) : null,
    });
  }
  if (rows.length === 0) return 0;
  return await saveLineSnapshots(rows);
}

app.get('/api/soccer/positions', asyncHandler(async (_req, res) => {
  // 包含所有已成交/部分成交/已结算的订单
  const [orders] = await pool.execute<any[]>(
    `SELECT o.id, o.market_id, o.token_id, o.side, o.size, o.price, o.order_status, o.created_at, o.memo,
            m.question_zh, m.question_en, m.outcomes, m.clob_token_ids, m.market_type, m.line,
            e.title_zh, e.home_team_zh, e.away_team_zh
     FROM soccer_orders o
     JOIN soccer_markets m ON m.id = o.market_id
     JOIN soccer_events e ON e.id = m.event_id
     WHERE o.order_status IN ('filled', 'partial', 'partial_cancelled', 'settled')
     ORDER BY o.created_at ASC`,
  );

  const posMap = new Map<string, any>();

  for (const o of orders) {
    const tid = String(o.token_id);
    if (!posMap.has(tid)) {
      const tokenIds = parseJsonArray(o.clob_token_ids);
      const outcomes = parseJsonArray(o.outcomes);
      const idx = tokenIds.findIndex(t => String(t) === tid);
      const outcomeName = idx >= 0 ? outcomes[idx] : 'Unknown';

      // 检查 memo 中是否包含结算信息
      const settledWin = o.memo?.includes('结算: 赢');
      const settledLoss = o.memo?.includes('结算: 输');

      posMap.set(tid, {
        token_id: tid,
        market_id: String(o.market_id),
        question_zh: o.question_zh || o.question_en,
        event_title: o.title_zh,
        outcome_name: outcomeName,
        market_type: o.market_type,
        line: o.line,
        total_bought: 0,
        total_sold: 0,
        total_cost: 0,
        total_income: 0,
        buy_count: 0,
        sell_count: 0,
        first_buy_at: null,
        last_order_at: null,
        all_settled: o.order_status === 'settled',
        settled_won: settledWin || false,
        settled_lost: settledLoss || false,
        clob_token_ids: tokenIds,
        outcome_idx: idx,
      });
    }

    const pos = posMap.get(tid)!;
    pos.all_settled = pos.all_settled && o.order_status === 'settled';
    const size = Number(o.size);
    const price = Number(o.price);

    if (o.side === 'BUY') {
      pos.total_bought += size;
      pos.total_cost += size * price;
      pos.buy_count++;
      if (!pos.first_buy_at || o.created_at < pos.first_buy_at) pos.first_buy_at = o.created_at;
    } else {
      pos.total_sold += size;
      pos.total_income += size * price;
      pos.sell_count++;
    }
    if (!pos.last_order_at || o.created_at > pos.last_order_at) pos.last_order_at = o.created_at;
  }

  const positions: any[] = [];
  for (const pos of posMap.values()) {
    pos.net_size = Number((pos.total_bought - pos.total_sold).toFixed(4));
    pos.avg_buy_price = pos.total_bought > 0 ? Number((pos.total_cost / pos.total_bought).toFixed(4)) : 0;
    pos.net_cost = Number((pos.total_cost - pos.total_income).toFixed(2));
    pos.is_settled = pos.all_settled;
    if (pos.net_size > 0) positions.push(pos);
  }

  // 批量查询 gamma API 获取市场价格和结算状态
  const marketIds = [...new Set(positions.map(p => p.market_id))];
  const marketResolutionMap = new Map<string, { closed: boolean; outcomePrices: number[] }>();

  // 逐个查询（gamma API /markets?ids= 不支持批量过滤）
  for (const mid of marketIds) {
    try {
      const m = await gammaGet(`/markets/${mid}`);
      if (!m) continue;
      const closed = m.closed === true;
      let prices: number[] = [];
      try {
        const raw = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (Array.isArray(raw)) prices = raw.map((p: any) => Number(p));
      } catch {}
      marketResolutionMap.set(mid, { closed, outcomePrices: prices });
    } catch (err: any) {
      console.log(`[Positions] gamma API 查询市场 ${mid} 失败:`, err.message || err);
    }
  }

  // 获取每个持仓的当前价格
  for (const pos of positions) {
    const resolution = marketResolutionMap.get(pos.market_id);

    // 优先级1: 本地已结算的订单，直接用结算结果
    if (pos.is_settled) {
      const finalPrice = pos.settled_won ? 1 : 0;
      pos.current_bid = finalPrice;
      pos.current_ask = finalPrice;
      pos.current_bid_size = 0;
      pos.current_ask_size = 0;
      pos.is_closed = true;
    }
    // 优先级2: gamma API 有该市场的价格数据
    else if (resolution && resolution.outcomePrices.length > 0) {
      const gammaPrice = pos.outcome_idx >= 0 ? (resolution.outcomePrices[pos.outcome_idx] ?? 0) : 0;
      pos.current_bid = gammaPrice;
      pos.current_ask = gammaPrice;
      pos.current_bid_size = 0;
      pos.current_ask_size = 0;
      pos.is_closed = resolution.closed;

      // 对于开放市场，补充 CLOB 订单簿深度（供卖出参考）
      if (!resolution.closed) {
        try {
          const book = await clobGet('/book', { token_id: pos.token_id });
          const bids = Array.isArray(book?.bids) ? book.bids : [];
          const asks = Array.isArray(book?.asks) ? book.asks : [];
          pos.current_bid_size = bids.length > 0 ? Number(bids[0].size) : 0;
          pos.current_ask_size = asks.length > 0 ? Number(asks[0].size) : 0;
          // 如果 gamma 价格为 0 但 CLOB 有买价，用 CLOB 买价作为参考
          if (gammaPrice === 0 && bids.length > 0) {
            pos.current_bid = Number(bids[0].price);
          }
        } catch {}
      }
    }
    // 优先级3: gamma API 无数据，查 CLOB 订单簿
    else {
      try {
        const book = await clobGet('/book', { token_id: pos.token_id });
        const bids = Array.isArray(book?.bids) ? book.bids : [];
        const asks = Array.isArray(book?.asks) ? book.asks : [];
        pos.current_bid = bids.length > 0 ? Number(bids[0].price) : 0;
        pos.current_bid_size = bids.length > 0 ? Number(bids[0].size) : 0;
        pos.current_ask = asks.length > 0 ? Number(asks[0].price) : 0;
        pos.current_ask_size = asks.length > 0 ? Number(asks[0].size) : 0;
      } catch {
        pos.current_bid = 0; pos.current_ask = 0;
      }
      pos.is_closed = false;
    }

    pos.unrealized_pnl = Number(((pos.current_bid - pos.avg_buy_price) * pos.net_size).toFixed(2));
    pos.estimated_value = Number((pos.current_bid * pos.net_size).toFixed(2));
  }

  // 过滤掉已结算或市场已关闭的持仓，它们不再属于活跃持仓管理
  const activePositions = positions.filter(p => !p.is_settled && !p.is_closed);
  res.json({ success: true, positions: activePositions });
}));

app.post('/api/soccer/positions/:tokenId/sell', asyncHandler(async (req, res) => {
  const tokenId = String(req.params.tokenId);
  const body = req.body as Record<string, unknown>;
  const size = Number(body.size ?? 0);
  const price = Number(body.price ?? 0);

  if (!size || size <= 0 || !price || price <= 0) {
    res.status(400).json({ success: false, error: '无效的数量或价格' });
    return;
  }

  const [rows] = await pool.execute<any[]>(
    'SELECT market_id FROM soccer_orders WHERE token_id = ? AND order_status IN ("filled","partial") LIMIT 1',
    [tokenId],
  );
  if (!rows.length) {
    res.status(404).json({ success: false, error: '未找到该代币的持仓记录' });
    return;
  }

  const result = await placeOrder({
    market_id: String(rows[0].market_id),
    token_id: tokenId,
    side: 'SELL',
    size,
    price,
    type: body.type === 'limit' ? 'limit' : 'market',
  });

  if (!result.success) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
}));

// ---- Wallet APIs ----

const defaultWalletAddress = config.walletAddress || '0x0000000000000000000000000000000000000000';

app.get('/api/soccer/wallet', asyncHandler(async (_req, res) => {
  const wallet = await getOrCreateWallet(defaultWalletAddress);
  
  // Trigger async chain balance sync in background (don't block response)
  syncOnChainBalance(defaultWalletAddress).catch((err) => {
    console.warn('[Wallet] 后台余额同步失败:', err.message?.slice(0, 100));
  });
  
  res.json({
    success: true,
    wallet: {
      address: wallet.wallet_address,
      balance_usdc: parseFloat(wallet.balance_usdc),
      total_deposited: parseFloat(wallet.total_deposited),
      total_withdrawn: parseFloat(wallet.total_withdrawn),
      total_pnl: parseFloat(wallet.total_pnl),
      chain_balance: wallet.chain_balance ? parseFloat(wallet.chain_balance) : null,
      last_sync_at: wallet.last_sync_at,
    },
    balances: [], // Chain balances are loaded separately for performance
  });
}));

// New endpoint for chain balances (separate from wallet info for faster loading)
app.get('/api/soccer/wallet/balances', asyncHandler(async (_req, res) => {
  try {
    const syncResult = await syncOnChainBalance(defaultWalletAddress);
    res.json({
      success: true,
      balances: syncResult.details || [],
    });
  } catch (err: any) {
    res.json({
      success: false,
      error: err.message,
      balances: [],
    });
  }
}));

app.get('/api/soccer/profile', asyncHandler(async (_req, res) => {
  const profile = await getPolymarketProfile();
  res.json({
    success: true,
    profile,
  });
}));

app.post('/api/soccer/wallet/deposit', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const amount = Number(body.amount ?? 0);
  const description = body.description ? String(body.description) : undefined;

  if (!amount || amount <= 0) {
    res.status(400).json({ success: false, error: '充值金额必须大于 0' });
    return;
  }

  const wallet = await deposit(defaultWalletAddress, amount, description);
  res.json({
    success: true,
    message: `充值成功：$${amount.toFixed(2)}`,
    wallet: {
      address: wallet.wallet_address,
      balance_usdc: parseFloat(wallet.balance_usdc),
    },
  });
}));

app.post('/api/soccer/wallet/withdraw', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const amount = Number(body.amount ?? 0);
  const description = body.description ? String(body.description) : undefined;

  if (!amount || amount <= 0) {
    res.status(400).json({ success: false, error: '提现金额必须大于 0' });
    return;
  }

  try {
    const wallet = await withdraw(defaultWalletAddress, amount, description);
    res.json({
      success: true,
      message: `提现成功：$${amount.toFixed(2)}`,
      wallet: {
        address: wallet.wallet_address,
        balance_usdc: parseFloat(wallet.balance_usdc),
      },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
}));

app.post('/api/soccer/wallet/sync', asyncHandler(async (_req, res) => {
  const result = await syncOnChainBalance(defaultWalletAddress);
  const wallet = await getOrCreateWallet(defaultWalletAddress);
  res.json({
    success: true,
    message: `链上余额同步完成`,
    wallet: {
      address: wallet.wallet_address,
      balance_usdc: parseFloat(wallet.balance_usdc),
      chain_balance: wallet.chain_balance ? parseFloat(wallet.chain_balance) : null,
      last_sync_at: wallet.last_sync_at,
    },
  });
}));

app.get('/api/soccer/wallet/transactions', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Number(req.query.offset || 0);
  const txType = req.query.tx_type as string | undefined;

  const result = await getWalletTransactions(defaultWalletAddress, { limit, offset, txType });
  res.json({
    success: true,
    total: result.total,
    transactions: result.list.map((tx) => ({
      id: tx.id,
      tx_type: tx.tx_type,
      amount: parseFloat(tx.amount),
      balance_after: tx.balance_after ? parseFloat(tx.balance_after) : null,
      order_id: tx.order_id,
      description: tx.description,
      status: tx.status,
      created_at: tx.created_at,
    })),
  });
}));

app.get('/api/soccer/translations', asyncHandler(async (_req, res) => {
  const events = await getAllEvents();
  res.json({ success: true, count: events.length, events });
}));

app.post('/api/soccer/translations', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const id = String(body.id ?? '');
  if (!id) {
    res.status(400).json({ success: false, error: '缺少 id' });
    return;
  }
  await updateEventTranslation({
    id,
    title_zh: body.title_zh ? String(body.title_zh) : undefined,
    home_team_zh: body.home_team_zh ? String(body.home_team_zh) : undefined,
    away_team_zh: body.away_team_zh ? String(body.away_team_zh) : undefined,
    league: body.league ? String(body.league) : undefined,
  });
  res.json({ success: true, message: '比赛信息已保存' });
}));

app.get('/api/soccer/untranslated', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const events = await getUntranslatedEvents(limit);
  res.json({ success: true, count: events.length, events });
}));

app.post('/api/soccer/translations/import', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) {
    res.status(400).json({ success: false, error: '缺少 events 数组' });
    return;
  }
  await batchImportTranslations(events as Parameters<typeof batchImportTranslations>[0]);
  res.json({ success: true, message: `已导入 ${events.length} 条比赛翻译` });
}));

app.get('/api/soccer/events/:id/markets', asyncHandler(async (req, res) => {
  const eventId = req.params.id;
  // Load persisted merged markets first (fast), fallback to Gamma API if none.
  let markets = await getMarketsForEvent(eventId);
  if (!markets.length) {
    markets = await fetchEventMarketsFromGamma(eventId);
  }
  res.json({ success: true, markets });
}));

app.get('/api/soccer/orderbook/:tokenId', asyncHandler(async (req, res) => {
  const tokenId = req.params.tokenId;
  try {
    const book = await clobGet('/book', { token_id: tokenId });
    res.json({ success: true, book });
  } catch (err: any) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error || err.message || '获取盘口深度失败';
    res.status(status).json({ success: false, error: message });
  }
}));

app.post('/api/soccer/markets/:id', asyncHandler(async (req, res) => {
  const marketId = req.params.id;
  const body = req.body as Record<string, unknown>;
  await updateMarketTranslation({
    id: marketId,
    question_zh: body.question_zh ? String(body.question_zh) : undefined,
    outcomes_zh: Array.isArray(body.outcomes_zh) ? body.outcomes_zh.map((o) => String(o)) : undefined,
  });
  res.json({ success: true, message: '盘口信息已保存' });
}));

// ---- Dictionary APIs: teams & leagues ----

app.get('/api/soccer/dict/teams', asyncHandler(async (req, res) => {
  const league = req.query.league as string | undefined;
  const teams = league ? await getTeamsByLeague(league) : await getAllTeams();
  res.json({ success: true, count: teams.length, teams });
}));

app.get('/api/soccer/dict/teams/untranslated', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const teams = await getUntranslatedTeams(limit);
  res.json({ success: true, count: teams.length, teams });
}));

app.post('/api/soccer/dict/teams', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const nameEn = String(body.name_en || '').trim();
  const nameZh = body.name_zh ? String(body.name_zh).trim() : null;
  const league = body.league ? String(body.league).trim() : null;
  if (!nameEn) {
    res.status(400).json({ success: false, error: '缺少 name_en' });
    return;
  }
  await upsertTeam(nameEn, nameZh, league);
  res.json({ success: true, message: '球队已保存' });
}));

app.put('/api/soccer/dict/teams/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!id) {
    res.status(400).json({ success: false, error: '无效的 id' });
    return;
  }
  await updateTeam(id, {
    name_zh: body.name_zh !== undefined ? String(body.name_zh) : undefined,
    league: body.league !== undefined ? String(body.league) : undefined,
  });
  res.json({ success: true, message: '球队已更新' });
}));

app.delete('/api/soccer/dict/teams/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ success: false, error: '无效的 id' });
    return;
  }
  await deleteTeam(id);
  res.json({ success: true, message: '球队已删除' });
}));

app.get('/api/soccer/dict/leagues', asyncHandler(async (_req, res) => {
  const leagues = await getAllLeagues();
  res.json({ success: true, count: leagues.length, leagues });
}));

app.get('/api/soccer/dict/leagues/untranslated', asyncHandler(async (_req, res) => {
  const leagues = await getUntranslatedLeagues();
  res.json({ success: true, count: leagues.length, leagues });
}));

app.post('/api/soccer/dict/leagues', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const nameEn = String(body.name_en || '').trim();
  const nameZh = body.name_zh ? String(body.name_zh).trim() : null;
  if (!nameEn) {
    res.status(400).json({ success: false, error: '缺少 name_en' });
    return;
  }
  await upsertLeague(nameEn, nameZh);
  res.json({ success: true, message: '联赛已保存' });
}));

app.put('/api/soccer/dict/leagues/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!id) {
    res.status(400).json({ success: false, error: '无效的 id' });
    return;
  }
  await updateLeague(id, body.name_zh ? String(body.name_zh) : '');
  res.json({ success: true, message: '联赛已更新' });
}));

app.delete('/api/soccer/dict/leagues/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ success: false, error: '无效的 id' });
    return;
  }
  await deleteLeague(id);
  res.json({ success: true, message: '联赛已删除' });
}));

app.post('/api/soccer/dict/sync', asyncHandler(async (_req, res) => {
  const result = await syncDictFromEvents();
  res.json({ success: true, ...result, message: `同步完成：新增 ${result.teams} 支球队，${result.leagues} 个联赛` });
}));

app.post('/api/soccer/dict/apply-translations', asyncHandler(async (_req, res) => {
  const result = await applyDictionaryToEvents();
  res.json({ success: true, ...result, message: `翻译已应用：更新 ${result.events} 场比赛` });
}));

app.post('/api/soccer/dict/deduplicate', asyncHandler(async (_req, res) => {
  const result = await deduplicateTeams();
  res.json({ success: true, ...result, message: `去重完成：合并 ${result.merged} 个重复球队，剩余 ${result.total} 支` });
}));

app.post('/api/soccer/dict/import', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const teams = Array.isArray(body.teams) ? body.teams : [];
  const leagues = Array.isArray(body.leagues) ? body.leagues : [];

  let teamCount = 0;
  let leagueCount = 0;

  if (teams.length) {
    teamCount = await batchImportTeams(teams as Array<{ name_en: string; name_zh?: string; league?: string }>);
  }
  if (leagues.length) {
    leagueCount = await batchImportLeagues(leagues as Array<{ name_en: string; name_zh?: string }>);
  }

  res.json({
    success: true,
    message: `导入完成：${teamCount} 支球队，${leagueCount} 个联赛`,
    teams: teamCount,
    leagues: leagueCount,
  });
}));

app.get('/api/soccer/dict/stats', asyncHandler(async (_req, res) => {
  const [teamMap, leagueMap] = await Promise.all([
    getTeamTranslationMap(),
    getLeagueTranslationMap(),
  ]);
  const allTeams = await getAllTeams();
  const allLeagues = await getAllLeagues();
  const translatedTeams = Object.keys(teamMap).length;
  const translatedLeagues = Object.keys(leagueMap).length;

  res.json({
    success: true,
    teams: {
      total: allTeams.length,
      translated: translatedTeams,
      untranslated: allTeams.length - translatedTeams,
    },
    leagues: {
      total: allLeagues.length,
      translated: translatedLeagues,
      untranslated: allLeagues.length - translatedLeagues,
    },
  });
}));

// ---- Sports data API (bzzoiro) ----
const SPORTS_API_BASE = process.env.SPORTS_API_BASE || 'https://sports.bzzoiro.com/api/v2';
const SPORTS_API_TOKEN = process.env.SPORTS_API_TOKEN || '';

const sportsClient = axios.create({
  baseURL: SPORTS_API_BASE,
  timeout: 30000,
  headers: SPORTS_API_TOKEN ? { Authorization: `Token ${SPORTS_API_TOKEN}` } : {},
  ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
});

async function sportsGet(path: string, params?: Record<string, any>): Promise<any> {
  const MAX_RETRIES = 2;
  let lastErr: any;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await sportsClient.get(path, { params });
      return response.data;
    } catch (err: any) {
      lastErr = err;
      if (err.response?.status === 401 || err.response?.status === 403) break;
    }
  }
  throw lastErr;
}

app.get('/api/sports/live', asyncHandler(async (_req, res) => {
  const data = await sportsGet('/events/live/');
  res.json({ success: true, count: data.count || 0, events: data.events || [] });
}));

app.get('/api/sports/events', asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0, date_from, date_to } = req.query;
  const params: Record<string, any> = { limit, offset };
  if (status) params.status = status;
  if (date_from) params.date_from = date_from;
  if (date_to) params.date_to = date_to;
  const data = await sportsGet('/events/', params);
  res.json({ success: true, count: data.count || 0, events: data.results || data.events || [] });
}));

app.get('/api/sports/events/:id', asyncHandler(async (req, res) => {
  const data = await sportsGet(`/events/${req.params.id}/`);
  res.json({ success: true, event: data });
}));

app.get('/api/sports/events/:id/stats', asyncHandler(async (req, res) => {
  const data = await sportsGet(`/events/${req.params.id}/stats/`);
  res.json({ success: true, stats: data });
}));

app.get('/api/sports/events/:id/incidents', asyncHandler(async (req, res) => {
  const data = await sportsGet(`/events/${req.params.id}/incidents/`);
  res.json({ success: true, incidents: data });
}));

app.get('/api/sports/events/:id/lineups', asyncHandler(async (req, res) => {
  const data = await sportsGet(`/events/${req.params.id}/lineups/`);
  res.json({ success: true, lineups: data });
}));

// Leagues endpoint
app.get('/api/sports/leagues', asyncHandler(async (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  const params: Record<string, any> = { limit, offset };
  const data = await sportsGet('/leagues/', params);
  const results = data.results || data.leagues || [];
  res.json({ success: true, count: data.count || results.length, leagues: results });
}));

// Translation dictionary for teams and leagues (from DB, shared with soccer module)
app.get('/api/sports/translations', asyncHandler(async (_req, res) => {
  const [teams, leagues] = await Promise.all([
    getTeamTranslationMap(),
    getLeagueTranslationMap(),
  ]);
  res.json({ success: true, teams, leagues });
}));

// ===== Value Bet Bot API =====

app.get('/api/bots/value-bet/status', (_req, res) => {
  res.json({ success: true, ...getBotStatus() });
});

app.post('/api/bots/value-bet/start', asyncHandler(async (req, res) => {
  const config = req.body?.config;
  await startBot(config);
  res.json({ success: true, ...getBotStatus() });
}));

app.post('/api/bots/value-bet/stop', (_req, res) => {
  stopBot();
  res.json({ success: true, ...getBotStatus() });
});

app.post('/api/bots/value-bet/config', asyncHandler(async (req, res) => {
  const config = updateConfig(req.body || {});
  res.json({ success: true, config });
}));

app.post('/api/bots/value-bet/trigger', asyncHandler(async (_req, res) => {
  await triggerCycle();
  res.json({ success: true, ...getBotStatus() });
}));

app.get('/api/bots/value-bet/records', asyncHandler(async (req, res) => {
  const { limit, offset, botId, eventId, recommendation, minEdge, orderBy } = req.query;
  const result = await getBetRecords({
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
    botId: botId as string | undefined,
    eventId: eventId as string | undefined,
    recommendation: recommendation as string | undefined,
    minEdge: minEdge ? Number(minEdge) : undefined,
    orderBy: orderBy as string | undefined,
  });
  res.json({ success: true, ...result });
}));

// 比赛配置 API
app.get('/api/bots/value-bet/matches', asyncHandler(async (_req, res) => {
  const matches = await getAllMatchStates();
  res.json({ success: true, matches });
}));

app.post('/api/bots/value-bet/matches/:eventId/initial-odds', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { homeTeam, awayTeam, homeProb, drawProb, awayProb, bzzoiroEventId, bzzoiroHomeTeam, bzzoiroAwayTeam, biasDirection, biasCoefficient, handicapTeam, handicapValue } = req.body;
  if (homeProb === undefined || drawProb === undefined || awayProb === undefined) {
    res.status(400).json({ success: false, error: '缺少概率参数' });
    return;
  }
  const result = await setManualInitialOdds(
    eventId,
    homeTeam || '', awayTeam || '',
    Number(homeProb), Number(drawProb), Number(awayProb),
    bzzoiroEventId ? Number(bzzoiroEventId) : undefined,
    bzzoiroHomeTeam, bzzoiroAwayTeam,
    biasDirection as 'home' | 'away' | 'none' | undefined,
    biasCoefficient !== undefined ? Number(biasCoefficient) : undefined,
    handicapTeam as string | undefined,
    handicapValue !== undefined ? Number(handicapValue) : undefined,
  );
  res.json({ success: true, match: result });
}));

app.delete('/api/bots/value-bet/matches/:eventId/initial-odds', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  await deleteMatchState(eventId);
  res.json({ success: true });
}));

// 获取可用 Polymarket 比赛列表（进行中或即将开始）
app.get('/api/bots/value-bet/available-matches', asyncHandler(async (_req, res) => {
  const events = await getAvailablePolymarketMatches();
  res.json({ success: true, events });
}));

// 获取已注册的盘口规则列表
app.get('/api/bots/value-bet/rules', asyncHandler(async (_req, res) => {
  const rules = getRuleMetas();
  res.json({ success: true, rules });
}));

// 获取所有比赛监控状态
app.get('/api/bots/value-bet/monitors', asyncHandler(async (_req, res) => {
  const monitors = getMatchMonitors();
  res.json({ success: true, monitors });
}));

// 启动某场比赛监控
app.post('/api/bots/value-bet/matches/:eventId/start', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  await startMatch(eventId);
  const monitor = getMatchMonitor(eventId);
  res.json({ success: true, monitor });
}));

// 停止某场比赛监控
app.post('/api/bots/value-bet/matches/:eventId/stop', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  stopMatch(eventId);
  const monitor = getMatchMonitor(eventId);
  res.json({ success: true, monitor });
}));

// 手动触发某场比赛一次计算
app.post('/api/bots/value-bet/matches/:eventId/trigger', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  await triggerMatchCycle(eventId);
  const monitor = getMatchMonitor(eventId);
  res.json({ success: true, monitor });
}));

// 获取某场比赛的计算日志
app.get('/api/bots/value-bet/matches/:eventId/logs', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const limit = Number(req.query.limit) || 100;
  const offset = Number(req.query.offset) || 0;
  const lastOnly = req.query.last === '1';
  const { logs, total } = await getCalcLogs(eventId, { limit, offset, lastOnly });
  res.json({ success: true, logs, total });
}));

// 日志分析（按盘口分组）
app.get('/api/bots/value-bet/matches/:eventId/logs/analysis', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const result = await getCalcLogsAnalysis(eventId);
  res.json({ success: true, ...result });
}));

// 获取 bzzoiro 比赛列表（实时 + 即将开始）
app.get('/api/bots/value-bet/bzzoiro-matches', asyncHandler(async (req, res) => {
  const includeUpcoming = req.query.upcoming !== '0';
  const results: any[] = [];

  const teamMap = await getTeamTranslationMap();

  // 实时比赛
  try {
    const liveData = await sportsGet('/events/live/');
    const liveEvents = liveData?.results || liveData?.events || (Array.isArray(liveData) ? liveData : []);
    for (const evt of liveEvents) {
      const homeTeam = typeof evt.home_team === 'object' ? evt.home_team?.name : evt.home_team;
      const awayTeam = typeof evt.away_team === 'object' ? evt.away_team?.name : evt.away_team;
      let homeScore = 0, awayScore = 0, minute = 0;
      if (evt.stats) {
        homeScore = evt.stats.home_score ?? 0;
        awayScore = evt.stats.away_score ?? 0;
      }
      if (evt.home_score !== undefined) homeScore = evt.home_score;
      if (evt.away_score !== undefined) awayScore = evt.away_score;
      if (evt.status?.current_minute) minute = evt.status.current_minute;

      results.push({
        id: evt.id,
        home_team: homeTeam,
        away_team: awayTeam,
        home_team_zh: (homeTeam && teamMap[homeTeam]) || null,
        away_team_zh: (awayTeam && teamMap[awayTeam]) || null,
        league: evt.league?.name || '',
        status: 'live',
        minute,
        home_score: homeScore,
        away_score: awayScore,
        start_time: evt.start_time || null,
      });
    }
  } catch (err: any) {
    console.error('获取 bzzoiro 实时比赛失败:', err.message);
  }

  // 即将开始的比赛
  if (includeUpcoming) {
    try {
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const dateFrom = today.toISOString().split('T')[0];
      const dateTo = tomorrow.toISOString().split('T')[0];
      const upcomingData = await sportsGet('/events/', { date_from: dateFrom, date_to: dateTo, sport: 'football' });
      const upcomingEvents = upcomingData?.results || upcomingData?.events || (Array.isArray(upcomingData) ? upcomingData : []);
      for (const evt of upcomingEvents) {
        const homeTeam = typeof evt.home_team === 'object' ? evt.home_team?.name : evt.home_team;
        const awayTeam = typeof evt.away_team === 'object' ? evt.away_team?.name : evt.away_team;
        results.push({
          id: evt.id,
          home_team: homeTeam,
          away_team: awayTeam,
          home_team_zh: (homeTeam && teamMap[homeTeam]) || null,
          away_team_zh: (awayTeam && teamMap[awayTeam]) || null,
          league: evt.league?.name || '',
          status: 'upcoming',
          minute: 0,
          home_score: 0,
          away_score: 0,
          start_time: evt.start_time || evt.event_date || null,
        });
      }
    } catch (err: any) {
      console.error('获取 bzzoiro 即将开始比赛失败:', err.message);
    }
  }

  res.json({ success: true, matches: results });
}));

// ===== Price Bot API =====

app.get('/api/bots/price-bot/status', (_req, res) => {
  res.json({ success: true, ...getPriceBotStatus() });
});

app.post('/api/bots/price-bot/start', asyncHandler(async (req, res) => {
  const config = req.body?.config;
  await startPriceBot(config);
  res.json({ success: true, ...getPriceBotStatus() });
}));

app.post('/api/bots/price-bot/stop', (_req, res) => {
  stopPriceBot();
  res.json({ success: true, ...getPriceBotStatus() });
});

app.post('/api/bots/price-bot/config', asyncHandler(async (req, res) => {
  const config = updatePriceBotConfig(req.body || {});
  res.json({ success: true, config });
}));

app.post('/api/bots/price-bot/trigger', asyncHandler(async (_req, res) => {
  await triggerPriceBotCycle();
  res.json({ success: true, ...getPriceBotStatus() });
}));

// ==================== 自动下单 ====================

app.get('/api/bots/price-bot/auto-trade', asyncHandler(async (_req, res) => {
  res.json({ success: true, ...(await getAutoTradeStatus()) });
}));

/**
 * 自动下单总开关 + 全局默认参数。
 *
 * 开关落在内存配置里（updateConfig），进程重启回到关闭状态——
 * 动钱的开关不该在无人值守时自己恢复。
 */
app.post('/api/bots/price-bot/auto-trade', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  if (body.enabled !== undefined) patch.autoTradeEnabled = body.enabled === true;
  if (body.defaults && typeof body.defaults === 'object') {
    const cur = getPriceBotStatus().config.autoTradeDefaults || {};
    patch.autoTradeDefaults = { ...cur, ...body.defaults };
  }
  updatePriceBotConfig(patch as any);
  res.json({ success: true, ...(await getAutoTradeStatus()) });
}));

/** 批量开关盘口级自动下单。不传 ruleIds 则作用于所有已启用规则 */
app.post('/api/bots/price-bot/auto-trade/batch', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const enabled = body.enabled === true;
  const ruleIds = Array.isArray(body.ruleIds)
    ? body.ruleIds.map(Number).filter((n: number) => Number.isFinite(n))
    : undefined;
  const result = await setAutoTradeBatch(enabled, ruleIds);
  res.json({ success: true, ...result, ...(await getAutoTradeStatus()) });
}));

/** 单个盘口的自动下单开关与参数覆盖 */
app.post('/api/bots/price-bot/auto-trade/:ruleId', asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  if (!Number.isFinite(ruleId)) {
    res.status(400).json({ success: false, message: '无效的 ruleId' });
    return;
  }
  const body = req.body || {};
  const ok = await setRuleAutoTrade(
    ruleId,
    body.enabled === true,
    body.params && typeof body.params === 'object' ? body.params : undefined,
  );
  res.json({ success: ok, rule: await getRule(ruleId) });
}));

/** 下单记录（含被风控拦下的 skipped，用于回答「为什么没下单」） */
app.get('/api/bots/price-bot/orders', asyncHandler(async (req, res) => {
  const { ruleId, status, limit, offset } = req.query;
  const result = await listAutoOrders({
    ruleId: ruleId !== undefined ? Number(ruleId) : undefined,
    status: status !== undefined ? String(status) : undefined,
    limit: limit !== undefined ? Number(limit) : undefined,
    offset: offset !== undefined ? Number(offset) : undefined,
  });
  res.json({ success: true, ...result });
}));

/**
 * 回填规则的链上结算真相。
 *
 * 常规同步（fetchTodaysSoccerEvents）用 `active:true, closed:false` + 48 小时窗口，
 * 已结算盘口按定义不在结果里，所以结算价永远进不了库——实测 172 条 buy_signal
 * 规则里 129 条拿不到真相。没有真相就只能用「价格日志出现过 bid>=0.99」当赢判据，
 * 那个判据精确率 100% 但召回率只有 80.6%，所有 EV 系统性偏悲观。
 * 详见 bots/price-bot/outcome-sync.ts 的文件头。
 *
 * 用 POST 而不是 GET：它会写库，且会对外发起 N 次 gamma 请求（按赛事分组）。
 */
app.post('/api/bots/price-bot/rules/sync-outcomes', asyncHandler(async (req, res) => {
  const limit = req.body?.limit !== undefined ? Number(req.body.limit) : 200;
  const result = await syncRuleOutcomes(Number.isFinite(limit) ? limit : 200);
  res.json({ success: true, ...result });
}));

// 监控规则 CRUD
app.get('/api/bots/price-bot/rules', asyncHandler(async (req, res) => {
  const { limit, offset, eventId, enabledOnly } = req.query;
  const result = await listRules({
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0,
    eventId: eventId as string | undefined,
    enabledOnly: enabledOnly === '1' || enabledOnly === 'true',
  });
  res.json({ success: true, ...result });
}));

app.get('/api/bots/price-bot/rules/:id', asyncHandler(async (req, res) => {
  const rule = await getRule(Number(req.params.id));
  if (!rule) {
    res.status(404).json({ success: false, error: '规则不存在' });
    return;
  }
  res.json({ success: true, rule });
}));

app.post('/api/bots/price-bot/rules', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const required = ['tokenId', 'marketId', 'eventId', 'outcome', 'ruleType', 'direction', 'signalType'];
  const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length) {
    res.status(400).json({ success: false, error: `缺少必要参数: ${missing.join(', ')}` });
    return;
  }

  // goal_surge 只允许建在 total / first_scorer 盘口上
  //（只有这两类盘口，再进一球才会把某 outcome 概率推向 100%）。
  // market_type 不在规则行上，只能查 soccer_markets 校验。
  if (body.ruleType === 'goal_surge') {
    const [mrows] = await pool.execute<any[]>(
      `SELECT market_type FROM soccer_markets WHERE id = ?`,
      [String(body.marketId)],
    );
    const mt = mrows.length ? String(mrows[0].market_type) : null;
    if (mt !== 'total' && mt !== 'first_scorer') {
      res.status(400).json({
        success: false,
        error: `进球买入信号(goal_surge)仅支持 大小球(total) / 谁先进球(first_scorer) 盘口，当前盘口类型: ${mt ?? '未找到'}`,
      });
      return;
    }
  }

  const id = await createRule({
    tokenId: String(body.tokenId),
    marketId: String(body.marketId),
    eventId: String(body.eventId),
    outcome: String(body.outcome),
    ruleType: body.ruleType as any,
    direction: body.direction as any,
    percentThreshold: body.percentThreshold != null ? Number(body.percentThreshold) : undefined,
    targetPrice: body.targetPrice != null ? Number(body.targetPrice) : undefined,
    priceLow: body.priceLow != null ? Number(body.priceLow) : undefined,
    priceHigh: body.priceHigh != null ? Number(body.priceHigh) : undefined,
    goalSurgeParams:
      body.goalSurgeParams && typeof body.goalSurgeParams === 'object' ? body.goalSurgeParams : undefined,
    signalType: body.signalType as any,
    cooldownSeconds: body.cooldownSeconds != null ? Number(body.cooldownSeconds) : 1,
    enabled: body.enabled !== false,
  });
  const rule = await getRule(id);
  res.json({ success: true, rule });
}));

app.post('/api/bots/price-bot/rules/batch-quick', asyncHandler(async (_req, res) => {
  // 一键批量创建：取「即将开赛」的前 5 场（not_started，按临近开赛升序），
  // 每场只建**全场大小球 Over 0.5** 一条规则。
  //
  // 为什么只有这一种：进球买入的信号模型目前只在这个盘口上验证过。
  // 首球盘(first_scorer)、半场盘、单队进球盘的价格形态与全场大小球不同
  // （尤其首球盘一旦有人进球另一边直接归零，不是「奔向 1.0」的形态），
  // 用同一套阈值去跑等于拿没验证过的假设去下单。等这个盘口跑成熟再逐个加。
  //
  // 线也只建 0.5（见 FIRST_TOTAL_LINE）。1.5 及以上在 0.5 未打出前没有意义：
  // 0 球时 Over 1.5 的价格只是 Over 0.5 的影子，进球瞬间两者同涨，监控它
  // 等于把同一个信号数了两遍，还平摊了额度。更高的线由「完结并开下一档」
  // 在 0.5 打出后按需接上。
  const events = (await getEventsWithMarkets())
    .filter((e: any) => e.match_status === 'not_started')
    .slice(0, 5);

  const created: Array<{
    ruleId: number; eventId: string; marketId: string; marketType: string; line: number | null; outcome: string;
  }> = [];
  const skipped: Array<{
    eventId: string; marketId: string; marketType: string; line: number | null; reason: string;
  }> = [];

  let snapshotted = 0;

  for (const ev of events) {
    const eventId = String((ev as any).id);
    const markets = await getMarketsForEvent(eventId);

    // 抓初盘梯度：这些赛事都是 not_started，此刻的价就是初盘。
    // 这是整条递进链上唯一能拿到真初盘的时机——开哨后 outcome_prices
    // 就被实时价覆盖了，而下一档开档决策要用初盘反推这场比赛的期望进球。
    try {
      snapshotted += await captureLineSnapshots(eventId, markets);
    } catch (err: any) {
      console.error(`[PriceBot] 抓取 ${eventId} 初盘梯度失败:`, err?.message ?? err);
    }

    for (const m of markets) {
      const marketType = String(m.market_type);
      if (marketType !== 'total') continue;

      // 只取全场双方合计的 Over 0.5。半场盘/单队盘/角球盘/其它线
      // 都由 extractTotalGoalLine 返回 null 或别的值而被剔除。
      if (extractTotalGoalLine(m) !== FIRST_TOTAL_LINE) continue;

      const wanted = 'over';

      // outcomes 与 clob_token_ids 索引对齐（见 /api/soccer/positions 的配对逻辑）
      const outcomes = parseJsonArray(m.outcomes);
      const tokens = parseJsonArray(m.clob_token_ids);
      const idx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === wanted);
      if (idx < 0 || tokens[idx] == null) {
        skipped.push({ eventId, marketId: String(m.id), marketType, line: m.line, reason: `未匹配到 ${wanted} outcome` });
        continue;
      }

      try {
        const ruleId = await createRule({
          tokenId: String(tokens[idx]),
          marketId: String(m.id),
          eventId,
          outcome: String(outcomes[idx]),
          ruleType: 'goal_surge' as any,
          direction: 'up' as any,
          signalType: 'buy_signal' as any,
          cooldownSeconds: 1,
          enabled: true,
        });
        created.push({ ruleId, eventId, marketId: String(m.id), marketType, line: m.line, outcome: String(outcomes[idx]) });
      } catch (err: any) {
        const dup = /duplicate|ER_DUP_ENTRY/i.test(err?.message || '');
        skipped.push({
          eventId, marketId: String(m.id), marketType, line: m.line,
          reason: dup ? '规则已存在' : `创建失败: ${err?.message ?? 'unknown'}`,
        });
      }
    }
  }

  res.json({ success: true, created, skipped, eventsScanned: events.length, snapshotted });
}));

/**
 * 手动完结一个盘口，并可选地接上下一档。
 *
 * 为什么要手动而不等链上结算：Polymarket 的 Over 0.5 多在**比赛结束**才结算，
 * 而不是进球那一刻。若等 gamma 的 closed=true 再开 1.5，整场比赛都用不上它。
 * 你看到进球就点一下，这是最及时也最可靠的信号。
 *
 * 完结动作 = 停监控 + 禁用规则（不删除，触发记录和下单记录要留着对账）。
 * next=true 时在同一场比赛里找下一档 total 盘口（0.5→1.5→2.5→3.5→4.5）建规则。
 *
 * 下一档继承当前规则的 goalSurgeParams 和 autoTradeParams，但**不继承授权开关**：
 * autoTradeEnabled 一律为 false。递进可以自动，动钱不能自动——新盘口要你再点一次授权。
 */
app.post('/api/bots/price-bot/rules/:id/settle', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const wantNext = body.next !== false; // 默认接下一档
  const autoStart = body.startNext !== false; // 默认把下一档也启动监控

  const rule = await getRule(id);
  if (!rule) {
    res.status(404).json({ success: false, error: '规则不存在' });
    return;
  }

  // 先停监控再禁用：反过来的话监控还在跑，可能在禁用生效前又触发一次
  stopMonitor(id);
  await updateRule(id, { enabled: false, autoTradeEnabled: false });
  // 标记待结算：与 enabled=0 分开存，这样「完结」和「手动停用」在列表上能区分开
  await markRuleSettled(id, true);

  const result: {
    settled: { ruleId: number; line: number | null };
    next: null | {
      ruleId: number; marketId: string; line: number; outcome: string; started: boolean;
      mutedMs: number;
    };
    reason?: string;
    /** 开档决策详情：为什么开/不开，公平价多少。前端据此提示是否可授权 */
    decision?: {
      reasonCode: string;
      nextLine: number | null;
      lambdaFull: number | null;
      fairProb: number | null;
      marketPrice: number | null;
      goalsNeeded: number | null;
      /** 买入闸门：非 null 表示即使开了档，此刻也不该授权下单 */
      buyBlockedReason: string | null;
    };
  } = { settled: { ruleId: id, line: null }, next: null };

  // 当前档：规则行上没有 line 列，要回查盘口
  const [curRows] = await pool.execute<any[]>(
    `SELECT question_en, question_zh, line, market_type FROM soccer_markets WHERE id = ?`,
    [rule.marketId],
  );
  const curMarket = curRows[0];
  const curLine = curMarket ? extractTotalGoalLine(curMarket) : null;
  result.settled.line = curLine;

  if (!wantNext) {
    res.json({ success: true, ...result, reason: '仅完结，未创建下一档' });
    return;
  }
  if (curMarket && String(curMarket.market_type) !== 'total') {
    res.json({ success: true, ...result, reason: '非大小球盘口，无下一档可接' });
    return;
  }
  if (curLine == null) {
    res.json({ success: true, ...result, reason: '无法识别当前盘口的总进球数线' });
    return;
  }

  const nextLine = TOTAL_GOAL_LINES[TOTAL_GOAL_LINES.indexOf(curLine) + 1];
  if (nextLine == null) {
    res.json({ success: true, ...result, reason: `${curLine} 已是最高档，无下一档` });
    return;
  }

  // 在同一场比赛里找 nextLine 的 Over 盘口
  const markets = await getMarketsForEvent(rule.eventId);
  const target = markets.find(
    (m) => String(m.market_type) === 'total' && extractTotalGoalLine(m) === nextLine,
  );
  if (!target) {
    res.json({ success: true, ...result, reason: `本场未找到 Over ${nextLine} 盘口` });
    return;
  }

  const outcomes = parseJsonArray(target.outcomes);
  const tokens = parseJsonArray(target.clob_token_ids);
  const idx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === 'over');
  if (idx < 0 || tokens[idx] == null) {
    res.json({ success: true, ...result, reason: `Over ${nextLine} 盘口未匹配到 over outcome` });
    return;
  }

  // ---- 开档决策 ----
  //
  // 递进原本是无条件的，实测下来那正是资金自杀的来源：赢一次赚约 $0.50，
  // 错一次亏约 $4.40，而错的形态几乎都是「买了还没打出的下一档」。
  // 这里用初盘反推的公平价判断这一档是否值得开，并给出买入闸门。
  //
  // 注意开档与买入是两件事：开档便宜可逆，宁可多开；买入动钱不可逆，
  // 闸门是比分。所以下面即使 open=true 也照旧 autoTradeEnabled=false。
  const snapshots = await getLineSnapshots(rule.eventId).catch(() => new Map());
  const [evRows] = await pool.execute<any[]>(
    `SELECT start_time, end_time FROM soccer_events WHERE id = ?`,
    [rule.eventId],
  );
  // start_time 优先；缺失时退 end_time（它是取整到整点/半点的计划开哨时刻，
  // 与 auto-trade.ts evaluateMatchClock 同口径，带最多 ±30 分钟取整误差）
  const kickoff = evRows[0]?.start_time ?? evRows[0]?.end_time ?? null;

  const decision = decideNextLineOpening({
    settledLine: curLine,
    kickoffOver25: snapshots.get(2.5)?.overPrice ?? null,
    kickoffNextOver: snapshots.get(nextLine)?.overPrice ?? null,
    bestBid: target.best_bid != null ? Number(target.best_bid) : null,
    bestAsk: target.best_ask != null ? Number(target.best_ask) : null,
    minute: matchMinuteFrom(kickoff),
    // 比分源：price-bot 不接比分，所以这里传 null。decideNextLineOpening 会
    // 按「上一档已打出」推断下限——人工点完结的语义本来就是「我看到进球了」。
    totalGoals: null,
  });

  result.decision = {
    reasonCode: decision.reasonCode,
    nextLine: decision.nextLine,
    lambdaFull: decision.lambdaFull,
    fairProb: decision.fairProb,
    marketPrice: decision.marketPrice,
    goalsNeeded: decision.goalsNeeded,
    buyBlockedReason: buyGateReason(nextLine, null),
  };

  if (!decision.open) {
    res.json({ success: true, ...result, reason: decision.reason });
    return;
  }

  try {
    const nextId = await createRule({
      tokenId: String(tokens[idx]),
      marketId: String(target.id),
      eventId: rule.eventId,
      outcome: String(outcomes[idx]),
      ruleType: rule.ruleType,
      direction: rule.direction,
      signalType: rule.signalType,
      cooldownSeconds: rule.cooldownSeconds,
      goalSurgeParams: rule.goalSurgeParams,
      // 参数继承，授权不继承：新盘口默认不下单
      autoTradeParams: rule.autoTradeParams,
      autoTradeEnabled: false,
      enabled: true,
    });
    let started = false;
    let mutedMs = 0;
    if (autoStart) {
      try {
        await startMonitor(nextId);
        started = true;
        // 买入静默：新盘口一上线就带着上一档打出时的余震涨幅，
        // 不静默的话状态机立刻判「涨幅达标」并发买入信号——而那波涨幅
        // 属于刚完结的上一档，不是这一档的进球。必须在 startMonitor 之后设，
        // 监控对象要先存在。
        if (muteSurgeSignals(nextId, decision.cooldownMs)) mutedMs = decision.cooldownMs;
      } catch (err: any) {
        console.error(`[PriceBot] 下一档 ${nextId} 启动监控失败:`, err?.message ?? err);
      }
    }
    result.next = {
      ruleId: nextId, marketId: String(target.id), line: nextLine,
      outcome: String(outcomes[idx]), started, mutedMs,
    };
    res.json({ success: true, ...result, reason: decision.reason });
  } catch (err: any) {
    // 规则已存在（uk_token_rule）不算失败：可能之前手工建过，直接把它启用起来
    if (/duplicate|ER_DUP_ENTRY/i.test(err?.message || '')) {
      res.json({ success: true, ...result, reason: `Over ${nextLine} 规则已存在` });
      return;
    }
    res.json({ success: true, ...result, reason: `创建下一档失败: ${err?.message ?? 'unknown'}` });
  }
}));

app.put('/api/bots/price-bot/rules/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const ok = await updateRule(id, body);
  if (!ok) {
    res.status(404).json({ success: false, error: '规则不存在' });
    return;
  }
  // 重新启用等于「这个盘口又要跑了」，待结算标记必须清掉，
  // 否则列表上会同时显示「监控中」和「待结算」两个矛盾的状态
  if (body.enabled === true) await markRuleSettled(id, false);
  // 停用等于「这个盘口不跑了」。maker 模式下未成交的买单会一直挂在盘口上，
  // 规则停了它还能成交——那笔成交没有任何策略依据。只撤未成交的挂单，
  // 已成交的持仓不动（去留由人工判断）。
  if (body.enabled === false) void cancelRestingBuyOrders(id, '规则停用');
  const rule = await getRule(id);
  res.json({ success: true, rule });
}));

app.delete('/api/bots/price-bot/rules/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  // 先停止监控
  stopMonitor(id);
  // 再撤未成交的买单，且必须在 deleteRule 之前：撤单要按 rule_id 查
  // price_bot_orders，规则行删掉之后这些挂单就再也找不到了。这里 await，
  // 不像停用那样后台跑，否则会和删除竞争。
  await cancelRestingBuyOrders(id, '规则删除');
  const ok = await deleteRule(id);
  if (!ok) {
    res.status(404).json({ success: false, error: '规则不存在' });
    return;
  }
  res.json({ success: true });
}));

// 监控控制
app.get('/api/bots/price-bot/monitors', asyncHandler(async (_req, res) => {
  const monitors = getMonitorList();
  res.json({ success: true, monitors });
}));

app.get('/api/bots/price-bot/monitors/:ruleId', asyncHandler(async (req, res) => {
  const monitor = getMonitor(Number(req.params.ruleId));
  if (!monitor) {
    res.status(404).json({ success: false, error: '监控不存在' });
    return;
  }
  res.json({ success: true, monitor });
}));

// 批量启动：必须在 /monitors/:ruleId/start 之前注册，
// 否则 "batch-start" 会被当成 :ruleId 参数吃掉。
// 单独建端点而非让前端循环调用单条启动接口：
// 每次 startMonitor 都会重建 WS 连接并触发一次高波动抑制窗口。
app.post('/api/bots/price-bot/monitors/batch-start', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const rawIds: unknown = body.ruleIds;

  let ruleIds: number[];
  if (Array.isArray(rawIds)) {
    ruleIds = rawIds.map(Number).filter((n) => Number.isFinite(n));
  } else {
    // 未指定则启动全部已启用规则
    const { rules } = await listRules({ enabledOnly: true });
    ruleIds = rules.map((r) => r.id).filter((id): id is number => id !== undefined);
  }

  const result = await startMonitors(ruleIds);
  res.json({ success: true, ...result, monitors: getMonitorList() });
}));

app.post('/api/bots/price-bot/monitors/:ruleId/start', asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  await startMonitor(ruleId);
  const monitor = getMonitor(ruleId);
  res.json({ success: true, monitor });
}));

app.post('/api/bots/price-bot/monitors/:ruleId/stop', asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  stopMonitor(ruleId);
  // 手动停监控和停用是同一件事：不再盯这个盘口了，挂在盘口上的未成交买单
  // 也就没人管了。已成交的持仓不动。
  void cancelRestingBuyOrders(ruleId, '手动停止监控');
  const monitor = getMonitor(ruleId);
  res.json({ success: true, monitor });
}));

app.post('/api/bots/price-bot/monitors/:ruleId/trigger', asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  await triggerMonitorCycle(ruleId);
  const monitor = getMonitor(ruleId);
  res.json({ success: true, monitor });
}));

// 触发记录
app.get('/api/bots/price-bot/triggers', asyncHandler(async (req, res) => {
  const { limit, offset, ruleId, eventId, tokenId } = req.query;
  const result = await listTriggers({
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
    ruleId: ruleId ? Number(ruleId) : undefined,
    eventId: eventId as string | undefined,
    tokenId: tokenId as string | undefined,
  });
  res.json({ success: true, ...result });
}));

// 监控日志
app.get('/api/bots/price-bot/logs', asyncHandler(async (req, res) => {
  const { limit, offset, ruleId, eventId, action } = req.query;
  const result = await listLogs({
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0,
    ruleId: ruleId ? Number(ruleId) : undefined,
    eventId: eventId as string | undefined,
    action: action as string | undefined,
  });
  res.json({ success: true, ...result });
}));

// WebSocket 连接事件（断联/重连样本，用于分析断联与进球的相关性）
app.get('/api/bots/price-bot/connection/events', asyncHandler(async (req, res) => {
  const { limit, offset, eventType, reason, tokenId } = req.query;
  const result = await listConnectionEvents({
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0,
    eventType: eventType as 'disconnect' | 'reconnect' | undefined,
    reason: reason as string | undefined,
    tokenId: tokenId as string | undefined,
  });
  res.json({ success: true, ...result });
}));

// 断联统计汇总
app.get('/api/bots/price-bot/connection/stats', asyncHandler(async (_req, res) => {
  const stats = await getConnectionStats();
  res.json({ success: true, stats, current: getConnectionState() });
}));

/**
 * 真实成交分析：收益仅来自交易所已标记 filled/settled 且规则已回填结果的订单。
 * placed 只是提交成功，skipped / failed / cancelled / partial 均不会混入实盘 P&L。
 */
app.get('/api/bots/price-bot/report', asyncHandler(async (req, res) => {
  const line = req.query.line === undefined || req.query.line === '' ? undefined : Number(req.query.line);
  if (line !== undefined && !Number.isFinite(line)) {
    res.status(400).json({ success: false, error: '无效的盘口线 line' });
    return;
  }
  const report = await fetchRealOrderReport(pool, {
    league: typeof req.query.league === 'string' ? req.query.league : undefined,
    marketType: typeof req.query.marketType === 'string' ? req.query.marketType : undefined,
    line,
    from: typeof req.query.from === 'string' ? req.query.from : undefined,
    to: typeof req.query.to === 'string' ? req.query.to : undefined,
  });
  res.json({ success: true, report });
}));

/** 仅返回实际成交且已结算样本出现过的联赛，供实单分析筛选。 */
app.get('/api/bots/price-bot/report/leagues', asyncHandler(async (_req, res) => {
  const leagues = await listRealOrderReportLeagues(pool);
  res.json({ success: true, leagues });
}));

let reportRefreshBusy = false;

/**
 * 手动刷新：先同步交易所订单/结算，再回填规则 outcome，最后返回最新报表。
 * GET /report 只读本地库；测试期间点刷新才会打 Gamma。
 */
app.post('/api/bots/price-bot/report/refresh', asyncHandler(async (_req, res) => {
  if (reportRefreshBusy) {
    res.status(429).json({ success: false, error: '正在同步，请稍后再试' });
    return;
  }
  reportRefreshBusy = true;
  try {
    const orders = await syncOrderStatus().catch((err: unknown) => ({
      success: false,
      message: err instanceof Error ? err.message : String(err),
      total: 0, matched: 0, updated: 0, imported: 0, unverified: 0,
      openOrdersRead: false, tradesRead: false, tradesTruncated: false,
    }));
    const settlements = await syncSettlements().catch((err: unknown) => ({
      success: false,
      message: err instanceof Error ? err.message : String(err),
      settledCount: 0,
    }));
    const outcomes = await syncRuleOutcomes(200).catch((err: unknown) => ({
      pending: 0, resolved: 0, stillOpen: 0, notFound: 0, failed: 1,
      details: [{ ruleId: 0, status: err instanceof Error ? err.message : String(err) }],
    }));
    const report = await fetchRealOrderReport(pool);
    res.json({
      success: true,
      report,
      sync: {
        orders: {
          updated: orders.updated ?? 0,
          imported: orders.imported ?? 0,
          unverified: orders.unverified ?? 0,
          openOrdersRead: orders.openOrdersRead ?? false,
          tradesRead: orders.tradesRead ?? false,
          tradesTruncated: orders.tradesTruncated ?? false,
          message: orders.message,
        },
        settlements: { settledCount: settlements.settledCount ?? 0, message: settlements.message },
        outcomes: {
          pending: outcomes.pending,
          resolved: outcomes.resolved,
          stillOpen: outcomes.stillOpen,
          notFound: outcomes.notFound,
          failed: outcomes.failed,
        },
      },
    });
  } finally {
    reportRefreshBusy = false;
  }
}));

// Static frontend in production/service mode; dev mode keeps API only.
if (!isDev) {
  app.use(express.static(FRONTEND_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

// Error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Request error:', err);
  res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
});

function msUntilNextRefresh() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function runAutoRefresh() {
  try {
    console.log('[Scheduler] 自动刷新比赛数据...');
    const result = await fetchTodaysSoccerEvents();
    console.log(`[Scheduler] 自动刷新完成，新增/更新 ${result.events} 场比赛`);
  } catch (err) {
    console.error('[Scheduler] 自动刷新失败:', err);
  }
}

function scheduleDailyRefresh() {
  setTimeout(() => {
    runAutoRefresh();
    setInterval(runAutoRefresh, 24 * 60 * 60 * 1000);
  }, msUntilNextRefresh());
}

// 定时刷新链上余额（每 3 分钟）
async function runBalanceSync() {
  try {
    const addr = config.walletAddress || defaultWalletAddress;
    if (addr && addr !== '0x0000000000000000000000000000000000000000') {
      await syncOnChainBalance(addr);
    }
  } catch (err) {
    console.error('[Balance] 余额同步失败:', err);
  }
}

// 定时同步订单状态（每 30 秒）
async function runOrderSync() {
  try {
    const result = await syncOrderStatus();
    if (result.imported > 0 || result.updated > 0) {
      console.log(`[OrderSync] 同步完成: ${result.total} 个订单, 更新 ${result.updated}, 导入 ${result.imported}`);
    }
    // 同步市场结算信息
    const settlement = await syncSettlements();
    if (settlement.settledCount > 0) {
      console.log(`[OrderSync] ${settlement.message}`);
    }
  } catch (err) {
    console.error('[OrderSync] 订单状态同步失败:', err);
  }
}

const server = app.listen(PORT, async () => {
  console.log(`Soccer dashboard server running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Soccer UI: http://localhost:${PORT}/soccer`);

  // Refresh on startup, then schedule daily refresh at 00:05 UTC.
  await runAutoRefresh();
  scheduleDailyRefresh();

  // 启动时同步一次余额，之后每 3 分钟自动刷新
  await runBalanceSync();
  setInterval(runBalanceSync, 3 * 60 * 1000);

  // 启动时同步一次订单状态，之后每 30 秒自动同步
  runOrderSync();
  setInterval(runOrderSync, 30 * 1000);

  // 规则结算真相不在 soccer_orders 上；每 5 分钟回填一次，报表漏斗才不会把已结算单当成持仓。
  async function runOutcomeSync() {
    try {
      const result = await syncRuleOutcomes(200);
      if (result.resolved > 0 || result.failed > 0) {
        console.log(`[OutcomeSync] pending=${result.pending} resolved=${result.resolved} open=${result.stillOpen} failed=${result.failed}`);
      }
    } catch (err) {
      console.error('[OutcomeSync] 规则结算回填失败:', err);
    }
  }
  runOutcomeSync();
  setInterval(runOutcomeSync, 5 * 60 * 1000);

  // 价格机器人自恢复
  await restorePriceBot();
});

/**
 * 进程重启后自动把价格机器人接回来。
 *
 * 以前只有前端点「启动」才会调 startPriceBot，所以每次重启都要人工补一次。
 * 实测 8/26~8/30 的 80 小时跨度里有 46 小时完全没有 price_update 采样，
 * 缺口不是 WS 断联造成的（连接事件只有一次 36 分钟的断联），
 * 而是进程起来之后没人去点启动——监控和采样就一直是停着的。
 *
 * 只恢复监控与采样，不动自动下单总开关：那个开关按设计每次重启都回到关闭，
 * 需要人明确授权才会真下单。恢复失败不阻断 HTTP 服务，打日志即可，
 * 页面上仍可手动启动。
 */
async function restorePriceBot(): Promise<void> {
  try {
    await startPriceBot();
    const status = getPriceBotStatus();
    console.log(`[PriceBot] 启动自恢复完成，监控中 ${status.monitors?.length ?? 0} 条规则`);
  } catch (err: any) {
    console.error('[PriceBot] 启动自恢复失败，需在页面手动启动:', err?.message ?? err);
  }
}

// WebSocket proxy: frontend → backend → Polymarket (through HTTP proxy)
const WS_UPSTREAM = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  if (url.pathname === '/ws/market') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs: WebSocket) => {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  console.log('[WS Proxy] client connected, connecting upstream with proxy:', !!agent);
  const upstream = new WebSocket(WS_UPSTREAM, { agent } as any);

  // Buffer client messages until upstream is open
  const msgBuffer: string[] = [];
  let upstreamReady = false;

  // Register listener immediately - don't wait for upstream open
  clientWs.on('message', (data) => {
    const msg = data.toString();
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(msg);
    } else {
      msgBuffer.push(msg);
    }
  });

  upstream.on('open', () => {
    console.log('[WS Proxy] upstream connected, flushing', msgBuffer.length, 'buffered msgs');
    upstreamReady = true;
    for (const msg of msgBuffer) {
      upstream.send(msg);
    }
    msgBuffer.length = 0;
  });

  upstream.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  upstream.on('error', (err: Error) => {
    console.error('[WS Proxy] upstream error:', err.message);
  });

  upstream.on('close', (code?: number, reason?: Buffer) => {
    console.log('[WS Proxy] upstream closed:', code, reason?.toString());
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await pool.end();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
  await pool.end();
  server.close(() => process.exit(0));
});
