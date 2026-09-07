/**
 * 全场次盘口监控的独立入口（纯观测，不下单）。
 *
 *   npx tsx src/bots/price-bot/line-monitor-runner.ts
 *
 * 可选环境变量：
 *   MONITOR_LINES=0.5,1.5     采哪些档（默认只 0.5）
 *   MONITOR_TICK_SECONDS=10   主循环间隔（默认 10；真实采样节奏由
 *                             cadenceSeconds 按每场比赛阶段决定）
 *   MONITOR_ONCE=1            只跑一轮就退出（用于验证）
 *
 * 与机器人进程独立：不读规则、不建规则、不下单，只写
 * price_bot_line_monitor 一张表。两个进程同时跑不会互相影响。
 */
import { runMonitorRound, DEFAULT_MONITOR_CONFIG, type MonitorConfig } from './line-monitor.js'

function parseLines(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_MONITOR_CONFIG.lines
  const out = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  return out.length ? out : DEFAULT_MONITOR_CONFIG.lines
}

const cfg: MonitorConfig = {
  ...DEFAULT_MONITOR_CONFIG,
  lines: parseLines(process.env.MONITOR_LINES),
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
    `[LineMonitor] 启动：档位 ${cfg.lines.join(',')}，` +
      `窗口 开哨前${cfg.preKickoffMinutes}分~开哨后${cfg.postKickoffMinutes}分，` +
      `tick ${tickMs / 1000}s，纯观测不下单`,
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
