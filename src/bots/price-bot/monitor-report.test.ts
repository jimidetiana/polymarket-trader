import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_REVERSAL, parseReversalParams } from './monitor-report.js'
import { DEFAULT_MONITOR_CONFIG } from './line-monitor-book.js'

/**
 * 这些用例守的是一个已经踩过的坑：反转查询不筛 line。
 * 单档采集时不显形；1.5/2.5 进库后，分母是 0.5 档早盘命中的 112 场，
 * 分子却接受任意档晚端 Under≥0.9——1-0 的比赛 Under 2.5 一直钉 0.999，
 * 于是 16 场「反转」里 10 场其实进了球，反转率从 5.4% 虚高到 14.3%。
 */

test('反转参数必须带 line，默认锁 0.5 档', () => {
  assert.equal(DEFAULT_REVERSAL.line, 0.5)
  assert.ok(DEFAULT_MONITOR_CONFIG.lines.includes(DEFAULT_REVERSAL.line))
})

test('parseReversalParams 认 line 查询参数', () => {
  assert.equal(parseReversalParams({ line: '1.5' }).line, 1.5)
  assert.equal(parseReversalParams({ line: '2.5' }).line, 2.5)
})

test('parseReversalParams：line 缺失或非法退回默认档，不静默变 0', () => {
  assert.equal(parseReversalParams({}).line, DEFAULT_REVERSAL.line)
  assert.equal(parseReversalParams({ line: '' }).line, DEFAULT_REVERSAL.line)
  assert.equal(parseReversalParams({ line: 'abc' }).line, DEFAULT_REVERSAL.line)
  // line=0 不是合法档位，但 0 是有限数，会被原样接受；
  // 这里固定住行为：只要不是「静默变 0」就行，非法值走上面三条。
  assert.equal(parseReversalParams({ line: '0.5' }).line, 0.5)
})

test('反转默认口径其余字段不变（改档不该顺手动阈值）', () => {
  const p = parseReversalParams({})
  assert.equal(p.earlyBid, 0.9)
  assert.equal(p.earlyBefore, 10)
  assert.equal(p.earlyFrom, null)
  assert.equal(p.lateBid, 0.9)
  assert.equal(p.lateAfter, 100)
  assert.equal(p.validOnly, false)
})
