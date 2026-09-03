import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  RefreshCw, Wallet, TrendingUp, TrendingDown, ShoppingCart,
  X, CheckCircle2, Clock, XCircle, AlertCircle, Zap,
  Trash2, ListOrdered, ArrowDownToLine, ArrowUpFromLine,
  ExternalLink, Eraser, Layers, ShieldAlert,
} from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatTime, formatPercent, formatUsdc, formatNumber } from '@/lib/utils'
import {
  fetchOrders, fetchPositions, quickSell, syncOrders,
  cancelOrder, fetchOrderReconcile, forceCloseOrder,
  type Position, type ReconcileResult,
} from '@/lib/api'

type TabKey = 'positions' | 'history' | 'resting'
type OrderFilter = 'all' | 'filled' | 'open' | 'settled' | 'cancelled' | 'failed'

const FILTER_TABS: { key: OrderFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'filled', label: '已成交' },
  { key: 'open', label: '挂单中' },
  { key: 'settled', label: '已结算' },
  { key: 'cancelled', label: '已取消' },
  { key: 'failed', label: '失败' },
]

export default function OrdersPage() {
  const [tab, setTab] = useState<TabKey>('positions')
  const [positions, setPositions] = useState<Position[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [filter, setFilter] = useState<OrderFilter>('all')
  // 卖出弹窗。mode 决定默认走市价还是限价，价格两种模式都可改
  const [sellTarget, setSellTarget] = useState<{ pos: Position; mode: 'market' | 'limit' } | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean; warning?: boolean } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null)
  const [reconcileBusy, setReconcileBusy] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [pos, ords] = await Promise.all([fetchPositions(), fetchOrders()])
      setPositions(pos.filter(p => !p.is_settled && !p.is_closed))
      setOrders(ords)
    } catch (err) {
      console.error('加载失败:', err)
    }
  }, [])

  // 挂单对账要打交易所，比本地查询慢得多，所以单独拉、单独转圈，
  // 不塞进 30s 的 loadData 里拖慢整页
  const loadReconcile = useCallback(async (showError = true): Promise<boolean> => {
    setReconcileBusy(true)
    try {
      setReconcile(await fetchOrderReconcile())
      return true
    } catch (err) {
      if (showError) setMessage({ text: `挂单对账失败：${err instanceof Error ? err.message : String(err)}`, error: true })
      return false
    } finally {
      setReconcileBusy(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [loadData])

  // 进「挂单管理」才拉对账，且只在没数据时自动拉一次。
  // 这个请求要打交易所，不适合跟着轮询跑；后续刷新交给页内按钮。
  useEffect(() => {
    if (tab !== 'resting') return
    if (reconcile || reconcileBusy) return
    void loadReconcile()
  }, [tab, reconcile, reconcileBusy, loadReconcile])

  async function handleSync() {
    setSyncing(true)
    try {
      const result = await syncOrders()
      const source = [
        `挂单${result.openOrdersRead ? '已读取' : '未读取'}`,
        `成交${result.tradesRead ? '已读取' : '未读取'}`,
      ].join(' · ')
      const warnings = [
        result.unverified > 0 ? `${result.unverified} 笔未核验` : '',
        result.tradesTruncated ? '成交历史只扫描到最近 10 页' : '',
        !result.openOrdersRead && result.openOrdersError ? `挂单读取失败：${result.openOrdersError}` : '',
        !result.tradesRead && result.tradesError ? `成交读取失败：${result.tradesError}` : '',
      ].filter(Boolean)
      let settlement = '结算：没有新结算'
      try {
        const settleResponse = await fetch('/api/soccer/orders/sync-settlements', { method: 'POST' })
        const settleResult = await settleResponse.json()
        if (!settleResponse.ok || !settleResult.success) throw new Error(settleResult.error || '结算同步失败')
        settlement = `结算：${settleResult.settledCount > 0 ? `已结算 ${settleResult.settledCount} 笔` : '没有新结算'}`
      } catch (err) {
        warnings.push(`结算未同步：${err instanceof Error ? err.message : String(err)}`)
      }
      // 对账是独立缓存。停留在挂单管理时必须重新拉，不能继续显示同步前的结论。
      const [, reconciled] = await Promise.all([loadData(), loadReconcile(false)])
      if (!reconciled) warnings.push('挂单对账未刷新，请稍后点“重新对账”')
      setMessage({
        text: `${result.message}｜${source}｜${settlement}${warnings.length ? `｜注意：${warnings.join('；')}` : ''}`,
        error: false,
        warning: warnings.length > 0,
      })
    } catch (err) {
      setMessage({ text: `同步失败：${err instanceof Error ? err.message : String(err)}`, error: true })
    } finally {
      setSyncing(false)
    }
  }

  // 快速卖出改成开弹窗，而不是直接 confirm 后按当前买价打出去。
  // 原来价格是写死的 current_bid，没有插手的机会：盘口一薄，
  // 「按买价卖出」和「按你以为的价格卖出」可以差很远。
  // 现在预填买价、可改，想原样确认也只多一次点击。
  function handleQuickSell(pos: Position) {
    if (!pos.current_bid || pos.current_bid <= 0) {
      setMessage({ text: '无法获取当前买价，请稍后重试', error: true })
      return
    }
    setSellTarget({ pos, mode: 'market' })
  }

  async function handleForceClose(orderId: number) {
    if (!confirm(
      `确定消除订单 #${orderId} 的残留记录吗？\n\n` +
      '这只改本地状态（标记为已取消），不会向交易所发撤单请求。\n' +
      '仅用于「交易所已经没有、本地还显示挂单中」的记录。\n' +
      '后端会再次核对交易所，若这笔仍然挂着会拒绝操作。',
    )) return
    try {
      const msg = await forceCloseOrder(orderId)
      setMessage({ text: msg, error: false })
      await Promise.all([loadData(), loadReconcile()])
    } catch (err) {
      setMessage({ text: `消除失败：${err instanceof Error ? err.message : String(err)}`, error: true })
    }
  }

  async function handleCancelResting(orderId: number) {
    if (!confirm(`确定向交易所撤销挂单 #${orderId} 吗？`)) return
    try {
      const msg = await cancelOrder(orderId)
      setMessage({ text: msg, error: false })
      await Promise.all([loadData(), loadReconcile()])
    } catch (err) {
      setMessage({ text: `撤单失败：${err instanceof Error ? err.message : String(err)}`, error: true })
    }
  }

  async function handleCancelOrder(orderId: number) {
    if (!confirm('确定取消该订单吗？')) return
    try {
      await cancelOrder(orderId)
      await loadData()
    } catch (err) {
      alert(`取消失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDeleteOrder(orderId: number) {
    if (!confirm('确定删除该订单记录吗？')) return
    try {
      const res = await fetch(`/api/soccer/orders/${orderId}`, { method: 'DELETE' })
      const msg = await res.text()
      alert(msg)
      await loadData()
    } catch (err) {
      alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const summary = useMemo(() => {
    const totalInvested = positions.reduce((s, p) => s + p.net_cost, 0)
    const totalValue = positions.reduce((s, p) => s + p.estimated_value, 0)
    const totalPnl = positions.reduce((s, p) => s + p.unrealized_pnl, 0)
    return { count: positions.length, totalInvested, totalValue, totalPnl }
  }, [positions])

  const filteredOrders = useMemo(() => {
    if (filter === 'all') return orders
    if (filter === 'open') return orders.filter((o) => o.order_status === 'open' || o.order_status === 'pending')
    if (filter === 'filled') return orders.filter((o) => o.order_status === 'filled' || o.order_status === 'partial' || o.order_status === 'partial_cancelled')
    return orders.filter((o) => o.order_status === filter)
  }, [orders, filter])

  return (
    <Layout
      title="订单管理"
      subtitle="持仓、订单记录与挂单对账，可自定义价格卖出、清理残留挂单"
      actions={
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 active:opacity-80 disabled:opacity-60"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
          同步订单
        </button>
      }
    >
      <div className="mx-auto max-w-7xl space-y-4">
        {message && (
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs',
              message.error
                ? 'border-error/30 bg-error/10 text-error'
                : message.warning
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-success/30 bg-success/10 text-success',
            )}
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{message.text}</span>
            <button type="button" onClick={() => setMessage(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryCard icon={ShoppingCart} label="持仓数量" value={`${summary.count} 个`} color="primary" />
          <SummaryCard icon={ArrowDownToLine} label="投入资金" value={`$${formatUsdc(summary.totalInvested)}`} color="warning" />
          <SummaryCard icon={Wallet} label="估算市值" value={`$${formatUsdc(summary.totalValue)}`} color="primary" />
          <SummaryCard
            icon={summary.totalPnl >= 0 ? TrendingUp : TrendingDown}
            label="未实现盈亏"
            value={`${summary.totalPnl >= 0 ? '+' : ''}$${formatUsdc(summary.totalPnl)}`}
            color={summary.totalPnl >= 0 ? 'success' : 'error'}
          />
        </div>

        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => setTab('positions')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              tab === 'positions' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            持仓管理
            {summary.count > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{summary.count}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              tab === 'history' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <ListOrdered className="h-3.5 w-3.5" />
            订单记录
            {orders.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{orders.length}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setTab('resting')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              tab === 'resting' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Layers className="h-3.5 w-3.5" />
            挂单管理
            {/* 残留数单独用警示色标出来：这一栏的重点就是「有几笔对不上账」 */}
            {reconcile && reconcile.counts.stale + reconcile.counts.orphan > 0 && (
              <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                {reconcile.counts.stale + reconcile.counts.orphan}
              </span>
            )}
          </button>
        </div>

        {tab === 'positions' ? (
          <PositionsList
            positions={positions}
            onQuickSell={handleQuickSell}
            onCustomSell={(pos) => setSellTarget({ pos, mode: 'limit' })}
          />
        ) : tab === 'history' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {FILTER_TABS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[10px] font-medium transition-colors',
                    filter === f.key
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card text-foreground hover:bg-muted',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <OrdersTable orders={filteredOrders} onCancel={handleCancelOrder} onDelete={handleDeleteOrder} />
          </div>
        ) : (
          <RestingOrdersPanel
            data={reconcile}
            busy={reconcileBusy}
            onRefresh={loadReconcile}
            onCancel={handleCancelResting}
            onForceClose={handleForceClose}
          />
        )}
      </div>

      {sellTarget && (
        <SellModal
          position={sellTarget.pos}
          initialMode={sellTarget.mode}
          onClose={() => setSellTarget(null)}
          onSuccess={async (msg) => {
            setMessage({ text: msg, error: false })
            setSellTarget(null)
            await loadData()
          }}
          onError={(msg) => setMessage({ text: msg, error: true })}
        />
      )}
    </Layout>
  )
}

function PositionsList({
  positions,
  onQuickSell,
  onCustomSell,
}: {
  positions: Position[]
  onQuickSell: (pos: Position) => void
  onCustomSell: (pos: Position) => void
}) {
  if (!positions.length) {
    return (
      <div className="rounded-lg border border-border bg-card p-12 text-center text-xs text-muted-foreground">
        暂无持仓。下单成交后，持仓将显示在此处。
      </div>
    )
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {positions.map((pos) => {
        const pnlPositive = pos.unrealized_pnl >= 0
        const isClosed = pos.is_closed || pos.is_settled
        return (
          <div key={pos.token_id} className={cn(
            'rounded-lg border bg-card p-4',
            isClosed ? 'border-muted-foreground/30 bg-muted/20' : 'border-border',
          )}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {pos.outcome_name}
                  </p>
                  {isClosed && (
                    <span className={cn(
                      'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                      pos.settled_won ? 'bg-success/15 text-success' : pos.settled_lost ? 'bg-error/15 text-error' : 'bg-muted text-muted-foreground',
                    )}>
                      {pos.settled_won ? '结算赢' : pos.settled_lost ? '结算输' : '已结算'}
                    </span>
                  )}
                </div>
                <p className="truncate text-[10px] text-muted-foreground">
                  {pos.event_title}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {pos.question_zh}
                </p>
              </div>
              <span className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                pnlPositive
                  ? 'bg-success/10 text-success'
                  : 'bg-error/10 text-error',
              )}>
                {pnlPositive ? '+' : ''}{formatUsdc(pos.unrealized_pnl)}
              </span>
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-md border border-border bg-background p-2">
                <p className="text-[10px] text-muted-foreground">持仓</p>
                <p className="text-sm font-bold text-foreground">{formatNumber(pos.net_size)}</p>
              </div>
              <div className="rounded-md border border-border bg-background p-2">
                <p className="text-[10px] text-muted-foreground">买入均价</p>
                <p className="text-sm font-bold text-foreground">{formatPercent(pos.avg_buy_price)}</p>
              </div>
              <div className="rounded-md border border-border bg-background p-2">
                <p className="text-[10px] text-muted-foreground">{isClosed ? '结算价' : '买价 / 卖价'}</p>
                <p className="text-sm font-bold text-foreground">
                  {isClosed ? (
                    <span className={pos.current_bid >= 0.5 ? 'text-success' : 'text-error'}>
                      {formatPercent(pos.current_bid)}
                    </span>
                  ) : (
                    <>
                      <span className="text-error">{formatPercent(pos.current_bid)}</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-success">{formatPercent(pos.current_ask)}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="rounded-md border border-border bg-background p-2">
                <p className="text-[10px] text-muted-foreground">{isClosed ? '结算价值' : '估算市值'}</p>
                <p className="text-sm font-bold text-primary">${formatUsdc(pos.estimated_value)}</p>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>买入 {pos.buy_count} 笔 · 卖出 {pos.sell_count} 笔</span>
              <span>投入 ${formatUsdc(pos.net_cost)}</span>
            </div>

            {isClosed ? (
              <div className="mt-3 flex items-center justify-center rounded-md border border-muted-foreground/20 bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
                市场已结算，无法交易
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => onQuickSell(pos)}
                  disabled={!pos.current_bid || pos.current_bid <= 0}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-error px-3 py-2 text-xs font-medium text-white hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Zap className="h-3.5 w-3.5" />
                  快速卖出
                </button>
                <button
                  type="button"
                  onClick={() => onCustomSell(pos)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <ArrowUpFromLine className="h-3.5 w-3.5" />
                  限价卖出
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SellModal({
  position,
  initialMode = 'limit',
  onClose,
  onSuccess,
  onError,
}: {
  position: Position
  initialMode?: 'market' | 'limit'
  onClose: () => void
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [mode, setMode] = useState<'market' | 'limit'>(initialMode)
  const [size, setSize] = useState(String(position.net_size))
  const [price, setPrice] = useState(position.current_bid ? String((position.current_bid * 100).toFixed(1)) : '50')
  const [submitting, setSubmitting] = useState(false)

  const sellSize = Number(size) || 0
  const sellPrice = Number(price) / 100 || 0
  const estimatedIncome = sellSize * sellPrice

  // 报价快捷键。手敲百分数容易点错一位，而卖出是不可撤的
  const bid = position.current_bid || 0
  const ask = position.current_ask || 0
  const presets: { label: string; value: number; hint: string }[] = [
    { label: '买价', value: bid, hint: '挂在当前买价，最容易马上成交' },
    { label: '买价 -1¢', value: bid - 0.01, hint: '让出 1 分钱换成交概率' },
    ...(bid > 0 && ask > 0
      ? [{ label: '中间价', value: (bid + ask) / 2, hint: '买卖价中点，等对手方过来' }]
      : []),
    ...(ask > 0 ? [{ label: '卖价', value: ask, hint: '挂在卖价，价格最优但要等' }] : []),
  ].filter((p) => p.value > 0 && p.value < 1)

  async function handleSubmit() {
    if (sellSize <= 0 || sellPrice <= 0 || sellPrice >= 1) {
      onError('请填写有效的数量和价格（0 < 价格 < 100）')
      return
    }
    if (sellSize > position.net_size) {
      onError(`数量不能超过持仓量 ${position.net_size}`)
      return
    }
    setSubmitting(true)
    try {
      const result = await quickSell(position.token_id, sellSize, sellPrice, mode)
      onSuccess(result.message)
    } catch (err) {
      onError(`卖出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">卖出持仓</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 市价 / 限价：两种都能改价格，区别只在吃单还是挂着等 */}
        <div className="mb-4 flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
          {([
            { key: 'market' as const, label: '市价卖出', hint: '按填写的价格直接吃对手方买单，求成交' },
            { key: 'limit' as const, label: '限价挂单', hint: '挂在盘口等人来买，价格更优但可能不成交' },
          ]).map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              title={m.hint}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                mode === m.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="mb-4 rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">盘口</span>
            <span className="font-medium text-foreground">{position.outcome_name}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">持仓量</span>
            <span className="font-bold text-foreground">{position.net_size} 份</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">买价 / 卖价</span>
            <span className="font-medium">
              <span className="text-error">{formatPercent(position.current_bid)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-success">{formatPercent(position.current_ask)}</span>
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">买入均价</span>
            <span className="font-medium text-foreground">{formatPercent(position.avg_buy_price)}</span>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">卖出数量（份）</label>
            <input
              type="number"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              max={position.net_size}
              step="0.1"
              className="h-9 w-full rounded-md border border-border bg-input px-3 text-xs text-foreground outline-none focus:border-primary"
            />
            <div className="mt-1 flex gap-1">
              <button type="button" onClick={() => setSize(String(position.net_size))} className="rounded bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted/70">全部</button>
              <button type="button" onClick={() => setSize(String((position.net_size / 2).toFixed(2)))} className="rounded bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted/70">半数</button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">卖出价格（百分比）</label>
            <div className="relative">
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                min="1"
                max="99"
                step="0.5"
                className="h-9 w-full rounded-md border border-border bg-input px-3 pr-8 text-xs text-foreground outline-none focus:border-primary"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
            </div>
            {presets.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    title={p.hint}
                    onClick={() => setPrice((p.value * 100).toFixed(1))}
                    className="rounded bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted/70"
                  >
                    {p.label} {formatPercent(p.value)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="text-[10px] text-muted-foreground">预计收入</span>
            <span className="text-sm font-bold text-primary">${formatUsdc(estimatedIncome)}</span>
          </div>
          {/* 盈亏用买入均价现算：卖出前最该知道的就是这一笔到底赚没赚 */}
          {position.avg_buy_price > 0 && sellSize > 0 && sellPrice > 0 && (
            <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
              <span className="text-[10px] text-muted-foreground">
                相对买入均价 {formatPercent(position.avg_buy_price)}
              </span>
              <span
                className={cn(
                  'text-xs font-bold',
                  sellPrice >= position.avg_buy_price ? 'text-success' : 'text-error',
                )}
              >
                {sellPrice >= position.avg_buy_price ? '+' : ''}
                ${formatUsdc((sellPrice - position.avg_buy_price) * sellSize)}
              </span>
            </div>
          )}
          {mode === 'market' && sellPrice > 0 && bid > 0 && sellPrice > bid && (
            <p className="text-[10px] text-warning">
              填的价格高于当前买价 {formatPercent(bid)}，市价单可能吃不到，会退化成挂单等成交。
            </p>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 rounded-md bg-error px-3 py-2 text-xs font-medium text-white hover:bg-error/90 disabled:opacity-60"
          >
            {submitting
              ? '提交中...'
              : `确认${mode === 'market' ? '卖出' : '挂单'} ${formatNumber(sellSize)} 份 @ ${formatPercent(sellPrice)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 挂单管理：把「本地以为挂着的」和「交易所真的挂着的」对起来。
 *
 * 三类分开处理，因为处理方式完全不同：
 *   live   真挂单 → 撤单（走交易所）
 *   stale  残留记录 → 消除（只改本地，交易所根本不认识它）
 *   orphan 交易所有、本地没登记 → 有真实敞口，必须让用户知道
 */
function RestingOrdersPanel({
  data,
  busy,
  onRefresh,
  onCancel,
  onForceClose,
}: {
  data: ReconcileResult | null
  busy: boolean
  onRefresh: () => void
  onCancel: (id: number) => void
  onForceClose: (id: number) => void
}) {
  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-card p-12 text-center text-xs text-muted-foreground">
        {busy ? '正在与交易所对账...' : '暂无数据'}
      </div>
    )
  }

  const { items, orphans, counts, exchangeReachable, exchangeCount } = data
  const live = items.filter((i) => i.kind === 'live')
  const stale = items.filter((i) => i.kind === 'stale')
  const unknown = items.filter((i) => i.kind === 'unknown')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-3 text-[10px]">
          <span className="text-muted-foreground">
            本地挂单中 <span className="font-bold text-foreground">{items.length}</span>
          </span>
          <span className="text-muted-foreground">
            交易所实际 <span className="font-bold text-foreground">{exchangeCount}</span>
          </span>
          <span className="text-success">正常 {counts.live}</span>
          <span className={counts.stale > 0 ? 'text-warning' : 'text-muted-foreground'}>
            残留 {counts.stale}
          </span>
          <span className={counts.orphan > 0 ? 'text-error' : 'text-muted-foreground'}>
            未登记 {counts.orphan}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-medium text-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
          重新对账
        </button>
      </div>

      {!exchangeReachable && (
        <div className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[10px] text-warning">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            连不上交易所，无法判断哪些是残留记录，下面一律按「未确认」显示。
            这时不提供「消除」——查不到不等于不存在，误消除会把真有敞口的挂单从账上抹掉。
          </span>
        </div>
      )}

      {orphans.length > 0 && (
        <div className="rounded-lg border border-error/40 bg-error/5 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-error">
            <ShieldAlert className="h-3.5 w-3.5" />
            交易所有 {orphans.length} 笔挂单，本地没有记录
          </p>
          <p className="mb-2 text-[10px] text-muted-foreground">
            这些挂单有真实敞口，但本地库里查不到对应订单，说明下单记录丢了或是别处下的。
            成交后不会有任何策略跟进。建议用「同步订单」把它们导入，或直接去 Polymarket 撤掉。
          </p>
          <div className="space-y-1">
            {orphans.map((o) => (
              <div
                key={o.clobOrderId}
                className="flex flex-wrap items-center gap-2 rounded border border-border bg-background px-2 py-1 font-mono text-[10px]"
              >
                <span className="text-muted-foreground">{o.clobOrderId.slice(0, 18)}...</span>
                {o.side && <span className="text-foreground">{o.side}</span>}
                {o.price != null && <span className="text-foreground">@{o.price}</span>}
                {o.size != null && (
                  <span className="text-muted-foreground">
                    {o.sizeMatched ?? 0}/{o.size}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {stale.length > 0 && (
        <RestingGroup
          tone="warning"
          title={`残留记录 ${stale.length} 笔`}
          desc="本地显示挂单中，但交易所已经没有这笔。它们不会再成交，却仍占着每盘口的下单配额，也让持仓看起来对不上账。「消除」只改本地状态为已取消，不向交易所发请求。"
          orders={stale}
          action="forceClose"
          onCancel={onCancel}
          onForceClose={onForceClose}
        />
      )}

      {live.length > 0 && (
        <RestingGroup
          tone="normal"
          title={`正常挂单 ${live.length} 笔`}
          desc="交易所确认仍在挂着，等待成交。撤单会真的向交易所发请求。"
          orders={live}
          action="cancel"
          onCancel={onCancel}
          onForceClose={onForceClose}
        />
      )}

      {unknown.length > 0 && (
        <RestingGroup
          tone="warning"
          title={`未确认 ${unknown.length} 笔`}
          desc="交易所不可达，无法判断这些是真挂单还是残留。恢复连接后重新对账。"
          orders={unknown}
          action="none"
          onCancel={onCancel}
          onForceClose={onForceClose}
        />
      )}

      {items.length === 0 && orphans.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-xs text-muted-foreground">
          没有挂单，本地与交易所一致。
        </div>
      )}
    </div>
  )
}

function RestingGroup({
  tone,
  title,
  desc,
  orders,
  action,
  onCancel,
  onForceClose,
}: {
  tone: 'normal' | 'warning'
  title: string
  desc: string
  orders: ReconcileResult['items']
  action: 'cancel' | 'forceClose' | 'none'
  onCancel: (id: number) => void
  onForceClose: (id: number) => void
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'warning' ? 'border-warning/40 bg-warning/5' : 'border-border bg-card',
      )}
    >
      <p className={cn('text-xs font-semibold', tone === 'warning' ? 'text-warning' : 'text-foreground')}>
        {title}
      </p>
      <p className="mb-2 mt-0.5 text-[10px] text-muted-foreground">{desc}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-2 py-1 font-medium">#</th>
              <th className="px-2 py-1 font-medium">时间</th>
              <th className="px-2 py-1 font-medium">盘口</th>
              <th className="px-2 py-1 text-center font-medium">方向</th>
              <th className="px-2 py-1 text-right font-medium">数量</th>
              <th className="px-2 py-1 text-right font-medium">价格</th>
              <th className="px-2 py-1 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{o.id}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-[10px] text-muted-foreground">
                  {formatTime(o.createdAt)}
                </td>
                <td className="px-2 py-1.5">
                  {o.marketId ? (
                    <Link
                      to={`/soccer?${new URLSearchParams({
                        ...(o.eventId ? { eventId: o.eventId } : {}),
                        marketId: o.marketId,
                      })}`}
                      title="在比赛管理中查看该盘口"
                      className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                    >
                      {o.questionZh || '查看盘口'}
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </Link>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">-</span>
                  )}
                  {o.titleZh && (
                    <span className="block truncate text-[9px] text-muted-foreground">{o.titleZh}</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-medium',
                      o.side === 'BUY' ? 'bg-success/10 text-success' : 'bg-error/10 text-error',
                    )}
                  >
                    {o.side === 'BUY' ? '买入' : '卖出'}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-[10px]">{formatNumber(o.size)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[10px]">{formatPercent(o.price)}</td>
                <td className="px-2 py-1.5 text-right">
                  {action === 'cancel' && (
                    <button
                      type="button"
                      onClick={() => onCancel(o.id)}
                      className="inline-flex items-center gap-0.5 rounded border border-error/30 bg-error/10 px-1.5 py-0.5 text-[10px] font-medium text-error hover:bg-error/20"
                    >
                      <XCircle className="h-2.5 w-2.5" />
                      撤单
                    </button>
                  )}
                  {action === 'forceClose' && (
                    <button
                      type="button"
                      onClick={() => onForceClose(o.id)}
                      title="只改本地状态，不向交易所发撤单请求"
                      className="inline-flex items-center gap-0.5 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning hover:bg-warning/20"
                    >
                      <Eraser className="h-2.5 w-2.5" />
                      消除
                    </button>
                  )}
                  {action === 'none' && <span className="text-[10px] text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function OrdersTable({
  orders,
  onCancel,
  onDelete,
}: {
  orders: any[]
  onCancel: (id: number) => void
  onDelete: (id: number) => void
}) {
  if (!orders.length) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-xs text-muted-foreground">
        暂无订单记录
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-3 py-2">时间</th>
            <th className="px-3 py-2">赛事</th>
            <th className="px-3 py-2">盘口</th>
            <th className="px-3 py-2 text-center">方向</th>
            <th className="px-3 py-2 text-right">数量</th>
            <th className="px-3 py-2 text-right">价格</th>
            <th className="px-3 py-2 text-center">状态</th>
            <th className="px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {orders.map((order) => {
            const isBuy = order.side === 'BUY'
            const status = order.order_status
            const isOpen = status === 'open' || status === 'pending'
            return (
              <tr key={order.id} className="hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-3 py-2 text-[10px] text-muted-foreground">
                  {formatTime(order.created_at)}
                </td>
                <td className="px-3 py-2">
                  <span className="text-[10px] text-foreground">{order.title_zh || '-'}</span>
                </td>
                <td className="px-3 py-2">
                  {/* 盘口名做成跳转：从订单直接到比赛管理里对应的那张盘口卡。
                      eventId 后端已随订单带出；缺了就退化成纯文本，不给死链接 */}
                  {order.market_id ? (
                    <Link
                      to={`/soccer?${new URLSearchParams({
                        ...(order.event_id ? { eventId: String(order.event_id) } : {}),
                        marketId: String(order.market_id),
                      })}`}
                      title="在比赛管理中查看该盘口"
                      className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                    >
                      {order.question_zh || '查看盘口'}
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </Link>
                  ) : (
                    <span className="text-[10px] text-foreground">{order.question_zh || '-'}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={cn(
                    'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    isBuy ? 'bg-success/10 text-success' : 'bg-error/10 text-error',
                  )}>
                    {isBuy ? <ArrowDownToLine className="h-2.5 w-2.5" /> : <ArrowUpFromLine className="h-2.5 w-2.5" />}
                    {isBuy ? '买入' : '卖出'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-[10px] text-foreground">
                  {formatNumber(order.size)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[10px] text-foreground">
                  {formatPercent(Number(order.price))}
                </td>
                <td className="px-3 py-2 text-center">
                  <OrderStatusBadge status={status} />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {isOpen ? (
                      <button
                        type="button"
                        onClick={() => onCancel(order.id)}
                        className="inline-flex items-center gap-0.5 rounded border border-error/30 bg-error/10 px-1.5 py-0.5 text-[10px] font-medium text-error hover:bg-error/20"
                      >
                        <XCircle className="h-2.5 w-2.5" />
                        取消
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onDelete(order.id)}
                        className="inline-flex items-center gap-0.5 rounded border border-muted-foreground/30 bg-muted/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/20"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                        删除
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OrderStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; icon: React.ElementType }> = {
    open: { label: '挂单中', className: 'bg-primary/10 text-primary border-primary/30', icon: Clock },
    pending: { label: '处理中', className: 'bg-warning/15 text-warning border-warning/30', icon: Clock },
    simulated: { label: '模拟', className: 'bg-warning/15 text-warning border-warning/30', icon: Clock },
    filled: { label: '已成交', className: 'bg-success/15 text-success border-success/30', icon: CheckCircle2 },
    partial: { label: '部分成交', className: 'bg-warning/15 text-warning border-warning/30', icon: Clock },
    partial_cancelled: { label: '部分取消', className: 'bg-warning/15 text-warning border-warning/30', icon: AlertCircle },
    cancelled: { label: '已取消', className: 'bg-muted text-muted-foreground border-border', icon: XCircle },
    failed: { label: '失败', className: 'bg-error/10 text-error border-error/30', icon: XCircle },
    closed: { label: '已结束', className: 'bg-muted text-muted-foreground border-border', icon: CheckCircle2 },
    settled: { label: '已结算', className: 'bg-primary/15 text-primary border-primary/30', icon: CheckCircle2 },
  }
  const info = map[status] || { label: status, className: 'bg-muted text-muted-foreground border-border', icon: AlertCircle }
  const Icon = info.icon
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', info.className)}>
      <Icon className="h-2.5 w-2.5" />
      {info.label}
    </span>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType
  label: string
  value: string
  color: 'primary' | 'warning' | 'success' | 'error'
}) {
  const colorClass = {
    primary: 'bg-primary/10 text-primary',
    warning: 'bg-warning/10 text-warning',
    success: 'bg-success/10 text-success',
    error: 'bg-error/10 text-error',
  }[color]
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-full', colorClass)}>
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
