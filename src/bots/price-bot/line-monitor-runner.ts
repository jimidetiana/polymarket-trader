/**
 * 全场次盘口监控的独立入口（纯观测，不下单）。
 *
 *   npx tsx src/bots/price-bot/line-monitor-runner.ts
 *
 * 可选环境变量：
 *   MONITOR_LINES=0.5,1.5,2.5 采哪些档（默认 0.5,1.5,2.5，全部从开哨前就采）
 *   MONITOR_SETTLED_CADENCE=300  某档 Over 钉死后的采样间隔秒，0=不降频
 *                                （默认 300：实测 62.9% 的采集量花在已钉死的档上）
 *   MONITOR_TICK_SECONDS=10   主循环间隔（默认 10；真实采样节奏由
 *                             cadenceSeconds 按每场比赛阶段决定）
 *   MONITOR_ONCE=1            只跑一轮就退出（用于验证）
 *   MONITOR_MIN_LIQUIDITY=5000  赛事最低挂单深度，0=关（默认 5000）
 *   MONITOR_MIN_VOLUME=0        赛事最低成交量，0=关（默认 0）
 *                               ⚠ 开这个会砍掉历史上过半的盈利场次，
 *                               原因见 line-monitor-book.ts passesMatchGate
 *
 * 与机器人进程独立：不读规则、不建规则、不下单，只写
 * price_bot_line_monitor 一张表。两个进程同时跑不会互相影响。
 *
 * 代理：走 .env 里的 HTTPS_PROXY，与 npm run soccer 同一条路径
 * （server.ts → config.js → import 'dotenv/config'）。
 *
 * 为什么要显式找 .env 而不是靠 dotenv 默认行为：.env 是 gitignored 的，
 * **不会随 git worktree 复制**。在 worktree 里跑时 cwd 下没有 .env，
 * dotenv 默认只看 cwd，于是拿不到代理 → 直连 clob.polymarket.com →
 * connect ECONNREFUSED / read ECONNRESET，几轮后变成 timeout of 20000ms。
 * 实测症状是「窗口28 采样28 回书0」：库侧查得到候选，网络侧一本书都没回来。
 *
 * 所以从本文件位置往上找最近的 .env（worktree 里找不到就落到主 checkout），
 * 这样 worktree 和主目录两边跑起来行为一致。启动日志会打出代理状态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

/** 从 startDir 逐级向上找 .env，返回第一个命中的绝对路径 */
function findEnvFile(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const here = path.dirname(fileURLToPath(import.meta.url))
// worktree 里没有 .env（gitignored 不复制），退到主 checkout 去找
const envPath =
  findEnvFile(process.cwd()) ??
  findEnvFile(here) ??
  findEnvFile(path.resolve(here, '../../../../../..'))
if (envPath) dotenv.config({ path: envPath })

// dotenv 必须排在 line-monitor.js 之前：那边虽已改成请求时读代理，
// 但 CLOB_API_URL 仍在模块加载时取值。
const { runMonitorRound, DEFAULT_MONITOR_CONFIG } = await import('./line-monitor.js')
type MonitorConfig = import('./line-monitor.js').MonitorConfig

function parseLines(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_MONITOR_CONFIG.lines
  const out = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  return out.length ? out : DEFAULT_MONITOR_CONFIG.lines
}

/** 环境变量里的非负数阈值；空/非法时用默认值，不静默当 0（0 是「关闸门」） */
function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const cfg: MonitorConfig = {
  ...DEFAULT_MONITOR_CONFIG,
  lines: parseLines(process.env.MONITOR_LINES),
  // 字段名必须和 MonitorConfig 完全一致：这里曾写成 minLiquidity/minVolume，
  // 因为上面先 spread 了默认值，拼错的键会被静默忽略 → 环境变量看着生效其实没接上。
  minEventLiquidity: parseThreshold(
    process.env.MONITOR_MIN_LIQUIDITY,
    DEFAULT_MONITOR_CONFIG.minEventLiquidity,
  ),
  minEventVolume: parseThreshold(
    process.env.MONITOR_MIN_VOLUME,
    DEFAULT_MONITOR_CONFIG.minEventVolume,
  ),
  settledCadenceSeconds: parseThreshold(
    process.env.MONITOR_SETTLED_CADENCE,
    DEFAULT_MONITOR_CONFIG.settledCadenceSeconds,
  ),
}

const tickMs = Math.max(1, Number(process.env.MONITOR_TICK_SECONDS ?? 10)) * 1000
const once = process.env.MONITOR_ONCE === '1'

let stopping = false
let inFlight = false

async function tick(): Promise<void> {
  // 上一轮没回来就跳过，避免请求堆积（同 pollBooksViaRest 的做法）
  if (inFlight) return
  inFlight = true
  const t0 = Date.now()
  try {
    const r = await runMonitorRound(cfg, new Date())
    if (r.inWindow === 0) {
      console.log(`[LineMonitor] 窗口内无候选（${new Date().toISOString()}）`)
    } else {
      const bad = Object.entries(r.invalidByReason)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      console.log(
        `[LineMonitor] 窗口${r.inWindow} 采样${r.candidates} 回书${r.booksReturned} ` +
          `落库${r.inserted} 有效${r.valid}` +
          (r.settledActive ? ` 已钉${r.settledActive}档(降频)` : '') +
          (r.newlySettled ? ` 新钉${r.newlySettled}` : '') +
          (bad ? ` | 无效: ${bad}` : '') +
          ` | ${Date.now() - t0}ms`,
      )
    }
  } catch (err: any) {
    console.error('[LineMonitor] 本轮出错:', err?.message ?? err)
  } finally {
    inFlight = false
  }
}

async function main(): Promise<void> {
  console.log(
    `[LineMonitor] 启动：档位 ${cfg.lines.join(',')}（全部从开哨前就采），` +
      `窗口 开哨前${cfg.preKickoffMinutes}分~开哨后${cfg.postKickoffMinutes}分，` +
      `tick ${tickMs / 1000}s，` +
      `已钉档降频至${cfg.settledCadenceSeconds}s，纯观测不下单`,
  )
  await tick()
  if (once) {
    console.log('[LineMonitor] MONITOR_ONCE=1，跑完一轮退出')
    process.exit(0)
  }
  const timer = setInterval(() => {
    if (!stopping) void tick()
  }, tickMs)

  const shutdown = (sig: string) => {
    if (stopping) return
    stopping = true
    console.log(`[LineMonitor] 收到 ${sig}，停止`)
    clearInterval(timer)
    // 等在途那一轮落库完再退
    const wait = setInterval(() => {
      if (!inFlight) {
        clearInterval(wait)
        process.exit(0)
      }
    }, 200)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main()
