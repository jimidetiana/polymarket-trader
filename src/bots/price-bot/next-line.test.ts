/**
 * 下一档开档决策测试。
 *
 * 跑法：npx tsx --test src/bots/price-bot/next-line.test.ts
 *
 * 用例主要来自 46 场已结算 goal_surge 实单里那 8 笔亏损的形态：
 * 清水心跳（0.5 打出后按 0.69 买 2.5）、乌迪内斯（3 球后按 0.67 买 3.5）、
 * 塞尔塔（按 0.90 买未打出的 2.5）。它们的共同点是买了「还没打出的下一档」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideNextLineOpening,
  inferLambdaFromOver25,
  fairNextGoalProb,
  impliedOverPrice,
  buyGateReason,
  isSurgeMuted,
  extendMuteUntil,
} from './next-line.js'
import {
  extractTotalGoalLine,
  nextTotalGoalLine,
  matchMinuteFrom,
  TOTAL_GOAL_LINES,
} from './goal-lines.js'

// ==================== λ 反推 ====================

test('从初盘 Over 2.5 反推的 λ 能还原回原价', () => {
  for (const price of [0.35, 0.42, 0.5, 0.62, 0.78]) {
    const lambda = inferLambdaFromOver25(price)
    assert.ok(lambda != null, `${price} 应能反推出 λ`)
    const back = impliedOverPrice(lambda, 2.5)
    assert.ok(back != null)
    assert.ok(Math.abs(back! - price) < 1e-4, `λ=${lambda} 还原出 ${back}，应接近 ${price}`)
  }
})

test('λ 随初盘 Over 2.5 单调递增', () => {
  const a = inferLambdaFromOver25(0.35)!
  const b = inferLambdaFromOver25(0.55)!
  assert.ok(a < b, `0.35→${a} 应小于 0.55→${b}`)
})

test('越界价格反推不出 λ，不拿假数字往下算', () => {
  assert.equal(inferLambdaFromOver25(0), null)
  assert.equal(inferLambdaFromOver25(1), null)
  assert.equal(inferLambdaFromOver25(-0.2), null)
  assert.equal(inferLambdaFromOver25(null), null)
  assert.equal(inferLambdaFromOver25(undefined), null)
})

// ==================== 公平价 ====================

test('公平价随比赛推进单调下降', () => {
  const lambda = 2.5
  const p10 = fairNextGoalProb(lambda, 1, 10)!.fairProb
  const p45 = fairNextGoalProb(lambda, 1, 45)!.fairProb
  const p80 = fairNextGoalProb(lambda, 1, 80)!.fairProb
  assert.ok(p10 > p45 && p45 > p80, `应递减：${p10} > ${p45} > ${p80}`)
})

test('需要两个球的公平价明显低于需要一个球', () => {
  const one = fairNextGoalProb(2.5, 1, 40)!.fairProb
  const two = fairNextGoalProb(2.5, 2, 40)!.fairProb
  assert.ok(two < one * 0.7, `跳档（需2球）${two} 应远低于正常递进（需1球）${one}`)
})

test('比赛结束后公平价为 0', () => {
  const r = fairNextGoalProb(2.5, 1, 90)
  assert.ok(r)
  assert.equal(r!.fairProb, 0)
})

test('分钟未知时不做时间衰减，用全场 λ（宽松侧）', () => {
  const unknown = fairNextGoalProb(2.5, 1, null)!
  const atZero = fairNextGoalProb(2.5, 1, 0)!
  assert.equal(unknown.fairProb, atZero.fairProb)
})

// ==================== 买入闸门 ====================

test('买入闸门：比分没打出该线就拒绝', () => {
  // 清水心跳：总进球 1~2，却买了 Over 2.5（需 3 球）
  assert.ok(buyGateReason(2.5, 2) != null)
  assert.ok(buyGateReason(2.5, 1) != null)
  // 打出了才放行
  assert.equal(buyGateReason(2.5, 3), null)
  assert.equal(buyGateReason(2.5, 4), null)
  assert.equal(buyGateReason(0.5, 1), null)
})

test('买入闸门：比分未知时拒绝（与开档相反）', () => {
  const why = buyGateReason(1.5, null)
  assert.ok(why != null)
  assert.match(why!, /比分未知/)
})

// ==================== 开档决策：样本里的亏损形态 ====================

test('清水心跳形态：只打出 0.5 就跳去开 2.5，被判影子不授权', () => {
  // 只进了 1 球（0.5 打出），下一档若按 2.5 算需要 3 球 —— 但正常递进是 1.5。
  // 这里模拟人工跳档：settledLine=1.5 而比分只有 1 球 → 比分落后
  const d = decideNextLineOpening({
    settledLine: 1.5,
    kickoffOver25: 0.42,
    bestBid: 0.69,
    minute: 40,
    totalGoals: 1,
  })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'score_behind')
})

test('清水心跳形态之二：1 球时 Over 2.5 报 0.69 远高于公平价，开但静默', () => {
  // settledLine=0.5（真打出了 1 球），下一档 1.5 需要 2 球... 但样本里买的是 2.5。
  // 用 totalGoals=1 + settledLine=0.5 → 下一档 1.5，需 1 球。
  // 直接检验「2.5 这档在 1 球时的公平价」：需 2 球
  const fair = fairNextGoalProb(inferLambdaFromOver25(0.42), 2, 40)!
  assert.ok(fair.fairProb < 0.5, `1 球、第40分钟买 Over 2.5 的公平价 ${fair.fairProb} 应低于 0.5`)
  assert.ok(0.69 - fair.fairProb > 0.12, '实付 0.69 相对公平价的溢价应被判为影子')
})

test('乌迪内斯形态：3 球后 Over 3.5 报 0.67 高于公平价，开监控但静默', () => {
  const d = decideNextLineOpening({
    settledLine: 2.5,
    kickoffOver25: 0.5,
    bestBid: 0.67,
    bestAsk: 0.71,
    minute: 70,
    totalGoals: 3,
  })
  assert.equal(d.open, true, '真进了 3 球，4.5 之前的档位该继续盯')
  assert.equal(d.reasonCode, 'shadow_hot')
  assert.ok(d.cooldownMs >= 60_000, '影子档位要静默足够久，别让余震涨幅触发买入')
  assert.match(d.reason, /影子/)
})

test('塞尔塔形态：Over 2.5 报 0.90 而公平价仅约 0.66，判影子', () => {
  const d = decideNextLineOpening({
    settledLine: 1.5,
    kickoffOver25: 0.5,
    bestBid: 0.9,
    bestAsk: 0.93,
    minute: 60,
    totalGoals: 2,
  })
  assert.equal(d.reasonCode, 'shadow_hot')
  assert.ok(d.open, '开监控是对的，错的是在这个价位买')
  assert.ok(d.fairProb != null && d.fairProb < 0.8)
})

// ==================== 开档决策：该开的要开 ====================

test('开哨后第 10 分钟进球，下一档 0.88 是公平的，正常开档', () => {
  const d = decideNextLineOpening({
    settledLine: 0.5,
    kickoffOver25: 0.55,
    bestBid: 0.88,
    bestAsk: 0.9,
    minute: 10,
    totalGoals: 1,
  })
  assert.equal(d.open, true)
  assert.equal(d.reasonCode, 'ok', `本该正常开档，实际 ${d.reasonCode}: ${d.reason}`)
  assert.ok(d.fairProb != null && d.fairProb > 0.85, `公平价 ${d.fairProb} 应高于报价 0.88 附近`)
  assert.ok(d.cooldownMs > 0, '正常开档也要静默，上一档的涨幅不属于这一档')
})

test('高进球比赛做到 4.5 档照样开：样本里 4.5 是唯一零亏损分组', () => {
  const d = decideNextLineOpening({
    settledLine: 3.5,
    kickoffOver25: 0.62,
    bestBid: 0.7,
    bestAsk: 0.73,
    minute: 55,
    totalGoals: 4,
  })
  assert.equal(d.open, true, `4.5 档不该被一刀切，实际 ${d.reasonCode}: ${d.reason}`)
})

// ==================== 开档决策：结构性挡掉 ====================

// 这条曾断言「不开档」。实测推翻了它：真实成交里第 60 分钟后那批
// （n=20，胜率 95%，ROI +23.1%）是唯一稳定为正的，按公平价高低拦会一起挡掉。
// 低公平价本身不是拒绝理由，价格有没有跟着虚高才是。
test('尾盘公平价低但价格没虚高：照开，标 cheap_value', () => {
  const d = decideNextLineOpening({
    settledLine: 1.5,
    kickoffOver25: 0.5,
    bestBid: 0.2,
    bestAsk: 0.24,
    minute: 85,
    totalGoals: 2,
  })
  assert.equal(d.open, true, `实际 ${d.reasonCode}: ${d.reason}`)
  assert.equal(d.reasonCode, 'cheap_value')
  assert.ok(d.fairProb != null && d.fairProb < 0.3, `公平价应低于 0.3，实际 ${d.fairProb}`)
  // 不加长静默：这形态本身就是要抓那一下涨，多静默就抓不到了
  assert.equal(d.cooldownMs, 8_000)
})

test('尾盘同样低的公平价，但价格虚高 → 仍判影子并静默 60s', () => {
  const d = decideNextLineOpening({
    settledLine: 1.5,
    kickoffOver25: 0.5,
    bestBid: 0.88,
    bestAsk: 0.9,
    minute: 85,
    totalGoals: 2,
  })
  assert.equal(d.reasonCode, 'shadow_hot', `实际 ${d.reasonCode}: ${d.reason}`)
  assert.equal(d.open, true)
  assert.ok(d.cooldownMs >= 60_000)
  // 关键：与上一条的公平价一致，唯一的差别是价格 —— 证明分流靠的是价格不是概率
  assert.ok(d.fairProb != null && d.fairProb < 0.3)
})

test('比赛已结束（分钟 ≥ 90）不开档', () => {
  const d = decideNextLineOpening({
    settledLine: 1.5,
    kickoffOver25: 0.5,
    bestBid: 0.1,
    minute: 92,
    totalGoals: 2,
  })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'low_fair_prob')
  assert.equal(d.fairProb, 0)
})

test('盘口过薄不开档：那种价格不能拿来做判断', () => {
  const d = decideNextLineOpening({
    settledLine: 0.5,
    kickoffOver25: 0.55,
    bestBid: 0.6,
    bestAsk: 0.85,
    minute: 20,
    totalGoals: 1,
  })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'thin_book')
})

test('低进球比赛的高档位初盘就极低，不开档', () => {
  // 初盘 Over 2.5 仅 0.22 → λ≈1.5，Over 4.5 初盘约 0.02
  const d = decideNextLineOpening({
    settledLine: 3.5,
    kickoffOver25: 0.22,
    bestBid: 0.3,
    minute: 30,
    totalGoals: 4,
  })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'cheap_kickoff')
})

test('实测初盘价优先于 λ 推算', () => {
  const d = decideNextLineOpening({
    settledLine: 2.5,
    kickoffOver25: 0.55,
    kickoffNextOver: 0.03, // 实测极低，与 λ 推算不符时以实测为准
    bestBid: 0.4,
    minute: 30,
    totalGoals: 3,
  })
  assert.equal(d.reasonCode, 'cheap_kickoff')
  assert.match(d.reason, /实测/)
})

// ==================== 开档决策：无快照 / 无下一档 ====================

test('缺初盘快照时照开监控但标记不授权（今晚连不上交易所也要能递进）', () => {
  const d = decideNextLineOpening({
    settledLine: 0.5,
    kickoffOver25: null,
    bestBid: 0.88,
    minute: 30,
    totalGoals: 1,
  })
  assert.equal(d.open, true)
  assert.equal(d.reasonCode, 'no_snapshot')
  assert.ok(d.cooldownMs > 0)
  assert.match(d.reason, /不授权/)
})

test('4.5 已是最高档，无下一档', () => {
  const d = decideNextLineOpening({ settledLine: 4.5, kickoffOver25: 0.6, totalGoals: 5 })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'no_next_line')
  assert.equal(d.nextLine, null)
})

test('识别不出当前档位时不递进', () => {
  const d = decideNextLineOpening({ settledLine: null, kickoffOver25: 0.5 })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'no_next_line')
})

test('比分源落后于完结动作时不递进', () => {
  // 点了完结 Over 2.5（需 3 球），但比分源只有 2 球
  const d = decideNextLineOpening({
    settledLine: 2.5,
    kickoffOver25: 0.5,
    bestBid: 0.8,
    minute: 60,
    totalGoals: 2,
  })
  assert.equal(d.open, false)
  assert.equal(d.reasonCode, 'score_behind')
})

test('比分未知时按「上一档已打出」推断，仍可递进', () => {
  const d = decideNextLineOpening({
    settledLine: 0.5,
    kickoffOver25: 0.55,
    bestBid: 0.85,
    minute: 25,
    totalGoals: null,
  })
  assert.equal(d.open, true, `比分未知不该阻断开档，实际 ${d.reasonCode}: ${d.reason}`)
  assert.equal(d.goalsNeeded, 1)
})

// ==================== 买入静默 ====================

test('静默期内买入信号被压住，到点后自动放行', () => {
  const t0 = 1_000_000
  const until = extendMuteUntil(null, 8_000, t0)
  assert.equal(until, t0 + 8_000)

  assert.equal(isSurgeMuted(until, t0), true, '刚设上就该静默')
  assert.equal(isSurgeMuted(until, t0 + 7_999), true, '差 1ms 仍在静默期内')
  assert.equal(isSurgeMuted(until, t0 + 8_000), false, '到点即放行')
  assert.equal(isSurgeMuted(until, t0 + 20_000), false)
})

test('没设过静默就不静默：老规则不受影响', () => {
  assert.equal(isSurgeMuted(null), false)
  assert.equal(isSurgeMuted(undefined), false)
})

test('叠加静默取较晚者，短的那次不能缩掉已有保护', () => {
  const t0 = 1_000_000
  const long = extendMuteUntil(null, 60_000, t0)
  // 随后又来一次 8s 的普通静默，不能把 60s 缩短
  const after = extendMuteUntil(long, 8_000, t0)
  assert.equal(after, t0 + 60_000)
  // 更长的那次可以延长
  assert.equal(extendMuteUntil(long, 90_000, t0), t0 + 90_000)
})

test('静默时长为 0 或负数视为不设，保持原值', () => {
  const t0 = 1_000_000
  assert.equal(extendMuteUntil(null, 0, t0), undefined)
  assert.equal(extendMuteUntil(null, -5, t0), undefined)
  assert.equal(extendMuteUntil(t0 + 500, 0, t0), t0 + 500)
})

test('影子档位的静默时长明显长于普通开档', () => {
  const shadow = decideNextLineOpening({
    settledLine: 1.5, kickoffOver25: 0.5, bestBid: 0.9, minute: 60, totalGoals: 2,
  })
  const normal = decideNextLineOpening({
    settledLine: 0.5, kickoffOver25: 0.55, bestBid: 0.88, minute: 10, totalGoals: 1,
  })
  assert.equal(shadow.reasonCode, 'shadow_hot')
  assert.equal(normal.reasonCode, 'ok')
  assert.ok(
    shadow.cooldownMs > normal.cooldownMs,
    `影子静默 ${shadow.cooldownMs}ms 应长于普通 ${normal.cooldownMs}ms`,
  )
})

test('不开档时静默时长为 0：没有监控要静默', () => {
  // 用真正的死局（比赛已过 90 分钟）而不是「尾盘低价」——后者现在是开档的
  const d = decideNextLineOpening({
    settledLine: 1.5, kickoffOver25: 0.5, bestBid: 0.2, minute: 92, totalGoals: 2,
  })
  assert.equal(d.open, false, `实际 ${d.reasonCode}: ${d.reason}`)
  assert.equal(d.cooldownMs, 0)
})

// ==================== 档位识别 ====================

test('全场大小球盘被正确识别', () => {
  assert.equal(extractTotalGoalLine({ question_en: 'FK Liepaja vs. Riga FC: O/U 0.5' }), 0.5)
  assert.equal(extractTotalGoalLine({ question_en: 'A vs B: Over/Under 2.5' }), 2.5)
  assert.equal(extractTotalGoalLine({ question_en: 'Total goals over 3.5?' }), 3.5)
  assert.equal(extractTotalGoalLine({ question_zh: '总进球数超过1.5', line: 1.5 }), 1.5)
})

test('单队盘/半场盘/角球盘一律排除', () => {
  // 标题式单队盘：冒号后夹着队名
  assert.equal(extractTotalGoalLine({ question_en: 'FK Liepaja vs. Riga FC: FK Liepaja O/U 0.5' }), null)
  assert.equal(extractTotalGoalLine({ question_en: 'Will Arsenal score over 1.5 goals?' }), null)
  assert.equal(extractTotalGoalLine({ question_en: 'A vs B: O/U 1.5 in the first half' }), null)
  assert.equal(extractTotalGoalLine({ question_en: 'A vs B: Corners O/U 9.5' }), null)
  assert.equal(extractTotalGoalLine({ question_zh: '上半场总进球0.5', question_en: 'halftime o/u 0.5' }), null)
})

test('不在白名单里的线不认（5.5 及以上几乎无成交）', () => {
  assert.equal(extractTotalGoalLine({ question_en: 'A vs B: O/U 5.5', line: 5.5 }), null)
})

test('档位递进按白名单顺序，最高档到头返回 null', () => {
  assert.equal(nextTotalGoalLine(0.5), 1.5)
  assert.equal(nextTotalGoalLine(3.5), 4.5)
  assert.equal(nextTotalGoalLine(4.5), null)
  assert.equal(nextTotalGoalLine(null), null)
  assert.equal(nextTotalGoalLine(7.5), null)
  // 白名单本身没被改动
  assert.deepEqual(TOTAL_GOAL_LINES, [0.5, 1.5, 2.5, 3.5, 4.5])
})

// ==================== 比赛分钟 ====================

test('比赛分钟从开哨时刻现算，未开哨为 0，缺时间为 null', () => {
  const now = Date.parse('2026-09-04T20:40:00Z')
  assert.equal(matchMinuteFrom('2026-09-04T20:00:00Z', now), 40)
  assert.equal(matchMinuteFrom('2026-09-04T21:00:00Z', now), 0)
  assert.equal(matchMinuteFrom(null, now), null)
  assert.equal(matchMinuteFrom('not-a-date', now), null)
})
