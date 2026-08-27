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
import { placeOrder, cancelOrder, cancelAllOrders, syncOrderStatus, syncSettlements } from './trading.js';
import {
  startBot as startPriceBot,
  stopBot as stopPriceBot,
  getBotStatus as getPriceBotStatus,
  updateConfig as updatePriceBotConfig,
  triggerCycle as triggerPriceBotCycle,
  startMonitor,
  stopMonitor,
  getMonitorList,
  getMonitor,
  triggerMonitorCycle,
  createRule,
  updateRule,
  deleteRule,
  getRule,
  listRules,
  listTriggers,
  listLogs,
  listConnectionEvents,
  getConnectionStats,
  getConnectionState,
} from '../bots/price-bot/price-bot.js';
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
    signalType: body.signalType as any,
    cooldownSeconds: body.cooldownSeconds != null ? Number(body.cooldownSeconds) : 300,
    enabled: body.enabled !== false,
  });
  const rule = await getRule(id);
  res.json({ success: true, rule });
}));

app.put('/api/bots/price-bot/rules/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const ok = await updateRule(id, req.body || {});
  if (!ok) {
    res.status(404).json({ success: false, error: '规则不存在' });
    return;
  }
  const rule = await getRule(id);
  res.json({ success: true, rule });
}));

app.delete('/api/bots/price-bot/rules/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  // 先停止监控
  stopMonitor(id);
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

app.post('/api/bots/price-bot/monitors/:ruleId/start', asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  await startMonitor(ruleId);
  const monitor = getMonitor(ruleId);
  res.json({ success: true, monitor });
}));

app.post('/api/bots/price-bot/monitors/:ruleId/stop', asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  stopMonitor(ruleId);
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
});

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
