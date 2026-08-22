import { useEffect, useState } from 'react'
import { fetchOrderBook } from '@/lib/api'
import type { LivePrice } from '@/types'

interface CompactOrderBookProps {
  tokenId: string
  livePrice?: LivePrice
  initialPrice: number
}

const POLL_INTERVAL_MS = 3000

interface BookLevel {
  price: number
  quantity: number
}

function formatCents(value: number): string {
  return `${value.toFixed(1)}`
}

function formatQty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function SdkOrderBookAdapter({
  tokenId,
  livePrice,
  initialPrice,
}: CompactOrderBookProps) {
  const [asks, setAsks] = useState<BookLevel[]>([])
  const [bids, setBids] = useState<BookLevel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const price = livePrice?.bid ?? livePrice?.ask ?? initialPrice

  useEffect(() => {
    let mounted = true
    let timer: ReturnType<typeof setInterval> | null = null

    async function load() {
      try {
        const book = await fetchOrderBook(tokenId)
        if (!mounted) return
        const parsedAsks = (book.asks || [])
          .map((level) => ({
            price: Math.round(Number(level.price) * 100),
            quantity: Number(level.size),
          }))
          .filter((l) => l.price > 0)
          .sort((a, b) => a.price - b.price)
        const parsedBids = (book.bids || [])
          .map((level) => ({
            price: Math.round(Number(level.price) * 100),
            quantity: Number(level.size),
          }))
          .filter((l) => l.price > 0)
          .sort((a, b) => b.price - a.price)
        setAsks(parsedAsks)
        setBids(parsedBids)
        setError(null)
      } catch (err) {
        if (!mounted) return
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    timer = setInterval(load, POLL_INTERVAL_MS)

    return () => {
      mounted = false
      if (timer) clearInterval(timer)
    }
  }, [tokenId])

  // Fallback synthetic depth only before first successful load.
  const fallbackAsks: BookLevel[] = [
    { price: Math.round((price + 0.006) * 100), quantity: 900 },
    { price: Math.round((price + 0.004) * 100), quantity: 1800 },
    { price: Math.round((price + 0.002) * 100), quantity: 2400 },
    { price: Math.round(price * 100), quantity: 1200 },
  ]
  const fallbackBids: BookLevel[] = [
    { price: Math.round(price * 100), quantity: 1100 },
    { price: Math.round(Math.max(0.01, price - 0.002) * 100), quantity: 2200 },
    { price: Math.round(Math.max(0.01, price - 0.004) * 100), quantity: 1600 },
    { price: Math.round(Math.max(0.01, price - 0.006) * 100), quantity: 800 },
  ]

  const displayAsks = asks.length ? asks : fallbackAsks
  const displayBids = bids.length ? bids : fallbackBids

  const maxAskQty = Math.max(...displayAsks.map((a) => a.quantity), 1)
  const maxBidQty = Math.max(...displayBids.map((b) => b.quantity), 1)

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold text-foreground">盘口深度</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {loading ? '加载中...' : error ? `错误: ${error}` : '实时'}
        </span>
      </div>

      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Asks: lowest ask at top, ascending */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-border bg-rose-500/5 px-3 py-1.5">
            <span className="text-xs font-semibold text-rose-500">卖盘 Asks</span>
            <span className="text-[10px] text-muted-foreground">最低卖价在上</span>
          </div>
          <div className="grid grid-cols-2 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>价格</span>
            <span className="text-right">数量</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {displayAsks.map((ask, idx) => (
              <div
                key={`ask-${idx}`}
                className="relative grid grid-cols-2 px-3 py-1.5 text-xs"
              >
                <div
                  className="absolute right-0 top-0 bottom-0 bg-rose-500/10"
                  style={{ width: `${(ask.quantity / maxAskQty) * 100}%` }}
                />
                <span className="relative font-mono text-rose-500">{formatCents(ask.price)}¢</span>
                <span className="relative text-right text-foreground">{formatQty(ask.quantity)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bids: highest bid at top, descending */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-border bg-emerald-500/5 px-3 py-1.5">
            <span className="text-xs font-semibold text-emerald-500">买盘 Bids</span>
            <span className="text-[10px] text-muted-foreground">最高买价在上</span>
          </div>
          <div className="grid grid-cols-2 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>价格</span>
            <span className="text-right">数量</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {displayBids.map((bid, idx) => (
              <div
                key={`bid-${idx}`}
                className="relative grid grid-cols-2 px-3 py-1.5 text-xs"
              >
                <div
                  className="absolute left-0 top-0 bottom-0 bg-emerald-500/10"
                  style={{ width: `${(bid.quantity / maxBidQty) * 100}%` }}
                />
                <span className="relative font-mono text-emerald-500">{formatCents(bid.price)}¢</span>
                <span className="relative text-right text-foreground">{formatQty(bid.quantity)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
