/**
 * 自动完结：买价站上阈值并持稳一段时间后，判定该档已打出，自动完结并递进。
 *
 * 为什么用 bestBid 而不是 ask 或 lastPrice：
 * bid 到 0.99 表示有人愿意**出** 0.99 买它，是最强的「已成定局」证据。
 * ask 到 0.99 只要有一个挂单就成立，薄盘上毫无意义。
 *
 * 为什么要求持稳而不是瞬时触碰：薄盘会瞬间打到 0.99 再回落。
 * 真打出的线不会回落（进球不可撤销），所以持稳这一条几乎不误杀真结算，
 * 但能挡掉全部瞬时噪音。
 *
 * 已知漏检：`maxBid>=0.99` 作为「赢」的代理有 10 个假阴性（见分析 9.18），
 * 即有些线最终结算为 yes 但买价从未摸到 0.99。这些不会自动完结，
 * 退化成人工点完结——是安全的失败方向（少做事，不做错事）。
 *
 * 已知误检：VAR 取消进球。价格会先冲到 0.99，复核期间维持高位，
 * 判罚后跌回。若复核超过 holdMs 就会误完结。后果可控：
 * 完结只是停监控 + 建下一档，且下一档 autoTradeEnabled=false 不动钱，
 * 人工重新启用被误完结的规则即可恢复。
 */

export interface AutoSettleParams {
  /** 是否启用自动完结 */
  enabled: boolean
  /** 买价阈值：达到并持稳才判已打出 */
  bidThreshold: number
  /** 持稳时长（毫秒） */
  holdMs: number
}

export const DEFAULT_AUTO_SETTLE: AutoSettleParams = {
  // 默认开启：这是纯观测动作（停监控 + 建不授权的下一档），不动钱。
  enabled: true,
  // 0.99 而不是 1.0：链上结算到 1.0 前市场就已到 0.99，等 1.0 会白等整场。
  bidThreshold: 0.99,
  // 30s：薄盘瞬时尖峰远短于此；真进球的 0.99 不会在 30 秒内跌回。
  holdMs: 30_000,
}

export interface AutoSettleStep {
  /** 写回 monitor 的持稳起始时刻；undefined 表示未在持稳中 */
  holdSince: number | undefined
  /** 是否应当触发自动完结 */
  fire: boolean
}

/**
 * 推进自动完结状态机。纯函数，便于单测（真实调用点在 evaluateRuleForId，要连库）。
 *
 * 触发需要同时满足三件事：
 * 1. **当前**读数在阈值之上（不能靠陈旧读数触发）
 * 2. 持稳计时已达 holdMs
 * 3. 期间没有出现低于阈值的读数
 *
 * bid 缺失（WS 消息不带盘口）时保留计时但不触发：
 * 缺数据不是回落的证据，但也不能当成站稳的证据。
 */
export function stepAutoSettle(
  bid: number | null | undefined,
  holdSince: number | undefined,
  p: AutoSettleParams,
  now: number,
): AutoSettleStep {
  if (!p.enabled) return { holdSince: undefined, fire: false }
  if (bid == null || !Number.isFinite(bid)) return { holdSince, fire: false }

  if (bid < p.bidThreshold) {
    // 跌出阈值：计时清零。真结算不会走到这里。
    return { holdSince: undefined, fire: false }
  }

  if (holdSince == null) return { holdSince: now, fire: false }
  return { holdSince, fire: now - holdSince >= p.holdMs }
}

/** 合并规则级与全局的自动完结参数 */
export function resolveAutoSettleParams(
  overrides: Partial<AutoSettleParams> | undefined,
  defaults: AutoSettleParams = DEFAULT_AUTO_SETTLE,
): AutoSettleParams {
  return {
    enabled: overrides?.enabled ?? defaults.enabled,
    bidThreshold: overrides?.bidThreshold ?? defaults.bidThreshold,
    holdMs: overrides?.holdMs ?? defaults.holdMs,
  }
}
