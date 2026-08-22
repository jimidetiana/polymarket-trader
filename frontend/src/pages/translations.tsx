import { useEffect, useMemo, useState } from 'react'
import {
  RefreshCw,
  Database,
  FileText,
  CheckCircle2,
  Sparkles,
  Download,
  Copy,
  Upload,
  CheckCircle,
  Save,
  Code,
  ChevronDown,
} from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatTime, escapeHtml } from '@/lib/utils'
import {
  fetchTranslations,
  fetchUntranslated,
  saveEventTranslation,
  saveMarketTranslation,
  importTranslations,
} from '@/lib/api'
import type { SoccerEvent, SoccerMarket } from '@/types'

const FORMAT_TEMPLATE = [
  {
    id: 'event-id-1',
    title_zh: '中文赛事标题',
    home_team_zh: '主队中文',
    away_team_zh: '客队中文',
    league: '联赛中文',
  },
]

export default function TranslationsPage() {
  const [events, setEvents] = useState<SoccerEvent[]>([])
  const [untranslatedEvents, setUntranslatedEvents] = useState<SoccerEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [exportScope, setExportScope] = useState<'all' | 'untranslated'>('all')
  const [exportStatus, setExportStatus] = useState('')
  const [importJson, setImportJson] = useState('')
  const [importStatus, setImportStatus] = useState('')

  const translatedCount = Math.max(0, events.length - untranslatedEvents.length)

  const exportPayload = useMemo(
    () => (exportScope === 'all' ? events : untranslatedEvents).map(buildExportItem),
    [events, untranslatedEvents, exportScope],
  )

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [all, untranslated] = await Promise.all([fetchTranslations(), fetchUntranslated(200)])
      setEvents(all)
      setUntranslatedEvents(untranslated)
      setExportStatus(`当前可导出 ${exportPayload.length} 条`)
    } catch (err) {
      setImportStatus(`加载失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  function downloadJson(filename: string, text: string) {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  function handleExport() {
    const json = JSON.stringify(exportPayload, null, 2)
    if (json === '[]') {
      setExportStatus('当前范围没有可导出的数据')
      return
    }
    const scopeLabel = exportScope === 'untranslated' ? 'untranslated' : 'all'
    const filename = `soccer-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.json`
    downloadJson(filename, json)
    setExportStatus(`已导出 ${filename}`)
  }

  async function handleCopyExport() {
    const json = JSON.stringify(exportPayload, null, 2)
    if (json === '[]') {
      setExportStatus('当前范围没有可导出的数据')
      return
    }
    const ok = await copyText(json)
    setExportStatus(ok ? '已复制到剪贴板' : '复制失败')
  }

  async function handleCopyTemplate() {
    const ok = await copyText(JSON.stringify(FORMAT_TEMPLATE, null, 2))
    alert(ok ? '模板已复制' : '复制失败')
  }

  function validateImportPayload(raw: string):
    | { valid: true; parsed: unknown[] }
    | { valid: false; error: string } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return { valid: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
    }
    if (!Array.isArray(parsed)) return { valid: false, error: '顶层必须是数组' }
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i] as { id?: unknown; markets?: unknown[] }
      if (!item || typeof item.id !== 'string' || !item.id) {
        return { valid: false, error: `第 ${i + 1} 条缺少有效 id` }
      }
      if (item.markets) {
        if (!Array.isArray(item.markets)) {
          return { valid: false, error: `第 ${i + 1} 条的 markets 必须是数组` }
        }
        for (let j = 0; j < item.markets.length; j++) {
          const m = item.markets[j] as { id?: unknown }
          if (!m || typeof m.id !== 'string' || !m.id) {
            return { valid: false, error: `第 ${i + 1} 条第 ${j + 1} 个盘口缺少有效 id` }
          }
        }
      }
    }
    return { valid: true, parsed }
  }

  function handleValidate() {
    const raw = importJson.trim()
    if (!raw) {
      setImportStatus('请先粘贴 JSON')
      return
    }
    const result = validateImportPayload(raw)
    if (result.valid) {
      setImportStatus(`格式正确，共 ${result.parsed.length} 条比赛`)
    } else {
      setImportStatus(result.error)
    }
  }

  async function handleImport() {
    const raw = importJson.trim()
    if (!raw) {
      setImportStatus('请先粘贴 JSON')
      return
    }
    const result = validateImportPayload(raw)
    if (!result.valid) {
      setImportStatus(result.error)
      return
    }
    setImportStatus('导入中...')
    try {
      const message = await importTranslations(result.parsed)
      setImportStatus(message)
      setImportJson('')
      await loadData()
    } catch (err) {
      setImportStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Layout
      title="比赛信息翻译"
      subtitle="导出、AI 翻译、批量导入足球赛事中文信息"
      actions={
        <button
          type="button"
          data-dom-id="btn-load"
          disabled={loading}
          onClick={loadData}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 active:opacity-80 disabled:opacity-60"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          重新加载
        </button>
      }
    >
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            icon={Database}
            label="数据库中的比赛"
            value={`${events.length} 条`}
            color="primary"
          />
          <StatCard
            icon={FileText}
            label="待翻译比赛"
            value={`${untranslatedEvents.length} 条`}
            color="warning"
          />
          <StatCard
            icon={CheckCircle2}
            label="已翻译比赛"
            value={`${translatedCount} 条`}
            color="success"
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">AI 批量翻译工作流</h2>
          </div>
          <div className="relative space-y-4">
            <Step number={1} title="导出待翻译数据" last={false}>
              <p className="mb-2 text-xs text-muted-foreground">
                只导出比赛基础信息（不含盘口），减小 AI 输入量。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={exportScope}
                  onChange={(e) => {
                    setExportScope(e.target.value as 'all' | 'untranslated')
                    setExportStatus(
                      `当前可导出 ${(e.target.value === 'all' ? events : untranslatedEvents).length} 条`,
                    )
                  }}
                  className="rounded-md border border-border bg-input px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
                >
                  <option value="all">导出全部比赛</option>
                  <option value="untranslated">仅导出未翻译</option>
                </select>
                <button
                  type="button"
                  onClick={handleExport}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 active:opacity-80"
                >
                  <Download className="h-3.5 w-3.5" />
                  导出 JSON
                </button>
                <button
                  type="button"
                  onClick={handleCopyExport}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制到剪贴板
                </button>
                <span className="text-xs text-muted-foreground">{exportStatus}</span>
              </div>
            </Step>

            <Step number={2} title="获取格式模板" last={false}>
              <p className="mb-2 text-xs text-muted-foreground">
                将导出的 JSON 与下方格式模板一起发给 AI，要求 AI 返回固定格式的翻译结果。
              </p>
              <details className="group rounded-md border border-border bg-background">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs font-medium text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Code className="h-3.5 w-3.5" />
                    查看格式模板
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-border p-3">
                  <pre className="max-h-64 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed text-foreground/90">
                    {JSON.stringify(FORMAT_TEMPLATE, null, 2)}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyTemplate}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
                  >
                    <Copy className="h-3 w-3" />
                    复制模板
                  </button>
                </div>
              </details>
            </Step>

            <Step number={3} title="粘贴翻译结果并导入" last={true}>
              <p className="mb-2 text-xs text-muted-foreground">
                将 AI 返回的固定格式 JSON 粘贴到下方，点击“批量导入”写入数据库。
              </p>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                rows={8}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                placeholder={`[{"id":"...","title_zh":"...","home_team_zh":"...","away_team_zh":"...","league":"..."}]`}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleImport}
                  className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 active:opacity-80"
                >
                  <Upload className="h-3.5 w-3.5" />
                  批量导入
                </button>
                <button
                  type="button"
                  onClick={handleValidate}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  校验格式
                </button>
                <span
                  className={cn(
                    'text-xs',
                    importStatus.startsWith('导入成功') || importStatus.startsWith('格式正确')
                      ? 'text-success'
                      : importStatus.startsWith('失败') ||
                          importStatus.startsWith('格式错误') ||
                          importStatus.startsWith('导入失败')
                        ? 'text-error'
                        : 'text-muted-foreground',
                  )}
                >
                  {importStatus}
                </span>
              </div>
            </Step>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h3 className="text-sm font-semibold text-foreground">手动编辑</h3>
            <span className="text-xs text-muted-foreground">可直接修改单条比赛/盘口并保存</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">英文标题</th>
                <th className="px-3 py-2 min-w-[160px]">中文标题</th>
                <th className="px-3 py-2">主队中文</th>
                <th className="px-3 py-2">客队中文</th>
                <th className="px-3 py-2">联赛</th>
                <th className="px-3 py-2">开赛时间</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!events.length ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                    暂无数据，请先在赛事页点击“刷新比赛”拉取数据
                  </td>
                </tr>
              ) : (
                events.map((evt) => <EventRow key={evt.id} event={evt} onSaved={loadData} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}

function EventRow({ event, onSaved }: { event: SoccerEvent; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [markets, setMarkets] = useState<SoccerMarket[]>([])
  const [marketsLoading, setMarketsLoading] = useState(false)

  async function handleSave(row: HTMLTableRowElement) {
    const fields: Record<string, string | null> = {}
    row.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((input) => {
      fields[input.dataset.field!] = input.value.trim() || null
    })
    try {
      await saveEventTranslation({
        id: event.id,
        title_zh: fields.title_zh,
        home_team_zh: fields.home_team_zh,
        away_team_zh: fields.away_team_zh,
        league: fields.league,
      })
      alert('保存成功')
      onSaved()
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function toggleMarkets() {
    const next = !open
    setOpen(next)
    if (next && !markets.length && !marketsLoading) {
      setMarketsLoading(true)
      try {
        const res = await fetch(`/api/soccer/events/${encodeURIComponent(event.id)}/markets`)
        const data = (await res.json()) as { success: boolean; markets?: SoccerMarket[]; error?: string }
        if (data.success) setMarkets(data.markets || [])
        else throw new Error(data.error || '加载失败')
      } catch (err) {
        alert(`加载失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setMarketsLoading(false)
      }
    }
  }

  const status = statusInfo(event.match_status || 'not_started')

  return (
    <>
      <tr className="border-b border-border hover:bg-white/[0.03]">
        <td className="px-3 py-2 align-top">
          <span
            className={cn(
              'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium',
              status.className,
            )}
          >
            {status.label}
          </span>
        </td>
        <td className="px-3 py-2 align-top text-muted-foreground">
          <span dangerouslySetInnerHTML={{ __html: escapeHtml(event.title_en) }} />
        </td>
        <td className="px-3 py-2 align-top">
          <EventInput defaultValue={event.title_zh || ''} field="title_zh" />
        </td>
        <td className="px-3 py-2 align-top">
          <EventInput defaultValue={event.home_team_zh || ''} field="home_team_zh" />
        </td>
        <td className="px-3 py-2 align-top">
          <EventInput defaultValue={event.away_team_zh || ''} field="away_team_zh" />
        </td>
        <td className="px-3 py-2 align-top">
          <EventInput defaultValue={event.league || ''} field="league" />
        </td>
        <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
          {formatTime(event.end_time)}
        </td>
        <td className="px-3 py-2 align-top">
          <div className="flex flex-col gap-1.5">
            <SaveButton onClick={(e) => handleSave((e.currentTarget.closest('tr') as HTMLTableRowElement))} />
            <button
              type="button"
              onClick={toggleMarkets}
              className="inline-flex items-center justify-center gap-1 rounded border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
            >
              {open ? '收起盘口' : '编辑盘口'}
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="bg-background/50">
          <td colSpan={8} className="px-3 py-3">
            {marketsLoading ? (
              <p className="text-xs text-muted-foreground">加载中...</p>
            ) : !markets.length ? (
              <p className="text-xs text-muted-foreground">暂无盘口</p>
            ) : (
              <div className="space-y-2">
                {markets.map((market) => (
                  <MarketEditor key={market.id} market={market} />
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function MarketEditor({ market }: { market: SoccerMarket }) {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : []
  const [questionZh, setQuestionZh] = useState(market.question_zh || '')
  const [outcomesZh, setOutcomesZh] = useState(outcomes.join(','))

  async function handleSave() {
    try {
      await saveMarketTranslation(market.id, {
        question_zh: questionZh.trim() || null,
        outcomes_zh: outcomesZh
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      })
      alert('保存成功')
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="rounded border border-border bg-card p-2">
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <div>
          <p className="text-[10px] text-muted-foreground">英文问题</p>
          <p className="text-xs text-foreground">
            <span dangerouslySetInnerHTML={{ __html: escapeHtml(market.question_en) }} />
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">中文问题</p>
          <input
            type="text"
            value={questionZh}
            onChange={(e) => setQuestionZh(e.target.value)}
            className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
          />
        </div>
      </div>
      <div className="mb-2">
        <p className="text-[10px] text-muted-foreground">选项（用英文逗号分隔）</p>
        <input
          type="text"
          value={outcomesZh}
          onChange={(e) => setOutcomesZh(e.target.value)}
          className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
        />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:opacity-90"
        >
          <Save className="h-3 w-3" />
          保存盘口
        </button>
      </div>
    </div>
  )
}

function EventInput({ defaultValue, field }: { defaultValue: string; field: string }) {
  return (
    <input
      type="text"
      data-field={field}
      defaultValue={defaultValue}
      className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
    />
  )
}

function SaveButton({ onClick }: { onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:opacity-90"
    >
      <Save className="h-3 w-3" />
      保存
    </button>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType
  label: string
  value: string
  color: 'primary' | 'warning' | 'success'
}) {
  const colorClass =
    color === 'primary'
      ? 'bg-primary/10 text-primary'
      : color === 'warning'
        ? 'bg-warning/10 text-warning'
        : 'bg-success/10 text-success'
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-full',
            colorClass,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-sm font-semibold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  )
}

function Step({
  number,
  title,
  children,
  last,
}: {
  number: number
  title: string
  children: React.ReactNode
  last: boolean
}) {
  return (
    <div className="relative pl-8">
      {!last && (
        <div className="absolute bottom-[-16px] left-[15px] top-[32px] w-0.5 bg-border" />
      )}
      <div className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {number}
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children}
      </div>
    </div>
  )
}

function statusInfo(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    not_started: {
      label: '未开始',
      className: 'bg-warning/15 text-warning border-warning/30',
    },
    live: {
      label: '进行中',
      className: 'bg-success/15 text-success border-success/30',
    },
    ended: {
      label: '已结束',
      className: 'bg-muted text-muted-foreground border-border',
    },
  }
  return map[status] || map.not_started
}

function buildExportItem(evt: SoccerEvent) {
  return {
    id: evt.id,
    title_en: evt.title_en || '',
    title_zh: evt.title_zh || '',
    home_team_en: evt.home_team_en || '',
    home_team_zh: evt.home_team_zh || '',
    away_team_en: evt.away_team_en || '',
    away_team_zh: evt.away_team_zh || '',
    league: evt.league || '',
    league_zh: evt.league || '',
    end_time: evt.end_time,
  }
}
