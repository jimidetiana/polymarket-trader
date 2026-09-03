import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, ChevronDown, BarChart3 } from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatUsdc, formatPercent, formatNumber } from '@/lib/utils'
import {
  fetchRealOrderReport,
  fetchRealOrderReportLeagues,
  refreshRealOrderReport,
  type RealOrderReportFilters,
  type RealOrderReport,
  type ReportGroup,
} from '@/lib/api'

function formatBeijingTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function positive(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatUsdc(value)}`
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'positive' | 'negative' | 'neutral' }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'positive' && 'text-success', tone === 'negative' && 'text-error')}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

function GroupTable({ title, groups }: { title: string; groups: ReportGroup[] }) {
  return (
    <section className="overflow-hidden rounded-md border bg-card">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">分组</th>
              <th className="px-3 py-2 text-right font-medium">独立盘口</th>
              <th className="px-3 py-2 text-right font-medium">胜率</th>
              <th className="px-3 py-2 text-right font-medium">投入</th>
              <th className="px-3 py-2 text-right font-medium">净利</th>
              <th className="px-3 py-2 text-right font-medium">ROI</th>
              <th className="px-3 py-2 text-right font-medium">保守凯莉</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {groups.length === 0 && <tr><td colSpan={7} className="px-3 py-5 text-center text-muted-foreground">暂无已结算实单</td></tr>}
            {groups.map(group => (
              <tr key={group.key} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">{group.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{group.n}</td>
                <td className="px-3 py-2 text-right tabular-nums">{group.winRate == null ? '—' : formatPercent(group.winRate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatUsdc(group.invested)}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', group.net > 0 ? 'text-success' : group.net < 0 ? 'text-error' : '')}>{positive(group.net)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{group.roi == null ? '—' : formatPercent(group.roi)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {group.sampleAdequate && group.kelly != null ? formatPercent(group.kelly) : <span className="text-warning">样本不足</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function PriceBotReportPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<RealOrderReport | null>(null)
  const [leagueOptions, setLeagueOptions] = useState<string[]>([])
  const [filters, setFilters] = useState<RealOrderReportFilters>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [syncing, setSyncing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  const loadLeagues = useCallback(async () => {
    try {
      const options = await fetchRealOrderReportLeagues()
      setLeagueOptions(options.map(row => row.league))
    } catch (err) {
      console.error('加载联赛筛选失败:', err)
    }
  }, [])

  const loadReport = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      setReport(await fetchRealOrderReport(filters))
      setLastUpdated(new Date().toISOString())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [filters])

  const syncAndLoad = useCallback(async () => {
    setSyncing(true)
    setError(null)
    try {
      const result = await refreshRealOrderReport()
      setReport(await fetchRealOrderReport(filters))
      setLastUpdated(new Date().toISOString())
      const { outcomes, settlements, orders } = result.sync
      setSyncNote(`回填 ${outcomes.resolved} 条规则结果 · 交易所结算 ${settlements.settledCount} · 订单更新 ${orders.updated + orders.imported}`)
      void loadLeagues()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }, [filters, loadLeagues])

  useEffect(() => {
    void loadLeagues()
  }, [loadLeagues])

  useEffect(() => {
    void loadReport()
    const timer = setInterval(() => { void loadReport(true) }, 30000)
    return () => clearInterval(timer)
  }, [loadReport])

  const renderBody = () => {
    if (loading && !report) return <div className="py-20 text-center text-sm text-muted-foreground">正在加载实单数据…</div>
    if (error) return <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>
    if (!report) return null

    const { funnel, overall, kelly, byLeague, byMarket, byPriceBand, timeline, rows } = report
    const ruleStats = overall.byRule
    const orderStats = overall.byOrder
    const filledTotal = funnel.filled + funnel.settled
    const submitted = funnel.submitted
    const submittedRate = submitted > 0 ? filledTotal / submitted : null
    const settledRate = filledTotal > 0 ? funnel.settled / filledTotal : null
    const maxCumulative = Math.max(1, ...timeline.map(point => Math.abs(point.cumulativeNet)))
    const rowLimit = expanded.orders ? rows.length : 40

    return (
      <>
        <section className="rounded-md border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium"><BarChart3 className="h-4 w-4 text-primary" /> 执行漏斗</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {[
              ['从未提交', funnel.skipped, '余额、额度或风控拦截'],
              ['提交失败', funnel.failed, '交易接口未接受'],
              ['已提交', submitted, 'API 接单，不等于成交'],
              ['已取消', funnel.cancelled, '交易所未成交'],
              ['部分成交', funnel.partial, '成交份数未持久化'],
              ['已成交未回填', funnel.filled, '成交了，规则还没有结算结果'],
              ['已结算', funnel.settled, '规则已回填结果，计入收益'],
            ].map(([label, count, hint]) => (
              <div key={String(label)} className="rounded border bg-muted/20 p-2">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(Number(count))}</div>
                <div className="mt-1 text-[10px] leading-tight text-muted-foreground">{hint}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            已提交→成交：{submittedRate == null ? '—' : formatPercent(submittedRate)}；成交→已结算：{settledRate == null ? '—' : formatPercent(settledRate)}。收益不包含从未提交、失败、取消或部分成交订单。
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="独立已结算盘口" value={`${ruleStats.n} / ${ruleStats.wins} 胜`} hint="默认胜率与凯莉口径" />
          <StatCard label="已实现投入" value={formatUsdc(ruleStats.invested)} hint={`${orderStats.n} 笔实际成交订单`} />
          <StatCard label="已实现净利" value={positive(ruleStats.net)} hint={ruleStats.roi == null ? 'ROI —' : `ROI ${formatPercent(ruleStats.roi)}`} tone={ruleStats.net > 0 ? 'positive' : ruleStats.net < 0 ? 'negative' : 'neutral'} />
          <StatCard label="独立盘口胜率" value={ruleStats.winRate == null ? '—' : formatPercent(ruleStats.winRate)} hint={ruleStats.winRateCI ? `Wilson 95%：${formatPercent(ruleStats.winRateCI[0])}–${formatPercent(ruleStats.winRateCI[1])}` : '暂无结算'} />
          <StatCard label="成交均价 / 赔率" value={ruleStats.averagePrice == null ? '—' : `${ruleStats.averagePrice.toFixed(3)} / ${ruleStats.decimalOdds?.toFixed(2) ?? '—'}`} hint="赔率为 1 ÷ 成交均价" />
        </section>

        <section className={cn('rounded-md border p-3', kelly.sampleAdequate ? 'border-primary/40 bg-primary/5' : 'border-warning/40 bg-warning/10')}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-sm font-medium">证据强度与凯莉</div>
              <div className="mt-1 text-xs text-muted-foreground">默认按独立盘口聚合；同一盘口的多笔成交只算一次胜负，避免虚增样本。</div>
            </div>
            <div className={cn('rounded px-2 py-1 text-xs font-medium', kelly.sampleAdequate ? 'bg-primary/15 text-primary' : 'bg-warning/20 text-warning')}>
              {kelly.sampleAdequate ? '样本支持保守加仓评估' : '样本不足，暂不足以支撑加仓'}
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <StatCard label="点估计凯莉 f*" value={kelly.point == null ? '—' : formatPercent(kelly.point)} hint="使用观测胜率" />
            <StatCard label="保守凯莉" value={kelly.conservative == null ? '0.00%' : formatPercent(kelly.conservative)} hint="使用 Wilson 95% 下界" />
            <StatCard label="四分之一凯莉" value={kelly.fractional == null ? '—' : formatPercent(kelly.fractional)} hint="仅作风险预算参考" />
            <StatCard label="仍需独立盘口" value={kelly.requiredRules == null ? '—' : `${Math.max(0, kelly.requiredRules - ruleStats.n)}`} hint={kelly.requiredRules == null ? '当前边际不为正或无法估算' : `约 ${kelly.requiredRules} 个总样本`} />
          </div>
        </section>

        {overall.unsettled.n > 0 && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm">另有 {overall.unsettled.n} 笔已成交、规则尚未回填结果，投入 {formatUsdc(overall.unsettled.invested)}，未混入收益或胜率。点「同步结算」会向 Gamma 回填。</div>}
        {syncNote && <div className="text-xs text-muted-foreground">{syncNote}</div>}

        <section className="grid gap-3 xl:grid-cols-2">
          <GroupTable title="按联赛（独立盘口）" groups={byLeague} />
          <GroupTable title="按盘口线（独立盘口）" groups={byMarket} />
        </section>
        <GroupTable title="按成交价格档（独立盘口）" groups={byPriceBand} />

        <section className="rounded-md border bg-card p-3">
          <div className="mb-3 text-sm font-medium">已实现净利时间线</div>
          {timeline.length === 0 ? <div className="py-4 text-center text-sm text-muted-foreground">暂无已结算实单</div> : (
            <div className="space-y-2">
              {timeline.map(point => {
                const width = Math.max(2, Math.abs(point.cumulativeNet) / maxCumulative * 100)
                return <div key={point.date} className="grid grid-cols-[88px_1fr_110px] items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{point.date}</span>
                  <div className="h-2 overflow-hidden rounded bg-muted"><div className={cn('h-full rounded', point.cumulativeNet >= 0 ? 'bg-success' : 'bg-destructive')} style={{ width: `${width}%` }} /></div>
                  <span className={cn('text-right tabular-nums', point.cumulativeNet > 0 ? 'text-success' : point.cumulativeNet < 0 ? 'text-destructive' : '')}>{positive(point.cumulativeNet)}</span>
                </div>
              })}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-md border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div><div className="text-sm font-medium">实单明细</div><div className="text-xs text-muted-foreground">只列交易所订单。交易所可能仍显示 filled，但规则已回填结果的会算进已结算，不是持仓。</div></div>
            <span className="text-xs text-muted-foreground">{rows.length} 条</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground"><tr>
                <th className="px-3 py-2 font-medium">时间（北京）</th><th className="px-3 py-2 font-medium">赛事 / 联赛</th><th className="px-3 py-2 font-medium">盘口</th><th className="px-3 py-2 font-medium">结果</th><th className="px-3 py-2 text-right font-medium">成交价</th><th className="px-3 py-2 text-right font-medium">份数</th><th className="px-3 py-2 text-right font-medium">盈亏</th><th className="px-3 py-2 font-medium">交易所状态</th>
              </tr></thead>
              <tbody className="divide-y">
                {rows.slice(0, rowLimit).map(row => <tr key={row.id} className="hover:bg-muted/30">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatBeijingTime(row.createdAt)}</td>
                  <td className="px-3 py-2"><div className="font-medium">{row.homeTeam || '—'} vs {row.awayTeam || '—'}</div><div className="text-muted-foreground">{row.league || '未标联赛'}</div></td>
                  <td className="px-3 py-2"><div>{row.marketName || row.marketType || '—'}</div><div className="text-muted-foreground">{row.marketType === 'total' ? `大小球 ${row.line ?? '—'}` : row.marketType || '—'} · {row.outcome}</div></td>
                  <td className="px-3 py-2">{row.settledOutcome === 'yes' ? <span className="text-success">赢</span> : row.settledOutcome === 'no' ? <span className="text-destructive">输</span> : <span className="text-muted-foreground">未结算</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.orderPrice > 0 ? row.orderPrice.toFixed(3) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.orderSize > 0 ? formatNumber(row.orderSize) : '—'}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', (row.pnl ?? 0) > 0 ? 'text-success' : (row.pnl ?? 0) < 0 ? 'text-destructive' : '')}>{row.pnl == null ? '—' : positive(row.pnl)}</td>
                  <td className="px-3 py-2"><span className="rounded bg-muted px-1.5 py-0.5">{row.executionStatus}{row.settledOutcome && row.executionStatus === 'filled' ? ' · 规则已结算' : ''}</span></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {rows.length > 40 && <button onClick={() => setExpanded(prev => ({ ...prev, orders: !prev.orders }))} className="flex w-full items-center justify-center gap-1 border-t px-3 py-2 text-xs text-primary hover:bg-muted/30">
            {expanded.orders ? '收起明细' : `显示其余 ${rows.length - 40} 条`} <ChevronDown className={cn('h-3 w-3 transition-transform', expanded.orders && 'rotate-180')} />
          </button>}
        </section>
      </>
    )
  }

  return (
    <Layout title="实单分析" subtitle="仅统计交易所真实成交，按独立盘口评估胜率与凯莉">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3"><Link to="/price-bot" className="rounded border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="返回价格监控"><ArrowLeft className="h-4 w-4" /></Link><div><h2 className="text-base font-semibold">价格监控 · 实单统计</h2><p className="text-xs text-muted-foreground">每 30 秒读库刷新；点同步会回填规则结算并拉交易所状态。不将 skipped、submitted 或假设成交计入收益。</p></div></div>
          <div className="flex items-center gap-2">
            {lastUpdated && <span className="text-xs text-muted-foreground">更新于 {formatBeijingTime(lastUpdated)}</span>}
            <button onClick={() => void loadReport()} disabled={loading || syncing} className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"><RefreshCw className={cn('h-3.5 w-3.5', loading && !syncing && 'animate-spin')} />重读</button>
            <button onClick={() => void syncAndLoad()} disabled={loading || syncing} className="inline-flex items-center gap-1.5 rounded border border-primary bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/15 disabled:opacity-50"><RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />同步结算</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 rounded border bg-card p-2">
          <select value={filters.league ?? ''} onChange={e => setFilters(prev => ({ ...prev, league: e.target.value || undefined }))} className="rounded border bg-background px-2 py-1.5 text-xs"><option value="">全部联赛</option>{leagueOptions.map(league => <option key={league} value={league}>{league}</option>)}</select>
          <select value={filters.marketType ?? ''} onChange={e => setFilters(prev => ({ ...prev, marketType: e.target.value || undefined }))} className="rounded border bg-background px-2 py-1.5 text-xs"><option value="">全部盘口类型</option><option value="total">大小球</option><option value="first_scorer">谁先进球</option></select>
          <input type="number" step="0.5" placeholder="盘口线" value={filters.line ?? ''} onChange={e => setFilters(prev => ({ ...prev, line: e.target.value === '' ? undefined : Number(e.target.value) }))} className="w-24 rounded border bg-background px-2 py-1.5 text-xs" />
          <input type="date" value={filters.from ?? ''} onChange={e => setFilters(prev => ({ ...prev, from: e.target.value || undefined }))} className="rounded border bg-background px-2 py-1.5 text-xs" />
          <span className="self-center text-xs text-muted-foreground">至</span>
          <input type="date" value={filters.to ?? ''} onChange={e => setFilters(prev => ({ ...prev, to: e.target.value || undefined }))} className="rounded border bg-background px-2 py-1.5 text-xs" />
          {Object.keys(filters).length > 0 && <button onClick={() => setFilters({})} className="px-2 text-xs text-muted-foreground hover:text-foreground">清除筛选</button>}
        </div>
        {renderBody()}
      </div>
    </Layout>
  )
}
