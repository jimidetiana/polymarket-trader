import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Activity, AlertTriangle } from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatNumber, formatPercent } from '@/lib/utils'
import {
  fetchMonitorReport,
  type MonitorReport,
  type ReversalParams,
} from '@/lib/api'

/** 采集器落后多少秒算「停了」。tick 最长 300s（赛前远端），留一倍余量 */
const STALE_LIMIT_SEC = 600

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'positive' | 'negative' | 'warning' | 'neutral'
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 text-xl font-semibold tabular-nums',
          tone === 'positive' && 'text-success',
          tone === 'negative' && 'text-error',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** 横向占比条。用来看有效率/无效原因构成，比纯数字快 */
function Bar({ pct, tone }: { pct: number; tone?: 'good' | 'bad' | 'neutral' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          'h-full rounded-full',
          tone === 'good' && 'bg-success',
          tone === 'bad' && 'bg-error',
          (!tone || tone === 'neutral') && 'bg-primary',
        )}
        style={{ width: `${Math.max(0, Math.min(1, pct)) * 100}%` }}
      />
    </div>
  )
}

function minuteRange(mn: number | null, mx: number | null): string {
  if (mn == null && mx == null) return '—'
  if (mn === mx) return `${mn}′`
  return `${mn ?? '?'}′ ~ ${mx ?? '?'}′`
}

export default function MonitorReportPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<MonitorReport | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  // 反转口径。默认对齐手写 SQL：早端含赛前、不限双边可成交
  const [rev, setRev] = useState<ReversalParams>({
    earlyBid: 0.9,
    earlyBefore: 10,
    earlyFrom: null,
    lateBid: 0.9,
    lateAfter: 100,
    validOnly: false,
  })

  const load = useCallback(async (params: ReversalParams) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchMonitorReport(params)
      setReport(data)
      setLastUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(rev)
    // 只在首次挂载拉一次；改口径要点「应用」，避免每敲一个字符打一次库
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ov = report?.overview
  const stale = ov?.staleSeconds
  const isStale = stale != null && stale > STALE_LIMIT_SEC

  return (
    <Layout
      title="采集器分析"
      subtitle="price_bot_line_monitor 纯观测时间序列，只读库不打外网"
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              to="/price-bot"
              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">采集器汇总分析</h1>
              <p className="text-xs text-muted-foreground">
                price_bot_line_monitor · 纯观测时间序列
                {lastUpdated && ` · 更新于 ${lastUpdated}`}
              </p>
            </div>
          </div>
          <button
            onClick={() => void load(rev)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-error/40 bg-error/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
            <span>{error}</span>
          </div>
        )}

        {ov && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <StatCard label="总行数" value={formatNumber(ov.rows)} hint={`${ov.snapshots} 轮采样`} />
              <StatCard label="赛事数" value={String(ov.events)} hint={`${ov.tokens} 个 token`} />
              <StatCard
                label="可成交行"
                value={formatNumber(ov.validRows)}
                hint={`占 ${formatPercent(ov.validPct)}`}
                tone={ov.validPct >= 0.2 ? 'positive' : 'warning'}
              />
              <StatCard
                label="采集状态"
                value={isStale ? '已停' : '运行中'}
                hint={stale == null ? '—' : `落后 ${stale}s`}
                tone={isStale ? 'negative' : 'positive'}
              />
              <StatCard
                label="覆盖时长"
                value={`${(ov.spanMinutes / 60).toFixed(1)}h`}
                hint={`${ov.spanMinutes} 分钟`}
              />
              <StatCard
                label="深度闸门"
                value={`${report.gate.belowGate}/${report.gate.events}`}
                hint={`低于 ${formatNumber(report.gate.threshold)} 的场次`}
                tone={report.gate.belowGate > 0 ? 'warning' : 'neutral'}
              />
            </div>

            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <Activity className="h-3.5 w-3.5" />
                读数前提
              </div>
              <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                <li>
                  <span className="text-foreground">snapshot_at 存 UTC</span>，新鲜度用 UTC_TIMESTAMP()
                  算；用 NOW() 会凭空多 8 小时，看起来像采集器挂了。
                </li>
                <li>
                  <span className="text-foreground">match_minute 相对「计划开哨」</span>，不是实际比赛钟，
                  开哨时间有 ±30 分钟 slop。负数=赛前。
                </li>
                <li>
                  <span className="text-foreground">单边盘不是 bug</span>：over/under 是互补 token，
                  over(5买/0卖) 必然镜像 under(0买/5卖)。0.5 档进球后成定局，赢家钉 0.999 且卖档空。
                </li>
              </ul>
            </div>
          </>
        )}

        {report && (
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="overflow-hidden rounded-md border bg-card">
              <div className="border-b px-3 py-2 text-sm font-medium">
                比赛阶段 × 可成交率
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  赛前盘双边最全，进球后掉下来
                </span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">阶段</th>
                    <th className="px-3 py-2 text-right font-medium">行数</th>
                    <th className="px-3 py-2 text-right font-medium">可成交</th>
                    <th className="px-3 py-2 text-right font-medium">占比</th>
                    <th className="w-24 px-3 py-2 font-medium">分布</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.phases.map((p) => (
                    <tr key={p.phase} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{p.phase}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(p.rows)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(p.valid)}</td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right tabular-nums',
                          p.validPct >= 0.5 ? 'text-success' : p.validPct < 0.1 ? 'text-error' : '',
                        )}
                      >
                        {formatPercent(p.validPct)}
                      </td>
                      <td className="px-3 py-2">
                        <Bar pct={p.validPct} tone={p.validPct >= 0.5 ? 'good' : 'neutral'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="overflow-hidden rounded-md border bg-card">
              <div className="border-b px-3 py-2 text-sm font-medium">
                无效原因构成
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  no_ask/no_bid 成对出现即互补 token
                </span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">原因</th>
                    <th className="px-3 py-2 text-right font-medium">行数</th>
                    <th className="px-3 py-2 text-right font-medium">占比</th>
                    <th className="w-24 px-3 py-2 font-medium">分布</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.reasons.map((r) => (
                    <tr key={r.reason} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono">{r.reason}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.rows)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(r.pct)}</td>
                      <td className="px-3 py-2">
                        <Bar pct={r.pct} tone={r.reason === '(有效)' ? 'good' : 'bad'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="overflow-hidden rounded-md border bg-card">
              <div className="border-b px-3 py-2 text-sm font-medium">
                可成交行的价格带
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  这才是真能下单的样本
                </span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">卖价带</th>
                    <th className="px-3 py-2 text-right font-medium">行数</th>
                    <th className="px-3 py-2 font-medium">出现分钟</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.bands.map((b) => (
                    <tr key={b.band} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono">{b.band}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(b.rows)}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {minuteRange(b.minMinute, b.maxMinute)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="overflow-hidden rounded-md border bg-card">
              <div className="border-b px-3 py-2 text-sm font-medium">
                O/U 盘口形态配对
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  镜像即正常，非镜像才要查
                </span>
              </div>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">形态</th>
                      <th className="px-3 py-2 text-right font-medium">配对数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {report.shapes.map((s) => (
                      <tr key={s.shape} className="hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono text-[11px]">{s.shape}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(s.pairs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {report && (
          <section className="overflow-hidden rounded-md border bg-card">
            <div className="border-b px-3 py-2 text-sm font-medium">
              反转分析
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                早端 Over 高价 → 晚端 Under 高价
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-3 border-b bg-muted/20 p-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">早端 Over 买价 &gt;</span>
                <input
                  type="number"
                  step="0.01"
                  value={rev.earlyBid}
                  onChange={(e) => setRev({ ...rev, earlyBid: Number(e.target.value) })}
                  className="w-20 rounded-md border bg-background px-2 py-1 text-xs tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">早端分钟 &lt;</span>
                <input
                  type="number"
                  value={rev.earlyBefore}
                  onChange={(e) => setRev({ ...rev, earlyBefore: Number(e.target.value) })}
                  className="w-20 rounded-md border bg-background px-2 py-1 text-xs tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">早端分钟 ≥（空=含赛前）</span>
                <input
                  type="number"
                  placeholder="不限"
                  value={rev.earlyFrom ?? ''}
                  onChange={(e) =>
                    setRev({
                      ...rev,
                      earlyFrom: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="w-28 rounded-md border bg-background px-2 py-1 text-xs tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">晚端 Under 买价 &gt;</span>
                <input
                  type="number"
                  step="0.01"
                  value={rev.lateBid}
                  onChange={(e) => setRev({ ...rev, lateBid: Number(e.target.value) })}
                  className="w-20 rounded-md border bg-background px-2 py-1 text-xs tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">晚端分钟 &gt;</span>
                <input
                  type="number"
                  value={rev.lateAfter}
                  onChange={(e) => setRev({ ...rev, lateAfter: Number(e.target.value) })}
                  className="w-20 rounded-md border bg-background px-2 py-1 text-xs tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5 pb-1.5">
                <input
                  type="checkbox"
                  checked={rev.validOnly}
                  onChange={(e) => setRev({ ...rev, validOnly: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                <span className="text-xs">只算双边可成交</span>
              </label>
              <button
                onClick={() => void load(rev)}
                disabled={loading}
                className="rounded-md border bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                应用
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-4">
              <StatCard
                label="早端命中"
                value={String(report.reversal.earlyEvents)}
                hint="Over 高价的场次"
              />
              <StatCard
                label="晚端命中"
                value={String(report.reversal.lateEvents)}
                hint="Under 高价的场次"
              />
              <StatCard
                label="反转场次"
                value={String(report.reversal.reversals)}
                hint="两端都命中"
                tone={report.reversal.reversals > 0 ? 'warning' : 'neutral'}
              />
              <StatCard
                label="反转率"
                value={report.reversal.rate == null ? '—' : formatPercent(report.reversal.rate)}
                hint="反转 / 早端"
              />
            </div>

            {!rev.validOnly && report.reversal.reversals > 0 && (
              <div className="mx-3 mb-3 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-muted-foreground">
                当前未勾选「只算双边可成交」。晚端 Under 顶到 0.999
                通常是<span className="text-foreground">单边钉死盘</span>（卖档空、买不进），
                不是可成交的反转。勾上再看会更接近能真正下单的口径。
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">赛事</th>
                    <th className="px-3 py-2 text-right font-medium">早端分钟</th>
                    <th className="px-3 py-2 text-right font-medium">早端行数</th>
                    <th className="px-3 py-2 text-right font-medium">早端峰值买价</th>
                    <th className="px-3 py-2 text-right font-medium">晚端分钟</th>
                    <th className="px-3 py-2 text-right font-medium">晚端行数</th>
                    <th className="px-3 py-2 text-right font-medium">晚端峰值买价</th>
                    <th className="px-3 py-2 text-right font-medium">深度</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.reversal.matches.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                        当前口径下没有反转场次
                      </td>
                    </tr>
                  )}
                  {report.reversal.matches.map((m) => (
                    <tr key={m.eventId} className="hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="font-medium">{m.title ?? m.eventId}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{m.eventId}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {minuteRange(m.earlyMinMinute, m.earlyMaxMinute)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.earlyRows}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.earlyMaxBid == null ? '—' : m.earlyMaxBid.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {minuteRange(m.lateMinMinute, m.lateMaxMinute)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.lateRows}</td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right tabular-nums',
                          m.lateMaxBid != null && m.lateMaxBid >= 0.99 && 'text-warning',
                        )}
                      >
                        {m.lateMaxBid == null ? '—' : m.lateMaxBid.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {m.liquidity == null ? '—' : formatNumber(Math.round(m.liquidity))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {report && (
          <section className="overflow-hidden rounded-md border bg-card">
            <div className="border-b px-3 py-2 text-sm font-medium">
              逐场明细
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                按采样行数排序，共 {report.matches.length} 场
              </span>
            </div>
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full min-w-[820px] text-left text-xs">
                <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">赛事</th>
                    <th className="px-3 py-2 text-right font-medium">行数</th>
                    <th className="px-3 py-2 text-right font-medium">可成交</th>
                    <th className="px-3 py-2 text-right font-medium">占比</th>
                    <th className="px-3 py-2 font-medium">覆盖分钟</th>
                    <th className="px-3 py-2 text-right font-medium">深度</th>
                    <th className="px-3 py-2 text-right font-medium">成交量</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.matches.map((m) => {
                    const pct = m.rows > 0 ? m.valid / m.rows : 0
                    return (
                      <tr key={m.eventId} className="hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <div className="font-medium">{m.title ?? m.eventId}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {m.eventId}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.rows)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.valid)}</td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right tabular-nums',
                            pct >= 0.5 ? 'text-success' : pct < 0.1 ? 'text-error' : '',
                          )}
                        >
                          {formatPercent(pct)}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {minuteRange(m.minMinute, m.maxMinute)}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right tabular-nums',
                            m.liquidity != null &&
                              m.liquidity < report.gate.threshold &&
                              'text-warning',
                          )}
                        >
                          {m.liquidity == null ? '—' : formatNumber(Math.round(m.liquidity))}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {m.volume == null ? '—' : formatNumber(Math.round(m.volume))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {loading && !report && (
          <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
        )}
      </div>
    </Layout>
  )
}
