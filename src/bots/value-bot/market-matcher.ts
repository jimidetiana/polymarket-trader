/**
 * 赛事匹配 - 将 bzzoiro 实时赛事匹配到 Polymarket 盘口事件
 */

import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { pool } from '../../soccer/db'
import type { LiveMatchState, PolymarketMarket, OutcomeBook } from './types'
import type { SoccerEventRow, SoccerMarketRow } from '../../soccer/db'

const CLOB_BASE = 'https://clob.polymarket.com'
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY

function getClobClient() {
  return axios.create({
    baseURL: CLOB_BASE,
    timeout: 10000,
    ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
  })
}

/**
 * 获取单个 token 的订单簿最优买卖价量
 */
async function fetchTokenBook(tokenId: string): Promise<{
  bestBid: number | null
  bestBidSize: number | null
  bestAsk: number | null
  bestAskSize: number | null
}> {
  try {
    const client = getClobClient()
    const resp = await client.get('/book', { params: { token_id: tokenId } })
    const data = resp.data
    const bids = data?.bids || []
    const asks = data?.asks || []

    let bestBid: number | null = null
    let bestBidSize: number | null = null
    if (bids.length > 0) {
      const sorted = bids
        .map((b: any) => ({ price: Number(b.price), size: Number(b.size) }))
        .filter((b: any) => b.price > 0 && b.size > 0)
        .sort((a: any, b: any) => b.price - a.price)
      if (sorted.length > 0) {
        bestBid = sorted[0].price
        bestBidSize = sorted[0].size
      }
    }

    let bestAsk: number | null = null
    let bestAskSize: number | null = null
    if (asks.length > 0) {
      const sorted = asks
        .map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
        .filter((a: any) => a.price > 0 && a.size > 0)
        .sort((a: any, b: any) => a.price - b.price)
      if (sorted.length > 0) {
        bestAsk = sorted[0].price
        bestAskSize = sorted[0].size
      }
    }

    return { bestBid, bestBidSize, bestAsk, bestAskSize }
  } catch {
    return { bestBid: null, bestBidSize: null, bestAsk: null, bestAskSize: null }
  }
}

/**
 * 批量获取盘口所有 outcome 的订单簿数据
 */
export async function fetchMarketBooks(
  market: PolymarketMarket,
): Promise<OutcomeBook[]> {
  const books: OutcomeBook[] = []
  for (let i = 0; i < market.outcomes.length; i++) {
    const tokenId = market.clobTokenIds[i]
    if (!tokenId) {
      books.push({
        outcome: market.outcomes[i],
        tokenId: '',
        bestBid: null,
        bestBidSize: null,
        bestAsk: null,
        bestAskSize: null,
      })
      continue
    }
    const book = await fetchTokenBook(tokenId)
    books.push({
      outcome: market.outcomes[i],
      tokenId,
      ...book,
    })
  }
  return books
}

// 常见球队名后缀
const SUFFIXES = [' FC', ' CF', ' SC', ' CD', ' SD', ' SK', ' FK', ' KF', ' AFC', ' B', ' II']

/**
 * 解析字段：兼容 JSON 数组和逗号分隔字符串
 */
function parseJsonOrCsv(raw: string | null | undefined): string[] {
  if (!raw) return []
  const s = String(raw).trim()
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed)) return parsed.map(String)
    return [String(parsed)]
  } catch {
    return s.split(',').map((x) => x.trim()).filter(Boolean)
  }
}

function normalizeName(name: string): string {
  let n = name.trim().toLowerCase()
  for (const s of SUFFIXES) {
    if (n.endsWith(s.toLowerCase())) n = n.slice(0, -s.length).trim()
  }
  return n
}

/**
 * 模糊匹配球队名
 */
function teamNamesMatch(name1: string, name2: string): boolean {
  const n1 = name1.trim().toLowerCase()
  const n2 = name2.trim().toLowerCase()
  if (n1 === n2) return true
  if (n1.includes(n2) || n2.includes(n1)) return true
  const norm1 = normalizeName(name1)
  const norm2 = normalizeName(name2)
  if (norm1 === norm2) return true
  if (norm1.includes(norm2) || norm2.includes(norm1)) return true
  return false
}

/**
 * 从数据库查找与 bzzoiro 实时赛事匹配的 Polymarket 事件
 */
export async function findPolymarketEvent(
  homeTeam: string,
  awayTeam: string,
): Promise<SoccerEventRow | null> {
  // 查询今天活跃的足球赛事
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM soccer_events
     WHERE event_status = 'active'
     AND (home_team_en IS NOT NULL OR away_team_en IS NOT NULL)
     ORDER BY start_time ASC
     LIMIT 200`,
  )

  for (const row of rows) {
    const pmHome = row.home_team_en || ''
    const pmAway = row.away_team_en || ''

    // 主客队都匹配
    const homeMatch = teamNamesMatch(homeTeam, pmHome) || teamNamesMatch(homeTeam, pmAway)
    const awayMatch = teamNamesMatch(awayTeam, pmAway) || teamNamesMatch(awayTeam, pmHome)

    if (homeMatch && awayMatch) {
      // 验证方向正确（主队对主队，客队对客队）
      const directMatch =
        (teamNamesMatch(homeTeam, pmHome) && teamNamesMatch(awayTeam, pmAway)) ||
        (teamNamesMatch(homeTeam, pmAway) && teamNamesMatch(awayTeam, pmHome))
      if (directMatch) return row as SoccerEventRow
    }
  }

  return null
}

/**
 * 获取赛事关联的盘口数据
 */
export async function getEventMarkets(
  eventId: string,
  types: string[] = ['moneyline', 'spread'],
): Promise<PolymarketMarket[]> {
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM soccer_markets WHERE event_id = ? AND market_status = 'active'`,
    [eventId],
  )

  const markets: PolymarketMarket[] = []
  for (const row of rows as SoccerMarketRow[]) {
    if (!types.includes(row.market_type)) continue

    const outcomes = parseJsonOrCsv(row.outcomes as string)
    const prices = parseJsonOrCsv(row.outcome_prices as string)
    const tokenIds = parseJsonOrCsv(row.clob_token_ids as string)

    if (!outcomes.length || !prices.length) continue

    markets.push({
      marketId: row.id,
      eventId: row.event_id,
      marketType: row.market_type,
      question: row.question_en,
      outcomes,
      outcomePrices: prices.map((p: any) => Number(p)),
      clobTokenIds: tokenIds,
      line: row.line != null ? Number(row.line) : null,
      bestBid: row.best_bid ?? null,
      bestAsk: row.best_ask ?? null,
      volume: row.volume,
    })
  }

  return markets
}

/**
 * 从胜平负盘口提取初始概率
 *
 * Polymarket 的胜平负可能是:
 * 1. 一个3结果市场 (outcomes=["Home","Draw","Away"])
 * 2. 多个2结果市场 ("Will X win?" → Yes/No)
 *
 * 对于情况2，需要找到3个独立的 yes/no 市场来推导概率
 */
export function extractMoneylineProbabilities(
  markets: PolymarketMarket[],
  homeTeam: string,
  awayTeam: string,
): { home: number; draw: number; away: number } | null {
  // 情况1: 3结果市场
  for (const m of markets) {
    if (m.marketType === 'moneyline' && m.outcomes.length === 3) {
      // 归一化价格作为概率
      const total = m.outcomePrices.reduce((s, p) => s + p, 0)
      if (total > 0) {
        const probs = m.outcomePrices.map((p) => p / total)
        // 尝试识别哪个是主胜/平/客胜
        const normalized = identify1x2Outcomes(m.outcomes, homeTeam, awayTeam)
        if (normalized) {
          return {
            home: probs[normalized.homeIdx],
            draw: probs[normalized.drawIdx],
            away: probs[normalized.awayIdx],
          }
        }
        // 默认按顺序
        return { home: probs[0], draw: probs[1], away: probs[2] }
      }
    }
  }

  // 情况2: 多个2结果市场
  // 查找 "Will [Team] win?" 类型的盘口
  let homeProb = 0
  let drawProb = 0
  let awayProb = 0
  let found = 0

  for (const m of markets) {
    if (m.marketType !== 'moneyline' || m.outcomes.length !== 2) continue
    const q = m.question.toLowerCase()
    const homeLower = homeTeam.toLowerCase()
    const awayLower = awayTeam.toLowerCase()

    // 找 Yes 价格
    const yesIdx = m.outcomes.findIndex((o) => o.toLowerCase() === 'yes')
    const noIdx = m.outcomes.findIndex((o) => o.toLowerCase() === 'no')
    if (yesIdx < 0) continue
    const yesPrice = m.outcomePrices[yesIdx]

    if (q.includes(homeLower) && (q.includes('win') || q.includes('winner'))) {
      homeProb = yesPrice
      found++
    } else if (q.includes(awayLower) && (q.includes('win') || q.includes('winner'))) {
      awayProb = yesPrice
      found++
    } else if (q.includes('draw') || q.includes('tie')) {
      drawProb = yesPrice
      found++
    }
  }

  if (found >= 2) {
    // 归一化
    const total = homeProb + drawProb + awayProb
    if (total > 0) {
      return { home: homeProb / total, draw: drawProb / total, away: awayProb / total }
    }
  }

  return null
}

function identify1x2Outcomes(
  outcomes: string[],
  homeTeam: string,
  awayTeam: string,
): { homeIdx: number; drawIdx: number; awayIdx: number } | null {
  const homeLower = homeTeam.toLowerCase()
  const awayLower = awayTeam.toLowerCase()
  let homeIdx = -1
  let drawIdx = -1
  let awayIdx = -1

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i].toLowerCase()
    if (o === 'draw' || o === 'tie' || o.includes('平')) {
      drawIdx = i
    } else if (o.includes(homeLower) || o === 'home' || o === '1') {
      homeIdx = i
    } else if (o.includes(awayLower) || o === 'away' || o === '2') {
      awayIdx = i
    }
  }

  if (homeIdx >= 0 && awayIdx >= 0) {
    if (drawIdx < 0) {
      drawIdx = outcomes.findIndex((_, i) => i !== homeIdx && i !== awayIdx)
    }
    return { homeIdx, drawIdx, awayIdx }
  }

  return null
}
