import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, Trophy, ChevronRight, AlertCircle, X, Star, ChevronDown, ChevronUp, Wallet, ListOrdered, XCircle, Languages } from 'lucide-react'
import { Layout } from '@/components/layout'
import { SdkOrderBookAdapter } from '@/components/sdk-order-book'
import { OrderForm } from '@/components/order-form'
import { cn, formatTime, formatPercent, formatUsdc } from '@/lib/utils'
import {
  fetchEvents,
  refreshEvents,
  fetchEventMarkets,
  submitOrder,
  cancelOrder,
  fetchWallet,
  fetchOrders,
  type WalletInfo,
} from '@/lib/api'
import { useSoccerWs } from '@/lib/useSoccerWs'
import {
  MARKET_TYPE_ORDER,
  MARKET_TYPE_LABELS,
  groupMarketsByType,
  getOutcomeColor,
  getOutcomeRoundedClass,
} from '@/lib/markets'
import type { SoccerEvent, SoccerMarket, SelectedOutcome } from '@/types'

type FilterKey = 'focus' | 'live' | 'not_started' | 'ended' | 'all'
type Lang = 'zh' | 'en'

const FILTER_TABS: { key: FilterKey; label: (counts: Record<string, number>) => string }[] = [
  { key: 'focus', label: () => '重点' },
  { key: 'live', label: (c) => `进行中 (${c.live})` },
  { key: 'not_started', label: (c) => `即将开始 (${c.not_started})` },
  { key: 'ended', label: (c) => `已结束 (${c.ended})` },
  { key: 'all', label: (c) => `全部 (${c.all})` },
]

function pickName(zh: string | null | undefined, en: string | null | undefined, lang: Lang): string {
  if (lang === 'zh') return zh || en || '-'
  return en || zh || '-'
}

export default function SoccerPage() {
  const [events, setEvents] = useState<SoccerEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('focus')
  const [fetchStatus, setFetchStatus] = useState('加载中...')
  const [lastUpdated, setLastUpdated] = useState('--')

  const [selectedEvent, setSelectedEvent] = useState<SoccerEvent | null>(null)
  const [markets, setMarkets] = useState<SoccerMarket[]>([])
  const [marketsLoading, setMarketsLoading] = useState(false)

  const [selected, setSelected] = useState<SelectedOutcome | null>(null)
  const [orderMessage, setOrderMessage] = useState<{ text: string; error: boolean; simulated?: boolean } | null>(null)
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [orders, setOrders] = useState<any[]>([])
  const [showOrders, setShowOrders] = useState(false)
  const [orderBookClick, setOrderBookClick] = useState<{ priceCents: number; side: 'BUY' | 'SELL'; timestamp: number } | null>(null)
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('pm-lang') as Lang) || 'zh')

  useEffect(() => {
    localStorage.setItem('pm-lang', lang)
  }, [lang])

  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('pm-favorite-markets')
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set<string>()
    }
  })
  useEffect(() => {
    localStorage.setItem('pm-favorite-markets', JSON.stringify(Array.from(favoriteIds)))
  }, [favoriteIds])

  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(() => {
    return new Set<string>()
  })

  function toggleFavorite(marketId: string) {
    setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (next.has(marketId)) next.delete(marketId)
      else next.add(marketId)
      return next
    })
  }

  const counts = useMemo(() => {
    const all = events.length
    const live = events.filter((e) => e.match_status === 'live').length
    const not_started = events.filter((e) => e.match_status === 'not_started').length
    const ended = events.filter((e) => e.match_status === 'ended').length
    return { all, live, not_started, ended }
  }, [events])

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (filter === 'all') return true
      if (filter === 'focus') return e.match_status === 'live' || e.match_status === 'not_started'
      return e.match_status === filter
    })
  }, [events, filter])

  useEffect(() => {
    loadEvents()
    loadWallet()
    loadOrders()
    // 每 30 秒刷新钱包余额
    const timer = setInterval(loadWallet, 30000)
    return () => clearInterval(timer)
  }, [])

  async function loadWallet() {
    try {
      const w = await fetchWallet()
      setWallet(w)
    } catch {
      // ignore
    }
  }

  async function loadOrders() {
    try {
      const data = await fetchOrders()
      setOrders(data)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!selectedEvent) {
      setMarkets([])
      setSelected(null)
      return
    }
    setMarketsLoading(true)
    fetchEventMarkets(selectedEvent.id)
      .then((data) => setMarkets(data))
      .catch((err) => {
        setOrderMessage({ text: `加载盘口失败：${err.message}`, error: true })
      })
      .finally(() => setMarketsLoading(false))
  }, [selectedEvent])

  // Auto-collapse groups with many markets to reduce clutter.
  useEffect(() => {
    const grouped = groupMarketsByType(markets)
    const next = new Set<string>()
    for (const [type, list] of Object.entries(grouped)) {
      if (list.length >= 6) next.add(type)
    }
    setCollapsedTypes(next)
  }, [markets])

  const tokenIds = useMemo(
    () => markets.flatMap((m) => (m.clob_token_ids || []).filter(Boolean) as string[]),
    [markets],
  )
  const { prices, status: wsStatus } = useSoccerWs(tokenIds)

  async function loadEvents() {
    setLoading(true)
    setFetchStatus('加载中...')
    try {
      const data = await fetchEvents()
      setEvents(data)
      setFetchStatus('已连接')
      setLastUpdated(new Date().toLocaleTimeString('zh-CN'))
    } catch (err) {
      setFetchStatus('失败')
      setOrderMessage({ text: `加载赛事失败：${err instanceof Error ? err.message : String(err)}`, error: true })
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    setLoading(true)
    setFetchStatus('刷新中...')
    try {
      const count = await refreshEvents()
      await loadEvents()
      setFetchStatus(`已刷新 ${count} 场`)
    } catch (err) {
      setFetchStatus('刷新失败')
      setOrderMessage({ text: `刷新失败：${err instanceof Error ? err.message : String(err)}`, error: true })
    } finally {
      setLoading(false)
    }
  }

  function handleSelectEvent(evt: SoccerEvent) {
    setSelectedEvent(evt)
    setSelected(null)
    setOrderMessage(null)
  }

  function handleSelectOutcome(
    event: SoccerEvent,
    market: SoccerMarket,
    outcomeIdx: number,
  ) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : []
    const tokens = Array.isArray(market.clob_token_ids) ? market.clob_token_ids : []
    const pricesArr = Array.isArray(market.outcome_prices) ? market.outcome_prices : []
    const tokenId = tokens[outcomeIdx]
    const outcomeName = outcomes[outcomeIdx]
    if (!tokenId || !outcomeName) return

    const live = tokenId ? prices[tokenId] : undefined
    const initial = Number(pricesArr[outcomeIdx] || 0)
    const price = live?.bid ?? live?.ask ?? initial

    setSelected({
      eventId: event.id,
      marketId: market.id,
      tokenId,
      outcomeName,
      price,
      market,
      event,
    })
    setOrderMessage(null)
  }

  async function handleOrderSubmit(values: {
    side: 'BUY' | 'SELL'
    size: number
    price: number
    type: 'market' | 'limit'
  }) {
    if (!selected) return
    const size = values.size
    const price = values.type === 'market' ? selected.price : values.price
    if (!size || size <= 0 || price <= 0 || price >= 1) {
      setOrderMessage({ text: '请填写有效的数量和价格（0 < 价格 < 1）', error: true })
      return
    }
    try {
      const result = await submitOrder({
        market_id: selected.marketId,
        token_id: selected.tokenId,
        side: values.side,
        size,
        price,
        type: values.type,
      })
      setOrderMessage({ text: result.message, error: false, simulated: result.simulated })
      // 刷新钱包余额和订单列表
      loadWallet()
      loadOrders()
    } catch (err) {
      setOrderMessage({
        text: `下单失败：${err instanceof Error ? err.message : String(err)}`,
        error: true,
      })
    }
  }

  async function handleCancelOrder(orderId: number) {
    if (!confirm('确定取消该订单吗？')) return
    try {
      const msg = await cancelOrder(orderId)
      alert(msg)
      loadWallet()
      loadOrders()
    } catch (err) {
      alert(`取消失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const wsDotClass =
    wsStatus === 'open'
      ? 'bg-success'
      : wsStatus === 'connecting'
        ? 'bg-warning'
        : wsStatus === 'error'
          ? 'bg-error'
          : 'bg-muted-foreground'

  return (
    <Layout
      title="Polymarket 足球赛事"
      subtitle="左侧选择比赛，右侧查看盘口并下单"
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Languages className="h-3.5 w-3.5" />
            {lang === 'zh' ? '中文' : 'EN'}
          </button>
          <button
            type="button"
            data-dom-id="btn-refresh"
            disabled={loading}
            onClick={handleRefresh}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 active:opacity-80 disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新比赛
          </button>
        </div>
      }
    >
      <div className="flex h-[calc(100vh-8rem)] gap-4 overflow-hidden">
        {/* 左侧：比赛列表 */}
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-3">
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="进行中" value={`${counts.live} 场`} className="text-success" />
              <StatCard label="即将开始" value={`${counts.not_started} 场`} className="text-warning" />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {FILTER_TABS.map((tab) => {
                const active = filter === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setFilter(tab.key)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-card text-foreground hover:bg-muted',
                    )}
                  >
                    {tab.label(counts)}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                状态：<span className="text-foreground">{fetchStatus}</span>
              </span>
              <span>更新：{lastUpdated}</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            <div className="space-y-2">
              {!filteredEvents.length ? (
                <div className="rounded-lg border border-border bg-card p-4 text-center">
                  <p className="text-xs text-muted-foreground">当前筛选条件下暂无比赛</p>
                </div>
              ) : (
                filteredEvents.map((evt) => (
                  <MatchCard
                    key={evt.id}
                    event={evt}
                    active={selectedEvent?.id === evt.id}
                    lang={lang}
                    onClick={() => handleSelectEvent(evt)}
                  />
                ))
              )}
            </div>
          </div>
        </aside>

        {/* 右侧：盘口区域 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {!selectedEvent ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Trophy className="h-8 w-8 opacity-40" />
              <p className="text-sm">从左侧选择一场比赛查看盘口</p>
            </div>
          ) : (
            <>
              <header className="border-b border-border px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-foreground">
                      {pickName(selectedEvent.title_zh, selectedEvent.title_en, lang)}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {selectedEvent.league || '足球'} · {formatTime(selectedEvent.end_time)} ·{' '}
                      <StatusBadge status={selectedEvent.match_status || 'not_started'} />
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                    <span className={cn('inline-flex h-2 w-2 rounded-full', wsDotClass)} />
                    <span>
                      {wsStatus === 'open'
                        ? '已连接'
                        : wsStatus === 'connecting'
                          ? '连接中...'
                          : wsStatus === 'error'
                            ? '连接错误'
                            : wsStatus === 'closed'
                              ? '已断开'
                              : '未连接'}
                    </span>
                  </div>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto p-4">
                {marketsLoading ? (
                  <div className="py-12 text-center text-xs text-muted-foreground">加载中...</div>
                ) : !markets.length ? (
                  <div className="py-12 text-center text-xs text-muted-foreground">暂无盘口</div>
                ) : (
                  <MarketGroups
                    markets={markets}
                    prices={prices}
                    selected={selected}
                    favoriteIds={favoriteIds}
                    collapsedTypes={collapsedTypes}
                    selectedEvent={selectedEvent}
                    lang={lang}
                    onToggleFavorite={toggleFavorite}
                    onToggleCollapse={(type) =>
                      setCollapsedTypes((prev) => {
                        const next = new Set(prev)
                        if (next.has(type)) next.delete(type)
                        else next.add(type)
                        return next
                      })
                    }
                    onSelectOutcome={handleSelectOutcome}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* 购买弹窗（置顶、顶部对齐、外层滚动，避免截断内部下拉菜单） */}
      {selected && (
        <div
          className="fixed inset-0 z-[100] overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(null)
          }}
        >
          <div className="flex min-h-full items-start justify-center py-6">
            <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    下单 · {selected.outcomeName}
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {pickName(selected.event.title_zh, selected.event.title_en, lang)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-4">
                <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <p className="text-[10px] text-muted-foreground">已选盘口</p>
                  <p className="text-sm font-medium text-foreground">
                    {pickName(selected.market.question_zh, selected.market.question_en, lang)}
                  </p>
                  <p className="mt-1 font-mono text-2xl font-bold text-primary">
                    {formatPercent(selected.price)}
                  </p>
                </div>

                <SdkOrderBookAdapter
                  tokenId={selected.tokenId}
                  livePrice={prices[selected.tokenId]}
                  initialPrice={selected.price}
                  onPriceClick={(priceCents, side) => setOrderBookClick({ priceCents, side, timestamp: Date.now() })}
                />

                {/* Wallet balance */}
                <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-primary" />
                    <span className="text-xs text-muted-foreground">可用余额</span>
                  </div>
                  <span className="text-sm font-bold text-foreground">
                    ${wallet ? formatUsdc(wallet.balance_usdc) : '--'}
                  </span>
                </div>

                <div className="mt-4 rounded-xl border border-border bg-card p-4">
                  <OrderForm
                    outcomeName={selected.outcomeName}
                    marketQuestion={pickName(selected.market.question_zh, selected.market.question_en, lang)}
                    currentPrice={selected.price}
                    maxAmount={wallet ? wallet.balance_usdc : 10000}
                    externalPrice={orderBookClick}
                    onSubmit={handleOrderSubmit}
                  />
                </div>

                {orderMessage && (
                  <div
                    className={cn(
                      'mt-3 flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs',
                      orderMessage.error
                        ? 'border-error/30 bg-error/10 text-error'
                        : 'border-success/30 bg-success/10 text-success',
                    )}
                  >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <div className="flex-1">
                      {orderMessage.text}
                      {orderMessage.simulated && (
                        <span className="ml-1 rounded bg-warning/20 px-1 py-0.5 text-[10px] text-warning">
                          模拟
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Orders toggle */}
                <button
                  type="button"
                  onClick={() => setShowOrders(!showOrders)}
                  className="mt-3 flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-left text-xs text-foreground hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2">
                    <ListOrdered className="h-3.5 w-3.5 text-primary" />
                    <span className="font-medium">我的订单</span>
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                      {orders.length}
                    </span>
                  </div>
                  {showOrders ? (
                    <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>

                {showOrders && (
                  <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-card">
                    {!orders.length ? (
                      <div className="p-4 text-center text-xs text-muted-foreground">
                        暂无订单
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {orders.slice(0, 20).map((order: any) => (
                          <div key={order.id} className="p-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className={cn(
                                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                  order.side === 'BUY'
                                    ? 'bg-success/10 text-success'
                                    : 'bg-error/10 text-error',
                                )}>
                                  {order.side === 'BUY' ? '买入' : '卖出'}
                                </span>
                                <span className="text-xs font-medium text-foreground">
                                  {order.size} @ {(Number(order.price) * 100).toFixed(1)}%
                                </span>
                              </div>
                              <OrderStatusBadge status={order.order_status} />
                            </div>
                            <p className="mt-1 truncate text-[10px] text-muted-foreground">
                              {pickName(order.title_zh || order.question_zh, order.title_en || order.question_en, lang)}
                            </p>
                            <div className="mt-1 flex items-center justify-between">
                              <span className="text-[10px] text-muted-foreground">
                                {formatTime(order.created_at)}
                              </span>
                              {(order.order_status === 'open' || order.order_status === 'pending' || order.order_status === 'simulated') && (
                                <button
                                  type="button"
                                  onClick={() => handleCancelOrder(order.id)}
                                  className="inline-flex items-center gap-1 rounded border border-error/30 bg-error/10 px-1.5 py-0.5 text-[10px] font-medium text-error hover:bg-error/20"
                                >
                                  <XCircle className="h-3 w-3" />
                                  取消
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}

function MatchCard({
  event,
  active,
  lang,
  onClick,
}: {
  event: SoccerEvent
  active: boolean
  lang: Lang
  onClick: () => void
}) {
  const home = pickName(event.home_team_zh, event.home_team_en, lang)
  const away = pickName(event.away_team_zh, event.away_team_en, lang)
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
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Trophy className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">
              {home} <span className="text-muted-foreground">vs</span> {away}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">
              {event.league || '足球'} · {formatTime(event.end_time)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={event.match_status || 'not_started'} />
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground', active && 'text-primary')} />
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
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
  const info = map[status] || map.not_started
  return (
    <span
      className={cn(
        'inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        info.className,
      )}
    >
      {info.label}
    </span>
  )
}

function OrderStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    open: { label: '挂单中', className: 'bg-primary/10 text-primary border-primary/30' },
    pending: { label: '处理中', className: 'bg-warning/15 text-warning border-warning/30' },
    simulated: { label: '模拟', className: 'bg-warning/15 text-warning border-warning/30' },
    filled: { label: '已成交', className: 'bg-success/15 text-success border-success/30' },
    cancelled: { label: '已取消', className: 'bg-muted text-muted-foreground border-border' },
    failed: { label: '失败', className: 'bg-error/10 text-error border-error/30' },
    closed: { label: '已结束', className: 'bg-muted text-muted-foreground border-border' },
  }
  const info = map[status] || { label: status, className: 'bg-muted text-muted-foreground border-border' }
  return (
    <span
      className={cn(
        'inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        info.className,
      )}
    >
      {info.label}
    </span>
  )
}

function StatCard({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="rounded-md border border-border bg-background p-2 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold text-foreground', className)}>{value}</p>
    </div>
  )
}

function MarketGroups({
  markets,
  prices,
  selected,
  favoriteIds,
  collapsedTypes,
  selectedEvent,
  lang,
  onToggleFavorite,
  onToggleCollapse,
  onSelectOutcome,
}: {
  markets: SoccerMarket[]
  prices: Record<string, { bid: number | null; ask: number | null }>
  selected: SelectedOutcome | null
  favoriteIds: Set<string>
  collapsedTypes: Set<string>
  selectedEvent: SoccerEvent | null
  lang: Lang
  onToggleFavorite: (marketId: string) => void
  onToggleCollapse: (type: string) => void
  onSelectOutcome: (event: SoccerEvent, market: SoccerMarket, idx: number) => void
}) {
  const grouped = useMemo(() => groupMarketsByType(markets), [markets])
  const favoriteMarkets = useMemo(
    () => markets.filter((m) => favoriteIds.has(m.id)),
    [markets, favoriteIds],
  )

  const renderGrid = (list: SoccerMarket[]) => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((market) => (
        <MarketCard
          key={market.id}
          market={market}
          livePrices={prices}
          selected={selected}
          isFavorite={favoriteIds.has(market.id)}
          lang={lang}
          onSelectOutcome={(idx) =>
            selectedEvent && onSelectOutcome(selectedEvent, market, idx)
          }
          onToggleFavorite={() => onToggleFavorite(market.id)}
        />
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      {favoriteMarkets.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-400">
              <Star className="h-3.5 w-3.5 fill-current" />
              收藏盘口
            </h3>
            <span className="text-[10px] text-muted-foreground">
              {favoriteMarkets.length} 个盘口
            </span>
          </div>
          {renderGrid(favoriteMarkets)}
        </section>
      )}

      {MARKET_TYPE_ORDER.map((type) => {
        const groupMarkets = grouped[type]
        if (!groupMarkets.length) return null
        const isCollapsed = collapsedTypes.has(type)
        return (
          <section key={type} className="space-y-3">
            <button
              type="button"
              onClick={() => onToggleCollapse(type)}
              className="flex w-full items-center justify-between rounded-md py-1 hover:bg-muted/50"
            >
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {MARKET_TYPE_LABELS[type]}
              </h3>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">
                  {groupMarkets.length} 个盘口
                </span>
                {isCollapsed ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
            </button>
            {!isCollapsed && renderGrid(groupMarkets)}
          </section>
        )
      })}
    </div>
  )
}

function MarketCard({
  market,
  livePrices,
  selected,
  isFavorite,
  lang,
  onSelectOutcome,
  onToggleFavorite,
}: {
  market: SoccerMarket
  livePrices: Record<string, { bid: number | null; ask: number | null }>
  selected: SelectedOutcome | null
  isFavorite: boolean
  lang: Lang
  onSelectOutcome: (idx: number) => void
  onToggleFavorite: () => void
}) {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : []
  const prices = Array.isArray(market.outcome_prices) ? market.outcome_prices : []
  const tokens = Array.isArray(market.clob_token_ids) ? market.clob_token_ids : []

  const gridClass =
    outcomes.length === 3
      ? 'grid-cols-3'
      : outcomes.length > 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : 'grid-cols-2'

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">
            {pickName(market.question_zh, market.question_en, lang)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {MARKET_TYPE_LABELS[market.market_type || 'other']}
            </span>
            {market.line !== null && market.line !== undefined && (
              <span className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                盘口 {market.line}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            'shrink-0 rounded-md p-1.5 transition-colors',
            isFavorite
              ? 'text-amber-400 hover:text-amber-500'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          title={isFavorite ? '取消收藏' : '收藏盘口'}
        >
          <Star className={cn('h-4 w-4', isFavorite && 'fill-current')} />
        </button>
      </div>
      <div className={cn('mt-auto grid gap-2', gridClass)}>
        {outcomes.map((name, idx) => {
          const tokenId = tokens[idx]
          const initialPrice = Number(prices[idx] ?? 0)
          const live = tokenId ? livePrices[tokenId] : undefined
          const price = live?.bid ?? live?.ask ?? initialPrice
          const accentColor = getOutcomeColor(name, idx, outcomes.length)
          const roundedClass = getOutcomeRoundedClass(idx, outcomes.length)
          const isSelected = selected?.tokenId === tokenId
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectOutcome(idx)}
              className={cn(
                'group relative flex flex-col items-center justify-center gap-0.5 border border-border bg-background px-2 py-2.5 transition-all hover:-translate-y-px',
                roundedClass,
                isSelected && 'border-primary ring-2 ring-primary',
              )}
            >
              <span className="max-w-full truncate px-1 text-[10px] font-medium text-muted-foreground">
                {name}
              </span>
              <span
                className="font-mono text-base font-bold"
                style={{ color: accentColor }}
              >
                {formatPercent(price)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
