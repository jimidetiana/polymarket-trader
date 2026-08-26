import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Activity, Clock, Target, Users, AlertCircle, ChevronRight, Play, Pause, Settings, Calendar } from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn } from '@/lib/utils'
import {
  fetchSportsLiveEvents,
  fetchSportsEvents,
  fetchSportsEventStats,
  fetchSportsEventIncidents,
  fetchSportsEventLineups,
  fetchSportsTranslations,
  fetchSportsLeagues,
} from '@/lib/api'
import type { SportsLiveEvent, SportsStats, SportsIncident, SportsLineups } from '@/types'

// 常见球队后缀，用于模糊匹配
const TEAM_SUFFIXES = [
  ' FC', ' CF', ' SC', ' CD', ' SD', ' SK', ' FK', ' KF', ' AFC',
  'FC ', 'CF ', 'SC ', 'CD ', 'SD ', 'SK ', 'FK ', 'KF ', 'AFC ',
  ' B', ' II', ' 1904', ' 1905', ' 1907', ' 1909', ' 1912', ' 1913',
  ' 1915', ' 1920', ' 1921', ' 1924', ' 1925', ' 1928', ' 1930',
  ' 1948', ' 1960', ' 1964', ' 1966', ' 1995', ' 1998', ' 2000',
  ' 05', ' 07', ' 08', ' 09', ' 10', ' 11', ' 12', ' 13', ' 14', ' 15', ' 16',
  ' Club', ' Football Club',
]

/**
 * 规范化球队名称，去除常见后缀用于模糊匹配
 */
function normalizeTeamName(name: string): string {
  let normalized = name.trim()
  for (const suffix of TEAM_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim()
    }
    if (normalized.startsWith(suffix)) {
      normalized = normalized.slice(suffix.length).trim()
    }
  }
  return normalized.toLowerCase()
}

function getTeamName(team: any, teamMap?: Record<string, string>): string {
  if (!team) return '-'
  let nameEn = ''
  if (typeof team === 'string') {
    nameEn = team
  } else if (typeof team === 'object') {
    nameEn = team.name || team.short_name || ''
  }
  if (!nameEn) return '-'
  if (!teamMap) return nameEn

  // 1. 精确匹配
  if (teamMap[nameEn]) return teamMap[nameEn]

  // 2. 大小写不敏感的精确匹配
  const lowerName = nameEn.toLowerCase()
  const exactCaseInsensitive = Object.entries(teamMap).find(
    ([k]) => k.toLowerCase() === lowerName,
  )
  if (exactCaseInsensitive) return exactCaseInsensitive[1]

  // 3. 模糊匹配（去除常见后缀）
  const normalized = normalizeTeamName(nameEn)
  for (const [key, value] of Object.entries(teamMap)) {
    if (normalizeTeamName(key) === normalized) {
      return value
    }
  }

  return nameEn
}

function getLeagueName(league: any, leagueMap?: Record<string, string>): string {
  if (!league) return '足球'
  let nameEn = ''
  if (typeof league === 'string') {
    nameEn = league
  } else if (typeof league === 'object') {
    nameEn = league.name || ''
  }
  if (!nameEn) return '足球'
  if (leagueMap && leagueMap[nameEn]) return leagueMap[nameEn]

  // 大小写不敏感匹配
  const lowerName = nameEn.toLowerCase()
  const match = Object.entries(leagueMap || {}).find(
    ([k]) => k.toLowerCase() === lowerName,
  )
  if (match) return match[1]

  return nameEn
}

/**
 * 通过联赛ID获取联赛名（带翻译）
 */
function getLeagueNameById(
  leagueId: number | string | undefined | null,
  leagueIdMap: Record<number, string>,
  leagueMap?: Record<string, string>,
): string {
  if (!leagueId) return '足球'
  const id = typeof leagueId === 'string' ? parseInt(leagueId, 10) : leagueId
  const nameEn = leagueIdMap[id]
  if (!nameEn) return '足球'
  return getLeagueName(nameEn, leagueMap)
}

function getEventStartTime(event: any): string {
  return event.start_time || event.event_date || ''
}

const REFRESH_OPTIONS = [
  { value: 5, label: '5秒' },
  { value: 10, label: '10秒' },
  { value: 30, label: '30秒' },
  { value: 60, label: '1分钟' },
  { value: 0, label: '手动' },
]

type ListTab = 'live' | 'upcoming'

export default function LiveMonitorPage() {
  const [liveEvents, setLiveEvents] = useState<SportsLiveEvent[]>([])
  const [upcomingEvents, setUpcomingEvents] = useState<SportsLiveEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [upcomingLoading, setUpcomingLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string>('--')
  const [refreshInterval, setRefreshInterval] = useState(10)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [selectedEvent, setSelectedEvent] = useState<SportsLiveEvent | null>(null)
  const [eventStats, setEventStats] = useState<SportsStats | null>(null)
  const [eventIncidents, setEventIncidents] = useState<SportsIncident[]>([])
  const [eventLineups, setEventLineups] = useState<SportsLineups | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'stats' | 'incidents' | 'lineups'>('incidents')
  const [showSettings, setShowSettings] = useState(false)
  const [listTab, setListTab] = useState<ListTab>('live')
  const [teamTranslations, setTeamTranslations] = useState<Record<string, string>>({})
  const [leagueTranslations, setLeagueTranslations] = useState<Record<string, string>>({})
  const [leagueIdMap, setLeagueIdMap] = useState<Record<number, string>>({})

  const events = listTab === 'live' ? liveEvents : upcomingEvents

  // 按时间排序：进行中的比赛按开始时间正序，即将开始的比赛按开赛时间正序
  const sortedEvents = [...events].sort((a, b) => {
    const timeA = new Date(getEventStartTime(a)).getTime()
    const timeB = new Date(getEventStartTime(b)).getTime()
    return timeA - timeB
  })

  const loadLiveEvents = useCallback(async () => {
    if (listTab !== 'live') setLoading(true)
    setError(null)
    try {
      const data = await fetchSportsLiveEvents()
      setLiveEvents(data)
      setLastUpdated(new Date().toLocaleTimeString('zh-CN'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [listTab])

  const loadUpcomingEvents = useCallback(async () => {
    setUpcomingLoading(true)
    try {
      const today = new Date()
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
      const dateFrom = today.toISOString().split('T')[0]
      const dateTo = tomorrow.toISOString().split('T')[0]
      const { events } = await fetchSportsEvents({
        status: 'notstarted',
        limit: 50,
        date_from: dateFrom,
        date_to: dateTo,
      })
      setUpcomingEvents(events)
    } catch {
      // ignore
    } finally {
      setUpcomingLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadLiveEvents()
    loadUpcomingEvents()
    loadTranslations()
  }, [loadLiveEvents, loadUpcomingEvents])

  async function loadTranslations() {
    try {
      const [{ teams, leagues }, leagueList] = await Promise.all([
        fetchSportsTranslations(),
        fetchSportsLeagues().catch(() => []),
      ])
      setTeamTranslations(teams)
      setLeagueTranslations(leagues)
      // Build league ID -> name map
      const idMap: Record<number, string> = {}
      for (const l of leagueList) {
        idMap[l.id] = l.name
      }
      setLeagueIdMap(idMap)
    } catch {
      // ignore
    }
  }

  const hasLiveMatches = liveEvents.length > 0

  // 没有比赛时自动降频（最少60秒检查一次），避免无意义请求
  const effectiveInterval = !hasLiveMatches && refreshInterval > 0 && refreshInterval < 60
    ? 60
    : refreshInterval

  // Auto refresh live events
  useEffect(() => {
    if (!autoRefresh || effectiveInterval <= 0) return
    const timer = setInterval(loadLiveEvents, effectiveInterval * 1000)
    return () => clearInterval(timer)
  }, [autoRefresh, effectiveInterval, loadLiveEvents])

  // Auto refresh upcoming events every 5 minutes
  useEffect(() => {
    const timer = setInterval(loadUpcomingEvents, 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [loadUpcomingEvents])

  // Also refresh selected event details on interval (only for live matches)
  useEffect(() => {
    if (!selectedEvent || !autoRefresh || effectiveInterval <= 0) return
    if (selectedEvent.status !== 'inprogress') return
    const timer = setInterval(() => {
      loadEventDetails(selectedEvent.id)
    }, effectiveInterval * 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvent?.id, autoRefresh, effectiveInterval])

  async function loadEventDetails(eventId: number) {
    setDetailLoading(true)
    try {
      const [stats, incidents, lineups] = await Promise.all([
        fetchSportsEventStats(eventId).catch(() => ({})),
        fetchSportsEventIncidents(eventId).catch(() => []),
        fetchSportsEventLineups(eventId).catch(() => ({})),
      ])
      setEventStats(stats)
      setEventIncidents(incidents)
      setEventLineups(lineups)
    } finally {
      setDetailLoading(false)
    }
  }

  async function handleSelectEvent(event: SportsLiveEvent) {
    setSelectedEvent(event)
    setActiveTab('incidents')
    await loadEventDetails(event.id)
  }

  return (
    <Layout
      title="足球赛事监听"
      subtitle="实时监控正在进行的足球比赛"
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
              autoRefresh
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-border bg-card text-foreground hover:bg-muted',
            )}
            title={autoRefresh ? '暂停自动刷新' : '开启自动刷新'}
          >
            {autoRefresh ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {autoRefresh ? '自动' : '暂停'}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Settings className="h-3.5 w-3.5" />
            间隔
          </button>
          <button
            type="button"
            disabled={listTab === 'live' ? loading : upcomingLoading}
            onClick={() => {
              if (listTab === 'live') {
                loadLiveEvents()
              } else {
                loadUpcomingEvents()
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 active:opacity-80 disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (listTab === 'live' ? loading : upcomingLoading) && 'animate-spin')} />
            刷新
          </button>
        </div>
      }
    >
      {showSettings && (
        <div className="mb-4 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">刷新间隔：</span>
            <div className="flex gap-1.5">
              {REFRESH_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setRefreshInterval(opt.value)
                    if (opt.value > 0) setAutoRefresh(true)
                    setShowSettings(false)
                  }}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
                    refreshInterval === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-foreground hover:bg-muted',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex h-[calc(100vh-10rem)] gap-4 overflow-hidden">
        {/* 左侧：比赛列表 */}
        <aside className="flex w-96 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-3">
            {/* Tab 切换 */}
            <div className="mb-3 flex gap-1 rounded-md bg-muted p-0.5">
              <button
                type="button"
                onClick={() => setListTab('live')}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] font-medium transition-colors',
                  listTab === 'live'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Activity className="h-3.5 w-3.5" />
                进行中
                <span className="rounded-full bg-success/20 px-1.5 py-0.5 text-[9px] font-bold text-success">
                  {liveEvents.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setListTab('upcoming')}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] font-medium transition-colors',
                  listTab === 'upcoming'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Calendar className="h-3.5 w-3.5" />
                即将开始
                <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[9px] font-bold text-warning">
                  {upcomingEvents.length}
                </span>
              </button>
            </div>

            {listTab === 'live' && (
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  状态：
                  <span className={cn(error ? 'text-error' : 'text-foreground')}>
                    {error ? '连接错误' : loading ? '刷新中...' : '已连接'}
                  </span>
                </span>
                <span>更新：{lastUpdated}</span>
                {!hasLiveMatches && autoRefresh && refreshInterval > 0 && refreshInterval < 60 && (
                  <span className="text-warning">(自动降频至1分钟)</span>
                )}
              </div>
            )}
            {listTab === 'upcoming' && (
              <div className="text-[10px] text-muted-foreground">
                今日未来24小时内的比赛 · 每5分钟刷新
              </div>
            )}
            {error && listTab === 'live' && (
              <div className="mt-2 flex items-center gap-1.5 rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[10px] text-error">
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span className="truncate">{error}</span>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {listTab === 'live' ? (
              !liveEvents.length ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Activity className="h-8 w-8 opacity-40" />
                  <p className="text-xs">暂无正在进行的比赛</p>
                  <p className="text-[10px]">比赛开始后会自动显示</p>
                  <p className="text-[10px]">每分钟检查一次新比赛</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sortedEvents.map((evt) => (
                    <LiveMatchCard
                      key={evt.id}
                      event={evt}
                      active={selectedEvent?.id === evt.id}
                      onClick={() => handleSelectEvent(evt)}
                      teamTranslations={teamTranslations}
                      leagueTranslations={leagueTranslations}
                      leagueIdMap={leagueIdMap}
                    />
                  ))}
                </div>
              )
            ) : upcomingLoading ? (
              <div className="py-12 text-center text-xs text-muted-foreground">加载中...</div>
            ) : !upcomingEvents.length ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Calendar className="h-8 w-8 opacity-40" />
                <p className="text-xs">暂无即将开始的比赛</p>
                <p className="text-[10px]">今日暂无安排</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sortedEvents.map((evt) => (
                  <LiveMatchCard
                    key={evt.id}
                    event={evt}
                    active={selectedEvent?.id === evt.id}
                    onClick={() => handleSelectEvent(evt)}
                    teamTranslations={teamTranslations}
                    leagueTranslations={leagueTranslations}
                    leagueIdMap={leagueIdMap}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* 右侧：比赛详情 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {!selectedEvent ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Activity className="h-8 w-8 opacity-40" />
              <p className="text-sm">从左侧选择一场比赛查看详情</p>
            </div>
          ) : (
            <>
              {/* 比赛头部 */}
              <header className="border-b border-border px-5 py-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    {getLeagueNameById(selectedEvent.league_id as number | undefined, leagueIdMap, leagueTranslations)}
                  </div>
                  <MatchStatusBadge status={selectedEvent.status} minute={selectedEvent.minute || selectedEvent.current_minute} period={selectedEvent.period} />
                </div>
                <div className="mt-3 grid grid-cols-3 items-center gap-4">
                  {/* 主队 */}
                  <div className="text-right">
                    <p className="text-base font-semibold text-foreground">
                      {getTeamName(selectedEvent.home_team, teamTranslations)}
                    </p>
                    {selectedEvent.home_team?.short_name && (
                      <p className="text-[10px] text-muted-foreground">{selectedEvent.home_team.short_name}</p>
                    )}
                  </div>
                  {/* 比分 */}
                  <div className="text-center">
                    <div className="font-mono text-3xl font-bold text-foreground">
                      {selectedEvent.home_score ?? '-'}
                      <span className="mx-2 text-muted-foreground">:</span>
                      {selectedEvent.away_score ?? '-'}
                    </div>
                    {(selectedEvent.home_score_ht !== undefined || selectedEvent.away_score_ht !== undefined) && (
                      <p className="text-[10px] text-muted-foreground">
                        半场 {selectedEvent.home_score_ht ?? 0} : {selectedEvent.away_score_ht ?? 0}
                      </p>
                    )}
                  </div>
                  {/* 客队 */}
                  <div className="text-left">
                    <p className="text-base font-semibold text-foreground">
                      {getTeamName(selectedEvent.away_team, teamTranslations)}
                    </p>
                    {selectedEvent.away_team?.short_name && (
                      <p className="text-[10px] text-muted-foreground">{selectedEvent.away_team.short_name}</p>
                    )}
                  </div>
                </div>
              </header>

              {/* Tab 切换 */}
              <div className="flex border-b border-border px-4">
                {[
                  { key: 'incidents', label: '比赛事件', icon: Target },
                  { key: 'stats', label: '数据统计', icon: Activity },
                  { key: 'lineups', label: '阵容', icon: Users },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key as typeof activeTab)}
                    className={cn(
                      'inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors',
                      activeTab === tab.key
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <tab.icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* 内容区 */}
              <div className="flex-1 overflow-y-auto p-4">
                {detailLoading && events.length > 0 ? (
                  <div className="py-12 text-center text-xs text-muted-foreground">加载中...</div>
                ) : activeTab === 'incidents' ? (
                  <IncidentsPanel incidents={eventIncidents} />
                ) : activeTab === 'stats' ? (
                  <StatsPanel stats={eventStats} homeTeam={getTeamName(selectedEvent.home_team, teamTranslations)} awayTeam={getTeamName(selectedEvent.away_team, teamTranslations)} />
                ) : (
                  <LineupsPanel lineups={eventLineups} homeTeam={getTeamName(selectedEvent.home_team, teamTranslations)} awayTeam={getTeamName(selectedEvent.away_team, teamTranslations)} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </Layout>
  )
}

// ---- 子组件 ----

function LiveMatchCard({
  event,
  active,
  onClick,
  teamTranslations,
  leagueTranslations,
  leagueIdMap,
}: {
  event: SportsLiveEvent
  active: boolean
  onClick: () => void
  teamTranslations: Record<string, string>
  leagueTranslations: Record<string, string>
  leagueIdMap: Record<number, string>
}) {
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
        'cursor-pointer overflow-hidden rounded-lg border bg-card transition-colors',
        active
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-primary/40',
      )}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {getLeagueNameById(event.league_id as number | undefined, leagueIdMap, leagueTranslations)}
          </span>
          <MatchStatusBadge status={event.status} minute={event.minute || event.current_minute} period={event.period} />
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="min-w-0 text-right">
            <p className="truncate text-xs font-semibold text-foreground">
              {getTeamName(event.home_team, teamTranslations)}
            </p>
          </div>
          <div className="font-mono text-sm font-bold text-foreground">
            {event.home_score ?? '-'} : {event.away_score ?? '-'}
          </div>
          <div className="min-w-0 text-left">
            <p className="truncate text-xs font-semibold text-foreground">
              {getTeamName(event.away_team, teamTranslations)}
            </p>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatStartTime(getEventStartTime(event))}
          </div>
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground', active && 'text-primary')} />
        </div>
      </div>
    </div>
  )
}

function MatchStatusBadge({
  status,
  minute,
}: {
  status: string
  minute?: number | null
  period?: string | null
}) {
  const map: Record<string, { label: string; className: string }> = {
    notstarted: {
      label: '未开始',
      className: 'bg-warning/15 text-warning border-warning/30',
    },
    inprogress: {
      label: '进行中',
      className: 'bg-success/15 text-success border-success/30',
    },
    finished: {
      label: '已结束',
      className: 'bg-muted text-muted-foreground border-border',
    },
    cancelled: {
      label: '已取消',
      className: 'bg-error/10 text-error border-error/30',
    },
  }
  const info = map[status] || { label: status, className: 'bg-muted text-muted-foreground border-border' }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        info.className,
      )}
    >
      {status === 'inprogress' && minute && (
        <span className="font-mono">{minute}'</span>
      )}
      {info.label}
    </span>
  )
}

function IncidentsPanel({ incidents }: { incidents: SportsIncident[] }) {
  if (!incidents || !incidents.length) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        暂无比赛事件
      </div>
    )
  }

  const sorted = [...incidents].sort((a, b) => (b.minute || 0) - (a.minute || 0))

  const incidentIcons: Record<string, string> = {
    goal: '⚽',
    yellow_card: '🟨',
    red_card: '🟥',
    substitution: '🔄',
    penalty: '🎯',
    own_goal: '⚽',
  }

  const incidentLabels: Record<string, string> = {
    goal: '进球',
    yellow_card: '黄牌',
    red_card: '红牌',
    substitution: '换人',
    penalty: '点球',
    own_goal: '乌龙球',
  }

  return (
    <div className="space-y-2">
      {sorted.map((inc, idx) => {
        const isHome = inc.team === 'home'
        return (
          <div
            key={idx}
            className={cn(
              'flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2',
              isHome ? 'flex-row' : 'flex-row-reverse',
            )}
          >
            <span className="font-mono text-xs font-bold text-primary w-10 shrink-0">
              {inc.minute || 0}'
            </span>
            <div className={cn('flex items-center gap-2 flex-1 min-w-0', isHome ? '' : 'flex-row-reverse')}>
              <span className="text-lg">{incidentIcons[inc.type || ''] || '📌'}</span>
              <div className={cn('min-w-0', isHome ? '' : 'text-right')}>
                <p className="truncate text-xs font-medium text-foreground">
                  {inc.player || incidentLabels[inc.type || ''] || inc.type || '事件'}
                </p>
                {inc.assist_player && (
                  <p className="truncate text-[10px] text-muted-foreground">
                    助攻：{inc.assist_player}
                  </p>
                )}
                {!inc.player && (
                  <p className="text-[10px] text-muted-foreground">
                    {incidentLabels[inc.type || ''] || inc.type}
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatsPanel({
  stats,
}: {
  stats: SportsStats | null
  homeTeam?: string
  awayTeam?: string
}) {
  if (!stats || (!stats.home && !stats.away)) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        暂无统计数据
      </div>
    )
  }

  const home = stats.home || {}
  const away = stats.away || {}

  // Collect all stat keys from both sides
  const allKeys = new Set([...Object.keys(home), ...Object.keys(away)])

  const formatStatKey = (key: string): string => {
    const map: Record<string, string> = {
      shots: '射门',
      shots_on_target: '射正',
      possession: '控球率',
      corners: '角球',
      fouls: '犯规',
      yellow_cards: '黄牌',
      red_cards: '红牌',
      offsides: '越位',
      saves: '扑救',
      passes: '传球',
      pass_accuracy: '传球成功率',
      xg: '预期进球',
      attacks: '进攻',
      dangerous_attacks: '危险进攻',
    }
    return map[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const formatStatValue = (key: string, value: any): string => {
    if (value === null || value === undefined) return '-'
    if (key === 'possession' || key === 'pass_accuracy') {
      return typeof value === 'number' ? `${value}%` : String(value)
    }
    return String(value)
  }

  const statKeys = Array.from(allKeys).filter((k) => {
    const hv = home[k]
    const av = away[k]
    // Only show numeric stats or meaningful ones
    return typeof hv === 'number' || typeof av === 'number'
  })

  if (!statKeys.length) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        暂无统计数据
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {statKeys.map((key) => {
        const homeVal = home[key]
        const awayVal = away[key]
        const homeNum = typeof homeVal === 'number' ? homeVal : 0
        const awayNum = typeof awayVal === 'number' ? awayVal : 0
        const total = homeNum + awayNum || 1
        const homePct = (homeNum / total) * 100
        const awayPct = (awayNum / total) * 100

        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className={cn('w-20 text-right font-medium', homeNum >= awayNum ? 'text-primary' : 'text-foreground')}>
                {formatStatValue(key, homeVal)}
              </span>
              <span className="text-[10px] text-muted-foreground">{formatStatKey(key)}</span>
              <span className={cn('w-20 text-left font-medium', awayNum >= homeNum ? 'text-primary' : 'text-foreground')}>
                {formatStatValue(key, awayVal)}
              </span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="bg-primary/70 transition-all"
                style={{ width: `${homePct}%` }}
              />
              <div
                className="bg-muted-foreground/30 transition-all"
                style={{ width: `${awayPct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LineupsPanel({
  lineups,
  homeTeam,
  awayTeam,
}: {
  lineups: SportsLineups | null
  homeTeam?: string
  awayTeam?: string
}) {
  if (!lineups || (!lineups.home?.lineup?.length && !lineups.away?.lineup?.length)) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        暂无阵容数据
      </div>
    )
  }

  const homeLineup = lineups.home?.lineup || []
  const awayLineup = lineups.away?.lineup || []
  const homeSubs = lineups.home?.substitutes || []
  const awaySubs = lineups.away?.substitutes || []

  const renderPlayer = (player: Record<string, any>, side: 'home' | 'away') => {
    const name = player.name || player.player_name || '-'
    const number = player.number || player.shirt_number || ''
    const position = player.position || ''
    return (
      <div
        key={player.id || name}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5',
          side === 'home' ? 'flex-row' : 'flex-row-reverse',
        )}
      >
        {number && (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
            {number}
          </span>
        )}
        <div className={cn('min-w-0', side === 'home' ? '' : 'text-right')}>
          <p className="truncate text-xs font-medium text-foreground">{name}</p>
          {position && (
            <p className="truncate text-[10px] text-muted-foreground">{position}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 首发阵容 */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          首发阵容
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">{homeTeam || '主队'}</p>
            {homeLineup.map((p) => renderPlayer(p, 'home'))}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">{awayTeam || '客队'}</p>
            {awayLineup.map((p) => renderPlayer(p, 'away'))}
          </div>
        </div>
      </section>

      {/* 替补 */}
      {(homeSubs.length > 0 || awaySubs.length > 0) && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            替补
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              {homeSubs.map((p) => renderPlayer(p, 'home'))}
            </div>
            <div className="space-y-1">
              {awaySubs.map((p) => renderPlayer(p, 'away'))}
            </div>
          </div>
        </section>
      )}

      {/* 教练 */}
      {(lineups.home?.coach || lineups.away?.coach) && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            教练
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <p className="text-xs text-foreground">
              {lineups.home?.coach || '-'}
            </p>
            <p className="text-xs text-foreground">
              {lineups.away?.coach || '-'}
            </p>
          </div>
        </section>
      )}
    </div>
  )
}

function formatStartTime(timeStr: string): string {
  if (!timeStr) return '--'
  try {
    const d = new Date(timeStr)
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return timeStr
  }
}
