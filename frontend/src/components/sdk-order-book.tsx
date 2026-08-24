import type { LivePrice, OrderBook } from '@/types'

interface CompactOrderBookProps {
  tokenId: string
  livePrice?: LivePrice
  initialPrice: number
  wsOrderBook?: OrderBook
  onPriceClick?: (priceCents: number, side: 'BUY' | 'SELL') => void
}

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

function parseAsks(levels: { price: number | string; size?: number | string }[]): BookLevel[] {
  return levels
    .map((l) => ({ price: Math.round(Number(l.price) * 100), quantity: Number(l.size ?? 0) }))
    .filter((l) => l.price > 0)
    .sort((a, b) => a.price - b.price)
}

function parseBids(levels: { price: number | string; size?: number | string }[]): BookLevel[] {
  return levels
    .map((l) => ({ price: Math.round(Number(l.price) * 100), quantity: Number(l.size ?? 0) }))
    .filter((l) => l.price > 0)
    .sort((a, b) => b.price - a.price)
}

export function SdkOrderBookAdapter({
  wsOrderBook,
  onPriceClick,
}: CompactOrderBookProps) {
  const wsAsks = wsOrderBook?.asks ? parseAsks(wsOrderBook.asks) : []
  const wsBids = wsOrderBook?.bids ? parseBids(wsOrderBook.bids) : []

  const hasData = wsAsks.length > 0 || wsBids.length > 0
  const maxAskQty = Math.max(...wsAsks.map((a) => a.quantity), 1)
  const maxBidQty = Math.max(...wsBids.map((b) => b.quantity), 1)

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold text-foreground">盘口深度</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {hasData ? 'WS 实时' : '等待数据...'}
        </span>
      </div>

      {onPriceClick && hasData && (
        <div className="border-b border-border bg-primary/5 px-4 py-1 text-center text-[10px] text-primary">
          点击价格快速下单
        </div>
      )}

      {!hasData ? (
        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
          等待 WebSocket 数据...
        </div>
      ) : (
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Asks: lowest ask at top, ascending */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-border bg-rose-500/5 px-3 py-1.5">
            <span className="text-xs font-semibold text-rose-500">卖盘 Asks</span>
            <span className="text-[10px] text-muted-foreground">点击买入</span>
          </div>
          <div className="grid grid-cols-2 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>价格</span>
            <span className="text-right">数量</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {wsAsks.map((ask, idx) => (
              <button
                key={`ask-${idx}`}
                type="button"
                onClick={() => onPriceClick?.(ask.price, 'BUY')}
                className="relative grid w-full grid-cols-2 px-3 py-1.5 text-xs hover:bg-rose-500/10"
              >
                <div
                  className="absolute right-0 top-0 bottom-0 bg-rose-500/10"
                  style={{ width: `${(ask.quantity / maxAskQty) * 100}%` }}
                />
                <span className="relative font-mono text-rose-500">{formatCents(ask.price)}¢</span>
                <span className="relative text-right text-foreground">{formatQty(ask.quantity)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Bids: highest bid at top, descending */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-border bg-emerald-500/5 px-3 py-1.5">
            <span className="text-xs font-semibold text-emerald-500">买盘 Bids</span>
            <span className="text-[10px] text-muted-foreground">点击卖出</span>
          </div>
          <div className="grid grid-cols-2 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>价格</span>
            <span className="text-right">数量</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {wsBids.map((bid, idx) => (
              <button
                key={`bid-${idx}`}
                type="button"
                onClick={() => onPriceClick?.(bid.price, 'SELL')}
                className="relative grid w-full grid-cols-2 px-3 py-1.5 text-xs hover:bg-emerald-500/10"
              >
                <div
                  className="absolute left-0 top-0 bottom-0 bg-emerald-500/10"
                  style={{ width: `${(bid.quantity / maxBidQty) * 100}%` }}
                />
                <span className="relative font-mono text-emerald-500">{formatCents(bid.price)}¢</span>
                <span className="relative text-right text-foreground">{formatQty(bid.quantity)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  )
}
