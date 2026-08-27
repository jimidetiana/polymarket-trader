/**
 * 价格监控并发触发去重测试
 *
 * 复现线上问题：WS 消息突发时，同一价格变化被重复记录数十次
 * （实测 2026-08-26 20:14:30 一秒内产生 17 条完全相同的触发记录）。
 *
 * 根因：evaluateRuleForId 含 await，冷却检查读到的 lastTriggerTime
 * 在任何一个并发调用写回之前都是旧值，导致全部通过检查。
 *
 * 运行：npx tsx scripts/test-price-bot-race.ts
 */

import {
  __injectPriceForTest,
  __registerMonitorForTest,
  __getMonitorStateForTest,
  __setVolatileForTest,
  __resetForTest,
} from '../src/bots/price-bot/price-bot.js'
import { pool } from '../src/soccer/db.js'
import { ensureTables } from '../src/bots/price-bot/db.js'

const TEST_TOKEN = 'test-token-race-999'
const TEST_RULE_ID = 999999
const TEST_EVENT = 'test-event-race'

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: 实际=${actual} 期望=${expected}`)
}

/** 统计测试规则产生的触发记录数 */
async function countTriggers(): Promise<number> {
  const [rows] = await pool.execute<any[]>(
    'SELECT COUNT(*) AS c FROM price_bot_triggers WHERE rule_id = ?',
    [TEST_RULE_ID],
  )
  return Number(rows[0]?.c ?? 0)
}

async function cleanup(): Promise<void> {
  await pool.execute('DELETE FROM price_bot_triggers WHERE rule_id = ?', [TEST_RULE_ID])
  await pool.execute('DELETE FROM price_bot_logs WHERE rule_id = ?', [TEST_RULE_ID])
}

function makeRule(cooldownSeconds: number) {
  return {
    id: TEST_RULE_ID,
    tokenId: TEST_TOKEN,
    marketId: 'test-market',
    eventId: TEST_EVENT,
    outcome: 'TestOutcome',
    ruleType: 'percent_change' as const,
    direction: 'both' as const,
    percentThreshold: 0.05,
    signalType: 'alert' as const,
    cooldownSeconds,
    enabled: true,
  }
}

/** 等待所有 fire-and-forget 的评估 promise 落地 */
async function drain(ms = 600): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  await ensureTables()
  await cleanup()

  // ===== 测试 1：消息突发只应产生一次触发 =====
  console.log('\n[测试 1] 50 条并发价格推送跨越阈值')
  __resetForTest()
  __registerMonitorForTest(makeRule(60), 0.50)

  // 同步连续注入，模拟 WS 一次性推来大量消息：
  // 每次调用都会启动一个未 await 的 evaluateRuleForId
  for (let i = 0; i < 50; i++) {
    __injectPriceForTest(TEST_TOKEN, 0.59, 0.61) // 中间价 0.60，+20%
  }
  await drain()

  check('触发记录数', await countTriggers(), 1)
  check('内存触发计数', __getMonitorStateForTest(TEST_RULE_ID)?.triggerCount, 1)
  check(
    '基准价已推进',
    __getMonitorStateForTest(TEST_RULE_ID)?.baselinePrice,
    0.6,
  )

  // ===== 测试 2：冷却期内的后续突发应被拦下 =====
  console.log('\n[测试 2] 冷却期内继续推送更高价格')
  for (let i = 0; i < 30; i++) {
    __injectPriceForTest(TEST_TOKEN, 0.79, 0.81) // 中间价 0.80，相对 0.60 又 +33%
  }
  await drain()

  check('触发记录数仍为 1', await countTriggers(), 1)

  // ===== 测试 3：冷却结束后允许新触发 =====
  console.log('\n[测试 3] 冷却结束后应能再次触发')
  await cleanup()
  __resetForTest()
  __registerMonitorForTest(makeRule(1), 0.50) // 冷却 1 秒

  for (let i = 0; i < 20; i++) {
    __injectPriceForTest(TEST_TOKEN, 0.59, 0.61)
  }
  await drain(300)
  const afterFirst = await countTriggers()

  await new Promise((r) => setTimeout(r, 1200)) // 等冷却过期

  for (let i = 0; i < 20; i++) {
    __injectPriceForTest(TEST_TOKEN, 0.69, 0.71) // 中间价 0.70，相对 0.60 +16.7%
  }
  await drain()

  check('第一波触发数', afterFirst, 1)
  check('冷却过期后累计触发数', await countTriggers(), 2)

  // ===== 测试 4：高波动窗口内应抑制 percent_change =====
  console.log('\n[测试 4] 断联期间（高波动窗口）抑制 percent_change')
  await cleanup()
  __resetForTest()
  __registerMonitorForTest(makeRule(60), 0.435)
  __setVolatileForTest(true) // 模拟断联中

  // 复现线上那次 0.435 → 0.92 的跳变（+111%）
  for (let i = 0; i < 10; i++) {
    __injectPriceForTest(TEST_TOKEN, 0.91, 0.93)
  }
  await drain()

  check('高波动窗口内触发数', await countTriggers(), 0)
  check(
    '抑制计数已累加',
    (__getMonitorStateForTest(TEST_RULE_ID)?.suppressedCount ?? 0) > 0,
    true,
  )
  check(
    '基准价已跟进到新价位',
    __getMonitorStateForTest(TEST_RULE_ID)?.baselinePrice,
    0.92,
  )

  // ===== 测试 5：窗口结束后恢复正常触发 =====
  console.log('\n[测试 5] 高波动窗口结束后恢复触发')
  __setVolatileForTest(false)

  for (let i = 0; i < 10; i++) {
    __injectPriceForTest(TEST_TOKEN, 0.98, 1.0) // 中间价 0.99，相对 0.92 +7.6%
  }
  await drain()

  check('窗口结束后触发数', await countTriggers(), 1)

  await cleanup()
  await pool.end()

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('测试异常:', err)
  try {
    await cleanup()
    await pool.end()
  } catch {}
  process.exit(1)
})
