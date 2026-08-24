import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_INFO_PATH = path.resolve(__dirname, '../../数据库连接.txt');

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function parseDbInfo(filePath: string): DbConfig {
  const text = fs.readFileSync(filePath, 'utf-8');
  const urlMatch = text.match(/spring\.datasource\.url\s*=\s*(.+)/);
  const userMatch = text.match(/spring\.datasource\.username\s*=\s*(.+)/);
  const passMatch = text.match(/spring\.datasource\.password\s*=\s*(.+)/);

  if (!urlMatch) throw new Error('Cannot parse DB URL from 数据库连接.txt');

  const url = urlMatch[1].trim();
  const user = userMatch?.[1].trim() ?? 'root';
  const password = passMatch?.[1].trim() ?? '';

  // jdbc:mysql://host:port/db?...
  const parsed = new URL(url.replace(/^jdbc:/, ''));
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    database: 'polymarket_soccer',
    user,
    password,
  };
}

export const dbConfig: DbConfig = parseDbInfo(DB_INFO_PATH);

export const pool = mysql.createPool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
});

export interface SoccerEventRow {
  id: string;
  slug: string;
  title_en: string;
  title_zh: string | null;
  league: string | null;
  home_team_en: string | null;
  away_team_en: string | null;
  home_team_zh: string | null;
  away_team_zh: string | null;
  start_time: string | null;
  end_time: string | null;
  volume: number;
  liquidity: number;
  event_status: string;
  fetched_at: string;
}

export interface SoccerMarketRow {
  id: string;
  event_id: string;
  question_en: string;
  question_zh: string | null;
  market_type: string;
  line: number | null;
  outcomes: unknown;
  outcome_prices: unknown;
  clob_token_ids: unknown;
  volume: number;
  liquidity: number;
  best_bid: number | null;
  best_ask: number | null;
  market_status: string;
  fetched_at: string;
}

export async function deleteEventsByEndDateRange(min: string, max: string): Promise<void> {
  await pool.execute(`DELETE FROM soccer_events WHERE end_time >= ? AND end_time < ?`, [min, max]);
}

export async function upsertEvent(row: SoccerEventRow): Promise<void> {
  await pool.execute(
    `INSERT INTO soccer_events
      (id, slug, title_en, title_zh, league, home_team_en, away_team_en, home_team_zh, away_team_zh,
       start_time, end_time, volume, liquidity, event_status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       slug=VALUES(slug), title_en=VALUES(title_en), title_zh=VALUES(title_zh), league=VALUES(league),
       home_team_en=VALUES(home_team_en), away_team_en=VALUES(away_team_en),
       home_team_zh=VALUES(home_team_zh), away_team_zh=VALUES(away_team_zh),
       start_time=VALUES(start_time), end_time=VALUES(end_time), volume=VALUES(volume),
       liquidity=VALUES(liquidity), event_status=VALUES(event_status), fetched_at=VALUES(fetched_at)`,
    [
      row.id, row.slug, row.title_en, row.title_zh, row.league,
      row.home_team_en, row.away_team_en, row.home_team_zh, row.away_team_zh,
      row.start_time, row.end_time, row.volume, row.liquidity, row.event_status, row.fetched_at,
    ],
  );
}

export async function upsertMarket(row: SoccerMarketRow): Promise<void> {
  await pool.execute(
    `INSERT INTO soccer_markets
      (id, event_id, question_en, question_zh, market_type, line, outcomes, outcome_prices,
       clob_token_ids, volume, liquidity, best_bid, best_ask, market_status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       event_id=VALUES(event_id), question_en=VALUES(question_en), question_zh=VALUES(question_zh),
       market_type=VALUES(market_type), line=VALUES(line), outcomes=VALUES(outcomes),
       outcome_prices=VALUES(outcome_prices), clob_token_ids=VALUES(clob_token_ids),
       volume=VALUES(volume), liquidity=VALUES(liquidity), best_bid=VALUES(best_bid),
       best_ask=VALUES(best_ask), market_status=VALUES(market_status), fetched_at=VALUES(fetched_at)`,
    [
      row.id, row.event_id, row.question_en, row.question_zh, row.market_type, row.line,
      JSON.stringify(row.outcomes), JSON.stringify(row.outcome_prices), JSON.stringify(row.clob_token_ids),
      row.volume, row.liquidity, row.best_bid, row.best_ask, row.market_status, row.fetched_at,
    ],
  );
}

export async function deleteDerivativeEvents(): Promise<number> {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `DELETE FROM soccer_events WHERE title_en LIKE '% - %'`,
  );
  return result.affectedRows;
}

export async function deleteClosedEvents(): Promise<number> {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `DELETE FROM soccer_events WHERE event_status = 'closed'`,
  );
  return result.affectedRows;
}

export function computeMatchStatus(endTime: string | Date | null): 'not_started' | 'live' | 'ended' {
  if (!endTime) return 'not_started';
  const end = typeof endTime === 'string' ? new Date(endTime.replace(' ', 'T') + 'Z') : endTime;
  if (isNaN(end.getTime())) return 'not_started';
  const now = Date.now();
  const kickoff = end.getTime();
  // Treat ~2 hours after kickoff as the live window for a football match
  // (90 minutes + stoppage + half-time).
  const matchDurationMs = 2 * 60 * 60 * 1000;
  if (now < kickoff) return 'not_started';
  if (now < kickoff + matchDurationMs) return 'live';
  return 'ended';
}

function getBeijingDayRange(now = new Date()): { start: Date; end: Date } {
  // Beijing day 00:00 -> UTC previous day 16:00; Beijing 23:59 -> UTC same day 15:59.
  // Show today + tomorrow (48 hours) so evening matches are available in advance.
  const utc = new Date(now.getTime());
  const start = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate() - 1, 16, 0, 0));
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
  return { start, end };
}

export async function getEventsWithMarkets(): Promise<SoccerEventRow[]> {
  const { start, end } = getBeijingDayRange();
  const startStr = start.toISOString().slice(0, 19).replace('T', ' ');
  const endStr = end.toISOString().slice(0, 19).replace('T', ' ');

  const [events] = await pool.execute<SoccerEventRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_events
     WHERE event_status='active' AND title_en NOT LIKE '% - %' AND end_time >= ? AND end_time < ?
     ORDER BY end_time ASC, volume DESC`,
    [startStr, endStr],
  );
  for (const event of events) {
    (event as unknown as { markets: SoccerMarketRow[] }).markets = [];
    (event as unknown as { match_status: string }).match_status = computeMatchStatus(event.end_time);
  }

  // Sort: live first, then not-started (nearest kickoff first), then ended (most recent first).
  const priority: Record<string, number> = { live: 0, not_started: 1, ended: 2 };
  events.sort((a, b) => {
    const pa = priority[(a as unknown as { match_status: string }).match_status] ?? 99;
    const pb = priority[(b as unknown as { match_status: string }).match_status] ?? 99;
    if (pa !== pb) return pa - pb;
    const ta = new Date(a.end_time || 0).getTime();
    const tb = new Date(b.end_time || 0).getTime();
    // For ended matches, show the most recently finished first.
    return pa === 2 ? tb - ta : ta - tb;
  });

  return events;
}

export async function getAllEvents(): Promise<SoccerEventRow[]> {
  const [events] = await pool.execute<SoccerEventRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_events WHERE title_en NOT LIKE '% - %' ORDER BY end_time DESC, volume DESC LIMIT 500`,
  );
  for (const event of events) {
    (event as unknown as { match_status: string }).match_status = computeMatchStatus(event.end_time);
  }
  return events;
}

export async function updateEventTranslation(params: {
  id: string;
  title_zh?: string;
  home_team_zh?: string;
  away_team_zh?: string;
  league?: string;
}): Promise<void> {
  await pool.execute(
    `UPDATE soccer_events
     SET title_zh = COALESCE(?, title_zh),
         home_team_zh = COALESCE(?, home_team_zh),
         away_team_zh = COALESCE(?, away_team_zh),
         league = COALESCE(?, league),
         fetched_at = NOW()
     WHERE id = ?`,
    [params.title_zh ?? null, params.home_team_zh ?? null, params.away_team_zh ?? null, params.league ?? null, params.id],
  );
}

export async function getMarketsForEvent(eventId: string): Promise<SoccerMarketRow[]> {
  const [markets] = await pool.execute<SoccerMarketRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_markets WHERE event_id = ? ORDER BY id`,
    [eventId],
  );
  return markets.map((m) => ({
    ...m,
    outcomes: safeJsonParse(m.outcomes),
    outcome_prices: safeJsonParse(m.outcome_prices),
    clob_token_ids: safeJsonParse(m.clob_token_ids),
  }));
}

export async function updateMarketTranslation(params: {
  id: string;
  question_zh?: string;
  outcomes_zh?: string[];
}): Promise<void> {
  await pool.execute(
    `UPDATE soccer_markets
     SET question_zh = COALESCE(?, question_zh),
         outcomes = COALESCE(?, outcomes),
         fetched_at = NOW()
     WHERE id = ?`,
    [params.question_zh ?? null, params.outcomes_zh ? JSON.stringify(params.outcomes_zh) : null, params.id],
  );
}

function safeJsonParse(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function insertOrder(params: {
  market_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  order_status?: string;
  memo?: string;
}): Promise<number> {
  const [result] = await pool.execute<mysql.OkPacket>(
    `INSERT INTO soccer_orders (market_id, token_id, side, size, price, order_status, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [params.market_id, params.token_id, params.side, params.size, params.price,
     params.order_status ?? 'pending', params.memo ?? null],
  );
  return result.insertId;
}

export async function getOrders(): Promise<unknown[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT o.*, m.question_zh, e.title_zh
     FROM soccer_orders o
     JOIN soccer_markets m ON m.id = o.market_id
     JOIN soccer_events e ON e.id = m.event_id
     ORDER BY o.created_at DESC`,
  );
  return rows;
}

export async function getOrder(id: number): Promise<{
  id: number;
  market_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  order_status: string;
  memo: string | null;
  created_at: string;
} | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, market_id, token_id, side, size, price, order_status, memo, created_at
     FROM soccer_orders WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.id,
    market_id: String(row.market_id),
    token_id: row.token_id,
    side: row.side as 'BUY' | 'SELL',
    size: Number(row.size),
    price: Number(row.price),
    order_status: row.order_status,
    memo: row.memo,
    created_at: row.created_at,
  };
}

export async function updateOrderStatus(id: number, status: string, memo?: string): Promise<void> {
  if (memo !== undefined) {
    await pool.execute(
      `UPDATE soccer_orders SET order_status = ?, memo = CONCAT(COALESCE(memo, ''), ' | ', ?) WHERE id = ?`,
      [status, memo, id],
    );
  } else {
    await pool.execute(
      `UPDATE soccer_orders SET order_status = ? WHERE id = ?`,
      [status, id],
    );
  }
}

export async function getTeamTranslationMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const [homeRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT DISTINCT home_team_en AS en, home_team_zh AS zh FROM soccer_events
     WHERE home_team_en IS NOT NULL AND home_team_zh IS NOT NULL AND home_team_zh <> ''`,
  );
  const [awayRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT DISTINCT away_team_en AS en, away_team_zh AS zh FROM soccer_events
     WHERE away_team_en IS NOT NULL AND away_team_zh IS NOT NULL AND away_team_zh <> ''`,
  );
  for (const row of [...homeRows, ...awayRows]) {
    if (row.en && row.zh && row.en !== row.zh) {
      map[row.en] = row.zh;
    }
  }
  return map;
}

export async function getUntranslatedEvents(limit = 100): Promise<SoccerEventRow[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 100), 500));
  const [events] = await pool.execute<SoccerEventRow[] & mysql.RowDataPacket[]>(
    `SELECT DISTINCT e.* FROM soccer_events e
     LEFT JOIN soccer_markets m ON m.event_id = e.id
     WHERE e.title_zh IS NULL OR e.title_zh = ''
        OR e.home_team_zh IS NULL OR e.home_team_zh = ''
        OR e.away_team_zh IS NULL OR e.away_team_zh = ''
        OR m.question_zh IS NULL OR m.question_zh = ''
     ORDER BY e.end_time DESC
     LIMIT ${safeLimit}`,
  );
  for (const event of events) {
    const [markets] = await pool.execute<SoccerMarketRow[] & mysql.RowDataPacket[]>(
      `SELECT * FROM soccer_markets WHERE event_id = ? ORDER BY id`,
      [event.id],
    );
    (event as unknown as { markets: SoccerMarketRow[] }).markets = markets.map((m) => ({
      ...m,
      outcomes: safeJsonParse(m.outcomes),
      outcome_prices: safeJsonParse(m.outcome_prices),
      clob_token_ids: safeJsonParse(m.clob_token_ids),
    }));
  }
  return events;
}

export interface BatchTranslationEvent {
  id: string;
  title_zh?: string;
  home_team_zh?: string;
  away_team_zh?: string;
  league?: string;
  markets?: Array<{
    id: string;
    question_zh?: string;
    outcomes_zh?: string[];
  }>;
}

export async function batchImportTranslations(events: BatchTranslationEvent[]): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const evt of events) {
      await conn.execute(
        `UPDATE soccer_events
         SET title_zh = COALESCE(?, title_zh),
             home_team_zh = COALESCE(?, home_team_zh),
             away_team_zh = COALESCE(?, away_team_zh),
             league = COALESCE(?, league),
             fetched_at = NOW()
         WHERE id = ?`,
        [evt.title_zh ?? null, evt.home_team_zh ?? null, evt.away_team_zh ?? null, evt.league ?? null, evt.id],
      );
      for (const m of evt.markets || []) {
        await conn.execute(
          `UPDATE soccer_markets
           SET question_zh = COALESCE(?, question_zh),
               outcomes = COALESCE(?, outcomes),
               fetched_at = NOW()
           WHERE id = ?`,
          [m.question_zh ?? null, m.outcomes_zh ? JSON.stringify(m.outcomes_zh) : null, m.id],
        );
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
