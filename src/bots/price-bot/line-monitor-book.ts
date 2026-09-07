/**
 * 盘口监控的纯逻辑：盘口整理、可成交判定、采样节奏、深度加权成交价。
 *
 * 单独一个文件是为了可测：line-monitor.ts 顶层 import 了 soccer/db.js，
 * 那里 module load 就 createPool，测试进程会挂住不退出。这里零 DB 依赖。
 */
import { FIRST_TOTAL_LINE } from './goal-lines.js'

/** 盘口有效性阈值。只用决策时刻信息，不看结果。 */
export interface MonitorConfig {
  /** 采样哪些档位。默认只 0.5。 */
  lines: number[]
  /** 开哨前多少分钟开始采 */
  preKickoffMinutes: number
  /** 开哨后多少分钟停止采 */
  postKickoffMinutes: number
  /** 最大可接受绝对价差 */
  maxSpread: number
  /** 顶档最小挂单量（张） */
  minTopSize: number
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  lines: [FIRST_TOTAL_LINE],
  preKickoffMinutes: 60,
  postKickoffMinutes: 130,
  maxSpread: 0.1,
  minTopSize: 1,
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
