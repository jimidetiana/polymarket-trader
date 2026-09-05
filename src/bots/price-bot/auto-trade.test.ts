/**
 * 自动下单的定价逻辑测试。
 *
 * 跑法：npx tsx --test src/bots/price-bot/auto-trade.test.ts
 *
 * 只测纯函数（tick 对齐 + 限价计算）。风控计数依赖库，不在此覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alignPriceUp,
  alignPriceDown,
  computeBuyLimitPrice,
  computeOrderSize,
  evaluateBookQuality,
  evaluateMatchClock,
  evaluateDeadBand,
  evaluateFairMargin,
  rollBuyDice,
  resolveAutoTradeParams,
  classifyBookState,
} from './auto-trade.js'
import { DEFAULT_AUTO_TRADE } from './types.js'
import type { PriceSnapshot, AutoTradeParams } from './types.js'

const P = (over: Partial<AutoTradeParams> = {}) =>
  ({ ...DEFAULT_AUTO_TRADE, ...over }) as Required<AutoTradeParams>

const snap = (bid: number | null, ask: number | null): PriceSnapshot => ({
  tokenId: 't',
  bestBid: bid,
  bestBidSize: null,
  bestAsk: ask,
  bestAskSize: null,
  lastPrice: bid,
  timestamp: new Date().toISOString(),
  source: 'ws',
})

test('alignPriceUp 向上对齐到 tick，且不留浮点尾巴', () => {
  assert.equal(alignPriceUp(0.611, 0.01), 0.62)
  assert.equal(alignPriceUp(0.61, 0.01), 0.61)
  assert.equal(alignPriceUp(0.6101, 0.001), 0.611)
  // 0.29999999999999993 这类输入不能变成 0.30000000000000004
  assert.equal(alignPriceUp(0.3, 0.01), 0.3)
})

test('有 ask 时以 ask+缓冲 定价（taker 单，为成交率穿价）', () => {
  const r = computeBuyLimitPrice(snap(0.6, 0.62), P({ slippageBuffer: 0.02 }))
  assert.ok(r)
  // 0.62 + 0.02 = 0.64，比 bestBid 0.60 高——这正是穿价的意图
  assert.equal(r!.price, 0.64)
  assert.match(r!.basis, /bestAsk/)
})

test('缺 ask 时以 bid+2×缓冲 兜底，并标注无 ask', () => {
  const r = computeBuyLimitPrice(snap(0.6, null), P({ slippageBuffer: 0.02 }))
  assert.ok(r)
  assert.equal(r!.price, 0.64)
  assert.match(r!.basis, /无ask/)
})

test('bid 和 ask 都缺失时返回 null，不瞎下单', () => {
  assert.equal(computeBuyLimitPrice(snap(null, null), P()), null)
})

test('限价被压在 1 以下（placeOrder 会拒 price>=1）', () => {
  const r = computeBuyLimitPrice(snap(0.99, 0.999), P({ slippageBuffer: 0.05, tickSize: 0.01 }))
  assert.ok(r)
  assert.ok(r!.price < 1, `限价 ${r!.price} 必须 < 1`)
  assert.equal(r!.price, 0.99)
})

test('负缓冲被归零，不会低于 ask 挂成永不成交的单', () => {
  const r = computeBuyLimitPrice(snap(0.6, 0.62), P({ slippageBuffer: -0.1 }))
  assert.ok(r)
  assert.equal(r!.price, 0.62)
})

test('宽价差盘口的限价被压回 bid+溢价上限，不去 0.99 接盘', () => {
  // 实测形态：bid 0.85 / ask 0.97，纯跟 ask 会算出 0.99——赢只赚 1%，错则归零
  const r = computeBuyLimitPrice(
    snap(0.85, 0.97),
    P({ slippageBuffer: 0.02, maxPremiumOverBid: 0.04 }),
  )
  assert.ok(r)
  assert.equal(r!.price, 0.89)
  assert.match(r!.basis, /溢价上限/)
})

test('溢价上限设 0 即不限制，退回纯 ask 穿价', () => {
  const r = computeBuyLimitPrice(
    snap(0.85, 0.97),
    P({ slippageBuffer: 0.02, maxPremiumOverBid: 0 }),
  )
  assert.ok(r)
  assert.equal(r!.price, 0.99)
  assert.doesNotMatch(r!.basis, /溢价上限/)
})

test('正常价差不受溢价上限干扰，该穿的价照穿', () => {
  const r = computeBuyLimitPrice(
    snap(0.9, 0.91),
    P({ slippageBuffer: 0.02, maxPremiumOverBid: 0.04 }),
  )
  assert.ok(r)
  // 0.91 + 0.02 = 0.93，未超 bid+0.04 = 0.94
  assert.equal(r!.price, 0.93)
  assert.doesNotMatch(r!.basis, /溢价上限/)
})

test('无 bid 时溢价上限不生效：没有共识价可参照', () => {
  const r = computeBuyLimitPrice(
    snap(null, 0.97),
    P({ slippageBuffer: 0.02, maxPremiumOverBid: 0.04 }),
  )
  assert.ok(r)
  assert.equal(r!.price, 0.99)
  assert.doesNotMatch(r!.basis, /溢价上限/)
})

test('无 ask 的 bid 兜底同样受溢价上限约束', () => {
  // bid 0.85 + 2×0.03 = 0.91 > 上限 0.89，压回 0.89
  const r = computeBuyLimitPrice(
    snap(0.85, null),
    P({ slippageBuffer: 0.03, maxPremiumOverBid: 0.04 }),
  )
  assert.ok(r)
  assert.equal(r!.price, 0.89)
  assert.match(r!.basis, /无ask/)
  assert.match(r!.basis, /溢价上限/)
})

test('usdc 口径：份数 = 金额/限价，取整数份且名义额不超预算', () => {
  const p = P({ sizeMode: 'usdc', baseSize: 20, maxSize: 50 })
  const size = computeOrderSize(0.64, p)
  // 20/0.64 = 31.25，取整数份 31（与足球页面手动表单同口径）
  assert.equal(size, 31)
  assert.ok(Number.isInteger(size), '份数必须是整数')
  assert.ok(0.64 * size <= 20 + 1e-9, '名义金额不得超过设定的下单金额')
})

test('份数一律取整，不出现小数份', () => {
  for (const price of [0.07, 0.33, 0.64, 0.91, 0.96]) {
    const size = computeOrderSize(price, P({ sizeMode: 'usdc', baseSize: 20, maxSize: 50 }))
    assert.ok(Number.isInteger(size), `限价 ${price} 下份数 ${size} 不是整数`)
  }
})

test('baseSize 不够一手时补到最低 5 份（maxSize 还有空间）', () => {
  // 现场原案：3 usdc @ 0.95 折出 3 份，卡在 5 份下限上一单也下不出去。
  // maxSize=50 撑得起 5 份（4.75 usdc），就该补上去而不是静默跳过。
  assert.equal(computeOrderSize(0.95, P({ sizeMode: 'usdc', baseSize: 3, maxSize: 50 })), 5)
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'shares', baseSize: 4, maxSize: 50 })), 5)
  // 刚好 5 份时按 5 份走，不多补
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'shares', baseSize: 5, maxSize: 50 })), 5)
})

test('补到下限也不越过 maxSize 硬帽，撑不起就返回 0', () => {
  // baseSize=maxSize=3 usdc：5 份要 4.75，超过硬帽，只能放弃
  assert.equal(computeOrderSize(0.95, P({ sizeMode: 'usdc', baseSize: 3, maxSize: 3 })), 0)
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'shares', baseSize: 4, maxSize: 4 })), 0)
  // 硬帽刚好够 5 份就放行
  assert.equal(computeOrderSize(0.95, P({ sizeMode: 'usdc', baseSize: 3, maxSize: 4.75 })), 5)
})

test('低价盘口补份数按 $1 名义额下限走，而不是只看 5 份', () => {
  // 0.05 下 5 份只有 $0.25，不满 $1；要 20 份才够
  assert.equal(computeOrderSize(0.05, P({ sizeMode: 'shares', baseSize: 5, maxSize: 100 })), 20)
})

test('shares 口径：baseSize 直接是份数', () => {
  const p = P({ sizeMode: 'shares', baseSize: 30, maxSize: 50 })
  assert.equal(computeOrderSize(0.64, p), 30)
})

test('maxSize 封顶标准规模（两种口径都生效）', () => {
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'shares', baseSize: 100, maxSize: 40 })), 40)
  // usdc 口径下按 40 而非 100 折算份数
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'usdc', baseSize: 100, maxSize: 40 })), 80)
})

test('限价为 0 或负时份数为 0，不会产生除零/负单', () => {
  assert.equal(computeOrderSize(0, P()), 0)
  assert.equal(computeOrderSize(-0.5, P()), 0)
})

test('串行闸让「查计数→下单」不会并发交错，每日上限守得住', async () => {
  // 复现 price-bot.ts 里的 withOrderGate 语义
  let gate: Promise<void> = Promise.resolve()
  const withGate = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = gate.then(fn, fn)
    gate = run.then(() => undefined, () => undefined)
    return run
  }

  const LIMIT = 2
  let placed = 0
  const attempt = () =>
    withGate(async () => {
      const cur = placed // 「查计数」
      await new Promise((r) => setTimeout(r, 5)) // 模拟下单往返延迟
      if (cur >= LIMIT) return 'skipped'
      placed = cur + 1 // 「落库」
      return 'placed'
    })

  // 5 个信号同时触发
  const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()])
  assert.equal(placed, LIMIT, `实际下单 ${placed} 笔，不得超过上限 ${LIMIT}`)
  assert.equal(results.filter((r) => r === 'placed').length, LIMIT)
  assert.equal(results.filter((r) => r === 'skipped').length, 3)
})

test('串行闸中某一单抛错不会堵死后续下单', async () => {
  let gate: Promise<void> = Promise.resolve()
  const withGate = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = gate.then(fn, fn)
    gate = run.then(() => undefined, () => undefined)
    return run
  }

  const boom = withGate(async () => {
    throw new Error('下单异常')
  })
  await assert.rejects(boom, /下单异常/)
  // 前一单抛错后，闸门必须仍然放行
  assert.equal(await withGate(async () => 'ok'), 'ok')
})

test('参数优先级：规则级 > 全局 > 内置默认', () => {
  const p = resolveAutoTradeParams(
    { autoTradeParams: { baseSize: 5 } },
    { baseSize: 99, maxOrdersPerDay: 7 },
  )
  assert.equal(p.baseSize, 5, '规则级覆盖全局')
  assert.equal(p.maxOrdersPerDay, 7, '全局覆盖内置默认')
  assert.equal(p.maxBuyPrice, DEFAULT_AUTO_TRADE.maxBuyPrice, '未指定的回退内置默认')
})

// ==================== 盘口质量闸 ====================

test('低价线的涨幅不给下单：Over 3.5 从 0.05 抬到 0.09 也要拦住', () => {
  // 现场原案（内卡萨 vs 蓝十字 3.5 误买入）：一个进球把所有档位一起抬起来，
  // 涨幅过阈值但这条线离结算还很远。
  const reason = evaluateBookQuality(snap(0.09, 0.11), P())
  assert.ok(reason, '应当被拦下')
  assert.match(reason!, /下限/)
})

test('0 球时的 Over 1.5 不给下单（价格在中段说明尚未打出）', () => {
  assert.ok(evaluateBookQuality(snap(0.45, 0.47), P()))
})

test('刚打出的线放行：0.9x 且价差正常', () => {
  assert.equal(evaluateBookQuality(snap(0.93, 0.95), P()), null)
})

test('价差过宽判薄盘，拦下穿价溢价', () => {
  // bid/ask 都在下限之上，但差了 0.25：按 ask 穿价等于按天价接货
  const reason = evaluateBookQuality(snap(0.7, 0.95), P())
  assert.ok(reason)
  assert.match(reason!, /价差/)
})

test('缺 bid 时用 ask 判下限，两者皆缺则交给定价环节', () => {
  assert.ok(evaluateBookQuality(snap(null, 0.2), P()), '仅 ask 且在下限下应拦住')
  assert.equal(evaluateBookQuality(snap(null, 0.95), P()), null, '仅 ask 且够高应放行')
  assert.equal(evaluateBookQuality(snap(null, null), P()), null, '无盘口不在此环节报错')
})

test('闸门可按规则关掉（下限/价差设 0 即不校验）', () => {
  assert.equal(evaluateBookQuality(snap(0.09, 0.4), P({ minBuyPrice: 0, maxSpread: 0 })), null)
})

// ==================== 卖出前的盘口守卫 ====================

test('结算清盘不当成亏损：bid 归零而 ask 停在 1.00', () => {
  // 实测形态：前一帧 1.00，下一帧 bid=0/ask=1。15 段「跌破 0.60 再没恢复」里 11 段是这个
  const r = classifyBookState(snap(0, 1))
  assert.equal(r.state, 'settlement-cleared')
  assert.equal(r.sellable, false)
  assert.match(r.reason, /结算清盘/)
})

test('已完结的规则一律不按价格卖，哪怕盘口看着正常', () => {
  const r = classifyBookState(snap(0.9, 0.92), { settledAt: '2026-08-30 12:00:00' })
  assert.equal(r.state, 'settlement-cleared')
  assert.equal(r.sellable, false)
  assert.match(r.reason, /已完结/)
})

test('买盘瞬时抽空识别为 bid-vacuum，不卖', () => {
  // bid 掉到 0.18 而 ask 仍在 1.00 —— 最优买单被撤，下一档远在低位
  const r = classifyBookState(snap(0.18, 1))
  assert.equal(r.state, 'bid-vacuum')
  assert.equal(r.sellable, false)
  assert.match(r.reason, /买盘瞬时抽空/)
})

test('正常盘口判为可卖', () => {
  const r = classifyBookState(snap(0.9, 0.92))
  assert.equal(r.state, 'normal')
  assert.equal(r.sellable, true)
})

test('真实下跌（买卖两边一起下来）不算抽空，可以卖', () => {
  // ask 也跟着跌到 0.55，说明是真实共识下移，不是单边抽空
  const r = classifyBookState(snap(0.5, 0.55))
  assert.equal(r.state, 'normal')
  assert.equal(r.sellable, true)
})

test('两边都无报价时不做判断', () => {
  const r = classifyBookState(snap(null, null))
  assert.equal(r.state, 'no-book')
  assert.equal(r.sellable, false)
})

test('缺 ask 且 bid 归零同样按结算清盘处理', () => {
  const r = classifyBookState(snap(0, null))
  assert.equal(r.state, 'settlement-cleared')
  assert.equal(r.sellable, false)
})

test('bid 归零但 ask 在中间价位：仍然不可卖（没有成交对手）', () => {
  // 历史回放里 850 个 bid<=0.02 的帧有 609 个是这形态（如 bid=0/ask=0.87），
  // 早先只判「ask 在 1.00 附近」会把它们当正常盘口放过去
  const r = classifyBookState(snap(0, 0.87))
  assert.equal(r.state, 'bid-vacuum')
  assert.equal(r.sellable, false)
  assert.match(r.reason, /买盘归零/)
})

test('抽空判定的 bid 阈值可调', () => {
  // 默认 0.6 放过 0.7；提高到 0.75 就该拦住
  assert.equal(classifyBookState(snap(0.7, 0.95)).state, 'normal')
  assert.equal(classifyBookState(snap(0.7, 0.95), { vacuumBidFloor: 0.75 }).state, 'bid-vacuum')
})

// ==================== maker 报价（第 9.14 节） ====================

const MK = (over: Partial<AutoTradeParams> = {}) => P({ buyOrderMode: 'maker', ...over })

test('alignPriceDown 向下对齐到 tick，且不留浮点尾巴', () => {
  assert.equal(alignPriceDown(0.619, 0.01), 0.61)
  assert.equal(alignPriceDown(0.61, 0.01), 0.61)
  assert.equal(alignPriceDown(0.6119, 0.001), 0.611)
  assert.equal(alignPriceDown(0.3, 0.01), 0.3)
})

test('maker 模式以 bestBid+1tick 报价，不碰 ask', () => {
  const r = computeBuyLimitPrice(snap(0.85, 0.9), MK())
  assert.ok(r)
  assert.equal(r.price, 0.86)
  assert.match(r.basis, /maker/)
  // 关键性质：严格低于 ask，否则就是穿价单
  assert.ok(r.price < 0.9)
})

test('maker 模式不使用 slippageBuffer（缓冲是穿价用的）', () => {
  const a = computeBuyLimitPrice(snap(0.85, 0.9), MK({ slippageBuffer: 0.02 }))
  const b = computeBuyLimitPrice(snap(0.85, 0.9), MK({ slippageBuffer: 0.2 }))
  assert.equal(a?.price, b?.price)
})

test('makerTickOffset=0 即 join，挂在 bestBid 上', () => {
  const r = computeBuyLimitPrice(snap(0.85, 0.9), MK({ makerTickOffset: 0 }))
  assert.equal(r?.price, 0.85)
  assert.match(r!.basis, /join/)
})

test('价差只有 1 tick 时 maker 报价降级为 join，不越过 ask', () => {
  const r = computeBuyLimitPrice(snap(0.85, 0.86), MK({ makerTickOffset: 1 }))
  assert.ok(r)
  // bid+1tick = 0.86 = ask，会变成穿价；必须压回 0.85
  assert.equal(r.price, 0.85)
  assert.ok(r.price < 0.86)
})

test('大 offset 被 ask-1tick 压住，仍是挂单', () => {
  const r = computeBuyLimitPrice(snap(0.8, 0.9), MK({ makerTickOffset: 20, maxPremiumOverBid: 0 }))
  assert.ok(r)
  assert.equal(r.price, 0.89)
  assert.ok(r.price < 0.9)
})

test('maker 报价同样受 maxPremiumOverBid 约束', () => {
  const r = computeBuyLimitPrice(snap(0.8, 0.95), MK({ makerTickOffset: 10, maxPremiumOverBid: 0.03 }))
  assert.ok(r)
  assert.equal(r.price, 0.83)
})

test('maker 模式缺 bid 时无法定价（没有买盘可作基准）', () => {
  // taker 模式下缺 bid 仍能按 ask 定价，maker 不能
  assert.equal(computeBuyLimitPrice(snap(null, 0.9), MK()), null)
  assert.ok(computeBuyLimitPrice(snap(null, 0.9), P()))
})

test('maker 报价被压在 1 以下', () => {
  const r = computeBuyLimitPrice(snap(0.99, null), MK({ maxPremiumOverBid: 0 }))
  assert.ok(r)
  assert.ok(r.price < 1)
})

test('无 ask 时 maker 仍按 bid+offset 报价（不必压 ask）', () => {
  const r = computeBuyLimitPrice(snap(0.85, null), MK())
  assert.equal(r?.price, 0.86)
})

test('价差闸门在 maker 模式下给出对应的原因文案', () => {
  const wide = snap(0.7, 0.95)
  assert.match(evaluateBookQuality(wide, P())!, /穿价买入会显著溢价/)
  assert.match(evaluateBookQuality(wide, MK())!, /逆向选择最重/)
})

test('默认仍是 taker，改动交易语义的开关不默认打开', () => {
  assert.equal(DEFAULT_AUTO_TRADE.buyOrderMode, 'taker')
  const r = computeBuyLimitPrice(snap(0.6, 0.62), P())
  assert.equal(r?.price, 0.64) // ask+缓冲，穿价
})

// ==================== 比赛时钟闸门 ====================

const KICK = '2026-08-29T09:00:00Z'
const at = (min: number) => Date.parse(KICK) + min * 60000

test('比赛时钟闸门默认不启用，早买也放过', () => {
  assert.equal(DEFAULT_AUTO_TRADE.minMatchMinute, 0)
  assert.equal(evaluateMatchClock(KICK, DEFAULT_AUTO_TRADE.minMatchMinute, at(1)), null)
})

test('启用后拦掉开哨初期，到点后放行', () => {
  assert.match(evaluateMatchClock(KICK, 30, at(10))!, /开哨后仅10分钟 < 下限30/)
  assert.equal(evaluateMatchClock(KICK, 30, at(30)), null)   // 边界含等号
  assert.equal(evaluateMatchClock(KICK, 30, at(75)), null)
})

test('开哨前就触发也算不足，用负分钟数如实写进 reason', () => {
  const why = evaluateMatchClock(KICK, 30, at(-20))
  assert.match(why!, /开哨后仅-20分钟/)
})

test('缺开哨时间或时间无法解析时放过，闸门不能变成静默全禁', () => {
  assert.equal(evaluateMatchClock(null, 30, at(1)), null)
  assert.equal(evaluateMatchClock(undefined, 30, at(1)), null)
  assert.equal(evaluateMatchClock('', 30, at(1)), null)
  assert.equal(evaluateMatchClock('不是时间', 30, at(1)), null)
})

test('闸门理由里带上「占用有限资金」，与 9.24 的动机一致', () => {
  assert.match(evaluateMatchClock(KICK, 30, at(5))!, /占用有限资金/)
})

test('裸 DATETIME 串按 UTC 解析：本机 UTC+8 时不能白多 480 分钟', () => {
  // 这一闸是「时间不够就拦」，多算 480 分钟会让它永远放行——
  // 静默失效比误拦更难发现，所以必须和 matchMinuteFrom 同口径。
  const now = Date.parse('2026-09-05T11:10:00Z')
  // 真实开哨 11:00 UTC，此刻第 10 分钟，下限 30 → 必须拦
  assert.match(evaluateMatchClock('2026-09-05 11:00:00', 30, now)!, /开哨后仅10分钟/)
  // 与带 Z 的写法等价
  assert.equal(
    evaluateMatchClock('2026-09-05 11:00:00', 30, now),
    evaluateMatchClock('2026-09-05T11:00:00Z', 30, now),
  )
})

// ==================== 买入筛子 ====================

/** 固定随机源：依次返回给定的 [0,1) 值，用完抛错（防止测试悄悄多摇一次） */
const seq = (...vals: number[]) => {
  let i = 0
  return () => {
    if (i >= vals.length) throw new Error('随机源被多取了一次')
    return vals[i++]
  }
}

test('筛子默认不启用，直接放行且不摇随机数', () => {
  assert.equal(DEFAULT_AUTO_TRADE.buyDiceThreshold, 0)
  const r = rollBuyDice(DEFAULT_AUTO_TRADE.buyDiceThreshold, DEFAULT_AUTO_TRADE.buyDiceRamp, 0, seq())
  assert.equal(r.hit, true)
  assert.equal(r.roll, null)
  assert.equal(r.reason, '')
})

test('阈值非法或 <=0 当作不启用，不能变成静默全禁', () => {
  assert.equal(rollBuyDice(0, 0.1, 0, seq()).hit, true)
  assert.equal(rollBuyDice(-1, 0.1, 0, seq()).hit, true)
  assert.equal(rollBuyDice(Number.NaN, 0.1, 0, seq()).hit, true)
})

test('摇出的数小于阈值才放行，0.6 是严格小于', () => {
  assert.equal(rollBuyDice(0.6, 0, 0, seq(0.5999)).hit, true)
  assert.equal(rollBuyDice(0.6, 0, 0, seq(0.6)).hit, false)    // 边界不含等号
  assert.equal(rollBuyDice(0.6, 0, 0, seq(0.7)).hit, false)
})

test('放行后连续被拦次数归零', () => {
  const r = rollBuyDice(0.6, 0.1, 3, seq(0.1))
  assert.equal(r.hit, true)
  assert.equal(r.misses, 0)
  assert.match(r.reason, /放行下单/)
})

test('每被拦一次阈值抬高一档，reason 写出基础值和放宽量', () => {
  const r1 = rollBuyDice(0.6, 0.1, 0, seq(0.9))
  assert.equal(r1.hit, false)
  assert.equal(r1.misses, 1)
  assert.equal(r1.threshold, 0.6)

  // 已被拦 2 次 → 阈值 0.6+0.2=0.8，摇 0.75 就能过
  const r2 = rollBuyDice(0.6, 0.1, 2, seq(0.75))
  assert.equal(Number(r2.threshold.toFixed(4)), 0.8)
  assert.equal(r2.hit, true)
  assert.match(r2.reason, /连续被拦2次/)
})

test('突破阈值限制：连续被拦到阈值满 1.0 就必然放行，且不再摇随机数', () => {
  // 0.6 + 4×0.1 = 1.0 → 第 5 次机会必然放行
  const forced = rollBuyDice(0.6, 0.1, 4, seq())   // 随机源为空：摇一次就抛错
  assert.equal(forced.hit, true)
  assert.equal(forced.roll, null)
  assert.equal(forced.threshold, 1)
  assert.equal(forced.misses, 0)
  assert.match(forced.reason, /阈值放宽到 1.00，必然放行/)
})

test('最多被连续拦 ceil((1−阈值)/ramp) 次：0.6 + 0.1 → 第 5 次必过', () => {
  let misses = 0
  for (let i = 0; i < 4; i++) {
    // 每次都摇 0.999，只有阈值抬到 1.0 才可能放行
    const r = rollBuyDice(0.6, 0.1, misses, seq(0.999))
    assert.equal(r.hit, false, `第 ${i + 1} 次不该放行`)
    misses = r.misses
  }
  assert.equal(misses, 4)
  const last = rollBuyDice(0.6, 0.1, misses, seq())
  assert.equal(last.hit, true)
})

test('ramp=0 时阈值不放宽，日志要说清楚下次还是同一阈值', () => {
  const r = rollBuyDice(0.6, 0, 5, seq(0.9))
  assert.equal(r.threshold, 0.6)
  assert.equal(r.hit, false)
  assert.match(r.reason, /未开启放宽/)
})

test('阈值 >=1 恒放行；负 ramp 视为不放宽', () => {
  assert.equal(rollBuyDice(1, 0, 0, seq()).hit, true)
  assert.equal(rollBuyDice(1.5, 0, 0, seq()).hit, true)
  const r = rollBuyDice(0.6, -0.5, 3, seq(0.9))
  assert.equal(r.threshold, 0.6)              // 负 ramp 不会把阈值拉低
})

test('阈值口径涵盖旧的面数口径：六面筛 ≡ 阈值 1/6', () => {
  const t = 1 / 6
  assert.equal(rollBuyDice(t, 0, 0, seq(0.16)).hit, true)     // 0.16 < 0.1667
  assert.equal(rollBuyDice(t, 0, 0, seq(0.17)).hit, false)
})

// ==================== 死区闸门 ====================
//
// 用例价位取自 92 个盘口的实测分档：0.70~0.85 净利 +28.37（须放行）、
// 0.85~0.93 净亏 −13.35（须拦）、0.93+ 胜率 100%（须放行）。

const DB = DEFAULT_AUTO_TRADE

test('死区内拒绝：0.85~0.93 是实测唯一净亏的价格带', () => {
  for (const price of [0.85, 0.87, 0.89, 0.9, 0.9299]) {
    const r = evaluateDeadBand(price, DB)
    assert.ok(r, `${price} 应被拦，实际放行`)
    assert.match(r!, /死区/)
  }
})

test('死区下方放行：0.70~0.85 是实测最赚的一档，绝不能误杀', () => {
  for (const price of [0.7, 0.78, 0.8299, 0.8499]) {
    assert.equal(evaluateDeadBand(price, DB), null, `${price} 应放行`)
  }
})

test('死区上方放行：0.93+ 是真结算，胜率 100%', () => {
  for (const price of [0.93, 0.947, 0.96, 0.99]) {
    assert.equal(evaluateDeadBand(price, DB), null, `${price} 应放行`)
  }
})

test('死区边界：下界闭、上界开', () => {
  assert.ok(evaluateDeadBand(0.85, DB), '下界本身在死区内')
  assert.equal(evaluateDeadBand(0.93, DB), null, '上界本身不在死区内')
})

test('上界不高于下界视为禁用', () => {
  const off = { deadBandLow: 0.85, deadBandHigh: 0.85 }
  assert.equal(evaluateDeadBand(0.87, off), null)
  assert.equal(evaluateDeadBand(0.9, { deadBandLow: 0.93, deadBandHigh: 0.85 }), null)
})

test('参数缺失视为禁用，不影响未配置的旧规则', () => {
  assert.equal(evaluateDeadBand(0.88, {}), null)
})

test('自定义死区边界生效', () => {
  const wide = { deadBandLow: 0.85, deadBandHigh: 0.95 }
  assert.ok(evaluateDeadBand(0.94, wide), '放宽上界后 0.94 应被拦')
  assert.equal(evaluateDeadBand(0.96, wide), null)
})

test('死区默认值就是回测出来的 0.85~0.93', () => {
  assert.equal(DEFAULT_AUTO_TRADE.deadBandLow, 0.85)
  assert.equal(DEFAULT_AUTO_TRADE.deadBandHigh, 0.93)
})

// ==================== 余量闸门 ====================

test('观测模式（minFairMargin=null）：算出余量但不拦', () => {
  const r = evaluateFairMargin(0.88, 0.21, { minFairMargin: null })
  assert.equal(r.reason, null, '观测模式不得拦截')
  assert.ok(r.margin != null && Math.abs(r.margin - (0.21 - 0.88)) < 1e-9)
  assert.match(r.note, /观测模式/)
})

test('公平价缺失（无初盘快照）时放行且余量为 null', () => {
  const r = evaluateFairMargin(0.88, null, { minFairMargin: 0 })
  assert.equal(r.reason, null, '缺数据不是拒绝的理由')
  assert.equal(r.margin, null)
  assert.match(r.note, /缺初盘快照/)
})

test('启用后：余量低于下限则拒绝', () => {
  const r = evaluateFairMargin(0.88, 0.21, { minFairMargin: 0 })
  assert.ok(r.reason, '公平价 0.21 远低于买价 0.88，应拒绝')
  assert.match(r.reason!, /市场价高于公平价过多/)
})

test('启用后：余量达标则放行', () => {
  // 实测最赚的一档：买价 0.78、公平价更高 → 正余量
  const r = evaluateFairMargin(0.78, 0.9, { minFairMargin: 0 })
  assert.equal(r.reason, null)
  assert.ok(r.margin != null && r.margin > 0)
})

test('余量恰等于下限时放行（下限是闭区间）', () => {
  const r = evaluateFairMargin(0.8, 0.85, { minFairMargin: 0.05 })
  assert.equal(r.reason, null)
})

test('余量闸门默认为观测模式，不改变现有行为', () => {
  assert.equal(DEFAULT_AUTO_TRADE.minFairMargin, null)
})

test('note 里带上公平价与买价，便于事后定阈值', () => {
  const r = evaluateFairMargin(0.885, 0.79, { minFairMargin: null })
  assert.match(r.note, /0\.79/)
  assert.match(r.note, /0\.885/)
})

test('NaN 公平价按缺失处理', () => {
  const r = evaluateFairMargin(0.88, Number.NaN, { minFairMargin: 0 })
  assert.equal(r.reason, null)
  assert.equal(r.margin, null)
})
