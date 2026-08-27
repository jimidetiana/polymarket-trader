import { useState, useEffect, useCallback } from 'react'
import { Play, Pause, Zap, Settings, Activity, RefreshCw, Plus, Trash2, TrendingUp, TrendingDown, Bell, Clock, Radio, FileText } from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn } from '@/lib/utils'
import { fetchEvents, fetchEventMarkets } from '@/lib/api'
import type { SoccerEvent, SoccerMarket } from '@/types'
import {
  fetchPriceBotStatus,
  startPriceBot,
  stopPriceBot,
  updatePriceBotConfig,
  triggerPriceBotCycle,
  fetchPriceBotRules,
  createPriceBotRule,
  deletePriceBotRule,
  updatePriceBotRule,
  fetchPriceBotMonitors,
  startPriceBotMonitor,
  stopPriceBotMonitor,
  triggerPriceBotMonitor,
  fetchPriceBotTriggers,
  fetchPriceBotLogs,
  type PriceBotStatus,
  type PriceMonitorRule,
  type PriceMonitorState,
  type PriceTriggerRecord,
  type PriceBotLog,
  type MatchContext,
} from '@/lib/api'

type Tab = 'rules' | 'monitors' | 'triggers' | 'logs'

const RULE_TYPE_LABELS: Record<string, string> = {
  percent_change: '百分比变化',
  price_break: '价格突破',
  price_range: '价格区间',
}

const DIRECTION_LABELS: Record<string, string> = {
  up: '上涨',
  down: '下跌',
  both: '双向',
}

const SIGNAL_LABELS: Record<string, { label: string; className: string; icon: typeof TrendingUp }> = {
  buy_signal: { label: '买入信号', className: 'bg-green-500/10 text-green-600 border-green-500/30', icon: TrendingUp },
  sell_signal: { label: '卖出信号', className: 'bg-red-500/10 text-red-600 border-red-500/30', icon: TrendingDown },
  alert: { label: '告警', className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30', icon: Bell },
}

const ACTION_LABELS: Record<string, { label: string; className: string; icon: typeof Play }> = {
  start: { label: '启动', className: 'bg-green-500/10 text-green-600 border-green-500/30', icon: Play },
  stop: { label: '停止', className: 'bg-red-500/10 text-red-600 border-red-500/30', icon: Pause },
  trigger: { label: '触发', className: 'bg-blue-500/10 text-blue-600 border-blue-500/30', icon: Zap },
  price_update: { label: '价格', className: 'bg-gray-500/10 text-gray-600 border-gray-500/30', icon: TrendingUp },
  disconnect: { label: '断联', className: 'bg-orange-500/10 text-orange-600 border-orange-500/30', icon: Pause },
  reconnect: { label: '重连', className: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/30', icon: Play },
}

/**
 * 价格/百分比格式化。
 *
 * 后端字段理论上都有值，但一旦某条记录缺字段，
 * 直接调 .toFixed() 会抛错并让整个页面白屏，所以统一做空值防护。
 */
function fmtPrice(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—'
}

function fmtPercent(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
}

/**
 * 比赛与盘口标签。
 *
 * 后端 LEFT JOIN 带出 matchName / marketName / league / line，
 * 让日志和触发记录能直接看出是哪场比赛的哪个盘口，而不只是一串 token_id。
 */
function MatchLabel({
  ctx,
  outcome,
}: {
  ctx: MatchContext
  outcome?: string
}) {
  if (!ctx.matchName && !ctx.marketName) {
    return outcome ? <span className="text-muted-foreground">{outcome}</span> : null
  }

  // 盘口名通常已含「主队 vs. 客队: O/U 3.5」，此时不再重复比赛名
  const marketSuffix = ctx.marketName?.includes(' vs')
    ? ctx.marketName.split(':').slice(1).join(':').trim()
    : ctx.marketName

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {ctx.matchName && (
        <span className="truncate font-medium text-foreground/90">{ctx.matchName}</span>
      )}
      {marketSuffix && (
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          {marketSuffix}
        </span>
      )}
      {outcome && <span className="shrink-0 text-muted-foreground">{outcome}</span>}
    </span>
  )
}

export default function PriceBotPage() {
  const [status, setStatus] = useState<PriceBotStatus | null>(null)
  const [tab, setTab] = useState<Tab>('rules')
  const [rules, setRules] = useState<PriceMonitorRule[]>([])
  const [monitors, setMonitors] = useState<PriceMonitorState[]>([])
  const [triggers, setTriggers] = useState<PriceTriggerRecord[]>([])
  const [logs, setLogs] = useState<PriceBotLog[]>([])
  const [loading, setLoading] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddRule, setShowAddRule] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchPriceBotStatus()
      setStatus(s)
    } catch {
      // ignore
    }
  }, [])

  const loadRules = useCallback(async () => {
    try {
      const { rules: r } = await fetchPriceBotRules({ limit: 100 })
      setRules(r)
    } catch {
      // ignore
    }
  }, [])

  const loadMonitors = useCallback(async () => {
    try {
      const m = await fetchPriceBotMonitors()
      setMonitors(m)
    } catch {
      // ignore
    }
  }, [])

  const loadTriggers = useCallback(async () => {
    setLoading(true)
    try {
      const { triggers: t } = await fetchPriceBotTriggers({ limit: 50 })
      setTriggers(t)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      const { logs: l } = await fetchPriceBotLogs({ limit: 100 })
      setLogs(l)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadRules()
    loadMonitors()
    loadTriggers()
    loadLogs()
    const interval = setInterval(() => {
      loadStatus()
      loadMonitors()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadStatus, loadRules, loadMonitors, loadTriggers, loadLogs])

  async function handleStart() {
    try {
      const s = await startPriceBot()
      setStatus(s)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleStop() {
    const s = await stopPriceBot()
    setStatus(s)
  }

  async function handleTrigger() {
    try {
      const s = await triggerPriceBotCycle()
      setStatus(s)
      await loadTriggers()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleConfigUpdate(config: Record<string, unknown>) {
    await updatePriceBotConfig(config)
    await loadStatus()
    setShowSettings(false)
  }

  async function handleDeleteRule(id: number) {
    if (!confirm('确认删除这条规则？')) return
    try {
      await deletePriceBotRule(id)
      await loadRules()
      await loadMonitors()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleToggleRule(rule: PriceMonitorRule) {
    if (!rule.id) return
    try {
      await updatePriceBotRule(rule.id, { enabled: !rule.enabled })
      await loadRules()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleMonitorAction(ruleId: number, action: 'start' | 'stop' | 'trigger') {
    try {
      if (action === 'start') await startPriceBotMonitor(ruleId)
      else if (action === 'stop') await stopPriceBotMonitor(ruleId)
      else await triggerPriceBotMonitor(ruleId)
      await loadMonitors()
      await loadLogs()
      if (action === 'trigger') await loadTriggers()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Layout title="价格监控机器人" subtitle="基于 WebSocket 实时价格变化的信号监控">
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-2.5 w-2.5 items-center justify-center rounded-full',
                status?.running ? 'bg-green-500 animate-pulse' : 'bg-gray-400',
              )}
            />
            <h1 className="text-sm font-semibold">价格监控机器人</h1>
            <span className="text-[10px] text-muted-foreground">
              {status?.running ? '运行中' : '已停止'} · {status?.monitorCount ?? 0} 条规则 · {status?.activeMonitorCount ?? 0} 个活跃监控
            </span>
            {status && (
              <span className={cn('flex items-center gap-0.5 text-[10px]', status.wsConnected ? 'text-green-600' : 'text-red-500')}>
                <Radio className="h-2.5 w-2.5" />
                {status.wsConnected ? 'WS已连接' : 'WS断开'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleTrigger}
              disabled={loading}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
              title="手动触发一次"
            >
              <Zap className="h-3 w-3" />
              触发
            </button>
            {status?.running ? (
              <button
                onClick={handleStop}
                className="flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-600 hover:bg-red-500/20"
              >
                <Pause className="h-3 w-3" />
                停止
              </button>
            ) : (
              <button
                onClick={handleStart}
                className="flex items-center gap-1 rounded-md bg-green-500/10 px-2 py-1 text-[11px] text-green-600 hover:bg-green-500/20"
              >
                <Play className="h-3 w-3" />
                启动
              </button>
            )}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted',
                showSettings && 'bg-muted',
              )}
            >
              <Settings className="h-3 w-3" />
              参数
            </button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && status && (
          <SettingsPanel config={status.config} onSave={handleConfigUpdate} />
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b px-4 py-2">
          {([
            { key: 'rules' as Tab, label: '监控规则', icon: Activity },
            { key: 'monitors' as Tab, label: '监控状态', icon: Radio },
            { key: 'triggers' as Tab, label: '触发记录', icon: Bell },
            { key: 'logs' as Tab, label: '日志', icon: FileText },
          ]).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key)
                if (t.key === 'rules') loadRules()
                else if (t.key === 'monitors') loadMonitors()
                else if (t.key === 'triggers') loadTriggers()
                else loadLogs()
              }}
              className={cn(
                'flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium',
                tab === t.key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <t.icon className="h-3 w-3" />
              {t.label}
            </button>
          ))}
          {tab === 'rules' && (
            <button
              type="button"
              onClick={() => setShowAddRule(!showAddRule)}
              className={cn(
                'ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted',
                showAddRule && 'bg-muted',
              )}
            >
              <Plus className="h-3 w-3" />
              创建价格监控机器人
            </button>
          )}
          {tab === 'triggers' && (
            <button
              type="button"
              onClick={loadTriggers}
              className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" />
              刷新
            </button>
          )}
          {tab === 'logs' && (
            <button
              type="button"
              onClick={loadLogs}
              className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" />
              刷新
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === 'rules' && (
            <RulesTab
              rules={rules}
              monitors={monitors}
              showAddRule={showAddRule}
              onAddRule={async (rule) => {
                try {
                  await createPriceBotRule(rule)
                  await loadRules()
                  setShowAddRule(false)
                } catch (err) {
                  alert(err instanceof Error ? err.message : String(err))
                }
              }}
              onDeleteRule={handleDeleteRule}
              onToggleRule={handleToggleRule}
              onMonitorAction={handleMonitorAction}
            />
          )}
          {tab === 'monitors' && (
            <MonitorsTab
              rules={rules}
              monitors={monitors}
              onAction={handleMonitorAction}
            />
          )}
          {tab === 'triggers' && (
            <TriggersTab triggers={triggers} loading={loading} />
          )}
          {tab === 'logs' && (
            <LogsTab logs={logs} rules={rules} />
          )}
        </div>
      </div>
    </Layout>
  )
}

// ==================== Settings Panel ====================

function SettingsPanel({
  config,
  onSave,
}: {
  config: PriceBotStatus['config']
  onSave: (config: Record<string, unknown>) => void
}) {
  const [pollInterval, setPollInterval] = useState(config.pollIntervalMs / 1000)

  return (
    <div className="border-b bg-muted/30 px-4 py-3">
      <div className="flex items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground">轮询间隔（秒，仅用于 fallback REST 轮询）</span>
          <input
            type="number"
            value={pollInterval}
            onChange={(e) => setPollInterval(Number(e.target.value))}
            min={1}
            step={1}
            className="w-32 rounded-md border bg-background px-2 py-1 text-xs"
          />
        </label>
        <button
          onClick={() => onSave({ pollIntervalMs: pollInterval * 1000 })}
          className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          保存
        </button>
      </div>
    </div>
  )
}

// ==================== Rules Tab ====================

function RulesTab({
  rules,
  monitors,
  showAddRule,
  onAddRule,
  onDeleteRule,
  onToggleRule,
  onMonitorAction,
}: {
  rules: PriceMonitorRule[]
  monitors: PriceMonitorState[]
  showAddRule: boolean
  onAddRule: (rule: Omit<PriceMonitorRule, 'id' | 'createdAt' | 'updatedAt'>) => void
  onDeleteRule: (id: number) => void
  onToggleRule: (rule: PriceMonitorRule) => void
  onMonitorAction: (ruleId: number, action: 'start' | 'stop' | 'trigger') => void
}) {
  if (showAddRule) {
    return <AddRuleForm onAdd={onAddRule} />
  }

  if (rules.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无监控规则，点击"创建价格监控机器人"创建
      </div>
    )
  }

  const monitorMap = new Map(monitors.map((m) => [m.ruleId, m]))

  return (
    <div className="divide-y">
      {rules.map((rule) => {
        const sig = SIGNAL_LABELS[rule.signalType] ?? SIGNAL_LABELS.alert
        const monitor = rule.id ? monitorMap.get(rule.id) : null
        const isRunning = monitor?.running ?? false
        return (
          <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    'flex h-2 w-2 items-center justify-center rounded-full',
                    isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400',
                  )}
                />
                <span className={cn('inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium', sig.className)}>
                  <sig.icon className="h-2.5 w-2.5" />
                  {sig.label}
                </span>
                <span className="text-xs font-medium">{RULE_TYPE_LABELS[rule.ruleType] ?? rule.ruleType}</span>
                <span className="text-[10px] text-muted-foreground">{DIRECTION_LABELS[rule.direction] ?? rule.direction}</span>
                {rule.enabled ? (
                  <span className="text-[10px] text-green-600">启用</span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">禁用</span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                outcome: {rule.outcome} · tokenId: {rule.tokenId.slice(0, 16)}...
                {rule.ruleType === 'percent_change' && rule.percentThreshold != null && ` · 阈值: ${(rule.percentThreshold * 100).toFixed(1)}%`}
                {rule.ruleType === 'price_break' && rule.targetPrice != null && ` · 目标价: ${rule.targetPrice}`}
                {rule.ruleType === 'price_range' && ` · 区间: ${rule.priceLow ?? '-'} ~ ${rule.priceHigh ?? '-'}`}
                {` · 冷却: ${rule.cooldownSeconds}s`}
                {monitor?.lastPrice != null && ` · 当前价: ${monitor.lastPrice.toFixed(4)}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isRunning ? (
                <button
                  type="button"
                  onClick={() => rule.id && onMonitorAction(rule.id, 'stop')}
                  className="flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-500/10"
                >
                  <Pause className="h-2.5 w-2.5" />
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => rule.id && onMonitorAction(rule.id, 'start')}
                  disabled={!rule.enabled}
                  className="flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] text-green-600 hover:bg-green-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={!rule.enabled ? '请先启用规则' : undefined}
                >
                  <Play className="h-2.5 w-2.5" />
                  启动
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggleRule(rule)}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted',
                  rule.enabled ? 'text-yellow-600' : 'text-green-600',
                )}
              >
                {rule.enabled ? '禁用' : '启用'}
              </button>
              <button
                type="button"
                onClick={() => rule.id && onDeleteRule(rule.id)}
                className="rounded border px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-500/10"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== Add Rule Form ====================

function AddRuleForm({
  onAdd,
}: {
  onAdd: (rule: Omit<PriceMonitorRule, 'id' | 'createdAt' | 'updatedAt'>) => void
}) {
  const [events, setEvents] = useState<SoccerEvent[]>([])
  const [markets, setMarkets] = useState<SoccerMarket[]>([])
  const [selectedEventId, setSelectedEventId] = useState('')
  const [selectedMarketIdx, setSelectedMarketIdx] = useState(-1)
  const [selectedOutcomeIdx, setSelectedOutcomeIdx] = useState(-1)
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [loadingMarkets, setLoadingMarkets] = useState(false)

  const [ruleType, setRuleType] = useState<PriceMonitorRule['ruleType']>('percent_change')
  const [direction, setDirection] = useState<PriceMonitorRule['direction']>('both')
  const [percentThreshold, setPercentThreshold] = useState(5)
  const [targetPrice, setTargetPrice] = useState(0.5)
  const [priceLow, setPriceLow] = useState(0.2)
  const [priceHigh, setPriceHigh] = useState(0.8)
  const [signalType, setSignalType] = useState<PriceMonitorRule['signalType']>('alert')
  const [cooldownSeconds, setCooldownSeconds] = useState(300)

  useEffect(() => {
    setLoadingEvents(true)
    fetchEvents()
      .then((all) => {
        // 只显示进行中和即将开始的比赛，排除已结束的
        setEvents(all.filter((e) => e.match_status === 'not_started' || e.match_status === 'live'))
      })
      .catch(() => {})
      .finally(() => setLoadingEvents(false))
  }, [])

  useEffect(() => {
    if (!selectedEventId) {
      setMarkets([])
      setSelectedMarketIdx(-1)
      return
    }
    setLoadingMarkets(true)
    setSelectedMarketIdx(-1)
    setSelectedOutcomeIdx(-1)
    fetchEventMarkets(selectedEventId)
      .then(setMarkets)
      .catch(() => setMarkets([]))
      .finally(() => setLoadingMarkets(false))
  }, [selectedEventId])

  const selectedMarket = selectedMarketIdx >= 0 ? markets[selectedMarketIdx] : null
  const outcomes = selectedMarket?.outcomes ?? []
  const tokenIds = selectedMarket?.clob_token_ids ?? []
  const selectedOutcome = selectedOutcomeIdx >= 0 ? outcomes[selectedOutcomeIdx] : null
  const selectedTokenId = selectedOutcomeIdx >= 0 ? tokenIds[selectedOutcomeIdx] : null

  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    if (!selectedEventId || !selectedMarket || !selectedTokenId || !selectedOutcome) {
      alert('请先选择比赛、盘口和结果')
      return
    }
    setSubmitting(true)
    try {
      const sourceIds = (selectedMarket as SoccerMarket & { source_market_ids?: string[] }).source_market_ids
      const marketId = sourceIds?.[selectedOutcomeIdx] ?? selectedMarket.id
      await onAdd({
        tokenId: selectedTokenId,
        marketId,
        eventId: selectedEventId,
        outcome: selectedOutcome,
        ruleType,
        direction,
        percentThreshold: ruleType === 'percent_change' ? percentThreshold / 100 : undefined,
        targetPrice: ruleType === 'price_break' ? targetPrice : undefined,
        priceLow: ruleType === 'price_range' ? priceLow : undefined,
        priceHigh: ruleType === 'price_range' ? priceHigh : undefined,
        signalType,
        cooldownSeconds,
        enabled: true,
      })
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'w-full rounded-md border bg-background px-2 py-1 text-xs'
  const labelCls = 'text-[10px] text-muted-foreground'

  return (
    <div className="p-4 space-y-4">
      {/* 市场选择器 */}
      <div className="rounded-md border p-3 space-y-3">
        <h3 className="text-xs font-semibold">选择监控市场</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>比赛 *</span>
            <select
              className={inputCls}
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              disabled={loadingEvents}
            >
              <option value="">{loadingEvents ? '加载中...' : '请选择比赛'}</option>
              {events.map((evt) => {
                const title = evt.title_zh || evt.title_en || evt.id
                const home = evt.home_team_zh || evt.home_team_en || ''
                const away = evt.away_team_zh || evt.away_team_en || ''
                return (
                  <option key={evt.id} value={evt.id}>
                    {home && away ? `${home} vs ${away}` : title}
                  </option>
                )
              })}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>盘口 *</span>
            <select
              className={inputCls}
              value={selectedMarketIdx}
              onChange={(e) => setSelectedMarketIdx(Number(e.target.value))}
              disabled={!selectedEventId || loadingMarkets}
            >
              <option value={-1}>{loadingMarkets ? '加载中...' : !selectedEventId ? '请先选择比赛' : '请选择盘口'}</option>
              {markets.map((m, i) => {
                const q = m.question_zh || m.question_en || m.id
                const line = m.line != null ? ` (让球${m.line})` : ''
                return (
                  <option key={i} value={i}>
                    {q}{line}
                  </option>
                )
              })}
            </select>
          </label>
        </div>
        {selectedMarket && outcomes.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={labelCls}>结果 *</span>
            <div className="flex gap-2">
              {outcomes.map((outcome, idx) => {
                const token = tokenIds[idx]
                const selected = selectedOutcomeIdx === idx
                return (
                  <button
                    key={idx}
                    onClick={() => setSelectedOutcomeIdx(idx)}
                    disabled={!token}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                      selected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-foreground hover:bg-muted',
                      !token && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    {outcome}
                  </button>
                )
              })}
            </div>
            {selectedTokenId && (
              <span className="text-[10px] text-muted-foreground">Token: {selectedTokenId.slice(0, 20)}...</span>
            )}
          </div>
        )}
      </div>

      {/* 规则配置 */}
      <div className="rounded-md border p-3 space-y-3">
        <h3 className="text-xs font-semibold">监控规则配置</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>规则类型</span>
            <select className={inputCls} value={ruleType} onChange={(e) => setRuleType(e.target.value as any)}>
              <option value="percent_change">百分比变化</option>
              <option value="price_break">价格突破</option>
              <option value="price_range">价格区间</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>方向</span>
            <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as any)}>
              <option value="up">上涨</option>
              <option value="down">下跌</option>
              <option value="both">双向</option>
            </select>
          </label>
          {ruleType === 'percent_change' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>变化阈值 (%)</span>
              <input type="number" className={inputCls} value={percentThreshold} onChange={(e) => setPercentThreshold(Number(e.target.value))} step={0.1} min={0} />
            </label>
          )}
          {ruleType === 'price_break' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>目标价格</span>
              <input type="number" className={inputCls} value={targetPrice} onChange={(e) => setTargetPrice(Number(e.target.value))} step={0.01} min={0} max={1} />
            </label>
          )}
          {ruleType === 'price_range' && (
            <>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>区间下限</span>
                <input type="number" className={inputCls} value={priceLow} onChange={(e) => setPriceLow(Number(e.target.value))} step={0.01} min={0} max={1} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>区间上限</span>
                <input type="number" className={inputCls} value={priceHigh} onChange={(e) => setPriceHigh(Number(e.target.value))} step={0.01} min={0} max={1} />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1">
            <span className={labelCls}>信号类型</span>
            <select className={inputCls} value={signalType} onChange={(e) => setSignalType(e.target.value as any)}>
              <option value="buy_signal">买入信号</option>
              <option value="sell_signal">卖出信号</option>
              <option value="alert">告警</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>冷却时间（秒）</span>
            <input type="number" className={inputCls} value={cooldownSeconds} onChange={(e) => setCooldownSeconds(Number(e.target.value))} step={30} min={0} />
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? '创建中...' : '创建机器人'}
        </button>
      </div>
    </div>
  )
}

// ==================== Monitors Tab ====================

function MonitorsTab({
  rules,
  monitors,
  onAction,
}: {
  rules: PriceMonitorRule[]
  monitors: PriceMonitorState[]
  onAction: (ruleId: number, action: 'start' | 'stop' | 'trigger') => void
}) {
  if (monitors.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无监控状态，请先创建规则并启动监控
      </div>
    )
  }

  const ruleMap = new Map(rules.map((r) => [r.id, r]))

  return (
    <div className="divide-y">
      {monitors.map((m) => {
        const rule = ruleMap.get(m.ruleId)
        return (
          <div key={m.ruleId} className="flex items-center gap-3 px-4 py-2.5">
            <div
              className={cn(
                'flex h-2 w-2 items-center justify-center rounded-full',
                m.running ? 'bg-green-500 animate-pulse' : 'bg-gray-400',
              )}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">
                  {rule ? RULE_TYPE_LABELS[rule.ruleType] : `规则#${m.ruleId}`}
                </span>
                {rule && (
                  <span className="text-[10px] text-muted-foreground">{rule.outcome}</span>
                )}
                <span className={cn('text-[10px]', m.running ? 'text-green-600' : 'text-muted-foreground')}>
                  {m.running ? '运行中' : '已停止'}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span>tokenId: {m.tokenId.slice(0, 16)}...</span>
                {m.lastPrice != null && (
                  <span>当前价: {m.lastPrice.toFixed(4)}</span>
                )}
                {m.baselinePrice != null && (
                  <span>基准价: {m.baselinePrice.toFixed(4)}</span>
                )}
                <span>触发: {m.triggerCount}次</span>
                <span>轮次: {m.cyclesRun}</span>
                {m.lastError && (
                  <span className="text-red-500">错误: {m.lastError.slice(0, 50)}</span>
                )}
              </div>
              {m.lastTriggerTime && (
                <div className="mt-0.5 flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  上次触发: {new Date(m.lastTriggerTime).toLocaleString('zh-CN')}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {m.running ? (
                <button
                  onClick={() => onAction(m.ruleId, 'stop')}
                  className="rounded border px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-500/10"
                >
                  停止
                </button>
              ) : (
                <button
                  onClick={() => onAction(m.ruleId, 'start')}
                  className="rounded border px-1.5 py-0.5 text-[10px] text-green-600 hover:bg-green-500/10"
                >
                  启动
                </button>
              )}
              <button
                onClick={() => onAction(m.ruleId, 'trigger')}
                className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                title="手动触发一次检测"
              >
                <Zap className="h-3 w-3" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== Triggers Tab ====================

function TriggersTab({
  triggers,
  loading,
}: {
  triggers: PriceTriggerRecord[]
  loading: boolean
}) {
  if (loading && triggers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中...
      </div>
    )
  }

  if (triggers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无触发记录
      </div>
    )
  }

  return (
    <div className="divide-y">
      {triggers.map((t, i) => {
        const sig = SIGNAL_LABELS[t.signalType] ?? SIGNAL_LABELS.alert
        const isUp = t.currentPrice > t.previousPrice
        return (
          <div key={t.id ?? i} className="flex items-center gap-3 px-4 py-2.5">
            <span className={cn('inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium', sig.className)}>
              <sig.icon className="h-2.5 w-2.5" />
              {sig.label}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <MatchLabel ctx={t} outcome={t.outcome} />
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="shrink-0">{RULE_TYPE_LABELS[t.ruleType] ?? t.ruleType}</span>
                <span className="shrink-0">{DIRECTION_LABELS[t.direction] ?? t.direction}</span>
                <span className="shrink-0 font-mono">
                  {fmtPrice(t.previousPrice)} → {fmtPrice(t.currentPrice)}
                </span>
                <span className={cn('flex shrink-0 items-center gap-0.5', isUp ? 'text-green-600' : 'text-red-600')}>
                  {isUp ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                  {fmtPercent(t.changePercent)}
                </span>
              </div>
            </div>
            {t.triggeredAt && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {new Date(t.triggeredAt).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ==================== Logs Tab ====================

function LogsTab({
  logs,
  rules,
}: {
  logs: PriceBotLog[]
  rules: PriceMonitorRule[]
}) {
  if (logs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无日志记录
      </div>
    )
  }

  const ruleMap = new Map(rules.map((r) => [r.id, r]))

  return (
    <div className="divide-y">
      {logs.map((log, i) => {
        const act = ACTION_LABELS[log.action] ?? ACTION_LABELS.price_update
        const rule = log.ruleId ? ruleMap.get(log.ruleId) : null
        return (
          <div key={log.id ?? i} className="flex items-center gap-3 px-4 py-2.5">
            <span className={cn('inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium', act.className)}>
              <act.icon className="h-2.5 w-2.5" />
              {act.label}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <MatchLabel ctx={log} outcome={log.outcome || rule?.outcome} />
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="shrink-0">规则#{log.ruleId}</span>
                {log.price != null && (
                  <span className="shrink-0 font-mono text-foreground/80">
                    {fmtPrice(log.price)}
                  </span>
                )}
                {log.detail && (
                  <span className="truncate">{log.detail}</span>
                )}
              </div>
            </div>
            {log.loggedAt && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {new Date(log.loggedAt).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
