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
 * 把价格对齐到合法 tick，向下取整。
 *
 * maker 报价用向下：向上对齐可能把报价顶到 bestAsk 上，那就从挂单变成了穿价单，
 * 整个 maker 模式的前提就没了。宁可少报半个 tick 慢一点成交。
 */
export function alignPriceDown(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price
  // 加一个极小量，避免 0.62/0.01 在浮点下算成 61.99999999999999 而少退一个 tick
  const ticks = Math.floor(price / tickSize + 1e-9)
  const aligned = ticks * tickSize
  const decimals = Math.max(0, Math.ceil(-Math.log10(tickSize)) + 1)
  return Number(aligned.toFixed(decimals))
}

/**
 * maker 报价：bestBid + makerTickOffset，且严格低于 bestAsk。
 *
 * 三条约束，按优先级：
 *  1. 不得 ≥ bestAsk —— 否则成了穿价单，maker 模式的前提消失
 *  2. 不得 ≥ 1 —— placeOrder 会拒
 *  3. 不得超过 bestBid + maxPremiumOverBid —— 与 taker 路径同一个闸门
 *
 * 价差只有 1 个 tick 时，offset≥1 会被压回 bestBid（即 join 报价）。
 * 这是正确的降级：那种盘口已经没有可插入的价位了。
 */
function computeMakerBuyPrice(
  snapshot: Pick<PriceSnapshot, 'bestBid' | 'bestAsk'>,
  p: Required<AutoTradeParams>,
): { price: number; basis: string } | null {
  const { bestBid, bestAsk } = snapshot
  const tick = p.tickSize > 0 ? p.tickSize : 0.01

  // maker 报价必须有 bid 作基准。无 bid 意味着没有买盘可参照，
  // 此时挂单等于凭空定价，不如放弃。
  if (bestBid == null || !(bestBid > 0)) return null

  const offset = Math.max(0, Math.floor(p.makerTickOffset))
  let raw = bestBid + offset * tick
  let basis = offset > 0
    ? `bestBid(${bestBid.toFixed(4)})+${offset}tick[maker]`
    : `bestBid(${bestBid.toFixed(4)})[maker/join]`

  // 压在 ask 之下至少一个 tick：这是 maker 与 taker 的分界线
  if (bestAsk != null && bestAsk > 0) {
    const ceiling = bestAsk - tick
    if (raw > ceiling) {
      raw = Math.max(bestBid, ceiling)
      basis += `→压到ask-1tick(${raw.toFixed(4)})`
    }
  }

  const premiumCap = p.maxPremiumOverBid ?? 0
  if (premiumCap > 0 && raw > bestBid + premiumCap) {
    raw = bestBid + premiumCap
    basis += `→压到bid+溢价上限(${premiumCap})`
  }

  // 向下对齐，避免对齐动作本身把报价推到 ask 上
  const aligned = alignPriceDown(raw, tick)
  // 对齐后仍要保证不低于 bid 之下（bid 本身就是合法档位，不会被磨掉）
  const floored = Math.max(aligned, alignPriceDown(bestBid, tick))
  const capped = Math.min(floored, 1 - tick)
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)))
  return { price: Number(capped.toFixed(decimals)), basis }
}

/**
 * 计算买入限价。两种报价方式由 `buyOrderMode` 选择。
 *
 * ## taker（默认）
 *
 * 以 bestAsk + 缓冲 报价，直接吃掉现有卖单立即成交，多付的价差换「拿得到货」。
 * 缓冲同时覆盖决策到撮合之间（签名+网络，百毫秒级）ask 的继续上移。
 *
 * 但纯跟 ask 在宽价差盘口会失控：实测 486 次「限价0.9900 ≥ 上限0.97」中，
 * bestBid 多在 0.85~0.90，是 ask 挂到 0.97 加缓冲顶上去的。那种价位买进去
 * 赢了只赚 1%、错了归零，赔率极差。maxPremiumOverBid 把限价压回 bid 附近，
 * 代价是可能挂不上——挂不上远好过在 0.99 接盘。
 *
 * ## maker
 *
 * 以 bestBid + makerTickOffset 报价，挂在盘口等成交，绝不穿价。
 * 实测每份省 +0.0822（第 9.14 节），代价是成交率 94.8%→55.8%。
 * 详见 `AutoTradeParams.buyOrderMode` 的注释。
 *
 * maker 模式下 slippageBuffer 不参与定价——缓冲的作用是穿价追 ask，
 * 而 maker 的整个前提就是不追。maxPremiumOverBid 仍然生效但通常不触发，
 * 因为溢价被 makerTickOffset 限得比它小得多。
 *
 * 返回 null 表示无法定价（ask 与 bid 均不可用；maker 模式下还要求 bid 可用）。
 */
export function computeBuyLimitPrice(
  snapshot: Pick<PriceSnapshot, 'bestBid' | 'bestAsk'>,
  p: Required<AutoTradeParams>,
): { price: number; basis: string } | null {
  const buffer = Math.max(0, p.slippageBuffer)

  if (p.buyOrderMode === 'maker') return computeMakerBuyPrice(snapshot, p)

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
      // maker 模式不穿价，所以「按天价接货」这条理由不适用；但闸门照样保留：
      // 宽价差本身标记薄盘，且第 9.12 节实测宽价差盘口正是挂单成交的那批
      // （成交时价差中位 0.090），逆向选择最重。放宽它在 9.14 里没有量过，
      // 所以不改行为，只把原因写准。
      return p.buyOrderMode === 'maker'
        ? `买卖价差${spread.toFixed(4)} > 上限${maxSpread}，盘口过薄，挂单在此类盘口逆向选择最重`
        : `买卖价差${spread.toFixed(4)} > 上限${maxSpread}，盘口过薄，穿价买入会显著溢价`
    }
  }

  return null
}

/**
 * 死区闸门：买入价落在「已按结算价定价、但线实际没打出」的区间内就拒绝。
 *
 * 见 AutoTradeParams.deadBandLow 的注释。要点是这不能用价格上限替代——
 * 死区之上（0.93+）反而是 100% 胜率，因为那是真结算了。中间那一段才是坑。
 *
 * 判的是**限价**（真正会付出去的价），不是 bestBid：闸门要拦的是实际成本。
 *
 * 返回 null 表示放行。
 */
export function evaluateDeadBand(
  limitPrice: number,
  p: Pick<AutoTradeParams, 'deadBandLow' | 'deadBandHigh'>,
): string | null {
  const lo = p.deadBandLow ?? 0
  const hi = p.deadBandHigh ?? 0
  // 上界不高于下界视为禁用
  if (!(hi > lo)) return null
  if (limitPrice >= lo && limitPrice < hi) {
    return (
      `买入价${limitPrice.toFixed(4)} 落在死区 [${lo}, ${hi})：` +
      `该价位已按结算价定价，但实测这一段的线多半还没打出` +
      `（92 盘口分档：此区间胜率 79.3% < 平衡所需 88.5%，净亏，而两侧都盈利）`
    )
  }
  return null
}

/**
 * 余量闸门：公平价与买入价的差额。
 *
 * 这是死区的动态版——死区之所以亏，是因为那个价位上市场价超出公平价最多。
 * 用余量表达就不必写死价格区间，能随进球分布/剩余时间/还需几球自动调整。
 *
 * `minFairMargin` 为 null 时**只计算不拦截**（观测模式），返回的 reason 为 null
 * 但 margin 仍然给出，调用方把它写进下单记录的理由里，用于日后定阈值。
 *
 * 公平价不可用（缺初盘快照）时余量为 null，一律放行——缺数据不是拒绝的理由，
 * 这一点与 next-line 的 no_snapshot 保持一致。
 */
export function evaluateFairMargin(
  limitPrice: number,
  fairProb: number | null | undefined,
  p: Pick<AutoTradeParams, 'minFairMargin'>,
): { margin: number | null; reason: string | null; note: string } {
  if (fairProb == null || !Number.isFinite(fairProb)) {
    return { margin: null, reason: null, note: '公平价不可用(缺初盘快照)' }
  }
  const margin = fairProb - limitPrice
  const note = `公平价${fairProb.toFixed(3)} − 买价${limitPrice.toFixed(4)} = 余量${margin >= 0 ? '+' : ''}${margin.toFixed(3)}`
  const floor = p.minFairMargin
  if (floor == null) return { margin, reason: null, note: `${note}[观测模式,不拦]` }
  // 1e-9 容差：两个小数相减带浮点残差（0.85 − 0.80 = 0.049999999999999996），
  // 恰好等于下限的应当放行。价格最小刻度是 0.001，这点容差改变不了任何真实判断。
  if (margin < floor - 1e-9) {
    return { margin, reason: `${note} < 下限${floor}，市场价高于公平价过多`, note }
  }
  return { margin, reason: null, note }
}

/**
 * 比赛时钟闸：开哨后不足 minMatchMinute 分钟就不买。
 *
 * 这一闸的目的不是提高胜率，是提高资金周转。见 types.ts 里 minMatchMinute 的注释
 * 和 9.24：早买付的价最贵、锁的时间最长，而钱包受限时绑住吞吐的是「金额 × 时长」。
 *
 * kickoff 用 MatchContext.endTime，它是取整到整点/半点的计划开哨时刻，
 * 所以这里算出的分钟数带最多 ±30 分钟的取整误差——闸门宽松一侧取整是安全的
 * （宁可放过也不误杀），因为误杀掉的是本来能赚的单。
 *
 * 返回 null 表示通过（含未启用、缺开哨时间、时间无法解析）。
 */
export function evaluateMatchClock(
  kickoff: string | null | undefined,
  minMatchMinute: number,
  now: number = Date.now(),
): string | null {
  if (!(minMatchMinute > 0)) return null
  if (!kickoff) return null                      // 没有开哨时间就不拦，避免闸门变成静默全禁
  const t = Date.parse(kickoff)
  if (!Number.isFinite(t)) return null
  const elapsed = (now - t) / 60000
  if (elapsed >= minMatchMinute) return null
  return `开哨后仅${elapsed.toFixed(0)}分钟 < 下限${minMatchMinute}，` +
    `此时贴线盘口价格最贵且离结算最远，买入会长时间占用有限资金`
}

// ==================== 买入筛子 ====================

/** 摇一次筛子的结果，见 rollBuyDice */
export interface DiceRoll {
  /** 摇出的随机数；筛子未启用时为 null */
  roll: number | null
  /** 实际生效的阈值（含连续被拦的放宽量） */
  threshold: number
  /** 是否放行（roll < threshold），放行才下单 */
  hit: boolean
  /** 摇完之后的连续被拦次数：放行归 0，被拦则 +1 */
  misses: number
  /** 人话说明，直接写进 price_bot_orders.reason */
  reason: string
}

/**
 * 买入前摇筛子：摇 [0,1) 随机数，小于阈值才放行。纯函数，随机源可注入。
 *
 * 连续被拦 k 次后阈值放宽到 min(1, base + k×ramp)，抬到 1.0 必然放行，
 * 所以 ramp>0 时最多被连续拦 ceil((1−base)/ramp) 次——这就是「突破阈值限制」。
 *
 * `misses` 必须是**全局连续**计数，不能按盘口计。按盘口计在实测数据上完全失效：
 * 61 条规则里 57 条一辈子只有 1 次买入机会，压根没有第二次摇动让 ramp 生效
 * （实测按盘口 ramp 0→0.2 净利纹丝不动，都是 $9.9x）。
 *
 * 必须放在**所有闸门之后、真要下单的那一刻**调用：放在前面会被
 * 「总开关关闭 / 无法定价 / 价差超限」这些压根不会成交的评估白白消耗——
 * 实测这类评估有 2835 条、真到下单阶段的只有 209 条，差 13 倍。
 *
 * @param base 基础阈值，<=0 视为不启用（直接放行），>=1 恒放行
 * @param ramp 每次连续被拦后抬高的幅度，<=0 表示不放宽
 * @param misses 当前的全局连续被拦次数
 * @param rnd [0,1) 随机源，默认 Math.random
 */
export function rollBuyDice(
  base: number,
  ramp: number,
  misses: number,
  rnd: () => number = Math.random,
): DiceRoll {
  // 阈值无效或 <=0 当作不启用，避免「填错一个数把买入全禁掉」
  if (!Number.isFinite(base) || base <= 0) {
    return { roll: null, threshold: 0, hit: true, misses: 0, reason: '' }
  }
  const step = Number.isFinite(ramp) && ramp > 0 ? ramp : 0
  const k = Number.isFinite(misses) && misses > 0 ? Math.floor(misses) : 0
  const threshold = Math.min(1, base + k * step)

  // 阈值到 1.0 就不必摇了，必然放行；也避免 rnd 恰好返回 1 时被误拦
  if (threshold >= 1) {
    return {
      roll: null,
      threshold: 1,
      hit: true,
      misses: 0,
      reason: `摇筛子：已连续被拦${k}次，阈值放宽到 1.00，必然放行`,
    }
  }

  const roll = rnd()
  const hit = roll < threshold
  const shown = `摇出 ${roll.toFixed(4)}，阈值 ${threshold.toFixed(4)}` +
    (k > 0 ? `（基础 ${base.toFixed(4)} + 连续被拦${k}次×${step.toFixed(4)}）` : '')

  if (hit) {
    return { roll, threshold, hit: true, misses: 0, reason: `摇筛子：${shown}，放行下单` }
  }
  const next = k + 1
  // 下一次的阈值，用来在日志里预告「还要被拦多久」
  const nextTh = Math.min(1, base + next * step)
  return {
    roll,
    threshold,
    hit: false,
    misses: next,
    reason:
      `摇筛子：${shown}，未通过，本次买入机会作废。` +
      (step > 0
        ? `下次阈值抬到 ${nextTh.toFixed(4)}${nextTh >= 1 ? '（下次必然放行）' : ''}`
        : '（未开启放宽，下次仍是同一阈值）'),
  }
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
