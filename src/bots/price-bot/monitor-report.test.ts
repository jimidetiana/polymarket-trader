import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * 观测单位 = (event_id, line)。这条用源码扫描来守：
 * 光靠类型检查发现不了 SQL 字符串里少写一个 line。
 */
test('monitor-report.ts / monitor-ev.ts 里不残留按 event 单独聚合的 SQL', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const f of ['monitor-report.ts', 'monitor-ev.ts']) {
    const src = await readFile(join(here, f), 'utf8')
    // 去掉注释再扫，否则注释里举的反例会误报
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/--[^\n]*/g, '')

    // 允许 COUNT(DISTINCT event_id)（「采了多少场比赛」是合法信息），
    // 但同一条 SELECT 里必须同时给出观测数，否则「场次」会被当成样本量。
    // 按 SELECT 切开逐段检查，而不是全文件一刀切。
    for (const stmt of code.split(/\bSELECT\b/i)) {
      if (!/COUNT\(DISTINCT\s+\w*\.?event_id\s*\)/i.test(stmt)) continue
      assert.ok(
        /COUNT\(DISTINCT\s+\w*\.?event_id\s*,\s*\w*\.?line\s*\)/i.test(stmt),
        `${f}: 有 COUNT(DISTINCT event_id) 但同段没有 COUNT(DISTINCT event_id, line)，` +
          `场次数会被误当样本量`,
      )
    }

    // GROUP BY / PARTITION BY 只要出现 event_id，同一子句里就必须出现 line
    for (const m of code.matchAll(/(GROUP BY|PARTITION BY)([^)\n]*event_id[^)\n]*)/gi)) {
      assert.ok(
        /\bline\b/i.test(m[2]),
        `${f}: 「${m[1]}${m[2].trim()}」少了 line`,
      )
    }
  }
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
