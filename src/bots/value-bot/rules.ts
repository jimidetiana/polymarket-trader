/**
 * 盘口概率规则 - 不同盘口类型使用不同的概率计算方式
 *
 * 规则系统设计为可扩展:
 * - 每种盘口类型实现 ProbabilityRule 接口
 * - 通过 ruleRegistry 注册和查找
 * - 新增盘口类型只需添加新规则并注册
 */

import { calculateLiveProbabilities, calculateLiveHandicapProbabilities } from './probability-model'
import type { InitialOdds, MatchContext, PolymarketMarket, ProbabilityResult, ProbabilityRule } from './types'

/**
 * 胜平负盘口规则
 *
 * Polymarket 胜平负盘口格式:
 * - 可能是3结果市场: outcomes=["Home/Yes","Draw","Away/Yes"], prices=[0.45,0.28,0.27]
 * - 可能是多个2结果市场: "Will [Team] win?" → Yes/No
 *
 * 对每个 outcome，计算模型概率并与市场隐含概率比较
 */
export class MoneylineRule implements ProbabilityRule {
  marketType = 'moneyline'
  marketTypeName = '胜平负'
  description = '基于泊松分布预测比赛结果概率。从初盘赔率推导主客队期望进球数λ，实时根据比赛时间和比分通过Skellam分布计算当前胜/平/负概率。'
  formula = 'P(胜/平/负) = Skellam(λ_home_remaining, λ_away_remaining, 当前比分差)\nλ_remaining = λ_full × (1 - t/90)^0.84'

  calculate(ctx: MatchContext, market: PolymarketMarket, initial: InitialOdds): ProbabilityResult[] {
    const { home, draw, away } = calculateLiveProbabilities(initial, ctx)

    // 应用比赛偏向调整
    const biasDir = initial.biasDirection || 'none'
    const biasCoef = initial.biasCoefficient || 0
    const adjHome = applyBias(home, 'home', biasDir, biasCoef)
    const adjDraw = applyBias(draw, 'draw', biasDir, biasCoef)
    const adjAway = applyBias(away, 'away', biasDir, biasCoef)

    const results: ProbabilityResult[] = []

    // 2-outcome Yes/No 市场：根据 question 判断 Yes 对应的角色
    if (market.outcomes.length === 2) {
      const yesIdx = market.outcomes.findIndex((o) => o.toLowerCase() === 'yes')
      const noIdx = market.outcomes.findIndex((o) => o.toLowerCase() === 'no')
      if (yesIdx >= 0 && noIdx >= 0) {
        const role = detectYesRole(market, initial)
        const yesProb = role === 'home' ? adjHome : role === 'draw' ? adjDraw : role === 'away' ? adjAway : 0
        const noProb = 1 - yesProb

        const probMap: Record<number, number> = { [yesIdx]: yesProb, [noIdx]: noProb }
        for (let i = 0; i < market.outcomes.length; i++) {
          const marketPrice = market.outcomePrices[i] || 0
          const modelProb = probMap[i] ?? 0
          const edge = modelProb - marketPrice
          results.push({
            outcome: market.outcomes[i],
            modelProbability: modelProb,
            marketPrice,
            impliedProbability: marketPrice,
            edge,
            recommendation: edge > 0.03 ? 'BUY' : edge < -0.03 ? 'SELL' : 'PASS',
          })
        }
        return results
      }
    }

    // 3-outcome 或其他市场：用 outcome 标签识别角色
    const modelProbs: Record<string, number> = { home: adjHome, draw: adjDraw, away: adjAway }
    const outcomeMap = identifyMoneylineOutcomes(market, initial)

    for (let i = 0; i < market.outcomes.length; i++) {
      const outcomeLabel = market.outcomes[i]
      const marketPrice = market.outcomePrices[i] || 0
      const impliedProb = marketPrice
      const role = outcomeMap[outcomeLabel] || outcomeMap[i] || ''

      const modelProb = modelProbs[role] ?? 0
      const edge = modelProb - impliedProb

      results.push({
        outcome: outcomeLabel,
        modelProbability: modelProb,
        marketPrice,
        impliedProbability: impliedProb,
        edge,
        recommendation: edge > 0.03 ? 'BUY' : edge < -0.03 ? 'SELL' : 'PASS',
      })
    }

    return results
  }
}

/**
 * 让球盘规则
 *
 * Polymarket 让球盘格式:
 * - question: "Team A vs Team B - Spread" 或类似
 * - line: 让球线 (如 -0.5 表示主队让0.5球)
 * - outcomes: ["Yes", "No"] 或 ["Home", "Away"]
 */
export class SpreadRule implements ProbabilityRule {
  marketType = 'spread'
  marketTypeName = '让球盘'
  description = '基于泊松分布计算让球盘概率。在胜平负模型基础上加入让球线(handicap)，计算让球后的胜/负概率（含走盘概率）。'
  formula = 'P(让胜/让负) = Skellam(λ_home_remaining, λ_away_remaining, 当前比分差 + 让球线)\nλ_remaining = λ_full × (1 - t/90)^0.84'

  calculate(ctx: MatchContext, market: PolymarketMarket, initial: InitialOdds): ProbabilityResult[] {
    const rawHandicap = Number(market.line ?? 0)
    // 判断让球方向：question 中提到的是主队还是客队
    const q = (market.question || '').toLowerCase()
    const homeLower = initial.homeTeam.toLowerCase()
    const awayLower = initial.awayTeam.toLowerCase()
    const isHomeHandicap = q.includes(homeLower) && !q.includes(awayLower)
    const isAwayHandicap = q.includes(awayLower) && !q.includes(homeLower)
    // 如果是客队让球，翻转符号（calculateHandicapProbabilities 中 handicap 是主队视角）
    const handicap = isAwayHandicap ? -rawHandicap : rawHandicap
    const { home, away } = calculateLiveHandicapProbabilities(
      initial,
      ctx,
      handicap,
    )

    // 应用比赛偏向调整
    const biasDir = initial.biasDirection || 'none'
    const biasCoef = initial.biasCoefficient || 0

    const results: ProbabilityResult[] = []

    for (let i = 0; i < market.outcomes.length; i++) {
      const outcomeLabel = market.outcomes[i]
      const marketPrice = market.outcomePrices[i] || 0
      const impliedProb = marketPrice

      // 判断该 outcome 是主队还是客队方向
      const isHome = isHomeOutcome(outcomeLabel, market, initial)
      const rawProb = isHome ? home : away
      const modelProb = applySpreadBias(rawProb, isHome, biasDir, biasCoef)
      const edge = modelProb - impliedProb

      results.push({
        outcome: outcomeLabel,
        modelProbability: modelProb,
        marketPrice,
        impliedProbability: impliedProb,
        edge,
        recommendation: edge > 0.03 ? 'BUY' : edge < -0.03 ? 'SELL' : 'PASS',
      })
    }

    return results
  }
}

// --- 辅助函数 ---

/**
 * 应用比赛偏向调整到概率上
 * @param prob 原始概率
 * @param role 该概率对应的角色 'home' | 'draw' | 'away'
 * @param biasDirection 比赛方向
 * @param biasCoefficient 比赛系数（如 0.05 = 5%）
 * @returns 调整后的概率
 */
function applyBias(
  prob: number,
  role: 'home' | 'draw' | 'away',
  biasDirection: 'home' | 'away' | 'none',
  biasCoefficient: number,
): number {
  if (biasDirection === 'none' || biasCoefficient === 0) return prob

  // 方向相同 → 加上系数
  // 方向相反 → 减去系数
  // 平局：如果偏向一方，平局概率降低（偏向方胜率升高，平概率自然降低）
  let delta = 0
  if (biasDirection === role) {
    delta = biasCoefficient
  } else if (role === 'draw') {
    delta = -biasCoefficient * 0.5  // 平局调整一半
  } else {
    delta = -biasCoefficient
  }

  const adjusted = prob + delta
  return Math.max(0, Math.min(1, adjusted))
}

/**
 * 应用比赛偏向调整到让球盘概率上
 * @param prob 原始概率
 * @param isHomeOutcome 是否是主队方向的 outcome
 * @param biasDirection 比赛方向
 * @param biasCoefficient 比赛系数
 */
function applySpreadBias(
  prob: number,
  isHomeOutcome: boolean,
  biasDirection: 'home' | 'away' | 'none',
  biasCoefficient: number,
): number {
  if (biasDirection === 'none' || biasCoefficient === 0) return prob

  const outcomeRole = isHomeOutcome ? 'home' : 'away'
  const delta = biasDirection === outcomeRole ? biasCoefficient : -biasCoefficient

  const adjusted = prob + delta
  return Math.max(0, Math.min(1, adjusted))
}

/**
 * 从 question 文本判断 Yes/No 市场中 Yes 对应的角色
 * 例如 "Will Malmo FF win?" → home, "Will it end in a draw?" → draw
 */
function detectYesRole(market: PolymarketMarket, initial: InitialOdds): 'home' | 'draw' | 'away' | '' {
  const q = (market.question || '').toLowerCase()
  const homeLower = initial.homeTeam.toLowerCase()
  const awayLower = initial.awayTeam.toLowerCase()

  if (q.includes('draw') || q.includes('tie') || q.includes('平')) {
    return 'draw'
  }
  if (q.includes(homeLower) && (q.includes('win') || q.includes('winner'))) {
    return 'home'
  }
  if (q.includes(awayLower) && (q.includes('win') || q.includes('winner'))) {
    return 'away'
  }
  // 模糊匹配：question 中只包含一个队名
  if (q.includes(homeLower) && !q.includes(awayLower)) return 'home'
  if (q.includes(awayLower) && !q.includes(homeLower)) return 'away'
  return ''
}

/**
 * 识别胜平负市场中的 outcome 角色
 * 返回 outcome标签 → 角色的映射
 */
function identifyMoneylineOutcomes(
  market: PolymarketMarket,
  initial: InitialOdds,
): Record<string, string> {
  const map: Record<string, string> = {}
  const homeLower = initial.homeTeam.toLowerCase()
  const awayLower = initial.awayTeam.toLowerCase()

  for (let i = 0; i < market.outcomes.length; i++) {
    const label = market.outcomes[i]
    const lower = label.toLowerCase()

    if (lower === 'home' || lower === 'yes' || lower.includes(homeLower) || lower.includes('主')) {
      // 需要进一步判断是主胜还是客胜
      if (lower.includes(awayLower)) {
        map[label] = 'away'
      } else {
        map[label] = 'home'
      }
    } else if (lower === 'away' || lower.includes(awayLower) || lower.includes('客')) {
      map[label] = 'away'
    } else if (lower === 'draw' || lower === 'tie' || lower.includes('平') || lower.includes('draw')) {
      map[label] = 'draw'
    } else {
      // 无法识别，按索引分配
      if (i === 0) map[label] = 'home'
      else if (i === 1) map[label] = 'draw'
      else if (i === 2) map[label] = 'away'
      else map[label] = 'other'
    }
  }

  return map
}

/**
 * 判断让球盘的 outcome 是主队还是客队方向
 */
function isHomeOutcome(outcomeLabel: string, market: PolymarketMarket, initial: InitialOdds): boolean {
  const lower = outcomeLabel.toLowerCase()
  const homeLower = initial.homeTeam.toLowerCase()
  const awayLower = initial.awayTeam.toLowerCase()

  // 明确的标签
  if (lower === 'home') return true
  if (lower === 'away') return false

  // Yes/No 市场：通过 question 判断方向
  if (lower === 'yes' || lower === 'no') {
    const q = (market.question || '').toLowerCase()
    if (q.includes(homeLower) && !q.includes(awayLower)) return lower === 'yes'
    if (q.includes(awayLower) && !q.includes(homeLower)) return lower === 'no'
    // 无法判断，默认第一个为主队
    return market.outcomes.indexOf(outcomeLabel) === 0
  }

  if (lower.includes(homeLower)) return true
  if (lower.includes(awayLower)) return false
  return market.outcomes.indexOf(outcomeLabel) === 0
}

// --- 规则注册表 ---

const ruleRegistry = new Map<string, ProbabilityRule>()

export function registerRule(rule: ProbabilityRule): void {
  ruleRegistry.set(rule.marketType, rule)
}

export function getRule(marketType: string): ProbabilityRule | undefined {
  return ruleRegistry.get(marketType)
}

export function getRegisteredRuleTypes(): string[] {
  return Array.from(ruleRegistry.keys())
}

export function getRuleMetas(): Array<{
  marketType: string
  marketTypeName: string
  description: string
  formula: string
}> {
  return Array.from(ruleRegistry.values()).map((r) => ({
    marketType: r.marketType,
    marketTypeName: r.marketTypeName,
    description: r.description,
    formula: r.formula,
  }))
}

// 注册默认规则
registerRule(new MoneylineRule())
registerRule(new SpreadRule())
