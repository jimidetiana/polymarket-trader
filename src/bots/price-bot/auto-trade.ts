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
 * 计算买入限价。以成交率为首要目标，但不接受无上限的溢价。
 *
 * 关键取舍：以 bestAsk 而非 bestBid 作基准。挂在 bestBid 上是 maker 单，
 * 要等别人来卖才成交；而进球瞬间价格正在快速上行，挂 bid 基本等于挂空。
 * 以 bestAsk + 缓冲 报价是 taker 单，直接吃掉现有卖单立即成交，
 * 多付的那点价差换来的是「拿得到货」。
 *
 * 缓冲同时覆盖决策到撮合之间（签名+网络，百毫秒级）ask 的继续上移。
 *
 * 但纯跟 ask 在宽价差盘口会失控：实测 486 次「限价0.9900 ≥ 上限0.97」中，
 * bestBid 多在 0.85~0.90，是 ask 挂到 0.97 加缓冲顶上去的。那种价位买进去
 * 赢了只赚 1%、错了归零，赔率极差。maxPremiumOverBid 把限价压回 bid 附近，
 * 代价是可能挂不上——挂不上远好过在 0.99 接盘。
 *
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

  // 溢价上限：只在有 bid 可参照时生效。无 bid 时没有「市场共识价」可比，
  // 硬套上限会把价格压到毫无意义的位置，交给下限/价差闸门去管。
  const premiumCap = p.maxPremiumOverBid ?? 0
  if (premiumCap > 0 && snapshot.bestBid != null && snapshot.bestBid > 0) {
    const ceiling = snapshot.bestBid + premiumCap
    if (raw > ceiling) {
      raw = ceiling
      basis += `→压到bid+溢价上限(${premiumCap})`
    }
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
 *
 * baseSize 不够一手时会向上补到最低 5 份，但绝不越过 maxSize——
 * baseSize 是「想下多少」，maxSize 才是「最多能下多少」。
 * 实测 baseSize=3 usdc 在限价 0.95 下算出 3 份，卡在 5 份下限上一单也下不出去；
 * 补到 5 份需 4.75 usdc，只要不超 maxSize 就该放行，否则参数配小了等于静默停机。
 * 返回 0 表示连 maxSize 都撑不起一手，此时跳过才是对的。
 */
export function computeOrderSize(price: number, p: Required<AutoTradeParams>): number {
  if (!(price > 0)) return 0

  const target = Math.min(p.baseSize, p.maxSize)
  const toShares = (v: number) => (p.sizeMode === 'usdc' ? v / price : v)

  const wanted = Math.floor(toShares(target))
  if (wanted >= MIN_ORDER_SHARES && wanted * price >= MIN_ORDER_NOTIONAL) return wanted

  // 补到下限：份数取 5 份与 $1 两个下限里更严的那个
  const floorShares = Math.max(MIN_ORDER_SHARES, Math.ceil(MIN_ORDER_NOTIONAL / price))
  // 硬帽同样要换成份数比：usdc 口径下 maxSize 是钱，shares 口径下就是份
  const hardCapShares = Math.floor(toShares(p.maxSize))
  if (floorShares > hardCapShares) return 0
  return floorShares
}

/**
 * 下单前的盘口质量闸：价格是否落在可买区间、盘口是否够厚。
 *
 * 判定用 bestBid（市场共识价）而不是穿价后的限价：限价含我们自己加的缓冲，
 * 拿它比下限等于把自己的让步算成市场认可度。
 * 返回 null 表示通过，否则返回中文原因，直接进 price_bot_orders.reason。
 */
export function evaluateBookQuality(
  snapshot: Pick<PriceSnapshot, 'bestBid' | 'bestAsk'>,
  p: Required<AutoTradeParams>,
): string | null {
  const { bestBid, bestAsk } = snapshot
  const floor = p.minBuyPrice ?? 0

  if (floor > 0) {
    // 缺 bid 时退而用 ask 判定，两者都没有交给定价环节报「无法定价」
    const ref = bestBid ?? bestAsk
    if (ref != null && ref < floor) {
      return `盘口价${ref.toFixed(4)} < 下限${floor}，该线离结算尚远（涨幅多来自更低档的线或薄盘噪音）`
    }
  }

  const maxSpread = p.maxSpread ?? 0
  if (maxSpread > 0 && bestBid != null && bestAsk != null && bestBid > 0) {
    const spread = bestAsk - bestBid
    if (spread > maxSpread) {
      return `买卖价差${spread.toFixed(4)} > 上限${maxSpread}，盘口过薄，穿价买入会显著溢价`
    }
  }

  return null
}

// ==================== 卖出前的盘口守卫 ====================

/**
 * 盘口状态。卖出决策必须先过这一层，光看 bestBid 会把三种完全不同的情况混成一种。
 *
 * - `normal`            买盘正常，卖单能按接近报价的价位成交
 * - `settlement-cleared` 盘口撤空（结算后），bestBid 归 0 但这不是亏损
 * - `bid-vacuum`        最优买单被瞬时抽走，下一档远在低位
 * - `no-book`           两边都没有报价，无从判断
 */
export type BookState = 'normal' | 'settlement-cleared' | 'bid-vacuum' | 'no-book'

export interface BookGuardResult {
  state: BookState
  /** 此刻能否按 bestBid 卖出而不至于把仓位贱卖 */
  sellable: boolean
  reason: string
}

/**
 * 卖出前判断盘口是否可用。
 *
 * 为什么必须有这一层——实测数据里三件事：
 *
 * 1. **结算清盘会伪装成归零。** 从 >=0.88 跌到 <=0.60 的 30 段里有 5 段、
 *    「跌破 0.60 后再没恢复」的 15 段里有 11 段，形态都是 `1.00 -> 0.00`：
 *    前一帧价格还是 1.00，下一帧 bid=0 且 ask=1。那是赢了之后盘口撤空，
 *    不是亏损。只看 bestBid 会把这些赢单送上卖出路径，在 0 附近抛掉。
 *
 * 2. **买盘瞬时抽空会伪装成暴跌。** 跌破 0.60 又恢复的 30 段里，36.7% 只有
 *    单个采样点低于 0.60，33.3% 在 10 秒内就回来，低位停留时长 p25 只有 1 秒。
 *    这些时刻 ask 仍在 0.93~1.00——盘口没清空，只是最优买单被撤、下一档远在低位。
 *    此时市价卖真的会成交在那个价位。
 *
 * 3. 因此价格止损在这份数据上是净亏的（30 秒确认窗仍是误触发 14 次换 4 次真止损）。
 *    这个函数不是止损，是任何自动卖出逻辑的前置条件：先确认「现在的 bid 是真的」。
 *
 * 判定顺序有讲究：settledAt 优先于价格形态，因为手动完结之后盘口读数一律不可信。
 */
export function classifyBookState(
  snapshot: Pick<PriceSnapshot, 'bestBid' | 'bestAsk'>,
  opts: { settledAt?: string | Date | null; vacuumBidFloor?: number } = {},
): BookGuardResult {
  const { bestBid, bestAsk } = snapshot

  // 已完结/已结算：不管盘口显示什么都不该再按价格卖
  if (opts.settledAt) {
    return {
      state: 'settlement-cleared',
      sellable: false,
      reason: '规则已完结，盘口读数不可信，不按价格卖出',
    }
  }

  if (bestBid == null && bestAsk == null) {
    return { state: 'no-book', sellable: false, reason: '买卖两边均无报价，无法判断' }
  }

  // 买盘归零：一律不可卖，先于其余判定。
  //
  // 没有买单就没有成交对手，ask 是多少都不影响这个结论。历史回放里
  // 850 个 bid<=0.02 的帧中有 609 个 ask 落在 0.02~0.99 之间（如 bid=0/ask=0.87），
  // 若只判「ask 在 1.00 附近」会把它们放过去，然后试图向空买盘挂卖单。
  //
  // 归零之后再按 ask 分因：停在天花板的是结算清盘（赢了之后撤单），
  // 其余是买盘被抽干。两者都不可卖，但 reason 要能区分，否则排查时看不出差别。
  const bidGone = bestBid == null || bestBid <= 0.02
  if (bidGone) {
    const askAtCeiling = bestAsk == null || bestAsk >= 0.99
    return {
      state: askAtCeiling ? 'settlement-cleared' : 'bid-vacuum',
      sellable: false,
      reason: askAtCeiling
        ? `盘口已撤空（bid=${bestBid ?? 'null'} / ask=${bestAsk ?? 'null'}），疑似结算清盘，不是亏损`
        : `买盘归零（bid=${bestBid ?? 'null'} / ask=${bestAsk?.toFixed(4) ?? 'null'}），无成交对手，不能卖`,
    }
  }

  // 买盘抽空：bid 掉到低位而 ask 还在高位，价差宽到不可能是真实共识
  const floor = opts.vacuumBidFloor ?? 0.6
  if (bestBid != null && bestBid <= floor && bestAsk != null && bestAsk >= 0.9) {
    return {
      state: 'bid-vacuum',
      sellable: false,
      reason: `买盘瞬时抽空（bid=${bestBid.toFixed(4)} 而 ask=${bestAsk.toFixed(4)}），` +
        '按此价卖出会大幅贱卖，应等买盘恢复',
    }
  }

  return { state: 'normal', sellable: true, reason: '买盘正常' }
}
