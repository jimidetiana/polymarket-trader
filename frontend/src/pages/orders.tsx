import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  RefreshCw, Wallet, TrendingUp, TrendingDown, ShoppingCart,
  X, CheckCircle2, Clock, XCircle, AlertCircle, Zap,
  Trash2, ListOrdered, ArrowDownToLine, ArrowUpFromLine,
} from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatTime, formatPercent, formatUsdc, formatNumber } from '@/lib/utils'
import {
  fetchOrders, fetchPositions, quickSell, syncOrders,
  cancelOrder, type Position,
} from '@/lib/api'

type TabKey = 'positions' | 'history'
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
  const [sellTarget, setSellTarget] = useState<Position | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [pos, ords] = await Promise.all([fetchPositions(), fetchOrders()])
      setPositions(pos.filter(p => !p.is_settled && !p.is_closed))
      setOrders(ords)
    } catch (err) {
      console.error('加载失败:', err)
    }
  }, [])

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [loadData])

  async function handleSync() {
    setSyncing(true)
    try {
      const result = await syncOrders()
      const settleResult = await fetch('/api/soccer/orders/sync-settlements', { method: 'POST' }).then(r => r.json())
      const msg = `${result.message}${settleResult.settledCount > 0 ? ` | ${settleResult.message}` : ''}`
      setMessage({ text: msg, error: false })
      await loadData()
    } catch (err) {
      setMessage({ text: `同步失败：${err instanceof Error ? err.message : String(err)}`, error: true })
    } finally {
      setSyncing(false)
    }
  }

  async function handleQuickSell(pos: Position) {
    if (!pos.current_bid || pos.current_bid <= 0) {
      setMessage({ text: '无法获取当前买价，请稍后重试', error: true })
      return
    }
    const income = (pos.current_bid * pos.net_size).toFixed(2)
    if (!confirm(`确认以 ${formatPercent(pos.current_bid)} 的买价卖出 ${pos.net_size} 份 ${pos.outcome_name}？\n预计收入: $${income}`)) return
    try {
      const result = await quickSell(pos.token_id, pos.net_size, pos.current_bid, 'market')
      setMessage({ text: result.message, error: false })
      await loadData()
    } catch (err) {
      setMessage({ text: `卖出失败：${err instanceof Error ? err.message : String(err)}`, error: true })
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
      subtitle="持仓一览与订单记录，支持快速卖出未结算持仓"
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
        </div>

        {tab === 'positions' ? (
          <PositionsList positions={positions} onQuickSell={handleQuickSell} onCustomSell={setSellTarget} />
        ) : (
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
        )}
      </div>

      {sellTarget && (
        <SellModal
          position={sellTarget}
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
  onClose,
  onSuccess,
  onError,
}: {
  position: Position
  onClose: () => void
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [size, setSize] = useState(String(position.net_size))
  const [price, setPrice] = useState(position.current_bid ? String((position.current_bid * 100).toFixed(1)) : '50')
  const [submitting, setSubmitting] = useState(false)

  const sellSize = Number(size) || 0
  const sellPrice = Number(price) / 100 || 0
  const estimatedIncome = sellSize * sellPrice

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
      const result = await quickSell(position.token_id, sellSize, sellPrice, 'limit')
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
          <h3 className="text-sm font-semibold text-foreground">限价卖出</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
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
            <span className="text-muted-foreground">当前买价</span>
            <span className="font-medium text-error">{formatPercent(position.current_bid)}</span>
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
            {position.current_bid > 0 && (
              <button
                type="button"
                onClick={() => setPrice(String((position.current_bid * 100).toFixed(1)))}
                className="mt-1 rounded bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted/70"
              >
                对齐买价 {formatPercent(position.current_bid)}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-[10px] text-muted-foreground">预计收入</span>
          <span className="text-sm font-bold text-primary">${formatUsdc(estimatedIncome)}</span>
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
            {submitting ? '提交中...' : '确认卖出'}
          </button>
        </div>
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
                  <span className="text-[10px] text-foreground">{order.question_zh || '-'}</span>
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
