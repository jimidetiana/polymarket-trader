/**
 * 价格监控机器人类型定义
 *
 * 监控指定市场/结果的价格变化，当价格满足设定条件时触发告警或交易。
 * 与 value-bot 不同，不需要关联比分数据，仅基于 CLOB 价格本身。
 */

import { type AutoSettleParams, DEFAULT_AUTO_SETTLE } from './auto-settle.js'

export type { AutoSettleParams }

// ==================== 配置类型 ====================

/**
 * 进球买入信号（goal_surge）参数。所有字段可选，留空回退 PriceBotConfig.goalSurgeDefaults。
 */
export interface GoalSurgeParams {
  /** 信号一：秒级递增回看窗口（毫秒） */
  surgeWindowMs?: number
  /** 信号一：窗口内 bestBid 净涨阈值（如 0.03） */
  surgeMinRise?: number
  /** 信号二：断联/波动窗口内相对进入前基准的跳升阈值（如 0.05） */
  jumpThreshold?: number
  /** 买单门槛：最小买单量（点3 信心，判断能否下单） */
  minBidSize?: number
  /** 卖单评估：最小卖单量（成交性） */
  minAskSize?: number
  /** 卖单评估：ask 价格上限（≤ 该值才有到 1.0 的利润空间，如 0.97） */
  askCeiling?: number
  /** 确认阶段：价格持稳下限（如 0.98，bestBid ≥ 该值且 <1.0 视为已确认真实） */
  confirmMin?: number
  /** 确认阶段：持稳时长（毫秒） */
  confirmHoldMs?: number
}

/** 下单规模口径：按份数(shares) 或 按金额(usdc，实际份数 = 金额 / 限价) */
export type OrderSizeMode = 'shares' | 'usdc'

/**
 * 自动下单参数。全局默认放在 PriceBotConfig.autoTradeDefaults，
 * 每条规则可用 PriceMonitorRule.autoTradeParams 覆盖其中任意字段。
 */
export interface AutoTradeParams {
  /** 下单规模口径 */
  sizeMode?: OrderSizeMode
  /** 标准下单规模：sizeMode=shares 时为份数，=usdc 时为金额 */
  baseSize?: number
  /** 单笔最大下单规模（与 baseSize 同口径），封顶用 */
  maxSize?: number
  /**
   * 穿价缓冲：在 bestAsk 之上再加的价格让步。
   *
   * 提高成交率的关键。进球瞬间 ask 在快速上移，从「决策」到「订单落到撮合」
   * 有网络+签名延迟（实测百毫秒级），按当时 ask 挂单很容易已经挂空。
   * 多让几个 tick 换成交确定性。
   */
  slippageBuffer?: number
  /** 买入价硬上限：算出来的限价超过该值就放弃（保住到 1.0 的利润空间） */
  maxBuyPrice?: number
  /**
   * 买入价硬下限（对 bestBid 判定）：盘口价低于该值就放弃。
   *
   * 进球买入的前提是「这条线刚刚打出，价格正奔向 1.0」。若买单价还在低位，
   * 说明这条线离结算很远——涨幅大概率来自更低档的线（0 球时进 1 球，
   * Over 3.5 也会从 0.05 抬到 0.09，涨幅照样过阈值）或是薄盘噪音。
   * 只有下限没上限会买到没利润空间的价，只有上限没下限会买到远未结算的线。
   */
  minBuyPrice?: number
  /**
   * 最大可接受买卖价差（bestAsk - bestBid）。超过就放弃。
   *
   * 限价是按 bestAsk 穿价算的，盘口一薄（挂单稀疏或对手盘被吃空）
   * ask 会远离真实价值，照它下单等于按天价接货。
   */
  maxSpread?: number
  /**
   * 相对 bestBid 的最大溢价：限价不得超过 bestBid + 该值。
   *
   * 无条件跟 bestAsk 报价，在宽价差盘口等于全盘接受对手方的要价。
   * 实测 486 次「限价0.9900 ≥ 上限0.97」里，bestBid 多在 0.85~0.90，
   * 是 ask 挂到 0.97 再加缓冲顶上去的——赢了只赚 1%，判断错则归零。
   * 用它把限价压回 bid 附近：可能挂不上，但挂不上比在 0.99 接盘好。
   * 设 0 表示不限制（退回纯 ask 穿价）。
   */
  maxPremiumOverBid?: number
  /** 每条规则累计最多下单笔数（跨重启，从库里数） */
  maxOrdersPerRule?: number
  /** 全局每日最多下单笔数（跨重启，按自然日 UTC 数） */
  maxOrdersPerDay?: number
  /** 全局累计下单金额上限（USDC，按自然日 UTC 计） */
  maxDailyNotional?: number
  /** 价格 tick，用于把限价对齐到合法档位 */
  tickSize?: number
  /**
   * 买入报价方式。
   *
   * - `taker`：按 bestAsk + 缓冲穿价，立刻成交。原有行为。
   * - `maker`：按 bestBid + makerTickOffset 挂在盘口下方等成交，不穿价。
   *
   * 实测（第 9.14 节，77 个信号配对 bootstrap）：同一个盘口上挂单必然比穿价便宜，
   * `bid+1tick` 报价平均省 **+0.0822/份**，95% 区间 [+0.0495, +0.1214]。
   * 这是构造保证的价格优势——挂单一定付得更少。
   *
   * 但代价是逆向选择：挂单只在有人愿意卖到你的价位时成交，而那更多发生在
   * 判断错的时候。挂单成交的那批盘口若改穿价值 −0.2157，比穿价整体 −0.1416
   * 差 0.0741，恰好吃掉价格优势的九成，净剩 +0.008。
   *
   * **所以 maker 模式单独不会让策略转正**，它的价值在于把「少付的钱」变成
   * 可支配的，而把「是否该留这个仓位」交给人工判断。配人工止损时才值得开。
   *
   * 另一个代价：成交率从 94.8% 降到 55.8%（等待中位 67s），44% 的信号不成交。
   * 不成交不是亏损，但会漏掉直接涨走的赢单。不要为此加「超时转穿价」——
   * 实测任何时长的回退都把每笔期望值拉回 −0.14~−0.17，等于把优势还回去。
   */
  buyOrderMode?: BuyOrderMode
  /**
   * maker 模式下高于 bestBid 的 tick 数。
   *
   * 1 = `bid+1tick`，自己开一个新价位、排在该价位队首。实测省 +0.0822。
   * 0 = 挂在 bestBid 上（join），省得略多（+0.0870）但要排在已有买单队尾，
   * 等待中位 221s（vs 67s），且回放模型忽略排队位置，真实成交率会明显低于
   * 测出来的 48.1%。默认取 1。
   *
   * 报价始终被压在 bestAsk 之下至少一个 tick，避免变成穿价单。
   */
  makerTickOffset?: number
  /**
   * 比赛时钟下限：开哨后不足该分钟数就不买。0 表示不启用。
   *
   * 钱包受限时真正的约束是「金额 × 占用时长」，不是单笔 ROI。实测（9.24）：
   * 开哨前 30 分钟买入的那一段付最高的价（均价 92.5）、锁最久的资金
   * （持仓中位 74.9 分钟）、每笔还是亏的（ROI −6.4%），是全轴最差的一格。
   * 机制不依赖样本量：贴线盘口在开哨初期，剩下 90 分钟里进球几率高，
   * 所以价格最贵——等于付接近确定性的价钱，买一个要等 75 分钟才兑现的东西。
   *
   * 反事实：设为 30 时留下 28/40 笔，净利从 $15.29 升到 $19.83，
   * 资金占用从 147.7 降到 60.5 $·h，每 $·h 收益提高 3.2 倍。
   * 但那是同一份样本上的回测，且开哨时间用的是取整后的 end_time（见下），
   * 所以默认关闭，要用请显式设值。
   *
   * 时钟口径：用 MatchContext.endTime 作开哨代理，它是取整到整点/半点的
   * 计划开哨时刻（实测进球都落在它之后 36~109 分钟），所以算出的「开哨后
   * 第几分钟」有最多 ±30 分钟的取整误差。设阈值时留出余量。
   */
  minMatchMinute?: number
  /**
   * 买入前摇筛子：摇一个 [0,1) 随机数，**小于该阈值才放行下单**。
   * 0（或 <=0）= 不启用，0.6 = 六成放行，>=1 = 恒放行。
   *
   * 摇筛子的时刻是「所有闸门都过了、真要下单」那一刻。没摇中记 `skipped`
   * （不占下单额度），这次买入机会作废。
   *
   * 阈值口径把上一版的「面数」包含在内：N 面筛摇中最大面 ≡ 阈值 1/N，
   * 所以六面筛就是 0.1667。改用阈值是因为它能连续调，且 0.6 这种档位
   * 用面数表达不出来。
   *
   * 实测（9.26，n=61 条 outcome 已知的规则，每笔按 5 份计）：
   *   基线（不摇筛）  61 单   胜率 91.8%  净利 $18.80  ROI +7.2%
   *   阈值 0.6        38.2 单 胜率 91.1%  净利 $9.93   ROI +6.1%（占基线 53%）
   *   阈值 0.8        49.6 单 胜率 91.5%  净利 $14.33  ROI +6.7%（占基线 76%）
   * 阈值 0.6 比上一版六面筛好得多（六面筛只剩 2% 净利）：0.6 平均取到的是
   * 第 1.06 次机会，几乎总是第一次，所以**不会**像面数筛那样偏向反复触发的
   * 假突破盘口。它是一个近似无偏的 60% 随机子样本——每笔的 EV 基本不变
   * （ROI 只从 7.2% 掉到 6.1%），只是**少做了四成的量**。
   *
   * 也就是说这是节流阀，不是筛选器：它不会提高胜率，只会等比例减少下单。
   * 要提高有限资金的吞吐，`minMatchMinute` 才是带信息的筛选器。
   */
  buyDiceThreshold?: number
  /**
   * 连续被筛子拦下时，每拦一次把阈值抬高多少（0 = 不放宽）。
   * 用来「突破阈值限制」：连续被拦 k 次后实际阈值 = min(1, 阈值 + k×ramp)，
   * 抬到 1.0 就必然放行，所以最多被连续拦 ceil((1−阈值)/ramp) 次。
   * 一旦放行，计数器归零。
   *
   * ⚠ 计数器是**全局连续**的，不是按盘口的。按盘口计数在这份数据上完全失效：
   * 61 条规则里 57 条（93.4%）一辈子只产生 1 次买入机会，压根没有第二次摇动
   * 让 ramp 生效——实测按盘口 ramp 0→0.2 净利都是 $9.9x，纹丝不动。
   * 改成全局连续计数才真的起作用（阈值 0.6，40000 次模拟里的最坏连续被拦次数）：
   *   ramp 0    最坏连拦 18 次  净利 $9.94  （占基线 53%）
   *   ramp 0.1  最坏连拦  4 次  净利 $10.76（占基线 57%）
   *   ramp 0.2  最坏连拦  2 次  净利 $11.28（占基线 60%）
   *   ramp 0.4  最坏连拦  1 次  净利 $12.09（占基线 64%）
   * 它的主要价值是**掐掉长尾**：0.6 的独立抛硬币会出现十几次连续被拦，
   * 那段时间机器人等于停摆。ramp 把这个尾巴按住，顺带把净利拉回来一点。
   */
  buyDiceRamp?: number
}

/** 买入报价方式，见 AutoTradeParams.buyOrderMode */
export type BuyOrderMode = 'taker' | 'maker'

export const DEFAULT_AUTO_TRADE: Required<AutoTradeParams> = {
  sizeMode: 'usdc',
  baseSize: 20,
  maxSize: 50,
  // 默认 2 个 tick（0.01 tick 下 = 0.02）。穿价买入时宁可多付一点也要成交。
  slippageBuffer: 0.02,
  // 0.97 以上买入到 1.0 的空间已不足 3%，扣掉滑点不值得。
  maxBuyPrice: 0.97,
  // 0.60 以下说明市场认为这条线还有四成以上概率不成立，不是「刚打出」的形态。
  minBuyPrice: 0.6,
  // 0.10 已是正常价差的数倍，再宽就是薄盘。
  maxSpread: 0.1,
  // 0.04：容得下正常价差 + 穿价缓冲，又挡住「bid 0.85 / ask 0.97」这类接盘。
  maxPremiumOverBid: 0.04,
  maxOrdersPerRule: 2,
  maxOrdersPerDay: 20,
  maxDailyNotional: 200,
  tickSize: 0.01,
  // 默认保持原有的穿价行为：maker 模式虽然每份省 +0.0822，但成交率掉到 55.8%，
  // 且需要人工判断接手逆向选择那一层（见 buyOrderMode 注释）。改动交易语义的
  // 开关不应默认打开。
  buyOrderMode: 'taker',
  // 0 = 不启用。改动交易语义的开关不默认打开，同 buyOrderMode。
  // 想按 9.24 的结论收紧资金占用就设 30（开哨时间是取整值，别设太贴）。
  minMatchMinute: 0,
  makerTickOffset: 1,
  // 0 = 不摇筛子。它是节流阀不是筛选器（阈值 0.6 只保住 53% 的净利，
  // 每笔 EV 基本不变），改动交易语义的开关不默认打开。
  buyDiceThreshold: 0,
  // 连续被拦时每次抬高的幅度。0.1 能把最坏连续被拦次数从 18 压到 4。
  buyDiceRamp: 0.1,
}

export interface PriceBotConfig {
  enabled: boolean
  pollIntervalMs: number
  botId: string
  /** 断联期间 REST 兜底轮询间隔（毫秒） */
  restFallbackIntervalMs: number
  /** 重连退避起始延迟（毫秒），失败后指数增长 */
  reconnectBaseDelayMs: number
  /** 重连退避上限（毫秒） */
  reconnectMaxDelayMs: number
  /** PONG 超时（毫秒）：发出 PING 后多久没收到 PONG 就判定连接已死 */
  pongTimeoutMs: number
  /** 重连成功后，高波动窗口持续时间（毫秒），期间抑制 percent_change 触发 */
  volatileWindowMs: number
  /** 是否在高波动窗口内抑制 percent_change 规则 */
  suppressVolatilePercentChange: boolean
  /** 是否把价格采样落库（用于回放价格路径、分析信号真伪） */
  samplePrices: boolean
  /**
   * 同一规则两次采样的最小间隔（毫秒）。
   *
   * 盘口不变时不落库，所以剧烈波动期采样自然变密、平静期自然变稀。
   * 该值只是给突发流量兜一个上限。
   */
  sampleMinIntervalMs: number
  /** 采样缓冲区刷盘间隔（毫秒），批量 INSERT 以免拖慢评估路径 */
  sampleFlushIntervalMs: number
  /**
   * 盘口深度定期补拉间隔（毫秒），0 = 关闭。
   *
   * WS 的 best_bid_ask / price_change 两类消息只带价格不带挂单量，只有 book
   * 全量快照才有 size。现有的 size 继承要求价位不变，价格一动就丢——实测
   * best_bid_size 只有 10.7% 的采样有值（4159/38693），ask 侧 7.4%。
   * 于是所有「按盘口厚度过滤」「按可成交量定份数」的判断都没有数据可依。
   *
   * 这里定期主动拉一次 REST /book 补齐深度。间隔要远大于 restFallbackIntervalMs
   * （400ms）——那是断联应急，这是常态补数，30 秒足够让 size 有连续覆盖，
   * 又不至于给 CLOB 增加明显负载。
   */
  bookRefreshIntervalMs: number
/**
   * 自动下单总开关。
   *
   * 与规则级 PriceMonitorRule.autoTradeEnabled 是「与」关系：
   * 两者同时为 true 才会真下单。默认 false，且进程重启后回到 false
   * （配置只存内存，不落库）——这是有意的：动钱的开关不该在无人值守时自己恢复。
   */
  autoTradeEnabled: boolean
  /** 自动下单全局默认参数（rule 未配置对应字段时回退） */
  autoTradeDefaults: AutoTradeParams
  /** 进球买入信号默认参数（rule 未配置对应字段时回退） */
  goalSurgeDefaults: GoalSurgeParams
  /**
   * 自动完结：买价站上阈值并持稳后自动完结当前档、按公平价判断是否递进。
   *
   * 与 autoTradeEnabled 相反，这个默认**开启**：完结只是停监控 + 建下一档，
   * 且新档硬编码 autoTradeEnabled=false，全程不动钱，所以无人值守也安全。
   */
  autoSettle: AutoSettleParams
}

export const DEFAULT_CONFIG: PriceBotConfig = {
  enabled: false,
  pollIntervalMs: 10_000,
  botId: 'price-bot-v1',
  restFallbackIntervalMs: 400,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 15_000,
  pongTimeoutMs: 10_000,
  volatileWindowMs: 8_000,
  suppressVolatilePercentChange: true,
  samplePrices: true,
  sampleMinIntervalMs: 250,
  sampleFlushIntervalMs: 2_000,
  bookRefreshIntervalMs: 30_000,
  autoTradeEnabled: false,
  autoTradeDefaults: { ...DEFAULT_AUTO_TRADE },
  goalSurgeDefaults: {
    // 窗口从 3s 放宽到 8s：实测进球后价格常呈阶梯式上行，
    // 3s 窗口只能吃到其中一段，净涨因此达不到阈值。
    surgeWindowMs: 8_000,
    // 净涨从 0.03 降到 0.02：配合 8s 窗口，覆盖「分两三跳累积上行」的形态。
    surgeMinRise: 0.02,
    jumpThreshold: 0.05,
    // 买单量门槛保留 50 作为「已知量时」的判据；
    // 实测 98% 的 WS 采样不带 size，缺量时不再阻断（见 stepGoalSurge）。
    minBidSize: 50,
    minAskSize: 50,
    askCeiling: 0.97,
    confirmMin: 0.98,
    confirmHoldMs: 2_000,
  },
  autoSettle: { ...DEFAULT_AUTO_SETTLE },
}

// ==================== 监控规则类型 ====================

/** 规则类型：价格变化百分比 / 价格绝对值突破 / 价格区间 */
export type PriceRuleType = 'percent_change' | 'price_break' | 'price_range' | 'goal_surge'

/** 监控方向：上涨 / 下跌 / 双向 */
export type PriceDirection = 'up' | 'down' | 'both'

/**
 * 价格监控规则配置
 * 每个被监控的 token 对应一条规则
 *
 * 继承 MatchContext：listRules 查询会 LEFT JOIN 带出比赛/盘口名，
 * 让前端机器人列表能直接显示「主队 vs 客队」。这些字段均为可选，
 * create/update 路径不设置它们。
 */
export interface PriceMonitorRule extends MatchContext {
  id?: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  ruleType: PriceRuleType
  direction: PriceDirection
  /** 百分比阈值（ruleType=percent_change 时使用），如 0.05 表示 5% */
  percentThreshold?: number
  /** 目标价格（ruleType=price_break 时使用） */
  targetPrice?: number
  /** 价格区间下限（ruleType=price_range 时使用） */
  priceLow?: number
  /** 价格区间上限（ruleType=price_range 时使用） */
  priceHigh?: number
  /** 信号类型：买入信号 / 卖出信号 / 双向信号告警 */
  signalType: 'buy_signal' | 'sell_signal' | 'alert'
  /** 冷却时间（秒），防止同一规则频繁触发 */
  cooldownSeconds: number
  /** 进球买入信号参数（ruleType=goal_surge 时使用），留空回退 config 默认 */
  goalSurgeParams?: GoalSurgeParams
  /**
   * 该盘口是否允许自动下单。默认 false。
   *
   * 与全局 PriceBotConfig.autoTradeEnabled 取「与」：总开关关掉时
   * 这里为 true 也不下单；总开关打开时只对本字段为 true 的盘口下单。
   */
  autoTradeEnabled?: boolean
  /** 该盘口的自动下单参数覆盖，留空回退 config.autoTradeDefaults */
  autoTradeParams?: AutoTradeParams
  /**
   * 手动完结时刻（ISO）。有值表示已完结、等待链上结算。
   *
   * 与 enabled 正交：完结必然伴随停用，但停用不代表完结
   * （也可能只是手动关掉）。两者分开存才能区分这两种情况。
   */
  settledAt?: string
  enabled: boolean
  createdAt?: string
  updatedAt?: string
}

// ==================== 价格快照 ====================

export interface PriceSnapshot {
  tokenId: string
  bestBid: number | null
  bestBidSize: number | null
  bestAsk: number | null
  bestAskSize: number | null
  lastPrice: number | null
  timestamp: string
  /** 数据来源：WebSocket 推送 / REST 兜底轮询 */
  source?: 'ws' | 'rest'
}

// ==================== 赛事上下文（JOIN 带出） ====================

/**
 * 日志/触发记录关联出的赛事与盘口信息。
 *
 * 原本这些记录只有 token_id 和 outcome，无法看出是哪场比赛的哪个盘口。
 * 查询时 LEFT JOIN soccer_events / soccer_markets 补齐，均为可选。
 */
export interface MatchContext {
  /** 「主队 vs 客队」，中文优先 */
  matchName?: string
  league?: string
  /** 盘口问题描述，如「A vs B: O/U 3.5」 */
  marketName?: string
  /** 盘口类型，如 total / spread */
  marketType?: string
  /** 盘口线，如 3.5 */
  line?: number
  /** 比赛状态（由 end_time 现算：not_started/live/ended），供左侧列表过滤 */
  matchStatus?: 'not_started' | 'live' | 'ended'
  /** 比赛 end_time（作 kickoff 代理），供排序/过滤 */
  endTime?: string
}

// ==================== 触发事件记录 ====================

export interface PriceTriggerRecord extends MatchContext {
  id?: number
  botId: string
  ruleId: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  ruleType: PriceRuleType
  direction: PriceDirection
  previousPrice: number
  currentPrice: number
  changePercent: number
  threshold: number
  signalType: string
  triggeredAt?: string
}

// ==================== 监控状态 ====================

export interface PriceMonitorState {
  ruleId: number
  tokenId: string
  running: boolean
  lastPollTime: string | null
  lastError: string | null
  cyclesRun: number
  triggerCount: number
  /** 基准价格（用于计算涨跌幅） */
  baselinePrice: number | null
  /** 上次触发时间（用于冷却） */
  lastTriggerTime: string | null
  /** 最近一次价格 */
  lastPrice: number | null
  /**
   * 正在处理触发（同步占位标记）。
   *
   * evaluateRuleForId 内含 await，消息突发时会有大量并发调用。
   * 该标记在任何 await 之前同步置位，确保同一规则同时只有一次触发在处理，
   * 避免并发调用全部读到旧的 lastTriggerTime / baselinePrice 而重复触发。
   */
  triggerInFlight?: boolean
  /** 因处于高波动窗口而被抑制的触发次数（用于观察抑制是否过度） */
  suppressedCount?: number
  /** 上次价格采样时刻（毫秒时间戳），用于限制采样频率 */
  lastSampleAt?: number
  /** 上次采样的盘口指纹，盘口完全未变时跳过采样 */
  lastSampleKey?: string
  /** 已缓冲的采样条数（用于观察采样量） */
  sampledCount?: number
  /** goal_surge：最近若干 tick 的环形缓冲（内存，秒级递增判定用） */
  recentTicks?: Array<{ t: number; bid: number | null; ask: number | null; mid: number | null; bidSize: number | null; askSize: number | null }>
  /** goal_surge：状态机当前态 */
  goalSurgeState?: 'idle' | 'candidate'
  /** goal_surge：候选态起始时间戳（毫秒），用于买单门槛超时回退 */
  candidateSince?: number
  /** goal_surge：进入波动窗口前的 bestBid 基准（信号二比较用） */
  preVolatileBid?: number | null
  /** goal_surge：已发买入信号、待「价格稳定在 confirmMin」事后确认 */
  pendingConfirm?: { signalTime: number; holdStartedAt?: number } | null
  /**
   * goal_surge：买入信号静默截止（毫秒时间戳）。到点之前不评估进球信号。
   *
   * 为「完结上一档、开下一档」那一刻服务。进球瞬间**所有**档位同涨
   * （0 球进 1 球时 Over 3.5 也会从 0.05 抬到 0.09），刚建的下一档一上线
   * 就看到一段陡涨，于是立刻发买入信号——但那段涨幅属于**刚打出的上一档**，
   * 不是这一档的进球。实测亏损单多是这个形态（按 0.85~0.90 接一条未打出的线）。
   *
   * 静默只压住「买」，不压住「看」：采样、日志、断联统计照常，
   * 所以静默期内的价格路径仍然完整落库，事后能复盘那波余震。
   */
  surgeMutedUntil?: number
  /**
   * 自动完结：买价站上阈值的起始时刻（毫秒时间戳）。
   * 跌出阈值即清空——薄盘的瞬时尖峰不能累计成「持稳」。
   */
  settleHoldSince?: number
  /** 自动完结已触发。防止完结流程还在跑时同一条规则被重复触发。 */
  autoSettleFired?: boolean
}

// ==================== 监控日志 ====================

export interface PriceBotLog extends MatchContext {
  id?: number
  ruleId: number
  tokenId: string
  eventId: string
  outcome: string
  action: 'start' | 'stop' | 'price_update' | 'trigger' | 'buy_signal' | 'disconnect' | 'reconnect'
  /** 中间价 (bestBid + bestAsk) / 2 */
  price: number | null
  /**
   * 盘口快照。买入实际吃 bestAsk、卖出吃 bestBid，
   * 只看中间价会把「报价被撤单导致 mid 跳变」误判成价格变化，
   * 所以判断信号真伪必须落库这四个字段。
   */
  bestBid?: number | null
  bestBidSize?: number | null
  bestAsk?: number | null
  bestAskSize?: number | null
  /** 数据来源：ws 实时推送 / rest 断联兜底轮询 */
  source?: 'ws' | 'rest' | null
  detail: string | null
  loggedAt?: string
}

// ==================== 连接事件记录 ====================

/**
 * WebSocket 连接事件。
 *
 * 用于验证「进球时盘口剧烈波动导致 WS 断联」这一假设：
 * 记录每次断开/重连的时长、重连后首个价格、以及断联前后的价差，
 * 积累样本后才能判断断联与进球的相关性。
 */
export interface PriceBotConnectionEvent {
  id?: number
  botId: string
  /** disconnect（断开） / reconnect（重连成功） */
  eventType: 'disconnect' | 'reconnect'
  /** 断开原因：ws_close / pong_timeout / ws_error / resubscribe（主动重建） */
  reason: string
  /** WebSocket 关闭码 */
  closeCode?: number | null
  /** 本次断联持续毫秒数（reconnect 事件才有） */
  downtimeMs?: number | null
  /** 断联时订阅的 token 数量 */
  subscribedTokens: number
  /** 断联前最后一次收到的价格（多 token 时记录首个受影响 token） */
  priceBefore?: number | null
  /** 重连后首个价格 */
  priceAfter?: number | null
  /** 断联前后价差（priceAfter - priceBefore） */
  priceDelta?: number | null
  /** 参考的 token（priceBefore/priceAfter 对应哪个 token） */
  tokenId?: string | null
  detail?: string | null
  createdAt?: string
}

// ==================== 连接状态 ====================

/** WebSocket 连接运行时状态 */
export interface ConnectionState {
  connected: boolean
  /** 当前是否处于断联期（含 REST 兜底中） */
  disconnected: boolean
  /** 本次断联开始时间 */
  disconnectedAt: string | null
  /** 连续重连失败次数（用于指数退避） */
  reconnectAttempts: number
  /** 累计断联次数 */
  totalDisconnects: number
  /** 最近一次断联时长（毫秒） */
  lastDowntimeMs: number | null
  /** REST 兜底轮询是否运行中 */
  restFallbackActive: boolean
  /**
   * 高波动窗口截止时间戳（毫秒）。
   *
   * 断联期间及重连后一段时间内，baselinePrice 可能是断联前的陈旧价格，
   * 基于它计算的百分比变化会产生巨大的假信号（实测见过 +111% 的跳变）。
   * 该窗口内 percent_change 类规则被抑制。
   */
  volatileUntil: number | null
}

// ==================== 自动下单记录 ====================

/**
 * 下单尝试的最终状态。
 *
 * skipped 表示被风控/参数拦下，压根没提交给交易所——它同样落库，
 * 否则「为什么这次信号没下单」只能靠翻日志猜。
 */
export type AutoOrderStatus = 'placed' | 'failed' | 'skipped' | 'simulated'

export interface AutoOrderRecord extends MatchContext {
  id?: number
  botId: string
  ruleId: number
  tokenId: string
  marketId: string
  eventId: string
  outcome: string
  /** 实际提交的限价（已含穿价缓冲、已对齐 tick） */
  limitPrice: number
  /** 实际提交的份数 */
  size: number
  /** 名义金额 = limitPrice * size */
  notional: number
  sizeMode: OrderSizeMode
  status: AutoOrderStatus
  /** skipped/failed 的原因，便于回溯风控命中项 */
  reason?: string
  /** 决策当时的盘口，用于事后复盘成交率 */
  bestBid?: number | null
  bestBidSize?: number | null
  bestAsk?: number | null
  bestAskSize?: number | null
  /** trading.ts 落库的订单主键（soccer_orders.id） */
  tradeOrderId?: number | null
  /** CLOB 侧订单号 */
  clobOrderId?: string | null
  createdAt?: string
}

// ==================== 机器人状态 ====================

interface BotState {
  config: PriceBotConfig
  monitors: Map<number, PriceMonitorState>
}

export type { BotState }
