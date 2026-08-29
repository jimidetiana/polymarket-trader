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
  computeBuyLimitPrice,
  computeOrderSize,
  resolveAutoTradeParams,
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

test('凑不满最低 5 份时返回 0，而不是凑数突破金额上限', () => {
  // 3 USDC @ 0.96 只能买 3 份，低于手动表单的 5 份下限
  assert.equal(computeOrderSize(0.96, P({ sizeMode: 'usdc', baseSize: 3, maxSize: 50 })), 0)
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'shares', baseSize: 4, maxSize: 50 })), 0)
  // 刚好 5 份且名义额 ≥ $1 时放行
  assert.equal(computeOrderSize(0.5, P({ sizeMode: 'shares', baseSize: 5, maxSize: 50 })), 5)
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
