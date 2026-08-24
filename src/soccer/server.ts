import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WebSocketServer, WebSocket } from 'ws';
import { fetchTodaysSoccerEvents, fetchEventMarketsFromGamma } from './fetcher.js';
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
import { placeOrder, cancelOrder, cancelAllOrders } from './trading.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SOCCER_UI_PORT || 3000);
const FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');
const isDev = process.env.NODE_ENV === 'development';

const CLOB_BASE = 'https://clob.polymarket.com';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const clobClient = axios.create({
  baseURL: CLOB_BASE,
  timeout: 30000,
  ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
});

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

const server = app.listen(PORT, async () => {
  console.log(`Soccer dashboard server running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Soccer UI: http://localhost:${PORT}/soccer`);

  // Refresh on startup, then schedule daily refresh at 00:05 UTC.
  await runAutoRefresh();
  scheduleDailyRefresh();
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
