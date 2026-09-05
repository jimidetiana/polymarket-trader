/**
 * 自动完结的状态机测试。
 *
 * 重点覆盖「持稳」这一条：薄盘瞬时打到 0.99 再回落不能触发完结，
 * 否则每个薄盘盘口都会被误完结一次。
 *
 * 跑法：npx tsx --test src/bots/price-bot/auto-settle.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stepAutoSettle,
  resolveAutoSettleParams,
  DEFAULT_AUTO_SETTLE,
} from './auto-settle.js'

const P = DEFAULT_AUTO_SETTLE

test('买价首次达阈值只开始计时，不立即完结', () => {
  const r = stepAutoSettle(0.99, undefined, P, 1_000)
  assert.equal(r.fire, false)
  assert.equal(r.holdSince, 1_000)
})

test('持稳未满时长不完结', () => {
  const r = stepAutoSettle(0.99, 1_000, P, 1_000 + P.holdMs - 1)
  assert.equal(r.fire, false)
  assert.equal(r.holdSince, 1_000)
})

test('持稳达到时长即完结', () => {
  const r = stepAutoSettle(0.99, 1_000, P, 1_000 + P.holdMs)
  assert.equal(r.fire, true)
})

test('薄盘瞬时尖峰不触发完结：跌回阈值下就清零计时', () => {
  // 打到 0.99 开始计时
  let s = stepAutoSettle(0.995, undefined, P, 0)
  assert.equal(s.holdSince, 0)
  // 1 秒后跌回 0.7：计时必须清零
  s = stepAutoSettle(0.7, s.holdSince, P, 1_000)
  assert.equal(s.holdSince, undefined)
  assert.equal(s.fire, false)
  // 再次冲上来，从新的时刻起算，而不是接着上次的
  s = stepAutoSettle(0.99, s.holdSince, P, 2_000)
  assert.equal(s.holdSince, 2_000)
  // 距首次触碰已过 holdMs，但距本次只过了 1ms —— 不能完结
  s = stepAutoSettle(0.99, s.holdSince, P, 2_001)
  assert.equal(s.fire, false)
})

test('阈值以下从不触发，无论持续多久', () => {
  const r = stepAutoSettle(0.98, undefined, P, 10_000_000)
  assert.equal(r.fire, false)
  assert.equal(r.holdSince, undefined)
})

test('买价缺失不触发也不清零：缺数据既非回落证据也非站稳证据', () => {
  const r = stepAutoSettle(null, 1_000, P, 1_000 + P.holdMs * 10)
  assert.equal(r.fire, false)
  assert.equal(r.holdSince, 1_000, '计时应保留，等下一个带盘口的读数')
})

test('缺失后恢复到阈值上，用原计时判定（不因缺数据而重新等一轮）', () => {
  let s = stepAutoSettle(0.99, undefined, P, 0)
  s = stepAutoSettle(null, s.holdSince, P, 10_000)
  s = stepAutoSettle(0.99, s.holdSince, P, P.holdMs)
  assert.equal(s.fire, true)
})

test('未启用时永不触发且不留状态', () => {
  const off = { ...P, enabled: false }
  const r = stepAutoSettle(1.0, 1_000, off, 1_000 + P.holdMs * 10)
  assert.equal(r.fire, false)
  assert.equal(r.holdSince, undefined)
})

test('已结算到 1.0 照常走持稳逻辑', () => {
  const r = stepAutoSettle(1.0, 500, P, 500 + P.holdMs)
  assert.equal(r.fire, true)
})

test('NaN 买价按缺失处理，不触发', () => {
  const r = stepAutoSettle(Number.NaN, 1_000, P, 1_000 + P.holdMs)
  assert.equal(r.fire, false)
  assert.equal(r.holdSince, 1_000)
})

test('默认值：阈值 0.99、持稳 30 秒、默认启用', () => {
  assert.equal(DEFAULT_AUTO_SETTLE.bidThreshold, 0.99)
  assert.equal(DEFAULT_AUTO_SETTLE.holdMs, 30_000)
  assert.equal(DEFAULT_AUTO_SETTLE.enabled, true)
})

test('参数合并：规则级覆盖全局，未给的沿用默认', () => {
  const p = resolveAutoSettleParams({ holdMs: 5_000 })
  assert.equal(p.holdMs, 5_000)
  assert.equal(p.bidThreshold, DEFAULT_AUTO_SETTLE.bidThreshold)
  assert.equal(p.enabled, DEFAULT_AUTO_SETTLE.enabled)
})

test('参数合并：enabled=false 不被默认值 true 覆盖掉', () => {
  const p = resolveAutoSettleParams({ enabled: false })
  assert.equal(p.enabled, false, '?? 而非 || ，false 必须保留')
})

test('自定义阈值生效', () => {
  const p = resolveAutoSettleParams({ bidThreshold: 0.95, holdMs: 1_000 })
  assert.equal(stepAutoSettle(0.96, 0, p, 1_000).fire, true)
  assert.equal(stepAutoSettle(0.94, 0, p, 1_000).fire, false)
})
