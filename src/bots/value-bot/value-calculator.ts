/**
 * 性价比计算器 - 比较模型概率与市场隐含概率，计算 edge
 */

import type { ProbabilityResult, PolymarketMarket, InitialOdds, MatchContext, ValueBetRecord, ValueBotConfig } from './types'
import { getRule } from './rules'

/**
 * 对单个盘口计算所有 outcome 的性价比
 */
export function evaluateMarket(
  market: PolymarketMarket,
  ctx: MatchContext,
  initial: InitialOdds,
  config: ValueBotConfig,
): ProbabilityResult[] {
  const rule = getRule(market.marketType)
  if (!rule) return []

  return rule.calculate(ctx, market, initial)
}

/**
 * 筛选出有性价比的记录
 */
export function filterValueBets(
  results: ProbabilityResult[],
  config: ValueBotConfig,
): ProbabilityResult[] {
  return results.filter((r) => Math.abs(r.edge) >= config.edgeThreshold && r.recommendation !== 'PASS')
}

/**
 * 将计算结果转换为数据库记录
 */
export function toBetRecord(
  result: ProbabilityResult,
  market: PolymarketMarket,
  ctx: MatchContext,
  initial: InitialOdds,
  bzzoiroEventId: number,
  config: ValueBotConfig,
): ValueBetRecord {
  return {
    botId: config.botId,
    polymarketEventId: market.eventId,
    bzzoiroEventId,
    marketId: market.marketId,
    marketType: market.marketType,
    question: market.question,
    outcome: result.outcome,
    handicap: market.line ?? null,
    modelProbability: Math.round(result.modelProbability * 10000) / 10000,
    marketPrice: Math.round(result.marketPrice * 10000) / 10000,
    impliedProbability: Math.round(result.impliedProbability * 10000) / 10000,
    edge: Math.round(result.edge * 10000) / 10000,
    matchMinute: ctx.minute,
    currentScore: `${ctx.homeGoals}-${ctx.awayGoals}`,
    lambdaHome: initial.lambdaHome,
    lambdaAway: initial.lambdaAway,
    recommendation: result.recommendation,
    status: 'recorded',
  }
}
