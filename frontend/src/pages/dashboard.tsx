import { useEffect, useState } from 'react'
import {
  BookOpen,
  List,
  PieChart,
  Terminal,
  SlidersHorizontal,
  Play,
  Square,
  XCircle,
} from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatNumber } from '@/lib/utils'

interface OrderBookRow {
  price: number
  size: number
}

interface Order {
  side: '买' | '卖'
  type: string
  price: number
  size: number
  status: string
  statusVariant: 'success' | 'info' | 'warning'
}

interface Log {
  time: string
  message: string
  variant?: 'default' | 'primary' | 'warning' | 'error'
}

export default function DashboardPage() {
  const [spread, setSpread] = useState(0.35)
  const [size, setSize] = useState(250)
  const [maxPos, setMaxPos] = useState(5000)
  const [running, setRunning] = useState(false)

  const [bids, setBids] = useState<OrderBookRow[]>([
    { price: 0.465, size: 1240 },
    { price: 0.463, size: 3880 },
    { price: 0.461, size: 2150 },
    { price: 0.459, size: 5020 },
    { price: 0.457, size: 1875 },
    { price: 0.455, size: 4320 },
    { price: 0.453, size: 2640 },
    { price: 0.451, size: 3110 },
  ])
  const [asks, setAsks] = useState<OrderBookRow[]>([
    { price: 0.467, size: 2080 },
    { price: 0.469, size: 4560 },
    { price: 0.471, size: 1920 },
    { price: 0.473, size: 3440 },
    { price: 0.475, size: 2760 },
    { price: 0.477, size: 5100 },
    { price: 0.479, size: 1630 },
    { price: 0.481, size: 2890 },
  ])

  const [orders] = useState<Order[]>([
    { side: '买', type: '限价', price: 0.463, size: 250, status: '挂单中', statusVariant: 'success' },
    { side: '卖', type: '限价', price: 0.471, size: 250, status: '挂单中', statusVariant: 'success' },
    { side: '买', type: '限价', price: 0.459, size: 500, status: '部分成交', statusVariant: 'info' },
  ])

  const [logs, setLogs] = useState<Log[]>([
    { time: '09:42:01', message: '策略已启动，市场连接正常' },
    { time: '09:42:03', message: '挂单：买入 250 @ 0.463' },
    { time: '09:42:03', message: '挂单：卖出 250 @ 0.471' },
    { time: '09:42:15', message: '部分成交：买入 125 @ 0.463', variant: 'primary' },
    { time: '09:43:08', message: '订单簿价差 0.80%，在目标范围内' },
    { time: '09:43:22', message: '仓位接近上限 75%', variant: 'warning' },
  ])

  const statusBadge = (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground">
      <span className={cn('h-2 w-2 rounded-full', running ? 'bg-success' : 'bg-warning')} />
      {running ? '运行中' : '已停止'}
    </span>
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setBids((prev) => updateSide(prev, 'bid'))
      setAsks((prev) => updateSide(prev, 'ask'))
    }, 1800)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const messages = [
      '订单簿更新，最佳买价 0.463',
      '订单簿更新，最佳卖价 0.471',
      '价差监控：当前 0.80%',
      '持仓估值更新：+4.50 USDC',
      '心跳：API 连接正常',
    ]
    const interval = setInterval(() => {
      const now = new Date()
      const time = now.toTimeString().split(' ')[0]
      const msg = messages[Math.floor(Math.random() * messages.length)]
      setLogs((prev) => [...prev.slice(-49), { time, message: msg }])
    }, 4200)
    return () => clearInterval(interval)
  }, [])

  function updateSide(rows: OrderBookRow[], _side: 'bid' | 'ask'): OrderBookRow[] {
    const idx = Math.floor(Math.random() * rows.length)
    return rows.map((row, i) => {
      if (i !== idx) return row
      const delta = (Math.random() - 0.5) * 0.004
      const newPrice = Math.max(0.01, Math.min(0.99, row.price + delta))
      return {
        price: Number(newPrice.toFixed(3)),
        size: Math.floor(1000 + Math.random() * 5000),
      }
    })
  }

  const netPosition = 750
  const avgCost = 0.461
  const currentPrice = 0.467
  const pnl = Number(((currentPrice - avgCost) * netPosition).toFixed(2))

  return (
    <Layout
      title="Polymarket Trader Dashboard"
      subtitle="Will the US confirm that aliens exist before 2027?"
      actions={
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 sm:flex">
            <span className="text-xs text-muted-foreground">市场</span>
            <span className="font-mono text-xs text-primary">0x7a3f...e9c2</span>
          </div>
          {statusBadge}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-dom-id="btn-start"
              onClick={() => setRunning(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 active:opacity-80"
            >
              <Play className="h-3.5 w-3.5" />
              启动策略
            </button>
            <button
              type="button"
              data-dom-id="btn-stop"
              onClick={() => setRunning(false)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Square className="h-3.5 w-3.5" />
              停止策略
            </button>
            <button
              type="button"
              data-dom-id="btn-cancel-all"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <XCircle className="h-3.5 w-3.5" />
              全部撤单
            </button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <aside className="flex flex-col gap-4">
          <section className="rounded-lg border border-border bg-card shadow-1">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">策略参数</h2>
            </div>
            <div className="space-y-3 p-4">
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">价差 (%)</label>
                <div className="relative">
                  <input
                    type="number"
                    value={spread}
                    step={0.01}
                    onChange={(e) => setSpread(Number(e.target.value))}
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary font-mono"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    %
                  </span>
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">单笔数量</label>
                <input
                  type="number"
                  value={size}
                  step={1}
                  onChange={(e) => setSize(Number(e.target.value))}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">最大仓位</label>
                <input
                  type="number"
                  value={maxPos}
                  step={100}
                  onChange={(e) => setMaxPos(Number(e.target.value))}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card shadow-1">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">订单簿</h2>
              </div>
              <span className="text-xs text-muted-foreground">USD / Share</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="grid grid-cols-2 border-b border-border text-xs text-muted-foreground">
                <div className="px-3 py-2 font-medium">买方</div>
                <div className="px-3 py-2 font-medium">卖方</div>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-2">
                <div className="panel-scroll border-r border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">价格</th>
                        <th className="px-3 py-1.5 text-right font-medium">数量</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {bids.map((row, i) => (
                        <tr key={`bid-${i}`}>
                          <td className="px-3 py-1 text-primary">{row.price.toFixed(3)}</td>
                          <td className="px-3 py-1 text-right text-foreground">
                            {formatNumber(row.size)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="panel-scroll">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">价格</th>
                        <th className="px-3 py-1.5 text-right font-medium">数量</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {asks.map((row, i) => (
                        <tr key={`ask-${i}`}>
                          <td className="px-3 py-1 text-error">{row.price.toFixed(3)}</td>
                          <td className="px-3 py-1 text-right text-foreground">
                            {formatNumber(row.size)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-lg border border-border bg-card shadow-1">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <List className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">当前订单</h2>
              </div>
              <span className="text-xs text-muted-foreground">{orders.length} 个活跃订单</span>
            </div>
            <div className="panel-scroll max-h-[220px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 border-b border-border bg-card text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">方向</th>
                    <th className="px-4 py-2 text-left font-medium">类型</th>
                    <th className="px-4 py-2 text-right font-medium">价格</th>
                    <th className="px-4 py-2 text-right font-medium">金额</th>
                    <th className="px-4 py-2 text-center font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {orders.map((order, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td
                        className={cn(
                          'px-4 py-2',
                          order.side === '买' ? 'text-primary' : 'text-error',
                        )}
                      >
                        {order.side}
                      </td>
                      <td className="px-4 py-2 text-foreground">{order.type}</td>
                      <td className="px-4 py-2 text-right text-foreground">
                        {order.price.toFixed(3)}
                      </td>
                      <td className="px-4 py-2 text-right text-foreground">
                        {formatNumber(order.size)}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5',
                            order.statusVariant === 'success' &&
                              'bg-success/15 text-success',
                            order.statusVariant === 'info' && 'bg-info/15 text-info',
                            order.statusVariant === 'warning' &&
                              'bg-warning/15 text-warning',
                          )}
                        >
                          {order.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card shadow-1">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <PieChart className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">持仓</h2>
              </div>
              <span className="text-xs text-muted-foreground">盈亏实时估算</span>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="净仓位" value={`+${netPosition}`} />
                <Stat label="平均成本" value={avgCost.toFixed(3)} />
                <Stat label="当前价格" value={currentPrice.toFixed(3)} className="text-primary" />
                <Stat
                  label="盈亏"
                  value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC`}
                  className={pnl >= 0 ? 'text-success' : 'text-error'}
                />
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card shadow-1">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Terminal className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">运行日志</h2>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ul className="panel-scroll h-full space-y-1 p-3 text-xs font-mono">
                {logs.map((log, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground">
                    <span className="shrink-0">{log.time}</span>
                    <span
                      className={cn(
                        log.variant === 'primary' && 'text-primary',
                        log.variant === 'warning' && 'text-warning',
                        log.variant === 'error' && 'text-error',
                        !log.variant && 'text-foreground',
                      )}
                    >
                      {log.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </Layout>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold font-mono text-foreground', className)}>{value}</p>
    </div>
  )
}
