import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  dbConfig,
  pool,
  upsertEvent,
  upsertMarket,
  deleteDerivativeEvents,
  deleteClosedEvents,
  type SoccerMarketRow,
} from './db.js';
import {
  getTeamTranslationMap,
  getLeagueTranslationMap,
  upsertTeam,
  upsertLeague,
} from './dict.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

function createGammaClient(): AxiosInstance {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const config: AxiosRequestConfig = {
    baseURL: GAMMA_BASE,
    timeout: 60000,
  };
  if (proxy) {
    config.httpsAgent = new HttpsProxyAgent(proxy);
  }
  return axios.create(config);
}

interface GammaOutcome {
  name: string;
  tokenId?: string;
  token_id?: string;
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId?: string;
  slug: string;
  endDate: string;
  startDate: string;
  active: boolean;
  closed: boolean;
  outcomes?: string | GammaOutcome[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  volume?: string | number;
  liquidity?: string | number;
  bestBid?: number;
  bestAsk?: number;
  line?: number;
  sportsMarketType?: string;
  marketType?: string;
}

interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description?: string;
  startDate?: string;
  creationDate?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  volume?: string | number;
  liquidity?: string | number;
  markets?: GammaMarket[];
  tags?: Array<{ slug?: string; label?: string }>;
}

export const TEAM_NAME_MAP: Record<string, string> = {
  'Shanghai Haigang FC': '上海海港',
  'Shanghai Shenhua FC': '上海申花',
  'Shanghai Port FC': '上海海港',
  'Beijing Guoan FC': '北京国安',
  'Chengdu Rongcheng FC': '成都蓉城',
  'Shandong Taishan FC': '山东泰山',
  'Tianjin Jinmen Tiger FC': '天津津门虎',
  'Zhejiang Professional FC': '浙江职业',
  'Dalian Yingbo FC': '大连英博',
  'Yunnan Yukun FC': '云南玉昆',
  'Qingdao Hainiu FC': '青岛海牛',
  'Changchun Yatai FC': '长春亚泰',
  'Wuhan Three Towns FC': '武汉三镇',
  'Henan FC': '河南',
  'Meizhou Hakka FC': '梅州客家',
  'Shenzhen Xinpengcheng FC': '深圳新鹏城',
  'Qingdao West Coast FC': '青岛西海岸',
  'Nantong Zhiyun FC': '南通支云',
  'Cangzhou Mighty Lions FC': '沧州雄狮',
  'Guangzhou FC': '广州',
  'Beijing Guoan': '北京国安',
  'Shanghai SIPG': '上海上港',
  'Guangzhou Evergrande': '广州恒大',
  'Shandong Luneng': '山东鲁能',
  'Manchester City': '曼城',
  'Manchester United': '曼联',
  'Liverpool': '利物浦',
  'Chelsea': '切尔西',
  'Arsenal': '阿森纳',
  'Tottenham Hotspur': '托特纳姆热刺',
  'Tottenham': '托特纳姆热刺',
  'Real Madrid': '皇家马德里',
  'Barcelona': '巴塞罗那',
  'Atletico Madrid': '马德里竞技',
  'Bayern Munich': '拜仁慕尼黑',
  'Borussia Dortmund': '多特蒙德',
  'Paris Saint-Germain': '巴黎圣日耳曼',
  'PSG': '巴黎圣日耳曼',
  'Inter Milan': '国际米兰',
  'AC Milan': 'AC米兰',
  'Juventus': '尤文图斯',
  'Napoli': '那不勒斯',
  'Roma': '罗马',
  'Lazio': '拉齐奥',
  'Ajax': '阿贾克斯',
  'Porto': '波尔图',
  'Benfica': '本菲卡',
  'Sporting CP': '葡萄牙体育',
};

const MARKET_TYPE_KEYWORDS: Array<[string[], string]> = [
  [['halftime', 'half-time', 'half time'], 'halftime'],
  [['second half', '2nd half'], 'second_half'],
  [['exact score', 'correct score'], 'exact_score'],
  [['first team to score', 'first to score', 'first goal'], 'first_scorer'],
  [['total goals', 'over/under', 'o/u'], 'total'],
  [['spread', 'handicap', 'asian handicap'], 'spread'],
  [['both teams to score', 'btts'], 'btts'],
  [['moneyline', 'winner', 'win the match', 'who will win', 'end in a draw', 'end in a tie'], 'moneyline'],
];

function classifyMarketType(questionEn: string): string {
  const lower = questionEn.toLowerCase();
  for (const [keywords, type] of MARKET_TYPE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return type;
  }
  // fallback: if question is simply "Will [team] win?" -> moneyline
  if (/^will\s+.+\s+win/.test(lower)) return 'moneyline';
  return 'other';
}

export function translateTeamName(en: string, map: Record<string, string>): string {
  // try exact match, then case-insensitive, then remove trailing "FC"
  if (map[en]) return map[en];
  const key = Object.keys(map).find(
    (k) => k.toLowerCase() === en.toLowerCase(),
  );
  if (key) return map[key];
  const stripped = en.replace(/\s+FC$/i, '').trim();
  if (map[stripped]) return map[stripped];
  return en;
}

export function translateText(en: string, homeEn: string, awayEn: string, homeZh: string, awayZh: string): string {
  let text = en;
  // replace longer names first to avoid partial replacement
  const pairs = [
    { en: homeEn, zh: homeZh },
    { en: awayEn, zh: awayZh },
  ];
  pairs.sort((a, b) => b.en.length - a.en.length);
  for (const { en: e, zh } of pairs) {
    if (!e || !zh) continue;
    const regex = new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(regex, zh);
  }

  const termReplacements: Array<[RegExp, string]> = [
    [/Will\s+/gi, ''],
    [/\s+win\s+the\s+match\?/gi, ' 会赢得比赛？'],
    [/\s+win\?/gi, ' 会赢？'],
    [/Halftime Result/gi, '半场结果'],
    [/Second Half Result/gi, '下半场结果'],
    [/Exact Score/gi, '准确比分'],
    [/First Team to Score/gi, '率先得分球队'],
    [/Total Goals/gi, '总进球数'],
    [/Over\/Under/gi, '大/小'],
    [/Spread/gi, '让球盘'],
    [/Handicap/gi, '让球'],
    [/Both Teams to Score/gi, '双方均进球'],
    [/Draw/gi, '平局'],
    [/Yes/gi, '是'],
    [/No/gi, '否'],
  ];

  for (const [regex, replacement] of termReplacements) {
    text = text.replace(regex, replacement);
  }
  return text.trim();
}

function parseJsonField<T>(value: unknown): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }
  return [];
}

function parseOutcomes(market: GammaMarket): Array<{ name: string; tokenId: string | null; price: number }> {
  const names = parseJsonField<string>(market.outcomes);
  const prices = parseJsonField<string>(market.outcomePrices).map((p) => Number(p));
  const tokenIds = parseJsonField<string>(market.clobTokenIds);
  return names.map((name, idx) => ({
    name,
    tokenId: tokenIds[idx] ?? null,
    price: prices[idx] ?? 0,
  }));
}

function parseTeams(title: string): { home: string; away: string } | null {
  const separators = [' vs. ', ' vs ', ' VS. ', ' VS '];
  for (const sep of separators) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      let home = title.slice(0, idx).trim();
      let away = title.slice(idx + sep.length).trim();
      // Strip event suffixes like " - Halftime Result" from the away team name
      const suffixIdx = away.search(/\s+[-–—]\s+/);
      if (suffixIdx > 0) away = away.slice(0, suffixIdx).trim();
      return { home, away };
    }
  }
  return null;
}

function toDateTime(iso: string | undefined): string | null {
  if (!iso) return null;
  // Normalize to UTC ISO string. If the input has no timezone suffix, treat it as UTC.
  const normalized = iso.match(/Z|[+-]\d{2}:?\d{2}$/i) ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function fetchTodaysSoccerEvents(): Promise<{ events: number }> {
  const client = createGammaClient();
  const [dbTeamMap, dbLeagueMap] = await Promise.all([
    getTeamTranslationMap(),
    getLeagueTranslationMap(),
  ]);
  const combinedTeamMap = { ...TEAM_NAME_MAP, ...dbTeamMap };

  // Clean up derivative events previously inserted by older versions.
  const deleted = await deleteDerivativeEvents();
  if (deleted > 0) console.log('Deleted', deleted, 'derivative events');

  // Remove stale closed events so old kick-off times don't persist in the UI.
  const deletedClosed = await deleteClosedEvents();
  if (deletedClosed > 0) console.log('Deleted', deletedClosed, 'closed events');

  // Use Beijing day range because most soccer matches are displayed/scheduled in Asia/Shanghai.
  // Fetch today + tomorrow (48 hours) so evening matches are available in advance.
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 16, 0, 0));
  const endOfDay = new Date(startOfDay.getTime() + 48 * 60 * 60 * 1000);

  const baseParams = {
    tag_id: 1,
    active: true,
    closed: false,
    end_date_min: startOfDay.toISOString(),
    end_date_max: endOfDay.toISOString(),
    limit: 100,
  };

  // Upsert semantics (INSERT ... ON DUPLICATE KEY UPDATE) mean previously fetched
  // records are preserved while fresh data overwrites matching IDs.

  const events: GammaEvent[] = [];
  const maxPages = 20;

  async function fetchPage(pageOffset: number, attempt = 1): Promise<GammaEvent[]> {
    try {
      const response = await client.get<GammaEvent[]>('/events', {
        params: { ...baseParams, offset: pageOffset },
        timeout: 60000,
      });
      return response.data || [];
    } catch (err) {
      const msg = (err as Error).message || '';
      const isRetryable = /aborted|reset|timeout|econnreset|etimedout/i.test(msg);
      if (isRetryable && attempt <= 3) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(`Page offset ${pageOffset} failed (${msg}), retry ${attempt}/3 in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        return fetchPage(pageOffset, attempt + 1);
      }
      throw err;
    }
  }

  for (let page = 0; page < maxPages; page++) {
    try {
      // Gamma API uses the number of already-fetched items as the cursor.
      const offset = events.length;
      const batch = await fetchPage(offset);
      if (!batch.length) break;
      events.push(...batch);
      if (batch.length < 100) break;
      // brief pause between pages to ease the proxy
      if (page % 5 === 0) await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.warn('Pagination stopped after', events.length, 'events:', (err as Error).message);
      break;
    }
  }

  // Keep only association football (soccer) events by checking league tags.
  const soccerEvents = events.filter((evt) =>
    (evt.tags || []).some((t) => {
      const slug = t.slug || '';
      return (
        slug === 'soccer' ||
        (slug.startsWith('soccer-') &&
          !slug.includes('transfer') &&
          !slug.includes('transfers')) ||
        slug === 'intlpt-soccer'
      );
    })
  );

  // Group events by base match title. Derivative markets on Polymarket are
  // published as separate events like "Team A vs. Team B - Total Goals" or
  // "Team A vs. Team B - First Team to Score". We merge those markets back
  // into the main event so the UI shows all available markets for a match.
  const eventGroups = new Map<string, GammaEvent[]>();
  for (const event of soccerEvents) {
    const baseTitle = event.title.split(' - ')[0].trim();
    if (!eventGroups.has(baseTitle)) eventGroups.set(baseTitle, []);
    eventGroups.get(baseTitle)!.push(event);
  }

  const mainEvents: GammaEvent[] = [];
  for (const group of eventGroups.values()) {
    const mainEvent = group.find((e) => !e.title.includes(' - ')) || group[0];
    const mergedMarkets = group.flatMap((e) => e.markets || []);
    const seen = new Set<string>();
    mainEvent.markets = mergedMarkets.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    mainEvents.push(mainEvent);
  }

  for (const event of mainEvents) {
    const teams = parseTeams(event.title);
    const homeEn = teams?.home ?? '';
    const awayEn = teams?.away ?? '';
    const homeZh = translateTeamName(homeEn, combinedTeamMap);
    const awayZh = translateTeamName(awayEn, combinedTeamMap);
    const titleZh = teams ? `${homeZh} vs ${awayZh}` : event.title;
    const leagueEn = event.tags?.find((t) => t.slug?.includes('league'))?.label ?? '足球';
    const league = dbLeagueMap[leagueEn] || leagueEn;

    // Auto-sync teams and leagues to dictionary
    if (homeEn) {
      await upsertTeam(homeEn, homeZh !== homeEn ? homeZh : null, leagueEn);
    }
    if (awayEn) {
      await upsertTeam(awayEn, awayZh !== awayEn ? awayZh : null, leagueEn);
    }
    if (leagueEn && leagueEn !== '足球') {
      await upsertLeague(leagueEn, league !== leagueEn ? league : null);
    }

    await upsertEvent({
      id: event.id,
      slug: event.slug,
      title_en: event.title,
      title_zh: titleZh,
      league,
      home_team_en: homeEn || null,
      away_team_en: awayEn || null,
      home_team_zh: homeZh || null,
      away_team_zh: awayZh || null,
      start_time: toDateTime(event.startDate),
      end_time: toDateTime(event.endDate),
      volume: Number(event.volume ?? 0),
      liquidity: Number(event.liquidity ?? 0),
      event_status: event.active && !event.closed ? 'active' : 'closed',
      fetched_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });

    // Persist merged markets so the UI can load them from the DB instantly.
    for (const market of event.markets || []) {
      const outcomes = parseOutcomes(market);
      const marketType = classifyMarketType(market.question);
      const questionZh = translateText(market.question, homeEn, awayEn, homeZh, awayZh);
      await upsertMarket({
        id: market.id,
        event_id: String(event.id),
        question_en: market.question,
        question_zh: questionZh,
        market_type: marketType,
        line: market.line ?? null,
        outcomes: outcomes.map((o) => o.name),
        outcome_prices: outcomes.map((o) => o.price),
        clob_token_ids: outcomes.map((o) => o.tokenId),
        volume: Number(market.volume ?? 0),
        liquidity: Number(market.liquidity ?? 0),
        best_bid: market.bestBid ?? null,
        best_ask: market.bestAsk ?? null,
        market_status: market.active && !market.closed ? 'active' : 'closed',
        fetched_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
    }
  }

  return { events: mainEvents.length };
}

export async function fetchEventMarketsFromGamma(eventId: string): Promise<SoccerMarketRow[]> {
  const client = createGammaClient();
  const response = await client.get<GammaEvent[]>('/events', {
    params: { id: eventId },
    timeout: 60000,
  });
  const gammaEvents = response.data || [];
  if (!gammaEvents.length) return [];

  const event = gammaEvents[0];
  const baseTitle = event.title.split(' - ')[0].trim();
  const relatedEvents: GammaEvent[] = [event];

  // Also fetch derivative markets that share the same base match title
  // (e.g. "Team A vs. Team B - Total Goals", "Team A vs. Team B - First to Score").
  if (baseTitle && baseTitle.length > 3) {
    try {
      const searchResp = await client.get<GammaEvent[]>('/events', {
        params: {
          tag_id: 1,
          active: true,
          closed: false,
          search: baseTitle,
          limit: 100,
        },
        timeout: 60000,
      });
      const candidates = searchResp.data || [];
      for (const candidate of candidates) {
        if (candidate.id === event.id) continue;
        const candidateBase = candidate.title.split(' - ')[0].trim();
        if (candidateBase.toLowerCase() === baseTitle.toLowerCase()) {
          relatedEvents.push(candidate);
        }
      }
    } catch (err) {
      console.warn(`[Markets] failed to search derivative events for ${baseTitle}:`, (err as Error).message);
    }
  }

  const seenMarketIds = new Set<string>();
  const result: SoccerMarketRow[] = [];

  for (const evt of relatedEvents) {
    const teams = parseTeams(evt.title);
    const homeEn = teams?.home ?? '';
    const awayEn = teams?.away ?? '';
    const [teamMap, leagueMap] = await Promise.all([
      getTeamTranslationMap(),
      getLeagueTranslationMap(),
    ]);
    const combinedTeamMap = { ...TEAM_NAME_MAP, ...teamMap };
    const homeZh = translateTeamName(homeEn, combinedTeamMap);
    const awayZh = translateTeamName(awayEn, combinedTeamMap);

    for (const market of evt.markets ?? []) {
      if (seenMarketIds.has(market.id)) continue;
      seenMarketIds.add(market.id);
      const outcomes = parseOutcomes(market);
      const marketType = classifyMarketType(market.question);
      const questionZh = translateText(market.question, homeEn, awayEn, homeZh, awayZh);
      result.push({
        id: market.id,
        event_id: eventId,
        question_en: market.question,
        question_zh: questionZh,
        market_type: marketType,
        line: market.line ?? null,
        outcomes: outcomes.map((o) => o.name),
        outcome_prices: outcomes.map((o) => o.price),
        clob_token_ids: outcomes.map((o) => o.tokenId),
        volume: Number(market.volume ?? 0),
        liquidity: Number(market.liquidity ?? 0),
        best_bid: market.bestBid ?? null,
        best_ask: market.bestAsk ?? null,
        market_status: market.active && !market.closed ? 'active' : 'closed',
        fetched_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
    }
  }

  return result;
}

// CLI entry point (works with tsx and node)
const isCli = process.argv.slice(1).some((arg) => arg.includes('fetcher'));
if (isCli) {
  (async () => {
    console.log('DB config:', dbConfig.host, dbConfig.port, dbConfig.database);
    const result = await fetchTodaysSoccerEvents();
    console.log('Fetched', result.events, 'events');
    await pool.end();
    process.exit(0);
  })().catch((err) => {
    console.error('Fetcher error:', err);
    process.exit(1);
  });
}
