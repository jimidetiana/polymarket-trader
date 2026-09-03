import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateOutcomeStats,
  computeKelly,
  wilsonInterval,
  type SettledSample,
} from './report.js'

test('computeKelly uses binary-contract odds and floors negative edge at zero', () => {
  const result = computeKelly(0.869, 0.855)
  assert.ok(result != null)
  // f = (q - price) / (1 - price) for a binary contract.
  assert.ok(Math.abs(result - ((0.869 - 0.855) / 0.145)) < 1e-12)
  assert.equal(computeKelly(0.5, 0.6), 0)
  assert.equal(computeKelly(1, 0.5), 1)
  assert.equal(computeKelly(0.8, 0), null)
  assert.equal(computeKelly(0.8, 1), null)
})

test('Wilson interval remains bounded at all-win and all-loss boundaries', () => {
  const allWins = wilsonInterval(5, 5)
  const allLosses = wilsonInterval(0, 5)
  assert.ok(allWins)
  assert.ok(allLosses)
  assert.equal(allWins[1], 1)
  assert.equal(allLosses[0], 0)
  assert.ok(allWins[0] < 1)
  assert.ok(allLosses[1] > 0)
  assert.equal(wilsonInterval(3, 0), null)
})

test('conservative Kelly from Wilson lower bound cannot exceed point Kelly', () => {
  const interval = wilsonInterval(18, 20)
  assert.ok(interval)
  const point = computeKelly(18 / 20, 0.8)
  const conservative = computeKelly(interval[0], 0.8)
  assert.ok(point != null)
  assert.ok(conservative != null)
  assert.ok(conservative <= point)
})

test('rule aggregation keeps multiple actual orders in one rule as one outcome', () => {
  const samples: SettledSample[] = [
    { orderId: 101, ruleId: 1, size: 2, price: 0.8, won: true },
    { orderId: 102, ruleId: 1, size: 3, price: 0.9, won: true },
    { orderId: 103, ruleId: 2, size: 1, price: 0.7, won: false },
  ]
  const byRule = aggregateOutcomeStats(samples, 'rule')
  const byOrder = aggregateOutcomeStats(samples, 'order')

  assert.equal(byRule.n, 2)
  assert.equal(byRule.wins, 1)
  assert.equal(byRule.winRate, 0.5)
  assert.equal(byOrder.n, 3)
  assert.equal(byOrder.wins, 2)
  assert.equal(byOrder.winRate, 2 / 3)
  // 规则 1 赚 5 - 4.3 = +0.7，规则 2 亏 0.7，净额刚好抵平。
  assert.ok(Math.abs(byRule.invested - 5.0) < 1e-10)
  assert.ok(Math.abs(byRule.net) < 1e-10)
  assert.ok(Math.abs((byRule.averagePrice ?? 0) - 5 / 6) < 1e-10)
})

test('invalid or non-fill-like samples do not enter realized outcome totals', () => {
  const stats = aggregateOutcomeStats([
    { orderId: 1, ruleId: 1, size: 5, price: 0.8, won: true },
    // The report query never turns partial states into samples. Invalid records are also ignored defensively.
    { orderId: 2, ruleId: 2, size: 0, price: 0.6, won: true },
    { orderId: 3, ruleId: 3, size: 2, price: 1, won: false },
  ], 'order')

  assert.equal(stats.n, 1)
  assert.equal(stats.invested, 4)
  assert.equal(stats.net, 1)
})
