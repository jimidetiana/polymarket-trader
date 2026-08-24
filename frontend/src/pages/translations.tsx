import { useEffect, useMemo, useState } from 'react'
import {
  RefreshCw,
  Users,
  Trophy,
  CheckCircle2,
  Sparkles,
  Download,
  Upload,
  Copy,
  CheckCircle,
  Save,
  Trash2,
  Plus,
  Database,
  Search,
  Filter,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Square,
  CheckSquare,
} from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, escapeHtml } from '@/lib/utils'
import {
  fetchDictTeams,
  fetchDictLeagues,
  fetchDictStats,
  syncDictFromEvents,
  applyDictionaryToEvents,
  deduplicateTeams,
  importDict,
  updateDictTeam,
  updateDictLeague,
  deleteDictTeam,
  deleteDictLeague,
  saveDictTeam,
  saveDictLeague,
  type DictTeam,
  type DictLeague,
} from '@/lib/api'

type TabType = 'teams' | 'leagues'
const PAGE_SIZE = 20

const TEAM_EXPORT_TEMPLATE = [
  { name_en: 'Manchester City', name_zh: '曼城', league: 'English Premier League' },
]

const LEAGUE_EXPORT_TEMPLATE = [
  { name_en: 'English Premier League', name_zh: '英格兰足球超级联赛' },
]

export default function TranslationsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('teams')
  const [teams, setTeams] = useState<DictTeam[]>([])
  const [leagues, setLeagues] = useState<DictLeague[]>([])
  const [stats, setStats] = useState<{
    teams: { total: number; translated: number; untranslated: number }
    leagues: { total: number; translated: number; untranslated: number }
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [leagueFilter, setLeagueFilter] = useState<string>('')
  const [filterUntranslated, setFilterUntranslated] = useState(false)
  const [importJson, setImportJson] = useState('')
  const [importStatus, setImportStatus] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [teamPage, setTeamPage] = useState(1)
  const [leaguePage, setLeaguePage] = useState(1)
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<number>>(new Set())
  const [selectedLeagueIds, setSelectedLeagueIds] = useState<Set<number>>(new Set())
  const [exportStatus, setExportStatus] = useState('')

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    setTeamPage(1)
    setLeaguePage(1)
    setSelectedTeamIds(new Set())
    setSelectedLeagueIds(new Set())
  }, [search, leagueFilter, filterUntranslated, activeTab])

  async function loadData() {
    setLoading(true)
    try {
      const [teamsData, leaguesData, statsData] = await Promise.all([
        fetchDictTeams(),
        fetchDictLeagues(),
        fetchDictStats(),
      ])
      setTeams(teamsData)
      setLeagues(leaguesData)
      setStats(statsData)
    } catch (err) {
      console.error('加载失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const uniqueLeagues = useMemo(() => {
    const set = new Set<string>()
    teams.forEach((t) => {
      if (t.league) set.add(t.league)
    })
    return Array.from(set).sort()
  }, [teams])

  const filteredTeams = useMemo(() => {
    return teams.filter((t) => {
      if (filterUntranslated && t.name_zh) return false
      if (leagueFilter && t.league !== leagueFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !t.name_en.toLowerCase().includes(q) &&
          !(t.name_zh?.toLowerCase().includes(q))
        ) {
          return false
        }
      }
      return true
    })
  }, [teams, search, leagueFilter, filterUntranslated])

  const filteredLeagues = useMemo(() => {
    return leagues.filter((l) => {
      if (filterUntranslated && l.name_zh) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !l.name_en.toLowerCase().includes(q) &&
          !(l.name_zh?.toLowerCase().includes(q))
        ) {
          return false
        }
      }
      return true
    })
  }, [leagues, search, filterUntranslated])

  const teamTotalPages = Math.max(1, Math.ceil(filteredTeams.length / PAGE_SIZE))
  const leagueTotalPages = Math.max(1, Math.ceil(filteredLeagues.length / PAGE_SIZE))

  const pagedTeams = useMemo(() => {
    const start = (teamPage - 1) * PAGE_SIZE
    return filteredTeams.slice(start, start + PAGE_SIZE)
  }, [filteredTeams, teamPage])

  const pagedLeagues = useMemo(() => {
    const start = (leaguePage - 1) * PAGE_SIZE
    return filteredLeagues.slice(start, start + PAGE_SIZE)
  }, [filteredLeagues, leaguePage])

  const allTeamsOnPageSelected = pagedTeams.length > 0 && pagedTeams.every((t) => selectedTeamIds.has(t.id))
  const allLeaguesOnPageSelected = pagedLeagues.length > 0 && pagedLeagues.every((l) => selectedLeagueIds.has(l.id))

  async function handleSync() {
    setSyncStatus('同步中...')
    try {
      const result = await syncDictFromEvents()
      setSyncStatus(result.message)
      await loadData()
    } catch (err) {
      setSyncStatus(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleApplyTranslations() {
    setSyncStatus('应用翻译中...')
    try {
      const result = await applyDictionaryToEvents()
      setSyncStatus(result.message)
      await loadData()
    } catch (err) {
      setSyncStatus(`应用失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDeduplicate() {
    setSyncStatus('去重中...')
    try {
      const result = await deduplicateTeams()
      setSyncStatus(result.message)
      await loadData()
    } catch (err) {
      setSyncStatus(`去重失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
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

  function getExportData(scope: 'all' | 'selected'): unknown[] {
    if (activeTab === 'teams') {
      const source = scope === 'selected'
        ? filteredTeams.filter((t) => selectedTeamIds.has(t.id))
        : filteredTeams
      return source.map((t) => ({
        name_en: t.name_en,
        name_zh: t.name_zh || '',
        league: t.league || '',
      }))
    } else {
      const source = scope === 'selected'
        ? filteredLeagues.filter((l) => selectedLeagueIds.has(l.id))
        : filteredLeagues
      return source.map((l) => ({
        name_en: l.name_en,
        name_zh: l.name_zh || '',
      }))
    }
  }

  function handleExport(scope: 'all' | 'selected') {
    const data = getExportData(scope)
    if (!data.length) {
      setExportStatus('没有可导出的数据')
      return
    }
    const json = JSON.stringify(data, null, 2)
    const scopeLabel = scope === 'selected' ? 'selected' : 'all'
    const filename = `dict-${activeTab}-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.json`
    downloadJson(filename, json)
    setExportStatus(`已导出 ${data.length} 条`)
  }

  async function handleCopy(scope: 'all' | 'selected') {
    const data = getExportData(scope)
    if (!data.length) {
      setExportStatus('没有可复制的数据')
      return
    }
    const json = JSON.stringify(data, null, 2)
    const ok = await copyText(json)
    setExportStatus(ok ? `已复制 ${data.length} 条到剪贴板` : '复制失败')
  }

  async function handleCopyTemplate() {
    const template = activeTab === 'teams' ? TEAM_EXPORT_TEMPLATE : LEAGUE_EXPORT_TEMPLATE
    const ok = await copyText(JSON.stringify(template, null, 2))
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
      const item = parsed[i] as { name_en?: unknown }
      if (!item || typeof item.name_en !== 'string' || !item.name_en) {
        return { valid: false, error: `第 ${i + 1} 条缺少有效 name_en` }
      }
    }
    return { valid: true, parsed }
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
      const payload = activeTab === 'teams'
        ? { teams: result.parsed as Array<{ name_en: string; name_zh?: string; league?: string }> }
        : { leagues: result.parsed as Array<{ name_en: string; name_zh?: string }> }
      const res = await importDict(payload)
      setImportStatus(res.message)
      setImportJson('')
      await loadData()
    } catch (err) {
      setImportStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleAddTeam() {
    const nameEn = prompt('请输入球队英文名：')
    if (!nameEn?.trim()) return
    const nameZh = prompt('请输入球队中文名（可选）：') || null
    const league = prompt('请输入所属联赛（可选）：') || null
    try {
      await saveDictTeam({ name_en: nameEn.trim(), name_zh: nameZh, league })
      await loadData()
      alert('添加成功')
    } catch (err) {
      alert(`添加失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleAddLeague() {
    const nameEn = prompt('请输入联赛英文名：')
    if (!nameEn?.trim()) return
    const nameZh = prompt('请输入联赛中文名（可选）：') || null
    try {
      await saveDictLeague({ name_en: nameEn.trim(), name_zh: nameZh })
      await loadData()
      alert('添加成功')
    } catch (err) {
      alert(`添加失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function toggleTeamSelect(id: number) {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleLeagueSelect(id: number) {
    setSelectedLeagueIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllTeams() {
    if (allTeamsOnPageSelected) {
      setSelectedTeamIds((prev) => {
        const next = new Set(prev)
        pagedTeams.forEach((t) => next.delete(t.id))
        return next
      })
    } else {
      setSelectedTeamIds((prev) => {
        const next = new Set(prev)
        pagedTeams.forEach((t) => next.add(t.id))
        return next
      })
    }
  }

  function toggleSelectAllLeagues() {
    if (allLeaguesOnPageSelected) {
      setSelectedLeagueIds((prev) => {
        const next = new Set(prev)
        pagedLeagues.forEach((l) => next.delete(l.id))
        return next
      })
    } else {
      setSelectedLeagueIds((prev) => {
        const next = new Set(prev)
        pagedLeagues.forEach((l) => next.add(l.id))
        return next
      })
    }
  }

  async function handleBatchDeleteTeams() {
    if (!selectedTeamIds.size) return
    if (!confirm(`确定删除选中的 ${selectedTeamIds.size} 支球队吗？`)) return
    let success = 0
    let failed = 0
    for (const id of selectedTeamIds) {
      try {
        await deleteDictTeam(id)
        success++
      } catch {
        failed++
      }
    }
    setSelectedTeamIds(new Set())
    await loadData()
    alert(`删除完成：成功 ${success} 条，失败 ${failed} 条`)
  }

  async function handleBatchDeleteLeagues() {
    if (!selectedLeagueIds.size) return
    if (!confirm(`确定删除选中的 ${selectedLeagueIds.size} 个联赛吗？`)) return
    let success = 0
    let failed = 0
    for (const id of selectedLeagueIds) {
      try {
        await deleteDictLeague(id)
        success++
      } catch {
        failed++
      }
    }
    setSelectedLeagueIds(new Set())
    await loadData()
    alert(`删除完成：成功 ${success} 条，失败 ${failed} 条`)
  }

  const selectedTeamCount = selectedTeamIds.size
  const selectedLeagueCount = selectedLeagueIds.size

  return (
    <Layout
      title="翻译词典管理"
      subtitle="以球队和联赛为单位管理翻译，一次翻译自动应用到所有比赛"
      actions={
        <button
          type="button"
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
        {/* Stats */}
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard icon={Users} label="球队总数" value={`${stats?.teams.total ?? 0} 支`} color="primary" />
          <StatCard icon={CheckCircle2} label="已翻译球队" value={`${stats?.teams.translated ?? 0} 支`} color="success" />
          <StatCard icon={Trophy} label="联赛总数" value={`${stats?.leagues.total ?? 0} 个`} color="primary" />
          <StatCard icon={CheckCircle2} label="已翻译联赛" value={`${stats?.leagues.translated ?? 0} 个`} color="success" />
        </div>

        {/* Dictionary actions */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="text-xs text-foreground">
              根据词典翻译已有比赛的球队名称
            </span>
          </div>
          <div className="flex items-center gap-2">
            {syncStatus && (
              <span className="text-xs text-muted-foreground">{syncStatus}</span>
            )}
            <button
              type="button"
              onClick={handleApplyTranslations}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              <Sparkles className="h-3.5 w-3.5" />
              应用词典翻译
            </button>
            <button
              type="button"
              onClick={handleSync}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50"
            >
              <Database className="h-3.5 w-3.5" />
              提取球队
            </button>
            <button
              type="button"
              onClick={handleDeduplicate}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50"
            >
              <Users className="h-3.5 w-3.5" />
              球队去重
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => setActiveTab('teams')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'teams'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Users className="h-3.5 w-3.5" />
            球队词典
            {stats && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                {stats.teams.untranslated} 未译
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('leagues')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'leagues'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Trophy className="h-3.5 w-3.5" />
            联赛词典
            {stats && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                {stats.leagues.untranslated} 未译
              </span>
            )}
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`搜索${activeTab === 'teams' ? '球队' : '联赛'}英文名/中文名...`}
              className="h-8 w-full rounded-md border border-border bg-input pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          {activeTab === 'teams' && (
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={leagueFilter}
                onChange={(e) => setLeagueFilter(e.target.value)}
                className="h-8 rounded-md border border-border bg-input px-2 text-xs text-foreground outline-none focus:border-primary"
              >
                <option value="">全部联赛</option>
                {uniqueLeagues.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
          )}
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
            <input
              type="checkbox"
              checked={filterUntranslated}
              onChange={(e) => setFilterUntranslated(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-primary"
            />
            仅显示未翻译
          </label>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative group">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Download className="h-3.5 w-3.5" />
                导出
                <ChevronRight className="h-3 w-3 rotate-90" />
              </button>
              <div className="absolute right-0 top-full z-10 mt-1 hidden w-40 rounded-md border border-border bg-background p-1 shadow-lg group-hover:block">
                <button
                  type="button"
                  onClick={() => handleExport('all')}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                >
                  <Download className="h-3 w-3" />
                  导出全部
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('selected')}
                  disabled={activeTab === 'teams' ? !selectedTeamCount : !selectedLeagueCount}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckSquare className="h-3 w-3" />
                  导出选中
                </button>
              </div>
            </div>
            <div className="relative group">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Copy className="h-3.5 w-3.5" />
                复制
                <ChevronRight className="h-3 w-3 rotate-90" />
              </button>
              <div className="absolute right-0 top-full z-10 mt-1 hidden w-40 rounded-md border border-border bg-background p-1 shadow-lg group-hover:block">
                <button
                  type="button"
                  onClick={() => handleCopy('all')}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                >
                  <Copy className="h-3 w-3" />
                  复制全部
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy('selected')}
                  disabled={activeTab === 'teams' ? !selectedTeamCount : !selectedLeagueCount}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckSquare className="h-3 w-3" />
                  复制选中
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={activeTab === 'teams' ? handleAddTeam : handleAddLeague}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              新增
            </button>
          </div>
        </div>

        {exportStatus && (
          <div className="text-xs text-muted-foreground">{exportStatus}</div>
        )}

        {/* Batch actions bar */}
        {(activeTab === 'teams' ? selectedTeamCount : selectedLeagueCount) > 0 && (
          <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="text-xs text-foreground">
              已选择 <strong className="text-primary">{activeTab === 'teams' ? selectedTeamCount : selectedLeagueCount}</strong> 项
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (activeTab === 'teams') setSelectedTeamIds(new Set())
                  else setSelectedLeagueIds(new Set())
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                取消选择
              </button>
              <button
                type="button"
                onClick={() => handleCopy(activeTab === 'teams' ? 'selected' : 'selected')}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
              >
                <Copy className="h-3 w-3" />
                复制选中
              </button>
              <button
                type="button"
                onClick={() => handleExport('selected')}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
              >
                <Download className="h-3 w-3" />
                导出选中
              </button>
              <button
                type="button"
                onClick={activeTab === 'teams' ? handleBatchDeleteTeams : handleBatchDeleteLeagues}
                className="inline-flex items-center gap-1 rounded-md bg-error/90 px-2 py-1 text-[10px] font-medium text-white hover:bg-error"
              >
                <Trash2 className="h-3 w-3" />
                批量删除
              </button>
            </div>
          </div>
        )}

        {/* Table */}
        {activeTab === 'teams' ? (
          <>
            <TeamsTable
              teams={pagedTeams}
              selectedIds={selectedTeamIds}
              allSelected={allTeamsOnPageSelected}
              onToggleSelect={toggleTeamSelect}
              onToggleSelectAll={toggleSelectAllTeams}
              onChanged={loadData}
            />
            <Pagination
              currentPage={teamPage}
              totalPages={teamTotalPages}
              totalItems={filteredTeams.length}
              pageSize={PAGE_SIZE}
              onChange={setTeamPage}
            />
          </>
        ) : (
          <>
            <LeaguesTable
              leagues={pagedLeagues}
              selectedIds={selectedLeagueIds}
              allSelected={allLeaguesOnPageSelected}
              onToggleSelect={toggleLeagueSelect}
              onToggleSelectAll={toggleSelectAllLeagues}
              onChanged={loadData}
            />
            <Pagination
              currentPage={leaguePage}
              totalPages={leagueTotalPages}
              totalItems={filteredLeagues.length}
              pageSize={PAGE_SIZE}
              onChange={setLeaguePage}
            />
          </>
        )}

        {/* Batch import */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              批量导入{activeTab === 'teams' ? '球队' : '联赛'}翻译
            </h2>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            将翻译结果按 JSON 格式粘贴到下方，点击导入。导入后相同{activeTab === 'teams' ? '球队' : '联赛'}自动翻译，无需重复操作。
          </p>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary font-mono"
            placeholder={activeTab === 'teams'
              ? '[{"name_en":"Manchester City","name_zh":"曼城","league":"English Premier League"}]'
              : '[{"name_en":"English Premier League","name_zh":"英格兰足球超级联赛"}]'
            }
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleImport}
              className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              <Upload className="h-3.5 w-3.5" />
              批量导入
            </button>
            <button
              type="button"
              onClick={handleCopyTemplate}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Copy className="h-3.5 w-3.5" />
              复制模板
            </button>
            <button
              type="button"
              onClick={() => {
                const result = validateImportPayload(importJson.trim())
                setImportStatus(result.valid ? `格式正确，共 ${result.parsed.length} 条` : result.error)
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              校验格式
            </button>
            <span
              className={cn(
                'text-xs',
                importStatus.includes('成功') || importStatus.includes('格式正确') || importStatus.includes('完成')
                  ? 'text-success'
                  : importStatus.includes('失败') || importStatus.includes('错误')
                    ? 'text-error'
                    : 'text-muted-foreground',
              )}
            >
              {importStatus}
            </span>
          </div>
        </div>
      </div>
    </Layout>
  )
}

function TeamsTable({
  teams,
  selectedIds,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onChanged,
}: {
  teams: DictTeam[]
  selectedIds: Set<number>
  allSelected: boolean
  onToggleSelect: (id: number) => void
  onToggleSelectAll: () => void
  onChanged: () => void
}) {
  async function handleSave(id: number, row: HTMLTableRowElement) {
    const nameZhInput = row.querySelector<HTMLInputElement>('input[data-field="name_zh"]')
    const leagueInput = row.querySelector<HTMLInputElement>('input[data-field="league"]')
    try {
      await updateDictTeam(id, {
        name_zh: nameZhInput?.value ?? undefined,
        league: leagueInput?.value ?? undefined,
      })
      onChanged()
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`确定删除球队 "${name}" 吗？`)) return
    try {
      await deleteDictTeam(id)
      onChanged()
    } catch (err) {
      alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!teams.length) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-xs text-muted-foreground">
        暂无数据。点击"同步比赛数据"从已有比赛中提取球队。
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="w-10 px-3 py-2">
              <button
                type="button"
                onClick={onToggleSelectAll}
                className="text-foreground hover:text-primary"
                title={allSelected ? '取消全选' : '全选本页'}
              >
                {allSelected ? (
                  <CheckSquare className="h-4 w-4 fill-primary text-primary" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </button>
            </th>
            <th className="w-10 px-3 py-2">#</th>
            <th className="px-3 py-2">英文队名</th>
            <th className="px-3 py-2 min-w-[160px]">中文队名</th>
            <th className="px-3 py-2 min-w-[180px]">所属联赛</th>
            <th className="w-24 px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {teams.map((team, idx) => (
            <tr key={team.id} className={cn('hover:bg-white/[0.03]', selectedIds.has(team.id) && 'bg-primary/5')}>
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => onToggleSelect(team.id)}
                  className="text-foreground hover:text-primary"
                >
                  {selectedIds.has(team.id) ? (
                    <CheckSquare className="h-4 w-4 fill-primary text-primary" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </button>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>
              <td className="px-3 py-2">
                <span
                  className="font-medium text-foreground"
                  dangerouslySetInnerHTML={{ __html: escapeHtml(team.name_en) }}
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="text"
                  data-field="name_zh"
                  defaultValue={team.name_zh || ''}
                  placeholder="输入中文队名"
                  className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="text"
                  data-field="league"
                  defaultValue={team.league || ''}
                  placeholder="所属联赛"
                  className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                />
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={(e) => handleSave(team.id, e.currentTarget.closest('tr')!)}
                    className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:opacity-90"
                  >
                    <Save className="h-3 w-3" />
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(team.id, team.name_en)}
                    className="inline-flex items-center gap-1 rounded border border-error/30 bg-error/10 px-2 py-1 text-[10px] font-medium text-error hover:bg-error/20"
                  >
                    <Trash2 className="h-3 w-3" />
                    删除
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LeaguesTable({
  leagues,
  selectedIds,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onChanged,
}: {
  leagues: DictLeague[]
  selectedIds: Set<number>
  allSelected: boolean
  onToggleSelect: (id: number) => void
  onToggleSelectAll: () => void
  onChanged: () => void
}) {
  async function handleSave(id: number, row: HTMLTableRowElement) {
    const input = row.querySelector<HTMLInputElement>('input[data-field="name_zh"]')
    try {
      await updateDictLeague(id, input?.value || '')
      onChanged()
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`确定删除联赛 "${name}" 吗？`)) return
    try {
      await deleteDictLeague(id)
      onChanged()
    } catch (err) {
      alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!leagues.length) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-xs text-muted-foreground">
        暂无数据。点击"同步比赛数据"从已有比赛中提取联赛。
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="w-10 px-3 py-2">
              <button
                type="button"
                onClick={onToggleSelectAll}
                className="text-foreground hover:text-primary"
                title={allSelected ? '取消全选' : '全选本页'}
              >
                {allSelected ? (
                  <CheckSquare className="h-4 w-4 fill-primary text-primary" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </button>
            </th>
            <th className="w-10 px-3 py-2">#</th>
            <th className="px-3 py-2">英文联赛名</th>
            <th className="px-3 py-2 min-w-[200px]">中文联赛名</th>
            <th className="w-24 px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {leagues.map((league, idx) => (
            <tr key={league.id} className={cn('hover:bg-white/[0.03]', selectedIds.has(league.id) && 'bg-primary/5')}>
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => onToggleSelect(league.id)}
                  className="text-foreground hover:text-primary"
                >
                  {selectedIds.has(league.id) ? (
                    <CheckSquare className="h-4 w-4 fill-primary text-primary" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </button>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>
              <td className="px-3 py-2">
                <span
                  className="font-medium text-foreground"
                  dangerouslySetInnerHTML={{ __html: escapeHtml(league.name_en) }}
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="text"
                  data-field="name_zh"
                  defaultValue={league.name_zh || ''}
                  placeholder="输入中文联赛名"
                  className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                />
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={(e) => handleSave(league.id, e.currentTarget.closest('tr')!)}
                    className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:opacity-90"
                  >
                    <Save className="h-3 w-3" />
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(league.id, league.name_en)}
                    className="inline-flex items-center gap-1 rounded border border-error/30 bg-error/10 px-2 py-1 text-[10px] font-medium text-error hover:bg-error/20"
                  >
                    <Trash2 className="h-3 w-3" />
                    删除
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onChange,
}: {
  currentPage: number
  totalPages: number
  totalItems: number
  pageSize: number
  onChange: (page: number) => void
}) {
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, totalItems)

  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-xs text-muted-foreground">
        显示 {start}-{end} / 共 {totalItems} 条
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[60px] text-center text-xs text-foreground">
          {currentPage} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
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
