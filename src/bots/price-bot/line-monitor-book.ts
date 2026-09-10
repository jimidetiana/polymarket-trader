/**
 * 盘口监控的纯逻辑：盘口整理、可成交判定、采样节奏、深度加权成交价。
 *
 * 单独一个文件是为了可测：line-monitor.ts 顶层 import 了 soccer/db.js，
 * 那里 module load 就 createPool，测试进程会挂住不退出。这里零 DB 依赖。
 */
import { FIRST_TOTAL_LINE } from './goal-lines.js'

/** 盘口有效性阈值。只用决策时刻信息，不看结果。 */
export interface MonitorConfig {
  /**
   * 采样哪些档位。**每档都从开哨前就采，不等低档打出**。
   *
   * 为什么不是「0.5 冲破后再顺势接 1.5」：那正是 line-monitor.ts 头注释里
   * 说的、这个采集器存在的原因要避开的做法。等 0.5 打出才开 1.5，1.5 的
   * 样本条件就变成「已经进了 ≥1 球」，选择偏差会被读成错价（实测过一次：
   * Over [0.10,0.30) 显示「隐含 77.7% vs 实测 45.9%」，等于 Over 3.5/4.5
   * 赢了 54%，足球里不可能）。所以档位集合必须**与结果无关地预先定义**。
   */
  lines: number[]
  /**
   * 某档的 Over 已经钉死后的采样间隔（秒）。0 = 不降频。
   *
   * 实测 80,000 行里 50,302 行（62.9%）是 0.5 的 Over 钉到 0.99 之后才采的，
   * 这批行里还可成交的只有 6 行（0.012%）——即 3/5 的采集量在记录一个
   * 不会再动的 0.999。降频而不是彻底停采：进球被 VAR 取消虽罕见但会翻档，
   * 完全停采就把那种翻转记成「一直是 0.999」。
   */
  settledCadenceSeconds: number
  /** 开哨前多少分钟开始采 */
  preKickoffMinutes: number
  /** 开哨后多少分钟停止采 */
  postKickoffMinutes: number
  /** 最大可接受绝对价差 */
  maxSpread: number
  /** 顶档最小挂单量（张） */
  minTopSize: number
  /**
   * 赛事最低成交量（USDC）。0 = 不按成交量筛。
   * 默认 0，见 passesMatchGate 里为什么它不适合当主闸门。
   */
  minEventVolume: number
  /** 赛事最低挂单深度（USDC）。0 = 不按深度筛。 */
  minEventLiquidity: number
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  // 0.5/1.5/2.5 三档同采。实测依据（20 场已被 Over 打破 0.5 的比赛，
  // 查 /prices-history fidelity=1）：1.5 档 19/20 场、2.5 档 20/20 场在场中
  // 都有报价，且每一场场中价格都动过 ≥0.05，不是钉住的死盘。
  // 不含 3.5/4.5：没实测过它们场中的活跃度，且请求量按档线性涨。
  lines: [FIRST_TOTAL_LINE, 1.5, 2.5],
  // 5 分钟。0.5 平均在第 36.9 分钟就定了，之后每场还要白采 503 行；
  // 降到 300s 砍掉其中约 93%，同时保留 VAR 翻转的观测窗口。
  settledCadenceSeconds: 300,
  preKickoffMinutes: 60,
  postKickoffMinutes: 130,
  maxSpread: 0.1,
  minTopSize: 1,
  // 成交量默认不筛：实测赛前成交量太小且与「盘能不能成交」不相关，见下。
  minEventVolume: 0,
  // 深度筛掉真正的死盘。5000 这个值实测省 9.9% 场次，且被它砍掉的
  // 7 笔历史成交单合计净 -0.25（即被砍掉的是净亏单，不是盈利单）。
  minEventLiquidity: 5_000,
}

/** 赛事级过滤的输入。字段名对齐 soccer_events 的列。 */
export interface MatchGateInput {
  /** soccer_events.volume：**累计已成交额**，每日 00:05 UTC 快照 */
  volume: number | null | undefined
  /** soccer_events.liquidity：盘上**还挂着**多少 */
  liquidity: number | null | undefined
}

/**
 * 「这场比赛值不值得采」的赛事级闸门。
 *
 * 为什么默认不按成交量筛（minEventVolume=0），尽管「冷门比赛不采」听起来天经地义：
 *
 * 1. **成交量和「盘能不能成交」几乎不相关。** volume 是已经成交了多少，
 *    liquidity 是盘上还挂着多少。实测低量比赛的深度完全正常：
 *      Woking FC   volume=41   liquidity=41,223
 *      Vólos NPS   volume=88   liquidity=109,201
 *      AD Machico  volume=234  liquidity=39,810
 *      BK Hacken   volume=412  liquidity=168,460
 *    做市商在冷门比赛上照样铺深度，这正是这些比赛能成交的原因。
 *
 * 2. **历史上赚钱的单一半在低量比赛里。** 108 笔成交单中 48 笔来自
 *    volume<5000，合计净 +8.43（总净 +14.35）。阈值 500 就会砍掉 12 笔、
 *    占总净利的 58%；阈值 3000 砍掉的净利超过 100%（即留下的是净亏组合）。
 *
 * 3. **赛前成交量本来就极小。** volume 是每日 00:05 UTC 的快照，未开赛场次
 *    实测中位数只有 853、p90 才 3,592。而历史盈利单看到的那些「低量」数字
 *    还是**赛后**快照（AD Machico 的 234 是开哨后 344 分钟采的），真实赛前
 *    量比它更低——任何 ≥100 的阈值在当时都会把它们挡在外面。
 *
 * 所以成交量这一维留成可调旋钮但默认关。真正能安全砍掉的是**零深度死盘**：
 * 全库 1846 场里 liquidity=0 的只有 27 场，liquidity<5000 的约占 9.9%。
 *
 * 两个条件是 **AND**（都要过），而不是任一过就留：deep-but-never-traded 是
 * 正常的（做市商铺了盘还没人吃），traded-but-now-empty 才是异常。
 */
export function passesMatchGate(
  m: MatchGateInput,
  cfg: Pick<MonitorConfig, 'minEventVolume' | 'minEventLiquidity'>,
): { pass: boolean; reason: string | null } {
  const vol = Number(m.volume ?? 0)
  const liq = Number(m.liquidity ?? 0)
  if (cfg.minEventVolume > 0 && !(vol >= cfg.minEventVolume)) {
    return { pass: false, reason: 'low_volume' }
  }
  if (cfg.minEventLiquidity > 0 && !(liq >= cfg.minEventLiquidity)) {
    return { pass: false, reason: 'low_liquidity' }
  }
  return { pass: true, reason: null }
}

/**
 * 把一侧盘口整理成前 N 档。
 * CLOB 的 bids/asks 顺序不保证，所以显式排序：买方由高到低，卖方由低到高。
 */
export function topLevels(raw: any, side: 'bids' | 'asks', n = 5): [number, number][] {
  const arr = Array.isArray(raw?.[side]) ? raw[side] : []
  const parsed: [number, number][] = []
  for (const lv of arr) {
    const p = Number(lv?.price)
    const s = Number(lv?.size)
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue
    parsed.push([p, s])
  }
  parsed.sort((a, b) => (side === 'bids' ? b[0] - a[0] : a[0] - b[0]))
  return parsed.slice(0, n)
}

/**
 * 决策时刻的可成交判定。只用当刻信息。
 *
 * 为什么 ask>=1 也算无效：结算会把赢家推到 1.0，此时「有 ask」是假的可成交。
 * 为什么要 ask>bid：交叉/锁盘是脏数据，不是可成交。
 */
export function judgeBook(
  bids: [number, number][],
  asks: [number, number][],
  cfg: MonitorConfig,
): { valid: boolean; reason: string | null } {
  if (!asks.length) return { valid: false, reason: 'no_ask' }
  if (!bids.length) return { valid: false, reason: 'no_bid' }
  const bestBid = bids[0][0]
  const bestAsk = asks[0][0]
  if (bestAsk >= 1) return { valid: false, reason: 'ask_at_one' }
  if (bestBid <= 0) return { valid: false, reason: 'bid_at_zero' }
  if (bestAsk <= bestBid) return { valid: false, reason: 'crossed' }
  if (bestAsk - bestBid > cfg.maxSpread) return { valid: false, reason: 'spread_wide' }
  if (asks[0][1] < cfg.minTopSize) return { valid: false, reason: 'thin_ask' }
  return { valid: true, reason: null }
}

/**
 * 该比赛此刻应当多久采一次（秒）。
 *
 * 分档而不是一律 20 秒：赛前价几小时才动一次，细粒度纯属浪费代理字节；
 * 而 Angelini 等测出盘中错价在进球后约 20 秒最强、5 分钟内衰减，所以开哨后
 * 必须细。取 20 秒是为了让「进球后 20 秒」这个窗口至少落进一个采样点。
 */
export function cadenceSeconds(matchMinute: number | null): number {
  if (matchMinute == null) return 300
  if (matchMinute < -10) return 300
  if (matchMinute < 0) return 60
  return 20
}

/** 「这一档已经打出了」的判定阈值。与 monitor-ev 的 SETTLE_THRESHOLD 同值。 */
export const SETTLED_BID = 0.99

/**
 * 这一档的 Over 是否已经钉死（=该档已打出，价格不会再回来）。
 *
 * **只认 Over 钉死，不认 Under 钉死**，这个不对称是刻意的：
 *
 * - Over 钉 0.999 = 球已经进了。进球不可逆（VAR 取消是罕见例外，
 *   所以下面是降频而非停采），这一档没有信息了。
 * - Under 钉 0.999 = 此刻还是 0-0，但**第 89 分钟仍可能进球**。这正是
 *   要测的「翻车」瞬间。若把它也当已定局而降频，就会漏掉整个反转事件。
 *
 * 判据只用 bid：钉死时卖档是空的，best_ask 为 null，不能拿来判。
 */
export function isLineSettled(
  side: 'over' | 'under',
  bestBid: number | null | undefined,
): boolean {
  if (side !== 'over') return false
  return bestBid != null && bestBid >= SETTLED_BID
}

/**
 * 计入「该档是否已打出」之后的实际采样间隔。
 *
 * 已打出的档取 max(正常节奏, settledCadenceSeconds)：绝不比正常节奏更快，
 * 也不会因为配 0 而变成「已打出就狂采」。
 */
export function cadenceSecondsFor(
  matchMinute: number | null,
  settled: boolean,
  settledCadence: number = DEFAULT_MONITOR_CONFIG.settledCadenceSeconds,
): number {
  const base = cadenceSeconds(matchMinute)
  if (!settled || settledCadence <= 0) return base
  return Math.max(base, settledCadence)
}

/**
 * 按 want 张吃盘口，返回深度加权成交价；深度不够返回 null。
 *
 * 为什么不用顶档 ask：Dubach(2026) 实测 Polymarket 深度分布接近均匀几何网格
 * 而非集中在顶档，顶档 ask 会系统性低估成交成本。深度不足时返回 null 而不是
 * 退化成顶档价——那会把「买不到」记成「买得到」。
 */
export function depthWeightedPrice(
  levels: [number, number][],
  want: number,
): number | null {
  if (want <= 0) return null
  let need = want
  let cost = 0
  for (const [p, s] of levels) {
    const take = Math.min(need, s)
    cost += take * p
    need -= take
    if (need <= 1e-9) return cost / want
  }
  return null
}

/** MySQL DATETIME 串（UTC），不带时区后缀 */
export function toMysqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
