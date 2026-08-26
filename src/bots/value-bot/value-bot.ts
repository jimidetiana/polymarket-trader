/**
 * 价值投注机器人 - 主循环
 *
 * 架构:
 * - 按比赛单独启停，每场配置好的比赛可独立启动监控
 * - 定时器统一轮询所有已启动的比赛
 * - 每次计算保存详细日志：时间、比分、各盘口概率、买卖价量、性价比
 */

import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { pool } from '../../soccer/db'
import { ensureTables, saveMatchState, getMatchState, recordBets, getBetRecords, getAllMatchStates, getAvailablePolymarketMatches, setManualInitialOdds, deleteMatchState, saveCalcLogs, getCalcLogs, getCalcLogsAnalysis } from './bet-recorder'
import { createInitialOddsFromMarkets } from './probability-model'
import { evaluateMarket, filterValueBets, toBetRecord } from './value-calculator'
import { findPolymarketEvent, getEventMarkets, extractMoneylineProbabilities, fetchMarketBooks } from './market-matcher'
import { getRuleMetas } from './rules'
import { DEFAULT_CONFIG } from './types'
import type { LiveMatchState, PolymarketMarket, InitialOdds, MatchContext, ValueBetRecord, ValueBotConfig, CalcLogEntry, OutcomeBook } from './types'

function getSportsClient() {
  const base = process.env.SPORTS_API_BASE || 'https://sports.bzzoiro.com/api/v2'
  const token = process.env.SPORTS_API_TOKEN || ''
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  return axios.create({
    baseURL: base,
    timeout: 30000,
    headers: token ? { Authorization: `Token ${token}` } : {},
    ...(proxy ? { httpsAgent: new HttpsProxyAgent(proxy) } : {}),
  })
}

/** 单场比赛的监控状态 */
interface MatchMonitor {
  eventId: string
  running: boolean
  lastPollTime: string | null
  lastError: string | null
  cyclesRun: number
  totalLogs: number
}

/** 全局机器人状态 */
interface BotState {
  config: ValueBotConfig
  monitors: Map<string, MatchMonitor>
}

const state: BotState = {
  config: { ...DEFAULT_CONFIG },
  monitors: new Map(),
}

let pollTimer: NodeJS.Timeout | null = null

/**
 * 获取 bzzoiro 实时比赛（单场，按 event ID）
 */
async function fetchLiveMatch(bzzoiroEventId: number): Promise<LiveMatchState | null> {
  const client = getSportsClient()
  try {
    const resp = await client.get(`/events/${bzzoiroEventId}/`)
    const evt = resp.data
    const homeTeam = typeof evt.home_team === 'object' ? evt.home_team?.name || '' : evt.home_team || ''
    const awayTeam = typeof evt.away_team === 'object' ? evt.away_team?.name || '' : evt.away_team || ''

    let homeGoals = 0
    let awayGoals = 0
    if (evt.stats) {
      homeGoals = evt.stats.home_score ?? evt.stats.score?.home ?? 0
      awayGoals = evt.stats.away_score ?? evt.stats.score?.away ?? 0
    }
    if (evt.home_score !== undefined) homeGoals = evt.home_score
    if (evt.away_score !== undefined) awayGoals = evt.away_score

    let minute = 0
    if (evt.status?.current_minute) minute = evt.status.current_minute
    else if (evt.minute) minute = evt.minute

    return {
      bzzoiroEventId: evt.id,
      homeTeam,
      awayTeam,
      league: evt.league?.name || '',
      minute,
      status: evt.status?.type || evt.status || '',
      homeGoals,
      awayGoals,
      startTime: evt.start_time || evt.event_date,
    }
  } catch {
    return null
  }
}

/**
 * 从数据库获取已配置比赛的 bzzoiro 关联信息
 */
async function getMatchBzzoiroInfo(eventId: string): Promise<{ bzzoiroEventId: number | null; bzzoiroHomeTeam: string | null; bzzoiroAwayTeam: string | null; homeTeam: string; awayTeam: string }> {
  const [rows] = await pool.execute<any[]>(
    `SELECT event_id, home_team, away_team, bzzoiro_event_id, bzzoiro_home_team, bzzoiro_away_team
     FROM value_bot_match_state WHERE event_id = ?`,
    [eventId],
  )
  if (!rows.length) return { bzzoiroEventId: null, bzzoiroHomeTeam: null, bzzoiroAwayTeam: null, homeTeam: '', awayTeam: '' }
  const r = rows[0]
  return {
    bzzoiroEventId: r.bzzoiro_event_id ?? null,
    bzzoiroHomeTeam: r.bzzoiro_home_team,
    bzzoiroAwayTeam: r.bzzoiro_away_team,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
  }
}

/**
 * 处理单场比赛 - 获取比分、计算概率、保存日志
 */
async function processMatch(eventId: string): Promise<void> {
  const monitor = state.monitors.get(eventId)
  if (!monitor) return

  monitor.cyclesRun++

  try {
    // 1. 获取比赛配置信息
    const info = await getMatchBzzoiroInfo(eventId)
    if (info.bzzoiroEventId === null) {
      monitor.lastError = '未关联 bzzoiro 赛事'
      monitor.lastPollTime = new Date().toISOString()
      return
    }

    // 2. 获取 bzzoiro 实时比分
    const match = await fetchLiveMatch(info.bzzoiroEventId)
    if (!match) {
      monitor.lastError = '获取 bzzoiro 比分失败'
      monitor.lastPollTime = new Date().toISOString()
      return
    }

    // 2.5 检查比赛状态
    const matchStatus = String(match.status || '').toLowerCase()
    // 中场休息：不停止，继续轮询等待下半场开始
    const halftimeKeywords = ['halftime', 'half_time', 'interval', 'break']
    const isHalftime = halftimeKeywords.some((kw) => matchStatus.includes(kw))

    // 结束关键词（注意：ft 容易被 halftime 误匹配，用 full_time 代替）
    const finishedKeywords = ['finished', 'ended', 'completed', 'postponed', 'full_time', 'match_ended', 'closed', 'final']
    const isFinished = !isHalftime && finishedKeywords.some((kw) => matchStatus.includes(kw))

    if (isFinished) {
      console.log(`[ValueBot] 比赛 ${eventId} 已结束 (${matchStatus}), ${match.homeGoals}-${match.awayGoals}, 自动停止监控`)
      monitor.running = false
      monitor.lastError = `比赛已结束: ${matchStatus}`
      monitor.lastPollTime = new Date().toISOString()
      return
    }

    if (isHalftime) {
      // 中场休息：继续轮询但不记录日志（比分不会变化）
      if (monitor.cyclesRun % 10 === 1) {
        console.log(`[ValueBot] 比赛 ${eventId} 中场休息 (${matchStatus}), 继续监听等待下半场`)
      }
      monitor.lastError = null
      monitor.lastPollTime = new Date().toISOString()
      // 仍然继续执行，正常计算和记录日志（比分不变也没关系）
    }

    // 3. 获取初盘
    const initial = await getMatchState(eventId)
    if (!initial) {
      monitor.lastError = '未找到初盘配置'
      monitor.lastPollTime = new Date().toISOString()
      return
    }

    // 4. 获取 Polymarket 盘口
    const markets = await getEventMarkets(eventId, ['moneyline', 'spread'])
    if (!markets.length) {
      monitor.lastError = '无可用盘口'
      monitor.lastPollTime = new Date().toISOString()
      return
    }

    // 5. 构建比赛上下文
    const ctx: MatchContext = {
      minute: match.minute,
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
      status: match.status,
      totalMatchMinutes: state.config.totalMatchMinutes,
      timeDecayExponent: state.config.timeDecayExponent,
      maxGoals: state.config.maxGoals,
    }

    // 6. 逐个盘口评估 + 获取订单簿 + 保存日志
    const calcLogs: CalcLogEntry[] = []
    const valueBets: ValueBetRecord[] = []

    for (const market of markets) {
      // 计算模型概率
      const results = evaluateMarket(market, ctx, initial, state.config)

      // 获取订单簿数据
      const books = await fetchMarketBooks(market)
      const bookMap = new Map<string, OutcomeBook>()
      for (const b of books) bookMap.set(b.outcome, b)

      for (const result of results) {
        const book = bookMap.get(result.outcome)
        const bestBid = book?.bestBid ?? null
        const bestAsk = book?.bestAsk ?? null
        const modelProb = result.modelProbability

        // 用订单簿实际价格计算 edge
        // BUY 看卖价(bestAsk)：模型概率 > 买入价 → 值得买入
        // SELL 看买价(bestBid)：卖出价 > 模型概率 → 值得卖出
        let edge: number
        let recommendation: string
        if (bestAsk != null && modelProb - bestAsk > state.config.edgeThreshold) {
          edge = modelProb - bestAsk
          recommendation = 'BUY'
        } else if (bestBid != null && bestBid - modelProb > state.config.edgeThreshold) {
          edge = modelProb - bestBid
          recommendation = 'SELL'
        } else {
          const midPrice = bestBid != null && bestAsk != null
            ? (bestBid + bestAsk) / 2
            : bestAsk ?? bestBid ?? result.marketPrice
          edge = modelProb - midPrice
          recommendation = 'PASS'
        }

        const roundedEdge = Math.round(edge * 10000) / 10000
        const roundedProb = Math.round(modelProb * 10000) / 10000

        calcLogs.push({
          eventId,
          bzzoiroEventId: info.bzzoiroEventId,
          matchMinute: ctx.minute,
          homeScore: ctx.homeGoals,
          awayScore: ctx.awayGoals,
          marketId: market.marketId,
          marketType: market.marketType,
          question: market.question,
          outcome: result.outcome,
          handicap: market.line ?? null,
          modelProbability: roundedProb,
          bestBid,
          bestBidSize: book?.bestBidSize ?? null,
          bestAsk,
          bestAskSize: book?.bestAskSize ?? null,
          edge: roundedEdge,
          recommendation,
        })

        // 有性价比的记录到价值投注表
        if (recommendation !== 'PASS' && Math.abs(roundedEdge) >= state.config.edgeThreshold) {
          const updatedResult = { ...result, edge: roundedEdge, recommendation, modelProbability: roundedProb }
          valueBets.push(toBetRecord(updatedResult, market, ctx, initial, info.bzzoiroEventId!, state.config))
        }
      }
    }

    // 7. 保存计算日志
    if (calcLogs.length > 0) {
      await saveCalcLogs(calcLogs)
      monitor.totalLogs += calcLogs.length
    }

    // 8. 保存价值投注记录
    if (valueBets.length > 0) {
      await recordBets(valueBets)
    }

    monitor.lastError = null
    console.log(`[ValueBot] ${eventId}: 第${monitor.cyclesRun}轮, ${match.homeGoals}-${match.awayGoals} (${match.minute}'), ${calcLogs.length}条日志, ${valueBets.length}条价值投注`)
  } catch (err: any) {
    monitor.lastError = err.message
    console.error(`[ValueBot] 处理比赛 ${eventId} 出错:`, err.message)
  } finally {
    monitor.lastPollTime = new Date().toISOString()
  }
}

/**
 * 执行一个完整的轮询周期 - 处理所有已启动的比赛
 */
async function runCycle(): Promise<void> {
  const activeEventIds = Array.from(state.monitors.values())
    .filter((m) => m.running)
    .map((m) => m.eventId)

  if (activeEventIds.length === 0) return

  for (const eventId of activeEventIds) {
    await processMatch(eventId)
  }
}

/**
 * 启动某场比赛的监控
 */
export async function startMatch(eventId: string): Promise<void> {
  await ensureTables()

  let monitor = state.monitors.get(eventId)
  if (!monitor) {
    monitor = {
      eventId,
      running: false,
      lastPollTime: null,
      lastError: null,
      cyclesRun: 0,
      totalLogs: 0,
    }
    state.monitors.set(eventId, monitor)
  }

  if (monitor.running) return
  monitor.running = true

  console.log(`[ValueBot] 启动比赛监控: ${eventId}`)

  // 立即执行一次
  await processMatch(eventId)

  // 如果还没有全局定时器，启动一个
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      runCycle().catch((err) => console.error('[ValueBot] 定时任务出错:', err))
    }, state.config.pollIntervalMs)
  }
}

/**
 * 停止某场比赛的监控
 */
export function stopMatch(eventId: string): void {
  const monitor = state.monitors.get(eventId)
  if (monitor) {
    monitor.running = false
    console.log(`[ValueBot] 停止比赛监控: ${eventId}`)
  }

  // 如果没有活跃的比赛了，停止定时器
  const anyRunning = Array.from(state.monitors.values()).some((m) => m.running)
  if (!anyRunning && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * 获取所有比赛监控状态
 */
export function getMatchMonitors() {
  const result: any[] = []
  for (const [eventId, m] of state.monitors) {
    result.push({
      eventId,
      running: m.running,
      lastPollTime: m.lastPollTime,
      lastError: m.lastError,
      cyclesRun: m.cyclesRun,
      totalLogs: m.totalLogs,
    })
  }
  return result
}

/**
 * 获取单个比赛监控状态
 */
export function getMatchMonitor(eventId: string) {
  const m = state.monitors.get(eventId)
  if (!m) return null
  return {
    eventId,
    running: m.running,
    lastPollTime: m.lastPollTime,
    lastError: m.lastError,
    cyclesRun: m.cyclesRun,
    totalLogs: m.totalLogs,
  }
}

/**
 * 更新配置
 */
export function updateConfig(config: Partial<ValueBotConfig>): ValueBotConfig {
  state.config = { ...state.config, ...config }
  // 如果有定时器在运行，重启以应用新间隔
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      runCycle().catch((err) => console.error('[ValueBot] 定时任务出错:', err))
    }, state.config.pollIntervalMs)
  }
  return state.config
}

/**
 * 手动触发某场比赛一次计算
 */
export async function triggerMatchCycle(eventId: string): Promise<void> {
  await processMatch(eventId)
}

// 兼容旧接口
export async function startBot(config?: Partial<ValueBotConfig>): Promise<void> {
  if (config) state.config = { ...state.config, ...config }
  state.config.enabled = true
  // 启动所有已配置但未启动的比赛
  const allStates = await getAllMatchStates()
  for (const s of allStates) {
    await startMatch(s.event_id)
  }
}

export function stopBot(): void {
  for (const [eventId] of state.monitors) {
    stopMatch(eventId)
  }
  state.config.enabled = false
}

export function getBotStatus() {
  const monitors = getMatchMonitors()
  return {
    running: monitors.some((m: any) => m.running),
    lastPollTime: monitors.length ? monitors[0].lastPollTime : null,
    lastError: null,
    totalRecords: 0,
    cyclesRun: 0,
    config: state.config,
    monitors,
  }
}

export async function triggerCycle(): Promise<void> {
  await runCycle()
}

export { getBetRecords, getAllMatchStates, getAvailablePolymarketMatches, setManualInitialOdds, deleteMatchState, getRuleMetas, getCalcLogs, getCalcLogsAnalysis }
