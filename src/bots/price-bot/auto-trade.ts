/**
 * 自动下单的纯计算逻辑：参数合并、tick 对齐、限价与份数计算。
 *
 * 单独成文件而不放进 price-bot.ts，是为了不依赖数据库和 WS 连接——
 * 这些是动钱的算式，必须能在没有 DB 的环境里直接跑测试。
 */

import { DEFAULT_AUTO_TRADE } from './types.js'
import type { AutoTradeParams, PriceSnapshot, PriceMonitorRule } from './types.js'

/**
 * 与足球赛事页面手动下单表单保持一致的下限（order-form.tsx）。
 * 那条路径是已验证能成交的，这里不另立标准。
 */
export const MIN_ORDER_SHARES = 5
export const MIN_ORDER_NOTIONAL = 1

/**
 * 合并全局默认与规则级覆盖，得到本次下单的有效参数。
 *
 * 优先级：规则级 > 全局配置 > 内置默认。
 */
export function resolveAutoTradeParams(
  rule: Pick<PriceMonitorRule, 'autoTradeParams'>,
  globalDefaults?: AutoTradeParams,
): Required<AutoTradeParams> {
  return {
    ...DEFAULT_AUTO_TRADE,
    ...(globalDefaults ?? {}),
    ...(rule.autoTradeParams ?? {}),
  } as Required<AutoTradeParams>
}

/**
 * 把价格对齐到合法 tick，向上取整。
 *
 * 买入向上而非四舍五入：宁可多付半个 tick，也不要因为价格不合法被交易所拒单。
 */
export function alignPriceUp(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price
  // 减去一个极小量，避免 0.62/0.01 在浮点下算成 62.00000000000001 而多进一个 tick
  const ticks = Math.ceil(price / tickSize - 1e-9)
  const aligned = ticks * tickSize
  // tickSize 是 0.01/0.001 这类小数，浮点乘法会留下 0.30000000000000004 这种尾巴
  const decimals = Math.max(0, Math.ceil(-Math.log10(tickSize)) + 1)
  return Number(aligned.toFixed(decimals))
}

/**
 * 计算买入限价。以成交率为首要目标。
 *
 * 关键取舍：以 bestAsk 而非 bestBid 作基准。挂在 bestBid 上是 maker 单，
 * 要等别人来卖才成交；而进球瞬间价格正在快速上行，挂 bid 基本等于挂空。
 * 以 bestAsk + 缓冲 报价是 taker 单，直接吃掉现有卖单立即成交，
 * 多付的那点价差换来的是「拿得到货」。
 *
 * 缓冲同时覆盖决策到撮合之间（签名+网络，百毫秒级）ask 的继续上移。
 * 返回 null 表示无法定价（ask 与 bid 均不可用）。
 */
export function computeBuyLimitPrice(
  snapshot: Pick<PriceSnapshot, 'bestBid' | 'bestAsk'>,
  p: Required<AutoTradeParams>,
): { price: number; basis: string } | null {
  const buffer = Math.max(0, p.slippageBuffer)

  let raw: number
  let basis: string
  if (snapshot.bestAsk != null && snapshot.bestAsk > 0) {
    raw = snapshot.bestAsk + buffer
    basis = `bestAsk(${snapshot.bestAsk.toFixed(4)})+缓冲(${buffer})`
  } else if (snapshot.bestBid != null && snapshot.bestBid > 0) {
    // 无 ask（对手盘被吃空，或 WS 只给了 bid）：以 bid 上浮两倍缓冲抢跑。
    // 缺口比正常价差大，所以让步也更大。
    raw = snapshot.bestBid + buffer * 2
    basis = `bestBid(${snapshot.bestBid.toFixed(4)})+2×缓冲(${buffer * 2})[无ask]`
  } else {
    return null
  }

  const aligned = alignPriceUp(raw, p.tickSize)
  // 价格必须严格小于 1（placeOrder 会拒 price>=1），留一个 tick 的余量
  const capped = Math.min(aligned, 1 - p.tickSize)
  // 精度跟随 tick：0.01 tick 出两位小数，与手动表单的 limitPrice/100 同口径
  const decimals = Math.max(0, Math.ceil(-Math.log10(p.tickSize)))
  return { price: Number(capped.toFixed(decimals)), basis }
}

/**
 * 按口径把「标准下单规模」换算成份数。
 *
 * sizeMode=usdc 时 baseSize 是金额，份数 = 金额 / 限价；
 * sizeMode=shares 时 baseSize 直接是份数。两种口径都受 maxSize 封顶。
 *
 * 取整数份，与足球页面手动表单一致（order-form.tsx:57 用 parseInt / Math.floor）。
 * 向下截断而不是四舍五入，保证名义金额不超预算。
 * 返回 0 表示这笔算不出合法规模，调用方应跳过而不是凑到下限——
 * 凑数会突破用户设定的金额上限。
 */
export function computeOrderSize(price: number, p: Required<AutoTradeParams>): number {
  if (!(price > 0)) return 0
  const capped = Math.min(p.baseSize, p.maxSize)
  const raw = p.sizeMode === 'usdc' ? capped / price : capped
  const size = Math.floor(raw)
  if (size < MIN_ORDER_SHARES) return 0
  if (size * price < MIN_ORDER_NOTIONAL) return 0
  return size
}
