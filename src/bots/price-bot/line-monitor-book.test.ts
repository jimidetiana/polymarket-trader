import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  topLevels,
  judgeBook,
  passesMatchGate,
  cadenceSeconds,
  depthWeightedPrice,
  toMysqlUtc,
  DEFAULT_MONITOR_CONFIG,
} from './line-monitor-book.js'

const cfg = DEFAULT_MONITOR_CONFIG

test('topLevels 显式排序：买方由高到低，卖方由低到高', () => {
  const book = {
    bids: [{ price: '0.10', size: '5' }, { price: '0.30', size: '7' }, { price: '0.20', size: '9' }],
    asks: [{ price: '0.60', size: '2' }, { price: '0.40', size: '3' }],
  }
  assert.deepEqual(topLevels(book, 'bids'), [[0.3, 7], [0.2, 9], [0.1, 5]])
  assert.deepEqual(topLevels(book, 'asks'), [[0.4, 3], [0.6, 2]])
})

test('topLevels 丢掉 size<=0 和非数值档', () => {
  const book = { bids: [{ price: '0.5', size: '0' }, { price: 'x', size: '3' }, { price: '0.4', size: '2' }] }
  assert.deepEqual(topLevels(book, 'bids'), [[0.4, 2]])
})

test('topLevels 截到 5 档', () => {
  const bids = Array.from({ length: 9 }, (_, i) => ({ price: String(0.9 - i * 0.1), size: '1' }))
  assert.equal(topLevels({ bids }, 'bids').length, 5)
})

test('topLevels 对缺失/畸形输入返回空数组', () => {
  assert.deepEqual(topLevels(null, 'bids'), [])
  assert.deepEqual(topLevels({}, 'asks'), [])
  assert.deepEqual(topLevels({ bids: 'nope' }, 'bids'), [])
})

test('judgeBook 单边盘无效', () => {
  assert.deepEqual(judgeBook([[0.1, 5]], [], cfg), { valid: false, reason: 'no_ask' })
  assert.deepEqual(judgeBook([], [[0.2, 5]], cfg), { valid: false, reason: 'no_bid' })
})

test('judgeBook：ask 站上 1.0 算无效（结算把赢家推到 1.0，不是真可成交）', () => {
  assert.deepEqual(judgeBook([[0.98, 5]], [[1.0, 5]], cfg), { valid: false, reason: 'ask_at_one' })
})

test('judgeBook：交叉盘无效', () => {
  assert.deepEqual(judgeBook([[0.5, 5]], [[0.4, 5]], cfg), { valid: false, reason: 'crossed' })
  // 相等也算交叉，不算可成交
  assert.deepEqual(judgeBook([[0.4, 5]], [[0.4, 5]], cfg), { valid: false, reason: 'crossed' })
})

test('judgeBook：价差超阈值无效', () => {
  assert.deepEqual(judgeBook([[0.2, 5]], [[0.35, 5]], cfg), { valid: false, reason: 'spread_wide' })
})

test('judgeBook：顶档挂单量不足无效', () => {
  const thin = judgeBook([[0.2, 5]], [[0.22, 0.5]], cfg)
  assert.deepEqual(thin, { valid: false, reason: 'thin_ask' })
})

test('judgeBook：正常双边盘有效', () => {
  assert.deepEqual(judgeBook([[0.2, 5]], [[0.22, 5]], cfg), { valid: true, reason: null })
})

test('cadenceSeconds 按比赛阶段分档，开哨后落到 20 秒', () => {
  assert.equal(cadenceSeconds(null), 300)
  assert.equal(cadenceSeconds(-45), 300)
  assert.equal(cadenceSeconds(-11), 300)
  assert.equal(cadenceSeconds(-10), 60)
  assert.equal(cadenceSeconds(-1), 60)
  assert.equal(cadenceSeconds(0), 20)
  assert.equal(cadenceSeconds(75), 20)
})

test('depthWeightedPrice 跨档累计，不是顶档价', () => {
  const asks: [number, number][] = [[0.10, 2], [0.12, 3], [0.20, 100]]
  // 买 5 张：2@0.10 + 3@0.12 = 0.56 → 均价 0.112，高于顶档 0.10
  assert.equal(depthWeightedPrice(asks, 5), 0.56 / 5)
  assert.ok(depthWeightedPrice(asks, 5)! > asks[0][0])
})

test('depthWeightedPrice 只吃顶档时等于顶档价', () => {
  assert.equal(depthWeightedPrice([[0.25, 10]], 4), 0.25)
})

test('depthWeightedPrice 深度不足返回 null，不退化成顶档价', () => {
  assert.equal(depthWeightedPrice([[0.10, 2], [0.12, 1]], 10), null)
  assert.equal(depthWeightedPrice([], 1), null)
})

test('depthWeightedPrice 非正数量返回 null', () => {
  assert.equal(depthWeightedPrice([[0.1, 5]], 0), null)
  assert.equal(depthWeightedPrice([[0.1, 5]], -3), null)
})

test('toMysqlUtc 输出无时区后缀的 UTC 串（本机 UTC+8 也不能偏）', () => {
  assert.equal(toMysqlUtc(new Date('2026-09-07T12:34:56.789Z')), '2026-09-07 12:34:56')
})

test('默认配置只采 0.5 档', () => {
  assert.deepEqual(DEFAULT_MONITOR_CONFIG.lines, [0.5])
})

// ---- passesMatchGate ----

const gate = { minEventVolume: 0, minEventLiquidity: 5000 }

test('passesMatchGate 深度够就过，成交量为 0 也不拦', () => {
  // 实测依据：一半历史盈利来自 volume<5000 的场次，所以成交量默认不当闸门
  assert.deepEqual(passesMatchGate({ volume: 0, liquidity: 41223 }, gate), {
    pass: true,
    reason: null,
  })
})

test('passesMatchGate 深度不足挡下，理由是 low_liquidity', () => {
  assert.deepEqual(passesMatchGate({ volume: 999999, liquidity: 4999 }, gate), {
    pass: false,
    reason: 'low_liquidity',
  })
})

test('passesMatchGate 阈值是含下界（>=），边界值放行', () => {
  assert.equal(passesMatchGate({ volume: 0, liquidity: 5000 }, gate).pass, true)
})

test('passesMatchGate null/undefined 当 0 处理，不当成无穷大放行', () => {
  assert.deepEqual(passesMatchGate({ volume: null, liquidity: null }, gate), {
    pass: false,
    reason: 'low_liquidity',
  })
  assert.equal(passesMatchGate({ volume: undefined, liquidity: undefined }, gate).pass, false)
})

test('passesMatchGate 阈值 0 = 关闸门，任何值都放行', () => {
  const off = { minEventVolume: 0, minEventLiquidity: 0 }
  assert.equal(passesMatchGate({ volume: 0, liquidity: 0 }, off).pass, true)
  assert.equal(passesMatchGate({ volume: null, liquidity: null }, off).pass, true)
})

test('passesMatchGate 开成交量闸门后先报 low_volume', () => {
  const both = { minEventVolume: 500, minEventLiquidity: 5000 }
  assert.deepEqual(passesMatchGate({ volume: 499, liquidity: 999999 }, both), {
    pass: false,
    reason: 'low_volume',
  })
})

test('passesMatchGate 两条件是 AND：任一不过都挡', () => {
  const both = { minEventVolume: 500, minEventLiquidity: 5000 }
  assert.equal(passesMatchGate({ volume: 600, liquidity: 4000 }, both).pass, false)
  assert.equal(passesMatchGate({ volume: 600, liquidity: 6000 }, both).pass, true)
})

test('默认配置：成交量闸门关、深度闸门 5000', () => {
  assert.equal(DEFAULT_MONITOR_CONFIG.minEventVolume, 0)
  assert.equal(DEFAULT_MONITOR_CONFIG.minEventLiquidity, 5000)
})
