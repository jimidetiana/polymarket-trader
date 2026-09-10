import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  wilson,
  eventsForMargin,
  MIN_EVENTS_FOR_EV,
  EV_LINES,
  DEFAULT_EV_LINE,
} from './monitor-ev.js'
import { DEFAULT_MONITOR_CONFIG } from './line-monitor-book.js'

// monitor-ev.ts 只 import type { Pool }，是类型导入，不会在加载时建连接池，
// 所以这两个纯函数可以直接单测（同 line-monitor-book 的做法）。

test('wilson 全胜不给零宽区间：18胜0负下界仍远离 1', () => {
  const [lo, hi] = wilson(18, 18)
  assert.equal(hi, 1)
  assert.ok(lo > 0.8 && lo < 0.85, `下界应在 0.82 附近，实际 ${lo}`)
})

test('wilson 全负不给零宽区间：0胜18负上界仍远离 0', () => {
  const [lo, hi] = wilson(0, 18)
  assert.equal(lo, 0)
  assert.ok(hi > 0.15 && hi < 0.2, `上界应在 0.176 附近，实际 ${hi}`)
})

test('wilson 覆盖用户那个 1/25=4% 的口径，区间宽到无法定论', () => {
  const [lo, hi] = wilson(1, 25)
  assert.ok(lo < 0.01, `下界应 <1%，实际 ${lo}`)
  assert.ok(hi > 0.19, `上界应 >19%，实际 ${hi}`)
  // 关键：区间必须同时包含 4% 和 0-0 自然率 ~8%，说明两者区分不开
  assert.ok(lo < 0.04 && hi > 0.04)
  assert.ok(lo < 0.078 && hi > 0.078)
})

test('wilson n=0 返回全区间而不是 NaN', () => {
  assert.deepEqual(wilson(0, 0), [0, 1])
})

test('wilson 区间随样本增大而收窄', () => {
  const small = wilson(9, 10)
  const large = wilson(900, 1000)
  assert.ok(large[1] - large[0] < small[1] - small[0])
})

test('wilson 下界不为负、上界不超 1', () => {
  for (const [w, n] of [[0, 1], [1, 1], [1, 3], [50, 100]] as const) {
    const [lo, hi] = wilson(w, n)
    assert.ok(lo >= 0 && hi <= 1, `n=${n} w=${w} 越界: ${lo},${hi}`)
  }
})

test('eventsForMargin 极端胜率也不返回 0（方差有下限）', () => {
  assert.ok(eventsForMargin(1.0, 0.03) > 0)
  assert.ok(eventsForMargin(0, 0.03) > 0)
})

test('eventsForMargin 精度要求越高需要样本越多', () => {
  assert.ok(eventsForMargin(0.5, 0.01) > eventsForMargin(0.5, 0.03))
})

test('eventsForMargin 最坏情况 p=0.5 约需千级样本', () => {
  const n = eventsForMargin(0.5, 0.03)
  assert.ok(n > 1000 && n < 1100, `实际 ${n}`)
})

test('样本门槛不低于 30，避免小样本出假精度', () => {
  assert.ok(MIN_EVENTS_FOR_EV >= 30)
})

test('EV 默认档是 0.5，历史数据的默认视图不会被新档冲掉', () => {
  assert.equal(DEFAULT_EV_LINE, 0.5)
})

test('EV 面板的档位集合与采集器默认档对齐（加档不加样本，各自独立攒）', () => {
  // 多档不是同一问题的更多样本：0.5 问「会不会进球」，1.5 问「会不会进第 2 个」
  assert.deepEqual(EV_LINES, DEFAULT_MONITOR_CONFIG.lines)
  // 至少包含默认档，否则面板会空白
  assert.ok(EV_LINES.includes(DEFAULT_EV_LINE))
})
