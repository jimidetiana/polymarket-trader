import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
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

  if (!marketId || !tokenId || !['BUY', 'SELL'].includes(side) || !size || !price) {
    res.status(400).json({ success: false, error: '缺少必要参数：market_id/token_id/side/size/price' });
    return;
  }

  const id = await insertOrder({
    market_id: marketId,
    token_id: tokenId,
    side,
    size,
    price,
    order_status: 'pending',
    memo: '界面下单（待实盘接入）',
  });
  res.json({ success: true, orderId: id, message: '下单请求已记录，待实盘接入后执行' });
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
    const response = await clobClient.get('/book', { params: { token_id: tokenId } });
    res.json({ success: true, book: response.data });
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

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await pool.end();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
  await pool.end();
  server.close(() => process.exit(0));
});
