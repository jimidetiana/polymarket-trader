/**
 * 全场次盘口监控（纯观测）。
 *
 * 目的：为「便宜侧是否被低估」这类问题攒**无选择偏差**的样本。
 *
 * 为什么不能复用机器人现有的规则样本：机器人是低档结算后才开下一档，
 * 所以 1.5+ 档的样本条件在「已经进了好几球」。实测开哨前开档的比例
 * 0.5 档 106/123，而 4.5 档 0/26。拿那批样本做定价分析，会把选择偏差
 * 读成错价（实测过一次：Over [0.10,0.30) 显示「隐含 77.7% vs 实测 45.9%」，
 * 等于 Over 3.5/4.5 赢了 54%，足球里不可能）。
 *
 * 所以这里的样本全集**与结果和后续价格无关地预先定义**：对每场比赛的每个
 * 目标档位，无论机器人是否交易、无论盘口好坏，都按固定节奏采样并落库，
 * 包括那些「无效盘口」的行（带 invalid_reason）——事后才能算出「有多少
 * 候选因为不可成交而被剔掉」这个分母。
 *
 * 本模块不下单、不建规则、不碰闸门。
 * 纯逻辑（盘口整理/有效性/节奏）在 line-monitor-book.ts，那边无 DB 依赖可测。
 */
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { pool } from '../../soccer/db.js'
import { extractTotalGoalLine, parseUtcish } from './goal-lines.js'
import { saveLineMonitorRows, type LineMonitorRow } from './db.js'
import {
  topLevels,
  judgeBook,
  cadenceSeconds,
  toMysqlUtc,
  passesMatchGate,
  DEFAULT_MONITOR_CONFIG,
  type MonitorConfig,
} from './line-monitor-book.js'

export { DEFAULT_MONITOR_CONFIG, type MonitorConfig }

const CLOB_BASE = process.env.CLOB_API_URL || 'https://clob.polymarket.com'

/**
 * 代理必须**请求时**解析，不能在模块加载时定死。
 *
 * 原来这里是 `const proxyUrl = process.env.HTTPS_PROXY || ''` 直接建 axios 实例。
 * 独立进程（line-monitor-runner）里环境变量的注入顺序在本模块 import 之后，
 * 于是 proxyUrl 恒为空串 → 直连 clob.polymarket.com → read ECONNRESET，
 * 连续几轮后变成 timeout of 20000ms exceeded。实测就是这个症状：
 * 「窗口8 采样8 回书0」——库侧查得到候选，网络侧一本书都没回来。
 *
 * 变量名的取值顺序必须与主进程一致（server.ts:102、price-bot.ts:83 都是
 * `HTTPS_PROXY || HTTP_PROXY`）。这里原先漏了 HTTP_PROXY，于是代理若是
 * 用那个名字传进来的，机器人连得上而采集器拿到空串——同一台机器上
 * 一个能跑一个不能，就是这个不一致造成的。
 */
let cachedAgent: HttpsProxyAgent<string> | null = null
let cachedProxyUrl: string | undefined

function proxyAgent(): HttpsProxyAgent<string> | undefined {
  const url =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    ''
  if (url !== cachedProxyUrl) {
    cachedProxyUrl = url
    cachedAgent = url ? new HttpsProxyAgent(url) : null
  }
  return cachedAgent ?? undefined
}

/**
 * timeout 给到 20s（机器人主路径是 5s）。
 * 这里一批就是几百个 token，比机器人单场十几个大一个量级，5s 会假失败。
 */
const restAxios = axios.create({
  baseURL: CLOB_BASE,
  timeout: 20000,
})

/** 与 price-bot.ts 一致：服务端对无效 token 静默丢弃，必须按 asset_id 对齐 */
const BOOKS_BATCH_SIZE = 50

interface Candidate {
  eventId: string
  marketId: string
  line: number
  /** 计划开哨的 epoch ms（parseUtcish 返回 number，不是 Date） */
  kickoffMs: number | null
  tokenId: string
  side: 'over' | 'under'
}

/** 解析 JSON 或逗号分隔（两种历史写法都见过，见 soccer/trading.ts:409） */
function parseJsonOrCsv(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  const s = String(v ?? '')
  if (!s) return []
  try {
    const p = JSON.parse(s)
    if (Array.isArray(p)) return p.map((x) => String(x))
  } catch {
    /* 落到 CSV */
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/**
 * 枚举当前时间窗内应当采样的候选。
 *
 * 窗口按**计划开哨**（soccer_events.end_time，UTC，已知取整到整/半点，±30min slop）。
 * 库里裸 DATETIME 必须走 parseUtcish：本机是 UTC+8，Date.parse 裸串会凭空多 480 分钟。
 */
export async function collectCandidates(
  cfg: MonitorConfig,
  now = new Date(),
): Promise<{ candidates: Candidate[]; gatedOut: Record<string, number> }> {
  const [rows] = await pool.query<any[]>(
    `SELECT m.id AS market_id, m.event_id, m.question_en, m.question_zh, m.line,
            m.outcomes, m.clob_token_ids, e.end_time,
            e.volume AS event_volume, e.liquidity AS event_liquidity
       FROM soccer_markets m
       JOIN soccer_events e ON e.id = m.event_id
      WHERE m.line IS NOT NULL
        AND m.clob_token_ids IS NOT NULL
        AND e.end_time IS NOT NULL
        AND e.end_time BETWEEN
              DATE_SUB(?, INTERVAL ? MINUTE) AND DATE_ADD(?, INTERVAL ? MINUTE)`,
    // 窗口反推：现在若在 [开哨-pre, 开哨+post] 内，则开哨在 [现在-post, 现在+pre]
    [now, cfg.postKickoffMinutes, now, cfg.preKickoffMinutes],
  )

  const wantLines = new Set(cfg.lines)
  const out: Candidate[] = []
  // 赛事级闸门按 event 计数（一场比赛只算一次），不按盘口行——
  // 同一场比赛在库里有 9 行 0.5 档（全场/半场/单队），下面 extractTotalGoalLine
  // 只留全场那一行，但闸门统计要的是「筛掉了几场」。
  const gatedEvents = new Map<string, string>()
  for (const r of rows) {
    const line = extractTotalGoalLine(r)
    if (line == null || !wantLines.has(line)) continue

    const gate = passesMatchGate(
      { volume: r.event_volume, liquidity: r.event_liquidity },
      cfg,
    )
    if (!gate.pass) {
      gatedEvents.set(String(r.event_id), gate.reason!)
      continue
    }

    const outcomes = parseJsonOrCsv(r.outcomes)
    const tokens = parseJsonOrCsv(r.clob_token_ids)
    // outcomes 与 clob_token_ids 按下标对齐（见 server.ts:1752）。
    // 只按 outcome 文本认边，绝不按下标猜——下标顺序一致是巧合。
    for (const side of ['over', 'under'] as const) {
      const idx = outcomes.findIndex((o) => o.trim().toLowerCase() === side)
      if (idx < 0 || tokens[idx] == null) continue
      out.push({
        eventId: String(r.event_id),
        marketId: String(r.market_id),
        line,
        kickoffMs: parseUtcish(r.end_time),
        tokenId: String(tokens[idx]),
        side,
      })
    }
  }
  const gatedOut: Record<string, number> = {}
  for (const reason of gatedEvents.values()) {
    gatedOut[reason] = (gatedOut[reason] ?? 0) + 1
  }
  return { candidates: out, gatedOut }
}

/** 批量取 book，按 asset_id 对齐。agent 每次请求现取，见 proxyAgent 注释。 */
async function fetchBooksBatch(tokenIds: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  for (let i = 0; i < tokenIds.length; i += BOOKS_BATCH_SIZE) {
    const chunk = tokenIds.slice(i, i + BOOKS_BATCH_SIZE)
    const resp = await restAxios.post(
      '/books',
      chunk.map((token_id) => ({ token_id })),
      { httpsAgent: proxyAgent() },
    )
    const arr = Array.isArray(resp.data) ? resp.data : []
    for (const book of arr) {
      if (book?.asset_id) out.set(String(book.asset_id), book)
    }
  }
  return out
}

/** tokenId -> 上次采样的 epoch ms。重启后重采一次，无害。 */
const lastSampled = new Map<string, number>()

/** 只留「按自身节奏该采」的候选 */
function filterDue(cands: Candidate[], now: Date): Candidate[] {
  const t = now.getTime()
  return cands.filter((c) => {
    const mm = c.kickoffMs != null ? Math.round((t - c.kickoffMs) / 60000) : null
    const need = cadenceSeconds(mm) * 1000
    const prev = lastSampled.get(c.tokenId)
    return prev == null || t - prev >= need
  })
}

export interface RoundResult {
  /** 时间窗内的候选总数（过了赛事闸门、含被节流跳过的） */
  inWindow: number
  /** 本轮实际采样的候选数 */
  candidates: number
  booksReturned: number
  inserted: number
  valid: number
  invalidByReason: Record<string, number>
  /** 被赛事级闸门筛掉的**场次**数，按原因分组 */
  gatedOut: Record<string, number>
}

/**
 * 跑一轮采样。
 *
 * 一轮内所有行共享同一个 snapshotAt——否则事后没法把同一轮的 over/under
 * 两侧配成一对来对照「1-Over_bid 与 Under 真实 ask 差多少」。
 */
export async function runMonitorRound(
  cfg: MonitorConfig = DEFAULT_MONITOR_CONFIG,
  now = new Date(),
): Promise<RoundResult> {
  const { candidates: all, gatedOut } = await collectCandidates(cfg, now)
  const cands = filterDue(all, now)
  const res: RoundResult = {
    inWindow: all.length,
    candidates: cands.length,
    booksReturned: 0,
    inserted: 0,
    valid: 0,
    invalidByReason: {},
    gatedOut,
  }
  if (!cands.length) return res

  const snapshotAt = toMysqlUtc(now)
  const tokenIds = [...new Set(cands.map((c) => c.tokenId))]
  let books: Map<string, any>
  try {
    books = await fetchBooksBatch(tokenIds)
  } catch (err: any) {
    console.error('[LineMonitor] POST /books 失败:', err?.message)
    return res
  }
  res.booksReturned = books.size
  // 取到盘口就算这一轮采过了。放在写库之前：写库失败也不该让下一轮
  // 立刻重打同一批 token（那会在 CLOB 出问题时把请求量放大成死循环）。
  for (const t of tokenIds) lastSampled.set(t, now.getTime())

  const rows: LineMonitorRow[] = []
  for (const c of cands) {
    const book = books.get(c.tokenId)
    const bids = book ? topLevels(book, 'bids') : []
    const asks = book ? topLevels(book, 'asks') : []
    const j = book ? judgeBook(bids, asks, cfg) : { valid: false, reason: 'no_book' }
    if (j.valid) res.valid++
    else res.invalidByReason[j.reason!] = (res.invalidByReason[j.reason!] ?? 0) + 1

    // 保留负数表示赛前。不用 matchMinuteFrom：它把赛前钳成 0，
    // 而「这条样本是不是赛前采的」正是选择偏差的关键标记。
    const matchMinute =
      c.kickoffMs != null ? Math.round((now.getTime() - c.kickoffMs) / 60000) : null

    rows.push({
      eventId: c.eventId,
      marketId: c.marketId,
      line: c.line,
      tokenId: c.tokenId,
      side: c.side,
      snapshotAt,
      kickoffAt: c.kickoffMs != null ? toMysqlUtc(new Date(c.kickoffMs)) : null,
      matchMinute,
      matchStatus: null,
      homeScore: null,
      awayScore: null,
      bestBid: bids.length ? bids[0][0] : null,
      bestAsk: asks.length ? asks[0][0] : null,
      bidDepth: bids,
      askDepth: asks,
      bookValid: j.valid,
      invalidReason: j.reason,
    })
  }

  res.inserted = await saveLineMonitorRows(rows)
  return res
}
