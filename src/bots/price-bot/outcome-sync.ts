/**
 * 回填规则的链上结算真相。
 *
 * ## 为什么需要单独一条路径
 *
 * 常规同步（`fetchTodaysSoccerEvents`）拿不到结算价，两个独立原因：
 *
 *  1. 查询参数是 `active: true, closed: false` —— 已结算的盘口按定义不满足，
 *     永远不出现在结果里。
 *  2. 日期窗口只有 48 小时，且每轮开头 `deleteClosedEvents()` 会删掉
 *     `event_status='closed'` 的赛事，`soccer_markets` 挂着 ON DELETE CASCADE
 *     跟着消失。
 *
 * 实测后果：172 条 buy_signal 规则里 129 条没有链上真相，其中 117 条的盘口行
 * 最后一次同步发生在**开球之前**。剩下能对上的 43 条是撞巧在结算后、下一轮
 * 删除前被同步到的。
 *
 * ## 为什么这件事值得单独修
 *
 * 没有结算真相，唯一可用的「赢」判据是价格日志里出现过 `bid >= 0.99`。
 * 拿它对上 43 条有真相的样本：
 *
 *   - 精确率 100%（判赢的 29 条，链上无一例外真赢，FP=0）
 *   - 召回率 80.6%（7 条链上结算 YES 的规则最高 bid 只到 0.60~0.98，
 *     监控在价格涨上去之前就停了，于是被算成亏损）
 *
 * 也就是说所有基于价格日志的 EV 都系统性偏悲观，而且偏多少无法从日志本身估出来。
 * 另外价格日志在盘口下架后会返回 0.000，46 条以 ~0 收尾的序列里有 11 条是从
 * 0.999 一步跳到 0.000 —— 那是下架假象不是亏损（rule 329 链上 `[1,0]` 结算为
 * 赢，价格日志却收在 0.000）。只看日志分不清「结算归零」和「盘口撤空」。
 *
 * ## 实现取舍
 *
 * 结算价写在 `price_bot_rules` 上而不是 `soccer_markets`：后者会被 CASCADE 删掉，
 * 规则行不会。这样即使赛事被清理，历史度量仍然可用。
 *
 * 按 market id 逐个直查（`fetchMarketByIdFromGamma`），不按 event id 批量查。
 * 大小球盘口挂在衍生赛事下，按 event id 只能拿到主赛事的胜平负三个盘口——
 * 实测 event=875687 返回 3 个盘口，id 是 3980273~3980275，而我们要的是 3982362。
 */

import { fetchMarketByIdFromGamma } from '../../soccer/fetcher.js'
import { listRulesPendingOutcome, recordRuleOutcome } from './db.js'

export interface OutcomeSyncResult {
  /** 待回填的规则数 */
  pending: number
  /** 成功写入结算真相的规则数 */
  resolved: number
  /** 盘口查到了但还没结算（价格仍在中间）的规则数 */
  stillOpen: number
  /** gamma 里找不到对应盘口的规则数 */
  notFound: number
  /** 抓取失败的赛事数 */
  failed: number
  details: Array<{ ruleId: number; status: string; price?: number; outcome?: string }>
}

/**
 * 回填一批规则的结算真相。
 *
 * 单条抓失败不影响其余——记 failed 继续走，下次调用会再试（settled_outcome
 * 仍是 NULL，所以下次还会被 listRulesPendingOutcome 选中）。
 *
 * 逐条串行而不并发：这是补数据的离线动作，没有延迟要求，而并发打 gamma
 * 容易撞限流，失败了还得重跑。
 */
export async function syncRuleOutcomes(limit = 200): Promise<OutcomeSyncResult> {
  const pending = await listRulesPendingOutcome(limit)
  const result: OutcomeSyncResult = {
    pending: pending.length,
    resolved: 0,
    stillOpen: 0,
    notFound: 0,
    failed: 0,
    details: [],
  }

  for (const r of pending) {
    let market: Awaited<ReturnType<typeof fetchMarketByIdFromGamma>>
    try {
      market = await fetchMarketByIdFromGamma(r.marketId)
    } catch (err) {
      result.failed++
      result.details.push({ ruleId: r.id, status: `抓取失败: ${(err as Error).message}` })
      continue
    }
    if (!market) {
      result.notFound++
      result.details.push({ ruleId: r.id, status: 'gamma 无此盘口' })
      continue
    }

    // 只按 outcome 文本对齐。不退化到「按下标猜」：写错一腿会把结算真相记反，
    // 而这一列的全部价值就在于它是真相，宁可留 NULL。
    const idx = market.outcomes.findIndex(
      (o) => o.trim().toLowerCase() === r.outcome.trim().toLowerCase(),
    )
    if (idx < 0 || idx >= market.outcomePrices.length) {
      result.notFound++
      result.details.push({
        ruleId: r.id,
        status: `盘口里找不到 "${r.outcome}" 这一腿（gamma 给的是 ${JSON.stringify(market.outcomes)}）`,
      })
      continue
    }

    const price = market.outcomePrices[idx]
    const outcome = await recordRuleOutcome(r.id, price)
    if (!outcome) {
      result.stillOpen++
      result.details.push({ ruleId: r.id, status: '尚未结算', price })
      continue
    }
    result.resolved++
    result.details.push({ ruleId: r.id, status: '已回填', price, outcome })
  }

  return result
}
