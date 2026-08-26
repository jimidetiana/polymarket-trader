import { useEffect, useState, useCallback, Fragment } from 'react'
import { Play, Pause, Zap, Settings, TrendingUp, TrendingDown, Clock, Activity, RefreshCw, Bot, Plus, Trash2, FileText, BarChart3 } from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn } from '@/lib/utils'
import {
  fetchValueBotStatus,
  startValueBot,
  stopValueBot,
  updateValueBotConfig,
  triggerValueBotCycle,
  fetchValueBetRecords,
  fetchMatchStates,
  fetchAvailableMatches,
  fetchBzzoiroMatches,
  setInitialOdds,
  deleteInitialOdds,
  type ValueBotStatus,
  type ValueBetRecord,
  type MatchState,
  type AvailableMatch,
  type BzzoiroMatch,
  fetchRuleMetas,
  type RuleMeta,
  startMatchMonitor,
  stopMatchMonitor,
  triggerMatchMonitor,
  fetchMatchMonitors,
  fetchCalcLogs,
  type MatchMonitor,
  type CalcLog,
  fetchCalcLogsAnalysis,
  type LogAnalysis,
  type LogTimelineEntry,
} from '@/lib/api'

type Tab = 'records' | 'matches' | 'rules' | 'logs'

export default function ValueBotPage() {
  const [status, setStatus] = useState<ValueBotStatus | null>(null)
  const [tab, setTab] = useState<Tab>('matches')
  const [records, setRecords] = useState<ValueBetRecord[]>([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [loading, setLoading] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [filterRec, setFilterRec] = useState<string>('')
  const [page, setPage] = useState(0)
  const pageSize = 50

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchValueBotStatus()
      setStatus(s)
    } catch {
      // ignore
    }
  }, [])

  const loadRecords = useCallback(async () => {
    setLoading(true)
    try {
      const { records: recs, total } = await fetchValueBetRecords({
        limit: pageSize,
        offset: page * pageSize,
        recommendation: filterRec || undefined,
      })
      setRecords(recs)
      setTotalRecords(total)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [page, filterRec])

  useEffect(() => {
    loadStatus()
    loadRecords()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [loadStatus, loadRecords])

  async function handleStart() {
    try {
      const s = await startValueBot()
      setStatus(s)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleStop() {
    const s = await stopValueBot()
    setStatus(s)
  }

  async function handleTrigger() {
    try {
      const s = await triggerValueBotCycle()
      setStatus(s)
      await loadRecords()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleConfigUpdate(config: Record<string, unknown>) {
    const s = await updateValueBotConfig(config)
    setStatus(s)
    setShowSettings(false)
  }

  return (
    <Layout title="价值投注机器人" subtitle="基于泊松模型的性价比交易">
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
            <h1 className="text-sm font-semibold">价值投注机器人</h1>
            <span className="text-[10px] text-muted-foreground">
              {status?.running ? '运行中' : '已停止'} · 第{status?.cyclesRun ?? 0}轮 · {status?.totalRecords ?? 0}条记录
            </span>
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

        {/* Status Bar */}
        {status && (
          <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-1.5 text-[10px] text-muted-foreground">
            <span>轮询间隔: {(status.config.pollIntervalMs / 1000).toFixed(0)}秒</span>
            <span>Edge阈值: {(status.config.edgeThreshold * 100).toFixed(1)}%</span>
            <span>衰减指数: {status.config.timeDecayExponent}</span>
            <span>最大进球: {status.config.maxGoals}</span>
            {status.lastPollTime && (
              <span className="flex items-center gap-0.5">
                <Clock className="h-2.5 w-2.5" />
                最后轮询: {new Date(status.lastPollTime).toLocaleTimeString('zh-CN')}
              </span>
            )}
            {status.lastError && (
              <span className="text-red-500">错误: {status.lastError}</span>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b px-4 py-2">
          <button
            onClick={() => setTab('matches')}
            className={cn(
              'flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium',
              tab === 'matches' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            <Bot className="h-3 w-3" />
            比赛配置
          </button>
          <button
            onClick={() => setTab('records')}
            className={cn(
              'flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium',
              tab === 'records' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            <Activity className="h-3 w-3" />
            投注记录
          </button>
          <button
            onClick={() => setTab('rules')}
            className={cn(
              'flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium',
              tab === 'rules' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            <Settings className="h-3 w-3" />
            盘口规则
          </button>
          <button
            onClick={() => setTab('logs')}
            className={cn(
              'flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium',
              tab === 'logs' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            <BarChart3 className="h-3 w-3" />
            日志分析
          </button>
        </div>

        {/* Tab Content */}
        {tab === 'matches' ? (
          <MatchesTab />
        ) : tab === 'rules' ? (
          <RulesTab status={status} onConfigChange={loadStatus} />
        ) : tab === 'logs' ? (
          <LogsAnalysisTab />
        ) : (
          <RecordsTab
            records={records}
            totalRecords={totalRecords}
            loading={loading}
            filterRec={filterRec}
            setFilterRec={setFilterRec}
            page={page}
            setPage={setPage}
            pageSize={pageSize}
            loadRecords={loadRecords}
          />
        )}
      </div>
    </Layout>
  )
}

// ===== 比赛配置 Tab =====

function MatchesTab() {
  const [configured, setConfigured] = useState<MatchState[]>([])
  const [monitors, setMonitors] = useState<Map<string, MatchMonitor>>(new Map())
  const [loading, setLoading] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [logEventId, setLogEventId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, ms] = await Promise.all([fetchMatchStates(), fetchMatchMonitors()])
      setConfigured(c)
      const map = new Map<string, MatchMonitor>()
      for (const m of ms) map.set(m.eventId, m)
      setMonitors(map)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [load])

  const handleStart = async (eventId: string) => {
    try {
      await startMatchMonitor(eventId)
      load()
    } catch { /* ignore */ }
  }

  const handleStop = async (eventId: string) => {
    try {
      await stopMatchMonitor(eventId)
      load()
    } catch { /* ignore */ }
  }

  const handleTrigger = async (eventId: string) => {
    try {
      await triggerMatchMonitor(eventId)
      load()
    } catch { /* ignore */ }
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-muted-foreground">
          已配置的比赛 ({configured.length})
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={load}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            刷新
          </button>
          <button
            onClick={() => setShowDialog(true)}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" />
            配置比赛
          </button>
        </div>
      </div>

      {configured.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-[11px] text-muted-foreground">
          暂无已配置的比赛，点击"配置比赛"添加
        </div>
      ) : (
        <div className="space-y-2">
          {configured.map((m) => {
            const mon = monitors.get(m.event_id)
            const running = mon?.running ?? false
            return (
              <div
                key={m.event_id}
                className={cn(
                  'rounded-md border bg-card p-2.5',
                  running && 'border-green-500/40 bg-green-500/5',
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">
                        {m.home_team} <span className="text-muted-foreground">vs</span> {m.away_team}
                      </span>
                      {m.source === 'manual' ? (
                        <span className="rounded bg-blue-500/10 px-1 py-0.5 text-[9px] text-blue-600">手动</span>
                      ) : (
                        <span className="rounded bg-green-500/10 px-1 py-0.5 text-[9px] text-green-600">自动</span>
                      )}
                      {running && (
                        <span className="flex items-center gap-0.5 rounded bg-green-500/10 px-1 py-0.5 text-[9px] text-green-600">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                          监控中
                        </span>
                      )}
                      {m.end_time && (
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(m.end_time.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>主胜: {(Number(m.initial_home_prob) * 100).toFixed(1)}%</span>
                      <span>平: {(Number(m.initial_draw_prob) * 100).toFixed(1)}%</span>
                      <span>客胜: {(Number(m.initial_away_prob) * 100).toFixed(1)}%</span>
                      <span className="text-primary">λ_H: {Number(m.lambda_home).toFixed(3)}</span>
                      <span className="text-primary">λ_A: {Number(m.lambda_away).toFixed(3)}</span>
                      {m.bzzoiro_event_id ? (
                        <span className="text-green-600">已关联 bzzoiro#{m.bzzoiro_event_id}</span>
                      ) : (
                        <span className="text-yellow-600">未关联比分源</span>
                      )}
                    </div>
                    {m.bzzoiro_home_team && m.bzzoiro_away_team && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        比分源: {m.bzzoiro_home_team} vs {m.bzzoiro_away_team}
                      </div>
                    )}
                    {mon && (
                      <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>轮次: {mon.cyclesRun}</span>
                        <span>日志: {mon.totalLogs}</span>
                        {mon.lastPollTime && (
                          <span>最后: {new Date(mon.lastPollTime).toLocaleTimeString('zh-CN')}</span>
                        )}
                        {mon.lastError && (
                          <span className="text-red-500">错误: {mon.lastError}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {running ? (
                      <button
                        onClick={() => handleStop(m.event_id)}
                        className="rounded p-1 text-red-600 hover:bg-red-500/10"
                        title="停止监控"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => handleStart(m.event_id)}
                        className="rounded p-1 text-green-600 hover:bg-green-500/10"
                        title="启动监控"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleTrigger(m.event_id)}
                      className="rounded p-1 text-blue-600 hover:bg-blue-500/10"
                      title="手动计算一次"
                    >
                      <Zap className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setLogEventId(m.event_id)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                      title="查看日志"
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={async () => {
                        await deleteInitialOdds(m.event_id)
                        load()
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-600"
                      title="删除配置"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 配置弹窗 */}
      {showDialog && (
        <MatchConfigDialog
          onClose={() => setShowDialog(false)}
          onSaved={() => {
            setShowDialog(false)
            load()
          }}
        />
      )}

      {/* 日志查看弹窗 */}
      {logEventId && (
        <LogViewerDialog
          eventId={logEventId}
          matchName={configured.find((m) => m.event_id === logEventId)?.home_team + ' vs ' + configured.find((m) => m.event_id === logEventId)?.away_team || ''}
          onClose={() => setLogEventId(null)}
        />
      )}
    </div>
  )
}

function MatchConfigDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const [polyMatches, setPolyMatches] = useState<AvailableMatch[]>([])
  const [bzzoiroMatches, setBzzoiroMatches] = useState<BzzoiroMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [polyId, setPolyId] = useState<string>('')
  const [bzzoiroId, setBzzoiroId] = useState<string>('')
  const [bzzoiroHome, setBzzoiroHome] = useState('')
  const [bzzoiroAway, setBzzoiroAway] = useState('')

  const [homeProb, setHomeProb] = useState(40)
  const [drawProb, setDrawProb] = useState(28)
  const [awayProb, setAwayProb] = useState(32)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const [poly, bzz] = await Promise.all([fetchAvailableMatches(), fetchBzzoiroMatches()])
        setPolyMatches(poly)
        setBzzoiroMatches(bzz)
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const selectedPoly = polyMatches.find((m) => String(m.id) === polyId) || null
  const selectedBzz = bzzoiroMatches.find((m) => String(m.id) === bzzoiroId) || null

  // Auto-fill bzzoiro team names when a bzzoiro match is selected
  useEffect(() => {
    if (selectedBzz) {
      setBzzoiroHome(selectedBzz.home_team)
      setBzzoiroAway(selectedBzz.away_team)
    }
  }, [selectedBzz])

  const total = homeProb + drawProb + awayProb
  const normalized = total > 0 ? [homeProb / total, drawProb / total, awayProb / total] : [0, 0, 0]

  async function handleSave() {
    if (!selectedPoly) {
      setError('请选择 Polymarket 比赛')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await setInitialOdds(
        selectedPoly.id,
        selectedPoly.home_team_en || selectedPoly.home_team_zh || '',
        selectedPoly.away_team_en || selectedPoly.away_team_zh || '',
        normalized[0],
        normalized[1],
        normalized[2],
        selectedBzz ? selectedBzz.id : undefined,
        bzzoiroHome || undefined,
        bzzoiroAway || undefined,
      )
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const liveMatches = bzzoiroMatches.filter((m) => m.status === 'live')
  const upcomingMatches = bzzoiroMatches.filter((m) => m.status === 'upcoming')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[90vh] w-[480px] overflow-auto rounded-lg border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">配置比赛</h3>

        {loading ? (
          <div className="py-8 text-center text-[11px] text-muted-foreground">加载中...</div>
        ) : (
          <div className="space-y-4">
            {/* Polymarket 比赛选择 */}
            <div>
              <label className="mb-1 block text-[11px] font-medium">Polymarket 比赛</label>
              <select
                value={polyId}
                onChange={(e) => setPolyId(e.target.value)}
                className="w-full rounded border bg-background px-2 py-1.5 text-[11px]"
              >
                <option value="">-- 选择 Polymarket 比赛 --</option>
                {polyMatches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.match_status === 'live' ? '[进行中] ' : ''}{m.home_team_zh || m.home_team_en || '?'} vs {m.away_team_zh || m.away_team_en || '?'}
                    {m.league ? ` (${m.league})` : ''}
                    {m.end_time ? ` · ${new Date(m.end_time.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* bzzoiro 比赛关联 */}
            <div>
              <label className="mb-1 block text-[11px] font-medium">比分数据源 (bzzoiro)</label>
              <select
                value={bzzoiroId}
                onChange={(e) => setBzzoiroId(e.target.value)}
                className="w-full rounded border bg-background px-2 py-1.5 text-[11px]"
              >
                <option value="">-- 不关联比分源 --</option>
                {liveMatches.length > 0 && (
                  <optgroup label="进行中">
                    {liveMatches.map((m) => (
                      <option key={m.id} value={String(m.id)}>
                        {m.home_team_zh || m.home_team} vs {m.away_team_zh || m.away_team} ({m.home_score}-{m.away_score} {m.minute}')
                        {m.league ? ` · ${m.league}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {upcomingMatches.length > 0 && (
                  <optgroup label="即将开始">
                    {upcomingMatches.map((m) => (
                      <option key={m.id} value={String(m.id)}>
                        {m.home_team_zh || m.home_team} vs {m.away_team_zh || m.away_team}
                        {m.league ? ` · ${m.league}` : ''}
                        {m.start_time ? ` · ${new Date(m.start_time).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            {/* 球队名称映射 */}
            {selectedPoly && (
              <div className="rounded-md border p-2.5">
                <div className="mb-2 text-[10px] font-medium text-muted-foreground">
                  球队名称映射（两侧翻译可能不一致，可手工修改）
                </div>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <div>
                      <div className="text-[9px] text-muted-foreground">Polymarket 主队</div>
                      <div className="text-[11px] font-medium">
                        {selectedPoly.home_team_zh || selectedPoly.home_team_en || '?'}
                      </div>
                      {selectedPoly.home_team_en && selectedPoly.home_team_zh && (
                        <div className="text-[9px] text-muted-foreground">{selectedPoly.home_team_en}</div>
                      )}
                    </div>
                    <span className="text-muted-foreground">→</span>
                    <div>
                      <div className="text-[9px] text-muted-foreground">bzzoiro 主队名</div>
                      <input
                        value={bzzoiroHome}
                        onChange={(e) => setBzzoiroHome(e.target.value)}
                        placeholder="bzzoiro 主队名称"
                        className="w-full rounded border bg-background px-1.5 py-1 text-[11px]"
                      />
                      {selectedBzz?.home_team_zh && selectedBzz?.home_team && selectedBzz.home_team !== selectedBzz.home_team_zh && (
                        <div className="text-[9px] text-muted-foreground">原文: {selectedBzz.home_team}</div>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <div>
                      <div className="text-[9px] text-muted-foreground">Polymarket 客队</div>
                      <div className="text-[11px] font-medium">
                        {selectedPoly.away_team_zh || selectedPoly.away_team_en || '?'}
                      </div>
                      {selectedPoly.away_team_en && selectedPoly.away_team_zh && (
                        <div className="text-[9px] text-muted-foreground">{selectedPoly.away_team_en}</div>
                      )}
                    </div>
                    <span className="text-muted-foreground">→</span>
                    <div>
                      <div className="text-[9px] text-muted-foreground">bzzoiro 客队名</div>
                      <input
                        value={bzzoiroAway}
                        onChange={(e) => setBzzoiroAway(e.target.value)}
                        placeholder="bzzoiro 客队名称"
                        className="w-full rounded border bg-background px-1.5 py-1 text-[11px]"
                      />
                      {selectedBzz?.away_team_zh && selectedBzz?.away_team && selectedBzz.away_team !== selectedBzz.away_team_zh && (
                        <div className="text-[9px] text-muted-foreground">原文: {selectedBzz.away_team}</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 初盘概率设置 */}
            {selectedPoly && (
              <div>
                <div className="mb-2 text-[11px] font-medium">初盘概率设置</div>
                <div className="space-y-2.5">
                  <div>
                    <label className="mb-0.5 flex items-center justify-between text-[11px]">
                      <span>主胜概率</span>
                      <span className="font-semibold text-blue-600">{homeProb}%</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={homeProb}
                      onChange={(e) => setHomeProb(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 flex items-center justify-between text-[11px]">
                      <span>平局概率</span>
                      <span className="font-semibold text-yellow-600">{drawProb}%</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={drawProb}
                      onChange={(e) => setDrawProb(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 flex items-center justify-between text-[11px]">
                      <span>客胜概率</span>
                      <span className="font-semibold text-red-600">{awayProb}%</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={awayProb}
                      onChange={(e) => setAwayProb(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>

                <div className="mt-2 rounded-md bg-muted/30 p-2 text-[10px]">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-muted-foreground">原始总和: {total}%</span>
                    {total !== 100 && <span className="text-yellow-600">将自动归一化</span>}
                  </div>
                  <div className="flex h-2 overflow-hidden rounded">
                    <div className="bg-blue-500" style={{ width: `${normalized[0] * 100}%` }} />
                    <div className="bg-yellow-500" style={{ width: `${normalized[1] * 100}%` }} />
                    <div className="bg-red-500" style={{ width: `${normalized[2] * 100}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
                    <span>主胜 {(normalized[0] * 100).toFixed(1)}%</span>
                    <span>平 {(normalized[1] * 100).toFixed(1)}%</span>
                    <span>客胜 {(normalized[2] * 100).toFixed(1)}%</span>
                  </div>
                </div>
              </div>
            )}

            {error && <p className="text-[11px] text-red-500">{error}</p>}

            <div className="flex justify-end gap-2 border-t pt-3">
              <button onClick={onClose} className="rounded border px-3 py-1 text-[11px] hover:bg-muted">
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !selectedPoly || total === 0}
                className="rounded bg-primary px-3 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 投注记录 Tab =====

function RecordsTab({
  records,
  totalRecords,
  loading,
  filterRec,
  setFilterRec,
  page,
  setPage,
  pageSize,
  loadRecords,
}: {
  records: ValueBetRecord[]
  totalRecords: number
  loading: boolean
  filterRec: string
  setFilterRec: (v: string) => void
  page: number
  setPage: (v: number) => void
  pageSize: number
  loadRecords: () => void
}) {
  return (
    <>
      {/* Filter Bar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <select
          value={filterRec}
          onChange={(e) => {
            setFilterRec(e.target.value)
            setPage(0)
          }}
          className="rounded border bg-background px-2 py-1 text-[11px]"
        >
          <option value="">全部</option>
          <option value="BUY">买入信号</option>
          <option value="SELL">卖出信号</option>
        </select>
        <button
          onClick={loadRecords}
          className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          刷新
        </button>
        <span className="text-[10px] text-muted-foreground">共 {totalRecords} 条</span>
      </div>

      {/* Records Table */}
      <div className="flex-1 overflow-auto">
        {records.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Activity className="h-8 w-8 opacity-40" />
            <p className="text-xs">暂无价值投注记录</p>
            <p className="text-[10px]">启动机器人后，有性价比的订单会显示在这里</p>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">时间</th>
                <th className="px-2 py-1.5 font-medium">比赛</th>
                <th className="px-2 py-1.5 font-medium">盘口</th>
                <th className="px-2 py-1.5 font-medium">方向</th>
                <th className="px-2 py-1.5 text-right font-medium">模型概率</th>
                <th className="px-2 py-1.5 text-right font-medium">市场价</th>
                <th className="px-2 py-1.5 text-right font-medium">Edge</th>
                <th className="px-2 py-1.5 text-center font-medium">分钟</th>
                <th className="px-2 py-1.5 text-center font-medium">比分</th>
                <th className="px-2 py-1.5 text-center font-medium">建议</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-b hover:bg-muted/30">
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {new Date(r.created_at).toLocaleTimeString('zh-CN')}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="text-[10px] text-muted-foreground">{r.polymarket_event_id}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[9px]',
                        r.market_type === 'moneyline' ? 'bg-blue-500/10 text-blue-600' : 'bg-purple-500/10 text-purple-600',
                      )}
                    >
                      {r.market_type === 'moneyline' ? '胜平负' : '让球'}
                    </span>
                    {r.handicap !== null && (
                      <span className="ml-1 text-[10px] text-muted-foreground">{Number(r.handicap) > 0 ? `+${r.handicap}` : r.handicap}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-medium">{r.outcome}</td>
                  <td className="px-2 py-1.5 text-right">{(r.model_probability * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">{(r.market_price * 100).toFixed(1)}¢</td>
                  <td
                    className={cn(
                      'px-2 py-1.5 text-right font-semibold',
                      r.edge > 0 ? 'text-green-600' : 'text-red-600',
                    )}
                  >
                    {r.edge > 0 ? '+' : ''}
                    {(r.edge * 100).toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-center text-muted-foreground">{r.match_minute}'</td>
                  <td className="px-2 py-1.5 text-center font-medium">{r.current_score}</td>
                  <td className="px-2 py-1.5 text-center">
                    <span
                      className={cn(
                        'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold',
                        r.recommendation === 'BUY'
                          ? 'bg-green-500/10 text-green-600'
                          : r.recommendation === 'SELL'
                            ? 'bg-red-500/10 text-red-600'
                            : 'bg-gray-500/10 text-gray-500',
                      )}
                    >
                      {r.recommendation === 'BUY' && <TrendingUp className="h-2.5 w-2.5" />}
                      {r.recommendation === 'SELL' && <TrendingDown className="h-2.5 w-2.5" />}
                      {r.recommendation === 'BUY' ? '买入' : r.recommendation === 'SELL' ? '卖出' : '观望'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalRecords > pageSize && (
        <div className="flex items-center justify-between border-t px-4 py-2 text-[10px]">
          <span className="text-muted-foreground">
            第 {page * pageSize + 1}-{Math.min((page + 1) * pageSize, totalRecords)} 条 / 共 {totalRecords} 条
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="rounded border px-2 py-0.5 disabled:opacity-50"
            >
              上一页
            </button>
            <button
              onClick={() => setPage(page + 1)}
              disabled={(page + 1) * pageSize >= totalRecords}
              className="rounded border px-2 py-0.5 disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function SettingsPanel({
  config,
  onSave,
}: {
  config: ValueBotStatus['config']
  onSave: (config: Record<string, unknown>) => void
}) {
  const [pollInterval, setPollInterval] = useState(config.pollIntervalMs / 1000)
  const [edgeThreshold, setEdgeThreshold] = useState(config.edgeThreshold * 100)
  const [decayExponent, setDecayExponent] = useState(config.timeDecayExponent)
  const [maxGoals, setMaxGoals] = useState(config.maxGoals)

  return (
    <div className="border-b bg-muted/20 px-4 py-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-[10px] text-muted-foreground">轮询间隔 (秒)</label>
          <input
            type="number"
            value={pollInterval}
            onChange={(e) => setPollInterval(Number(e.target.value))}
            min={5}
            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] text-muted-foreground">Edge阈值 (%)</label>
          <input
            type="number"
            value={edgeThreshold}
            onChange={(e) => setEdgeThreshold(Number(e.target.value))}
            min={0}
            step={0.5}
            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] text-muted-foreground">时间衰减指数</label>
          <input
            type="number"
            value={decayExponent}
            onChange={(e) => setDecayExponent(Number(e.target.value))}
            min={0.1}
            max={2}
            step={0.01}
            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] text-muted-foreground">最大进球数</label>
          <input
            type="number"
            value={maxGoals}
            onChange={(e) => setMaxGoals(Number(e.target.value))}
            min={5}
            max={15}
            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
          />
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={() =>
            onSave({
              pollIntervalMs: pollInterval * 1000,
              edgeThreshold: edgeThreshold / 100,
              timeDecayExponent: decayExponent,
              maxGoals,
            })
          }
          className="rounded-md bg-primary px-3 py-1 text-[11px] text-primary-foreground"
        >
          保存配置
        </button>
      </div>
    </div>
  )
}

// ===== 日志查看弹窗 =====

function LogViewerDialog({
  eventId,
  matchName,
  onClose,
}: {
  eventId: string
  matchName: string
  onClose: () => void
}) {
  const [logs, setLogs] = useState<CalcLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { logs: l, total: t } = await fetchCalcLogs(eventId, {
        limit: 50,
      })
      setLogs(l)
      setTotal(t)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [load])

  // 按 calc_time 分组日志
  const grouped = new Map<string, CalcLog[]>()
  for (const log of logs) {
    const key = log.calc_time
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(log)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[900px] max-w-[95vw] flex-col rounded-lg bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div>
            <h3 className="text-xs font-semibold">{matchName} - 计算日志</h3>
            <p className="text-[10px] text-muted-foreground">共 {total} 条记录，每5秒刷新</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={load}
              className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              刷新
            </button>
            <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {loading && logs.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-muted-foreground">加载中...</div>
          ) : logs.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-muted-foreground">暂无日志，启动监控后自动生成</div>
          ) : (
            <div className="space-y-3">
              {Array.from(grouped.entries()).map(([time, entries]) => {
                const first = entries[0]
                return (
                  <div key={time} className="rounded-md border bg-card">
                    <div className="flex items-center gap-3 border-b px-3 py-1.5 text-[10px]">
                      <span className="font-medium text-foreground">
                        {new Date(time.replace(' ', 'T') + 'Z').toLocaleString('zh-CN')}
                      </span>
                      <span className="text-muted-foreground">
                        比分: <span className="font-mono font-medium text-foreground">{first.home_score}-{first.away_score}</span>
                      </span>
                      <span className="text-muted-foreground">{first.match_minute}'</span>
                      <span className="text-[9px] text-muted-foreground">
                        {entries[0].market_type === 'moneyline' ? '胜平负' : '让球盘'}
                      </span>
                    </div>
                    <div className="divide-y">
                      {entries.map((log) => (
                        <div key={log.id} className="flex items-center gap-3 px-3 py-1.5 text-[10px]">
                          <span className="w-20 truncate font-medium" title={log.outcome}>{log.outcome}</span>
                          {log.handicap !== null && (
                            <span className="text-muted-foreground">让{log.handicap > 0 ? '+' : ''}{log.handicap}</span>
                          )}
                          <span className="text-blue-600">
                            模型: {(Number(log.model_probability) * 100).toFixed(1)}%
                          </span>
                          <span className="text-green-600">
                            买: {log.best_bid !== null ? `${(Number(log.best_bid) * 100).toFixed(1)}%×${Number(log.best_bid_size).toFixed(0)}` : '—'}
                          </span>
                          <span className="text-red-600">
                            卖: {log.best_ask !== null ? `${(Number(log.best_ask) * 100).toFixed(1)}%×${Number(log.best_ask_size).toFixed(0)}` : '—'}
                          </span>
                          <span className={cn(
                            'font-medium',
                            Number(log.edge) > 0 ? 'text-green-600' : Number(log.edge) < 0 ? 'text-red-600' : 'text-muted-foreground',
                          )}>
                            Edge: {Number(log.edge) > 0 ? '+' : ''}{(Number(log.edge) * 100).toFixed(1)}%
                          </span>
                          <span className={cn(
                            'rounded px-1 py-0.5 text-[9px]',
                            log.recommendation === 'BUY' ? 'bg-green-500/10 text-green-600' :
                            log.recommendation === 'SELL' ? 'bg-red-500/10 text-red-600' :
                            'bg-muted text-muted-foreground',
                          )}>
                            {log.recommendation}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ===== 盘口规则 Tab =====

function RulesTab({
  status,
  onConfigChange,
}: {
  status: ValueBotStatus | null
  onConfigChange: () => void
}) {
  const [rules, setRules] = useState<RuleMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [edgeThreshold, setEdgeThreshold] = useState(3)
  const [decayExponent, setDecayExponent] = useState(0.84)
  const [maxGoals, setMaxGoals] = useState(10)
  const [totalMinutes, setTotalMinutes] = useState(90)
  const [pollInterval, setPollInterval] = useState(30)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchRuleMetas()
      .then(setRules)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (status?.config) {
      setEdgeThreshold(Math.round(status.config.edgeThreshold * 100))
      setDecayExponent(status.config.timeDecayExponent)
      setMaxGoals(status.config.maxGoals)
      setTotalMinutes(status.config.totalMatchMinutes)
      setPollInterval(Math.round(status.config.pollIntervalMs / 1000))
    }
  }, [status])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateValueBotConfig({
        edgeThreshold: edgeThreshold / 100,
        timeDecayExponent: decayExponent,
        maxGoals,
        totalMatchMinutes: totalMinutes,
        pollIntervalMs: pollInterval * 1000,
      })
      onConfigChange()
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-xs text-muted-foreground">加载中...</div>
  }

  return (
    <div className="space-y-4 p-4">
      {/* 已注册盘口类型 */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-foreground">已注册盘口类型</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rules.map((rule) => (
            <div key={rule.marketType} className="rounded-lg border bg-card p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                  {rule.marketType}
                </span>
                <span className="text-sm font-semibold">{rule.marketTypeName}</span>
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
                {rule.description}
              </p>
              <div className="rounded bg-muted p-2">
                <pre className="whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">
                  {rule.formula}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 概率模型参数 */}
      <div className="rounded-lg border bg-card p-3">
        <h3 className="mb-3 text-xs font-semibold text-foreground">概率模型参数</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">
              Edge 阈值 (触发记录的最小性价比): {edgeThreshold}%
            </label>
            <input
              type="range"
              min={1}
              max={20}
              value={edgeThreshold}
              onChange={(e) => setEdgeThreshold(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">
              时间衰减指数: {decayExponent.toFixed(2)}
            </label>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={decayExponent}
              onChange={(e) => setDecayExponent(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">Poisson 最大进球数</label>
            <input
              type="number"
              min={5}
              max={20}
              value={maxGoals}
              onChange={(e) => setMaxGoals(Number(e.target.value))}
              className="w-full rounded border bg-background px-2 py-1 text-[11px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">比赛总时长 (分钟)</label>
            <input
              type="number"
              min={60}
              max={120}
              value={totalMinutes}
              onChange={(e) => setTotalMinutes(Number(e.target.value))}
              className="w-full rounded border bg-background px-2 py-1 text-[11px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">轮询间隔 (秒)</label>
            <input
              type="number"
              min={5}
              max={300}
              value={pollInterval}
              onChange={(e) => setPollInterval(Number(e.target.value))}
              className="w-full rounded border bg-background px-2 py-1 text-[11px]"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1 text-[11px] text-primary-foreground"
          >
            {saving ? '保存中...' : '保存参数'}
          </button>
        </div>
      </div>

      {/* 算法说明 */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <h3 className="mb-2 text-xs font-semibold text-foreground">算法流程说明</h3>
        <ol className="space-y-1 text-[10px] leading-relaxed text-muted-foreground">
          <li>1. 从初盘赔率推导主客队期望进球数 λ (泊松分布参数)</li>
          <li>2. 实时计算剩余 λ: λ_remaining = λ_full × (1 - t/T)^α</li>
          <li>3. 用 Skellam 分布计算当前比分差下的胜/平/负概率</li>
          <li>4. 让球盘在胜平负基础上加入让球线，计算让球后比分差的概率</li>
          <li>5. 对比模型概率与 Polymarket 市场隐含概率，计算 Edge</li>
          <li>6. Edge &gt; 阈值时记录为 BUY 信号，Edge &lt; -阈值时记录为 SELL 信号</li>
        </ol>
      </div>
    </div>
  )
}

// ===== 日志分析 Tab =====

function LogsAnalysisTab() {
  const [matches, setMatches] = useState<MatchState[]>([])
  const [selectedEvent, setSelectedEvent] = useState<string>('')
  const [analysis, setAnalysis] = useState<LogAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedMarket, setExpandedMarket] = useState<string | null>(null)

  useEffect(() => {
    fetchMatchStates().then((ms) => {
      setMatches(ms)
      if (ms.length && !selectedEvent) {
        setSelectedEvent(ms[0].event_id)
      }
    })
  }, [])

  useEffect(() => {
    if (!selectedEvent) return
    setLoading(true)
    fetchCalcLogsAnalysis(selectedEvent)
      .then(setAnalysis)
      .catch(() => setAnalysis(null))
      .finally(() => setLoading(false))
  }, [selectedEvent])

  const matchInfo = analysis?.matchInfo
  const markets = analysis?.markets || []
  const marketTypeNames: Record<string, string> = { moneyline: '胜平负', spread: '让球盘' }
  const groupedByType = markets.reduce<Record<string, typeof markets>>((acc, m) => {
    const t = m.marketType
    if (!acc[t]) acc[t] = []
    acc[t].push(m)
    return acc
  }, {})

  return (
    <div className="flex h-full flex-col overflow-auto">
      {/* 比赛选择栏 */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <select
          value={selectedEvent}
          onChange={(e) => setSelectedEvent(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          {matches.map((m) => (
            <option key={m.event_id} value={m.event_id}>
              {m.home_team || m.event_id} vs {m.away_team || ''}
            </option>
          ))}
        </select>
        {matchInfo && (
          <span className="text-[10px] text-muted-foreground">
            {matchInfo.homeTeam} vs {matchInfo.awayTeam} · 当前比分 {matchInfo.homeScore}-{matchInfo.awayScore} ({matchInfo.minute}')
          </span>
        )}
        <button
          onClick={() => {
            if (!selectedEvent) return
            setLoading(true)
            fetchCalcLogsAnalysis(selectedEvent)
              .then(setAnalysis)
              .catch(() => setAnalysis(null))
              .finally(() => setLoading(false))
          }}
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
        >
          <RefreshCw className="h-3 w-3" />
          刷新
        </button>
        {loading && <span className="text-[10px] text-muted-foreground">加载中...</span>}
      </div>

      {/* 日志内容 */}
      {!loading && markets.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          暂无日志数据
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-4">
        {Object.entries(groupedByType).map(([type, typeMarkets]) => (
          <div key={type}>
            {/* 盘口类型标题 */}
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-semibold">{marketTypeNames[type] || type}</h3>
              <span className="text-[10px] text-muted-foreground">{typeMarkets.length} 个盘口</span>
            </div>

            {/* 盘口列表 */}
            <div className="space-y-2">
              {typeMarkets.map((market) => {
                const isExpanded = expandedMarket === market.marketId
                const allOutcomes = market.outcomes
                const allTimeline = allOutcomes.flatMap((o) => o.timeline)
                const timeLabels = [...new Set(allTimeline.map((t) => `${t.matchMinute}'`))].sort((a, b) => parseInt(a) - parseInt(b))

                return (
                  <div key={market.marketId} className="rounded-lg border">
                    {/* 盘口标题行 */}
                    <button
                      onClick={() => setExpandedMarket(isExpanded ? null : market.marketId)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium">
                          {market.question || `${marketTypeNames[type] || type}`}
                        </span>
                        {market.handicap != null && (
                          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-600">
                            让球 {market.handicap}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-muted-foreground">
                          {timeLabels.length} 个时间点 · {allOutcomes.length} 个选项
                        </span>
                        <span className="text-[10px] text-muted-foreground">{isExpanded ? '▾' : '▸'}</span>
                      </div>
                    </button>

                    {/* 展开内容 */}
                    {isExpanded && (
                      <div className="border-t px-3 py-2 space-y-3">
                        {/* 概率变化图表 */}
                        <MiniChart
                          title="模型概率 vs 市场价"
                          outcomes={allOutcomes}
                          metric="probability"
                        />
                        <MiniChart
                          title="Edge 变化"
                          outcomes={allOutcomes}
                          metric="edge"
                        />

                        {/* 详细表格 */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-[10px]">
                            <thead>
                              <tr className="border-b text-muted-foreground">
                                <th className="px-1.5 py-1 text-left">时间</th>
                                <th className="px-1.5 py-1 text-center">比分</th>
                                {allOutcomes.map((o) => (
                                  <th key={o.outcome} className="px-1.5 py-1 text-center" colSpan={3}>
                                    {o.outcome}
                                  </th>
                                ))}
                              </tr>
                              <tr className="border-b text-[9px] text-muted-foreground">
                                <th className="px-1.5 py-0.5"></th>
                                <th className="px-1.5 py-0.5"></th>
                                {allOutcomes.map((o) => (
                                  <Fragment key={o.outcome}>
                                    <th className="px-1 py-0.5 font-normal text-blue-500">P</th>
                                    <th className="px-1 py-0.5 font-normal text-green-600">Bid</th>
                                    <th className="px-1 py-0.5 font-normal text-red-500">Edge</th>
                                  </Fragment>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {timeLabels.map((timeLabel) => {
                                const minute = parseInt(timeLabel)
                                return (
                                  <tr key={timeLabel} className="border-b border-dashed hover:bg-muted/30">
                                    <td className="px-1.5 py-1 text-muted-foreground">{timeLabel}</td>
                                    <td className="px-1.5 py-1 text-center text-muted-foreground">
                                      {allTimeline.find((t) => t.matchMinute === minute)
                                        ? `${allTimeline.find((t) => t.matchMinute === minute)?.homeScore}-${allTimeline.find((t) => t.matchMinute === minute)?.awayScore}`
                                        : '-'}
                                    </td>
                                    {allOutcomes.map((o) => {
                                      const entry = o.timeline.find((t) => t.matchMinute === minute)
                                      return (
                                        <Fragment key={o.outcome}>
                                          <td className={cn('px-1 py-1 text-center', entry ? '' : 'text-muted-foreground')}>
                                            {entry ? (entry.modelProbability * 100).toFixed(1) + '%' : '-'}
                                          </td>
                                          <td className="px-1 py-1 text-center text-green-600">
                                            {entry?.bestBid != null ? (entry.bestBid * 100).toFixed(1) + '%' : '-'}
                                          </td>
                                          <td className={cn(
                                            'px-1 py-1 text-center font-medium',
                                            entry ? (entry.edge > 0.03 ? 'text-green-600' : entry.edge < -0.03 ? 'text-red-500' : 'text-muted-foreground') : '',
                                          )}>
                                            {entry ? (entry.edge > 0 ? '+' : '') + (entry.edge * 100).toFixed(1) + '%' : '-'}
                                          </td>
                                        </Fragment>
                                      )
                                    })}
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* 推荐信号汇总 */}
                        <div className="flex flex-wrap gap-1.5">
                          {allOutcomes.map((o) => {
                            const recs = o.timeline.map((t) => t.recommendation)
                            const buyCount = recs.filter((r) => r === 'BUY').length
                            const sellCount = recs.filter((r) => r === 'SELL').length
                            return (
                              <div key={o.outcome} className="rounded border px-2 py-0.5 text-[9px]">
                                <span className="text-muted-foreground">{o.outcome}: </span>
                                {buyCount > 0 && <span className="text-green-600">BUY×{buyCount} </span>}
                                {sellCount > 0 && <span className="text-red-500">SELL×{sellCount} </span>}
                                {buyCount === 0 && sellCount === 0 && <span className="text-muted-foreground">全PASS</span>}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// 内联迷你折线图
function MiniChart({
  title,
  outcomes,
  metric,
}: {
  title: string
  outcomes: { outcome: string; timeline: LogTimelineEntry[] }[]
  metric: 'probability' | 'edge'
}) {
  const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']
  const width = 600
  const height = 120
  const pad = { l: 30, r: 10, t: 18, b: 20 }

  const allTimes: number[] = []
  const valueMap: Record<string, { time: number; value: number }[]> = {}
  for (const o of outcomes) {
    valueMap[o.outcome] = o.timeline.map((t) => {
      if (!allTimes.includes(t.matchMinute)) allTimes.push(t.matchMinute)
      return {
        time: t.matchMinute,
        value: metric === 'probability' ? t.modelProbability : t.edge,
      }
    })
  }
  allTimes.sort((a, b) => a - b)
  if (allTimes.length < 2) return null

  const xMin = allTimes[0]
  const xMax = allTimes[allTimes.length - 1]
  const xRange = xMax - xMin || 1
  let yMin: number, yMax: number
  if (metric === 'probability') {
    yMin = 0
    yMax = 1
  } else {
    const allVals = Object.values(valueMap).flat().map((v) => v.value)
    yMin = Math.min(...allVals, -0.05)
    yMax = Math.max(...allVals, 0.05)
    if (yMax - yMin < 0.1) {
      const mid = (yMax + yMin) / 2
      yMin = mid - 0.05
      yMax = mid + 0.05
    }
  }
  const yRange = yMax - yMin || 1

  const xScale = (x: number) => pad.l + ((x - xMin) / xRange) * (width - pad.l - pad.r)
  const yScale = (y: number) => pad.t + (1 - (y - yMin) / yRange) * (height - pad.t - pad.b)

  const yTicks = metric === 'probability'
    ? [0, 0.25, 0.5, 0.75, 1]
    : [yMin, yMin + yRange / 2, yMax]

  return (
    <div>
      <div className="mb-1 text-[10px] font-medium text-muted-foreground">{title}</div>
      <svg width={width} height={height} className="border rounded bg-muted/20">
        {/* Y 轴刻度 */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={pad.l} y1={yScale(tick)} x2={width - pad.r} y2={yScale(tick)}
              stroke="currentColor" strokeOpacity={0.1} strokeDasharray="2 2"
            />
            <text x={2} y={yScale(tick) + 3} className="fill-muted-foreground" fontSize={8}>
              {metric === 'probability' ? (tick * 100).toFixed(0) + '%' : (tick * 100).toFixed(1) + '%'}
            </text>
          </g>
        ))}
        {/* 0 线 for edge */}
        {metric === 'edge' && yMin < 0 && yMax > 0 && (
          <line
            x1={pad.l} y1={yScale(0)} x2={width - pad.r} y2={yScale(0)}
            stroke="currentColor" strokeOpacity={0.3}
          />
        )}
        {/* 折线 */}
        {outcomes.map((o, i) => {
          const data = valueMap[o.outcome]
          if (data.length < 1) return null
          const color = colors[i % colors.length]
          const path = data.map((d, j) => `${j === 0 ? 'M' : 'L'} ${xScale(d.time).toFixed(1)} ${yScale(d.value).toFixed(1)}`).join(' ')
          return (
            <g key={o.outcome}>
              <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
              {data.map((d, j) => (
                <circle key={j} cx={xScale(d.time)} cy={yScale(d.value)} r={2} fill={color} />
              ))}
            </g>
          )
        })}
        {/* X 轴 */}
        {allTimes.map((t) => (
          <text key={t} x={xScale(t)} y={height - 5} className="fill-muted-foreground" fontSize={8} textAnchor="middle">
            {t}'
          </text>
        ))}
        {/* 图例 */}
        {outcomes.map((o, i) => (
          <g key={o.outcome}>
            <rect x={pad.l + 80 + i * 80} y={3} width={8} height={8} fill={colors[i % colors.length]} rx={1} />
            <text x={pad.l + 92 + i * 80} y={10} className="fill-foreground" fontSize={8}>
              {o.outcome.length > 10 ? o.outcome.slice(0, 10) + '...' : o.outcome}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
