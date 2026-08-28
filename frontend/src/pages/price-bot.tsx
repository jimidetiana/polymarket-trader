import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Play, Pause, Zap, Settings, Activity, RefreshCw, Plus, Trash2,
  TrendingUp, TrendingDown, Bell, Radio, FileText,
  ChevronDown, ChevronUp, ChevronRight, LineChart,
} from 'lucide-react'
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
  quickCreatePriceBotRules,
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
  type GoalSurgeParams,
} from '@/lib/api'

const RULE_TYPE_LABELS: Record<string, string> = {
  percent_change: '百分比变化',
  price_break: '价格突破',
  price_range: '价格区间',
  goal_surge: '进球买入信号',
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
  buy_signal: { label: '买入信号', className: 'bg-green-500/10 text-green-600 border-green-500/30', icon: TrendingUp },
  price_update: { label: '价格', className: 'bg-gray-500/10 text-gray-600 border-gray-500/30', icon: TrendingUp },
  disconnect: { label: '断联', className: 'bg-orange-500/10 text-orange-600 border-orange-500/30', icon: Pause },
  reconnect: { label: '重连', className: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/30', icon: Play },
}

/** 比赛状态徽标（镜像 soccer.tsx 的 StatusBadge 配色） */
const MATCH_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  live: { label: '进行中', className: 'bg-success/15 text-success border-success/30' },
  not_started: { label: '即将开始', className: 'bg-warning/15 text-warning border-warning/30' },
  ended: { label: '已结束', className: 'bg-muted text-muted-foreground border-border' },
}

/** 左侧列表状态过滤标签 */
type StatusFilterKey = 'all' | 'live' | 'not_started' | 'ended'
const STATUS_FILTER_TABS: { key: StatusFilterKey; label: (c: Record<string, number>) => string }[] = [
  { key: 'all', label: (c) => `全部 (${c.all})` },
  { key: 'live', label: (c) => `进行中 (${c.live})` },
  { key: 'not_started', label: (c) => `即将开始 (${c.not_started})` },
  { key: 'ended', label: (c) => `已结束 (${c.ended})` },
]

/** 左侧列表盘口过滤标签：大小球线(0.5–4.5) + 首球(谁先进球) */
type MarketFilterKey = 'all' | '0.5' | '1.5' | '2.5' | '3.5' | '4.5' | 'first_scorer'
const MARKET_FILTER_TABS: { key: MarketFilterKey; label: string; match: (r: PriceMonitorRule) => boolean }[] = [
  { key: 'all', label: '全部盘口', match: () => true },
  { key: '0.5', label: '0.5', match: (r) => r.marketType === 'total' && r.line === 0.5 },
  { key: '1.5', label: '1.5', match: (r) => r.marketType === 'total' && r.line === 1.5 },
  { key: '2.5', label: '2.5', match: (r) => r.marketType === 'total' && r.line === 2.5 },
  { key: '3.5', label: '3.5', match: (r) => r.marketType === 'total' && r.line === 3.5 },
  { key: '4.5', label: '4.5', match: (r) => r.marketType === 'total' && r.line === 4.5 },
  { key: 'first_scorer', label: '首球', match: (r) => r.marketType === 'first_scorer' },
]

/** goal_surge 参数输入项（留空则由后端用默认值回退） */
const GOAL_SURGE_FIELDS: { key: keyof GoalSurgeParams; label: string; placeholder: string; step: number }[] = [
  { key: 'surgeWindowMs', label: '递增窗口(ms)', placeholder: '3000', step: 100 },
  { key: 'surgeMinRise', label: '窗口净涨阈值', placeholder: '0.03', step: 0.01 },
  { key: 'jumpThreshold', label: '断联跳升阈值', placeholder: '0.05', step: 0.01 },
  { key: 'minBidSize', label: '最小买单量', placeholder: '50', step: 1 },
  { key: 'minAskSize', label: '最小卖单量', placeholder: '50', step: 1 },
  { key: 'askCeiling', label: '卖价上限', placeholder: '0.97', step: 0.01 },
  { key: 'confirmMin', label: '确认持稳下限', placeholder: '0.98', step: 0.01 },
  { key: 'confirmHoldMs', label: '持稳时长(ms)', placeholder: '2000', step: 100 },
]

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
 * 盘口名精简：盘口名通常已含「主队 vs. 客队: O/U 3.5」，
 * 此时去掉重复的比赛名部分，只留冒号后的盘口描述。
 */
function marketSuffixOf(marketName?: string): string | undefined {
  if (!marketName) return undefined
  return marketName.includes(' vs')
    ? marketName.split(':').slice(1).join(':').trim() || marketName
    : marketName
}

/** 机器人主标题：比赛名优先，无比赛名时回退规则类型 */
function primaryTitleOf(rule: PriceMonitorRule): string {
  return rule.matchName || RULE_TYPE_LABELS[rule.ruleType] || rule.ruleType
}

export default function PriceBotPage() {
  const [status, setStatus] = useState<PriceBotStatus | null>(null)
  const [rules, setRules] = useState<PriceMonitorRule[]>([])
  const [monitors, setMonitors] = useState<PriceMonitorState[]>([])
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>('all')
  const [marketFilter, setMarketFilter] = useState<MarketFilterKey>('all')
  const [batchCreating, setBatchCreating] = useState(false)

  // 选中机器人的触发记录 / 日志（按 ruleId 过滤，不进 5s 轮询）
  const [botTriggers, setBotTriggers] = useState<PriceTriggerRecord[]>([])
  const [botLogs, setBotLogs] = useState<PriceBotLog[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchPriceBotStatus())
    } catch {
      // ignore
    }
  }, [])

  const loadRules = useCallback(async () => {
    try {
      const { rules: r } = await fetchPriceBotRules({ limit: 200 })
      setRules(r)
    } catch {
      // ignore
    }
  }, [])

  const loadMonitors = useCallback(async () => {
    try {
      setMonitors(await fetchPriceBotMonitors())
    } catch {
      // ignore
    }
  }, [])

  const loadBotData = useCallback(async (ruleId: number) => {
    setDetailLoading(true)
    try {
      const [{ triggers }, { logs }] = await Promise.all([
        fetchPriceBotTriggers({ ruleId, limit: 50 }),
        fetchPriceBotLogs({ ruleId, limit: 100 }),
      ])
      setBotTriggers(triggers)
      setBotLogs(logs)
    } catch {
      // ignore
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // 首次加载 + 每 5s 轮询引擎状态与监控运行态（监控态驱动「监控状态」区块实时刷新）
  useEffect(() => {
    loadStatus()
    loadRules()
    loadMonitors()
    const interval = setInterval(() => {
      loadStatus()
      loadMonitors()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadStatus, loadRules, loadMonitors])

  // 切换选中机器人时，拉取该机器人的触发记录与日志
  useEffect(() => {
    if (selectedRuleId == null) {
      setBotTriggers([])
      setBotLogs([])
      return
    }
    loadBotData(selectedRuleId)
  }, [selectedRuleId, loadBotData])

  const monitorMap = new Map(monitors.map((m) => [m.ruleId, m]))
  const selectedRule = selectedRuleId != null ? rules.find((r) => r.id === selectedRuleId) ?? null : null
  const selectedMonitor = selectedRuleId != null ? monitorMap.get(selectedRuleId) ?? null : null

  // 左侧列表按比赛状态过滤（matchStatus 由后端 listRules 现算带出）
  const statusCounts = useMemo(() => {
    const live = rules.filter((r) => r.matchStatus === 'live').length
    const not_started = rules.filter((r) => r.matchStatus === 'not_started').length
    const ended = rules.filter((r) => r.matchStatus === 'ended').length
    return { all: rules.length, live, not_started, ended }
  }, [rules])

  const filteredRules = useMemo(() => {
    const mf = MARKET_FILTER_TABS.find((t) => t.key === marketFilter) ?? MARKET_FILTER_TABS[0]
    return rules.filter(
      (r) => (statusFilter === 'all' || r.matchStatus === statusFilter) && mf.match(r),
    )
  }, [rules, statusFilter, marketFilter])

  // 盘口过滤各标签的计数（全局，与状态计数一致）
  const marketCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of MARKET_FILTER_TABS) c[t.key] = rules.filter((r) => t.match(r)).length
    return c
  }, [rules])

  function handleSelect(ruleId: number) {
    setSelectedRuleId(ruleId)
    setCreating(false)
  }

  async function handleEngineStart() {
    try {
      setStatus(await startPriceBot())
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleEngineStop() {
    setStatus(await stopPriceBot())
  }

  async function handleEngineTrigger() {
    try {
      setStatus(await triggerPriceBotCycle())
      if (selectedRuleId != null) await loadBotData(selectedRuleId)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleConfigUpdate(config: Record<string, unknown>) {
    await updatePriceBotConfig(config)
    await loadStatus()
    setShowSettings(false)
  }

  async function handleAddRule(rule: Omit<PriceMonitorRule, 'id' | 'createdAt' | 'updatedAt'>) {
    try {
      const created = await createPriceBotRule(rule)
      await loadRules()
      await loadMonitors()
      setCreating(false)
      if (created?.id != null) setSelectedRuleId(created.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleBatchCreate() {
    if (batchCreating) return
    if (!confirm('将扫描接下来最多 5 场未开赛比赛，为其大小球盘口(监控 Over)与首球盘口(监控 Yes)批量创建「进球买入信号」机器人。确认？')) return
    setBatchCreating(true)
    try {
      const res = await quickCreatePriceBotRules()
      await loadRules()
      await loadMonitors()
      const skippedNote = res.skipped.length ? `，跳过 ${res.skipped.length} 个（已存在或无匹配结果）` : ''
      alert(`已创建 ${res.created.length} 个机器人（扫描 ${res.eventsScanned} 场）${skippedNote}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBatchCreating(false)
    }
  }

  async function handleDeleteRule(id: number) {
    if (!confirm('确认删除这个机器人？')) return
    try {
      await deletePriceBotRule(id)
      if (id === selectedRuleId) setSelectedRuleId(null)
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
      if (ruleId === selectedRuleId) await loadBotData(ruleId)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const activeCount = status?.activeMonitorCount ?? 0
  const totalCount = status?.monitorCount ?? rules.length

  return (
    <Layout
      title="价格监控机器人"
      subtitle="左侧选择机器人，右侧查看监控详情"
      actions={
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleEngineTrigger}
            className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
            title="手动触发一次全局检测"
          >
            <Zap className="h-4 w-4" />
            触发
          </button>
          {status?.running ? (
            <button
              onClick={handleEngineStop}
              className="flex items-center gap-1 rounded-md bg-red-500/10 px-2.5 py-1.5 text-sm text-red-600 hover:bg-red-500/20"
            >
              <Pause className="h-4 w-4" />
              停止引擎
            </button>
          ) : (
            <button
              onClick={handleEngineStart}
              className="flex items-center gap-1 rounded-md bg-green-500/10 px-2.5 py-1.5 text-sm text-green-600 hover:bg-green-500/20"
            >
              <Play className="h-4 w-4" />
              启动引擎
            </button>
          )}
          <button
            onClick={() => setShowSettings((s) => !s)}
            className={cn(
              'flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted',
              showSettings && 'bg-muted',
            )}
          >
            <Settings className="h-4 w-4" />
            参数
          </button>
        </div>
      }
    >
      {showSettings && status && (
        <div className="mb-4">
          <SettingsPanel config={status.config} onSave={handleConfigUpdate} />
        </div>
      )}

      <div className="flex h-[calc(100vh-8rem)] gap-4 overflow-hidden">
        {/* 左侧：机器人列表 */}
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-3">
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="活跃监控" value={`${activeCount} 个`} className="text-success" />
              <StatCard label="机器人总数" value={`${totalCount} 个`} />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span
                  className={cn(
                    'inline-flex h-2 w-2 rounded-full',
                    status?.running ? 'bg-green-500 animate-pulse' : 'bg-gray-400',
                  )}
                />
                {status?.running ? '引擎运行中' : '引擎已停止'}
              </span>
              {status && (
                <span className={cn('flex items-center gap-0.5', status.wsConnected ? 'text-green-600' : 'text-red-500')}>
                  <Radio className="h-3 w-3" />
                  {status.wsConnected ? 'WS已连接' : 'WS断开'}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setCreating(true)
                setSelectedRuleId(null)
              }}
              className={cn(
                'mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                creating
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background hover:bg-muted',
              )}
            >
              <Plus className="h-4 w-4" />
              创建机器人
            </button>
            <button
              type="button"
              onClick={handleBatchCreate}
              disabled={batchCreating}
              title="扫描未来最多 5 场未开赛比赛，批量创建大小球(Over)+首球(Yes)进球买入信号机器人"
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm font-medium text-green-600 transition-colors hover:bg-green-500/20 disabled:opacity-50"
            >
              <Zap className="h-4 w-4" />
              {batchCreating ? '批量创建中...' : '一键批量创建（未来5场）'}
            </button>
          </div>

          {/* 比赛状态过滤标签 */}
          <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
            {STATUS_FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  statusFilter === tab.key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {tab.label(statusCounts)}
              </button>
            ))}
          </div>

          {/* 盘口过滤标签：大小球线(0.5–4.5) + 首球 */}
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-2">
            <span className="mr-1 self-center text-xs text-muted-foreground">盘口</span>
            {MARKET_FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setMarketFilter(tab.key)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  marketFilter === tab.key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {tab.label} ({marketCounts[tab.key] ?? 0})
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {rules.length === 0 ? (
              <div className="rounded-lg border border-border bg-card p-4 text-center">
                <p className="text-sm text-muted-foreground">暂无机器人，点击「创建机器人」开始</p>
              </div>
            ) : filteredRules.length === 0 ? (
              <div className="rounded-lg border border-border bg-card p-4 text-center">
                <p className="text-sm text-muted-foreground">当前过滤条件下暂无机器人</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredRules.map((rule) => (
                  <BotCard
                    key={rule.id}
                    rule={rule}
                    monitor={rule.id != null ? monitorMap.get(rule.id) ?? null : null}
                    active={rule.id === selectedRuleId}
                    onClick={() => rule.id != null && handleSelect(rule.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* 右侧：详情 / 创建表单 / 空态 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {creating ? (
            <AddRuleForm onAdd={handleAddRule} onCancel={() => setCreating(false)} />
          ) : !selectedRule ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <LineChart className="h-9 w-9 opacity-40" />
              <p className="text-sm">从左侧选择一个机器人查看监控详情</p>
            </div>
          ) : (
            <BotDetail
              rule={selectedRule}
              monitor={selectedMonitor}
              triggers={botTriggers}
              logs={botLogs}
              detailLoading={detailLoading}
              onMonitorAction={handleMonitorAction}
              onToggleRule={handleToggleRule}
              onDeleteRule={handleDeleteRule}
              onRefreshDetail={() => selectedRule.id != null && loadBotData(selectedRule.id)}
            />
          )}
        </main>
      </div>
    </Layout>
  )
}

// ==================== 左侧机器人卡片 ====================

function BotCard({
  rule,
  monitor,
  active,
  onClick,
}: {
  rule: PriceMonitorRule
  monitor: PriceMonitorState | null
  active: boolean
  onClick: () => void
}) {
  const sig = SIGNAL_LABELS[rule.signalType] ?? SIGNAL_LABELS.alert
  const isRunning = monitor?.running ?? false
  const suffix = marketSuffixOf(rule.marketName)
  const price = monitor?.lastPrice

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'cursor-pointer rounded-lg border bg-card px-3 py-2.5 transition-colors',
        active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex h-2 w-2 shrink-0 rounded-full',
            isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400',
          )}
        />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {primaryTitleOf(rule)}
        </p>
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground', active && 'text-primary')} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className={cn('inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-xs font-medium', sig.className)}>
          <sig.icon className="h-3 w-3" />
          {sig.label}
        </span>
        {rule.matchStatus && MATCH_STATUS_BADGE[rule.matchStatus] && (
          <span className={cn('rounded border px-1.5 py-0.5 text-xs font-medium', MATCH_STATUS_BADGE[rule.matchStatus].className)}>
            {MATCH_STATUS_BADGE[rule.matchStatus].label}
          </span>
        )}
        {suffix && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{suffix}</span>
        )}
        <span className="text-xs text-muted-foreground">{rule.outcome}</span>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{RULE_TYPE_LABELS[rule.ruleType] ?? rule.ruleType}</span>
        <span className="font-mono text-foreground/80">
          {price != null ? price.toFixed(4) : '—'}
        </span>
      </div>
    </div>
  )
}

// ==================== 右侧机器人详情 ====================

function BotDetail({
  rule,
  monitor,
  triggers,
  logs,
  detailLoading,
  onMonitorAction,
  onToggleRule,
  onDeleteRule,
  onRefreshDetail,
}: {
  rule: PriceMonitorRule
  monitor: PriceMonitorState | null
  triggers: PriceTriggerRecord[]
  logs: PriceBotLog[]
  detailLoading: boolean
  onMonitorAction: (ruleId: number, action: 'start' | 'stop' | 'trigger') => void
  onToggleRule: (rule: PriceMonitorRule) => void
  onDeleteRule: (id: number) => void
  onRefreshDetail: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const sig = SIGNAL_LABELS[rule.signalType] ?? SIGNAL_LABELS.alert
  const isRunning = monitor?.running ?? false
  const suffix = marketSuffixOf(rule.marketName)

  return (
    <>
      {/* 详情头 */}
      <header className="border-b border-border px-5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex h-2.5 w-2.5 shrink-0 rounded-full',
                  isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400',
                )}
              />
              <h2 className="truncate text-base font-semibold text-foreground">{primaryTitleOf(rule)}</h2>
              <span className={cn('inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-xs font-medium', sig.className)}>
                <sig.icon className="h-3 w-3" />
                {sig.label}
              </span>
              <span className={cn('text-xs', isRunning ? 'text-green-600' : 'text-muted-foreground')}>
                {isRunning ? '监控中' : '未运行'}
              </span>
              {rule.enabled ? (
                <span className="text-xs text-green-600">已启用</span>
              ) : (
                <span className="text-xs text-muted-foreground">已禁用</span>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {[suffix, rule.outcome, RULE_TYPE_LABELS[rule.ruleType], DIRECTION_LABELS[rule.direction], rule.league]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="truncate text-xs text-muted-foreground">token: {rule.tokenId}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isRunning ? (
              <button
                onClick={() => rule.id != null && onMonitorAction(rule.id, 'stop')}
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm text-red-600 hover:bg-red-500/10"
              >
                <Pause className="h-3.5 w-3.5" />
                停止
              </button>
            ) : (
              <button
                onClick={() => rule.id != null && onMonitorAction(rule.id, 'start')}
                disabled={!rule.enabled}
                title={!rule.enabled ? '请先启用机器人' : undefined}
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm text-green-600 hover:bg-green-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                启动
              </button>
            )}
            <button
              onClick={() => rule.id != null && onMonitorAction(rule.id, 'trigger')}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm hover:bg-muted"
              title="手动触发一次检测"
            >
              <Zap className="h-3.5 w-3.5" />
              触发
            </button>
            <button
              onClick={() => onToggleRule(rule)}
              className={cn(
                'rounded-md border px-2 py-1 text-sm hover:bg-muted',
                rule.enabled ? 'text-yellow-600' : 'text-green-600',
              )}
            >
              {rule.enabled ? '禁用' : '启用'}
            </button>
            <button
              onClick={() => rule.id != null && onDeleteRule(rule.id)}
              className="rounded-md border px-2 py-1 text-sm text-red-600 hover:bg-red-500/10"
              title="删除机器人"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* 四个可折叠区块 */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          <Section
            title="监控规则"
            icon={Activity}
            collapsed={collapsed.has('rule')}
            onToggle={() => toggle('rule')}
          >
            <RuleSection rule={rule} />
          </Section>

          <Section
            title="监控状态"
            icon={Radio}
            collapsed={collapsed.has('status')}
            onToggle={() => toggle('status')}
          >
            <StatusSection monitor={monitor} />
          </Section>

          <Section
            title="触发记录"
            icon={Bell}
            count={triggers.length}
            collapsed={collapsed.has('triggers')}
            onToggle={() => toggle('triggers')}
            action={
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRefreshDetail()
                }}
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                <RefreshCw className={cn('h-3 w-3', detailLoading && 'animate-spin')} />
                刷新
              </button>
            }
          >
            <TriggersSection triggers={triggers} />
          </Section>

          <Section
            title="日志"
            icon={FileText}
            count={logs.length}
            collapsed={collapsed.has('logs')}
            onToggle={() => toggle('logs')}
            action={
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRefreshDetail()
                }}
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                <RefreshCw className={cn('h-3 w-3', detailLoading && 'animate-spin')} />
                刷新
              </button>
            }
          >
            <LogsSection logs={logs} />
          </Section>
        </div>
      </div>
    </>
  )
}

// ==================== 可折叠区块外壳 ====================

function Section({
  title,
  icon: Icon,
  count,
  action,
  collapsed,
  onToggle,
  children,
}: {
  title: string
  icon: typeof Activity
  count?: number
  action?: React.ReactNode
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-muted/40"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          {count != null && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              {count}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {action}
          {collapsed ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      </div>
      {!collapsed && <div className="border-t border-border">{children}</div>}
    </section>
  )
}

function KV({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-medium text-foreground', className)}>{value}</span>
    </div>
  )
}

// ==================== 监控规则区块 ====================

function RuleSection({ rule }: { rule: PriceMonitorRule }) {
  return (
    <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
      <KV label="规则类型" value={RULE_TYPE_LABELS[rule.ruleType] ?? rule.ruleType} />
      <KV label="方向" value={DIRECTION_LABELS[rule.direction] ?? rule.direction} />
      <KV label="信号类型" value={SIGNAL_LABELS[rule.signalType]?.label ?? rule.signalType} />
      {rule.ruleType === 'percent_change' && (
        <KV
          label="变化阈值"
          value={rule.percentThreshold != null ? `${(rule.percentThreshold * 100).toFixed(1)}%` : '—'}
        />
      )}
      {rule.ruleType === 'price_break' && (
        <KV label="目标价格" value={rule.targetPrice != null ? rule.targetPrice.toFixed(4) : '—'} />
      )}
      {rule.ruleType === 'price_range' && (
        <KV label="价格区间" value={`${rule.priceLow ?? '—'} ~ ${rule.priceHigh ?? '—'}`} />
      )}
      {rule.ruleType === 'goal_surge' && (
        <KV
          label="信号参数"
          value={
            rule.goalSurgeParams && Object.keys(rule.goalSurgeParams).length
              ? Object.entries(rule.goalSurgeParams).map(([k, v]) => `${k}=${v}`).join(', ')
              : '全部默认'
          }
        />
      )}
      <KV label="冷却时间" value={`${rule.cooldownSeconds}s`} />
      <KV label="启用状态" value={rule.enabled ? '已启用' : '已禁用'} className={rule.enabled ? 'text-green-600' : 'text-muted-foreground'} />
      <KV label="结果" value={rule.outcome} />
      {rule.marketName && <KV label="盘口" value={marketSuffixOf(rule.marketName)} />}
      {rule.createdAt && (
        <KV label="创建时间" value={new Date(rule.createdAt).toLocaleString('zh-CN')} />
      )}
    </div>
  )
}

// ==================== 监控状态区块 ====================

function StatusSection({ monitor }: { monitor: PriceMonitorState | null }) {
  if (!monitor) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        该机器人尚未启动监控
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
      <KV
        label="运行状态"
        value={monitor.running ? '监控中' : '已停止'}
        className={monitor.running ? 'text-green-600' : 'text-muted-foreground'}
      />
      <KV label="当前价" value={fmtPrice(monitor.lastPrice)} className="font-mono" />
      <KV label="基准价" value={fmtPrice(monitor.baselinePrice)} className="font-mono" />
      <KV label="触发次数" value={`${monitor.triggerCount} 次`} />
      <KV label="检测轮次" value={monitor.cyclesRun} />
      <KV
        label="上次触发"
        value={monitor.lastTriggerTime ? new Date(monitor.lastTriggerTime).toLocaleString('zh-CN') : '—'}
      />
      <KV
        label="上次轮询"
        value={monitor.lastPollTime ? new Date(monitor.lastPollTime).toLocaleString('zh-CN') : '—'}
      />
      {monitor.lastError && (
        <div className="col-span-2 flex flex-col gap-0.5 sm:col-span-3">
          <span className="text-xs text-muted-foreground">最近错误</span>
          <span className="text-sm font-medium text-red-500">{monitor.lastError}</span>
        </div>
      )}
    </div>
  )
}

// ==================== 触发记录区块 ====================

function TriggersSection({ triggers }: { triggers: PriceTriggerRecord[] }) {
  if (triggers.length === 0) {
    return <div className="p-6 text-center text-sm text-muted-foreground">暂无触发记录</div>
  }
  return (
    <div className="divide-y divide-border">
      {triggers.map((t, i) => {
        const sig = SIGNAL_LABELS[t.signalType] ?? SIGNAL_LABELS.alert
        const isUp = t.currentPrice > t.previousPrice
        return (
          <div key={t.id ?? i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className={cn('inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-xs font-medium', sig.className)}>
              <sig.icon className="h-3 w-3" />
              {sig.label}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {RULE_TYPE_LABELS[t.ruleType] ?? t.ruleType} · {DIRECTION_LABELS[t.direction] ?? t.direction}
            </span>
            <span className="shrink-0 font-mono text-foreground/90">
              {fmtPrice(t.previousPrice)} → {fmtPrice(t.currentPrice)}
            </span>
            <span className={cn('flex shrink-0 items-center gap-0.5', isUp ? 'text-green-600' : 'text-red-600')}>
              {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {fmtPercent(t.changePercent)}
            </span>
            {t.triggeredAt && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {new Date(t.triggeredAt).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ==================== 日志区块 ====================

function LogsSection({ logs }: { logs: PriceBotLog[] }) {
  if (logs.length === 0) {
    return <div className="p-6 text-center text-sm text-muted-foreground">暂无日志记录</div>
  }
  return (
    <div className="divide-y divide-border">
      {logs.map((log, i) => {
        const act = ACTION_LABELS[log.action] ?? ACTION_LABELS.price_update
        return (
          <div key={log.id ?? i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className={cn('inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-xs font-medium', act.className)}>
              <act.icon className="h-3 w-3" />
              {act.label}
            </span>
            {log.price != null && (
              <span className="shrink-0 font-mono text-foreground/90">{fmtPrice(log.price)}</span>
            )}
            {log.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{log.detail}</span>}
            {log.loggedAt && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {new Date(log.loggedAt).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ==================== 参数面板 ====================

function SettingsPanel({
  config,
  onSave,
}: {
  config: PriceBotStatus['config']
  onSave: (config: Record<string, unknown>) => void
}) {
  const [pollInterval, setPollInterval] = useState(config.pollIntervalMs / 1000)

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">轮询间隔（秒，仅用于 fallback REST 轮询）</span>
          <input
            type="number"
            value={pollInterval}
            onChange={(e) => setPollInterval(Number(e.target.value))}
            min={1}
            step={1}
            className="w-36 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <button
          onClick={() => onSave({ pollIntervalMs: pollInterval * 1000 })}
          className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
        >
          保存
        </button>
      </div>
    </div>
  )
}

// ==================== 创建机器人表单 ====================

function AddRuleForm({
  onAdd,
  onCancel,
}: {
  onAdd: (rule: Omit<PriceMonitorRule, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
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
  const [cooldownSeconds, setCooldownSeconds] = useState(1)
  // goal_surge 参数（字符串态，留空则不提交、由后端用默认值回退）
  const [gsParams, setGsParams] = useState<Record<string, string>>({})

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

  // goal_surge：强制 buy_signal + up 方向；已选盘口若非 total/first_scorer 则清空重选
  useEffect(() => {
    if (ruleType !== 'goal_surge') return
    setSignalType('buy_signal')
    setDirection('up')
    if (selectedMarketIdx >= 0) {
      const m = markets[selectedMarketIdx]
      if (m && m.market_type !== 'total' && m.market_type !== 'first_scorer') {
        setSelectedMarketIdx(-1)
        setSelectedOutcomeIdx(-1)
      }
    }
  }, [ruleType, markets, selectedMarketIdx])

  const selectedMarket = selectedMarketIdx >= 0 ? markets[selectedMarketIdx] : null
  const outcomes = selectedMarket?.outcomes ?? []
  const tokenIds = selectedMarket?.clob_token_ids ?? []
  const selectedOutcome = selectedOutcomeIdx >= 0 ? outcomes[selectedOutcomeIdx] : null
  const selectedTokenId = selectedOutcomeIdx >= 0 ? tokenIds[selectedOutcomeIdx] : null

  const isGoalSurge = ruleType === 'goal_surge'
  // goal_surge 只能建在大小球/首球盘口上（保留原始下标，供 selectedMarketIdx 语义不变）
  const visibleMarkets = useMemo(
    () =>
      markets
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !isGoalSurge || m.market_type === 'total' || m.market_type === 'first_scorer'),
    [markets, isGoalSurge],
  )

  const [submitting, setSubmitting] = useState(false)

  // 仅收集用户实际填写的字段；留空的交给后端默认值
  function buildGoalSurgeParams(): GoalSurgeParams | undefined {
    const out: Record<string, number> = {}
    for (const { key } of GOAL_SURGE_FIELDS) {
      const raw = gsParams[key]
      if (raw != null && raw.trim() !== '') {
        const n = Number(raw)
        if (Number.isFinite(n)) out[key] = n
      }
    }
    return Object.keys(out).length ? (out as GoalSurgeParams) : undefined
  }

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
        goalSurgeParams: isGoalSurge ? buildGoalSurgeParams() : undefined,
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

  const inputCls = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm'
  const labelCls = 'text-xs text-muted-foreground'

  return (
    <>
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold text-foreground">创建价格监控机器人</h2>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted"
        >
          取消
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* 市场选择器 */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <h3 className="text-sm font-semibold">选择监控市场</h3>
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
                <option value={-1}>
                  {loadingMarkets
                    ? '加载中...'
                    : !selectedEventId
                      ? '请先选择比赛'
                      : isGoalSurge && visibleMarkets.length === 0
                        ? '该比赛无大小球/首球盘口'
                        : '请选择盘口'}
                </option>
                {visibleMarkets.map(({ m, i }) => {
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
              <div className="flex flex-wrap gap-2">
                {outcomes.map((outcome, idx) => {
                  const token = tokenIds[idx]
                  const selected = selectedOutcomeIdx === idx
                  return (
                    <button
                      key={idx}
                      onClick={() => setSelectedOutcomeIdx(idx)}
                      disabled={!token}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                        selected
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background text-foreground hover:bg-muted',
                        !token && 'cursor-not-allowed opacity-40',
                      )}
                    >
                      {outcome}
                    </button>
                  )
                })}
              </div>
              {selectedTokenId && (
                <span className="text-xs text-muted-foreground">Token: {selectedTokenId.slice(0, 20)}...</span>
              )}
            </div>
          )}
        </div>

        {/* 规则配置 */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <h3 className="text-sm font-semibold">监控规则配置</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={labelCls}>规则类型</span>
              <select className={inputCls} value={ruleType} onChange={(e) => setRuleType(e.target.value as PriceMonitorRule['ruleType'])}>
                <option value="percent_change">百分比变化</option>
                <option value="price_break">价格突破</option>
                <option value="price_range">价格区间</option>
                <option value="goal_surge">进球买入信号</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelCls}>方向</span>
              <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as PriceMonitorRule['direction'])} disabled={isGoalSurge}>
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
              <select className={inputCls} value={signalType} onChange={(e) => setSignalType(e.target.value as PriceMonitorRule['signalType'])} disabled={isGoalSurge}>
                <option value="buy_signal">买入信号</option>
                <option value="sell_signal">卖出信号</option>
                <option value="alert">告警</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelCls}>冷却时间（秒）</span>
              <input type="number" className={inputCls} value={cooldownSeconds} onChange={(e) => setCooldownSeconds(Number(e.target.value))} step={1} min={0} />
            </label>
          </div>

          {isGoalSurge && (
            <div className="space-y-2 rounded-md border border-green-500/30 bg-green-500/5 p-3">
              <p className="text-xs text-muted-foreground">
                进球买入信号仅适用于大小球/首球盘口，方向固定为上涨、信号固定为买入。以下参数留空即使用系统默认值。
              </p>
              <div className="grid grid-cols-2 gap-3">
                {GOAL_SURGE_FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1">
                    <span className={labelCls}>{f.label}</span>
                    <input
                      type="number"
                      className={inputCls}
                      value={gsParams[f.key] ?? ''}
                      placeholder={`默认 ${f.placeholder}`}
                      step={f.step}
                      min={0}
                      onChange={(e) => setGsParams((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-4 py-1.5 text-sm hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? '创建中...' : '创建机器人'}
          </button>
        </div>
      </div>
    </>
  )
}

// ==================== 小组件 ====================

function StatCard({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-2 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold text-foreground', className)}>{value}</p>
    </div>
  )
}
