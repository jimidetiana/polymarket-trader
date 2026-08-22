import { useState } from 'react'
import { Minus, Plus, AlertCircle } from 'lucide-react'
import { cn, formatPercent } from '@/lib/utils'

interface OrderFormProps {
  outcomeName: string
  marketQuestion: string
  currentPrice: number
  maxAmount?: number
  onSubmit: (values: {
    side: 'BUY' | 'SELL'
    size: number
    price: number
    type: 'market' | 'limit'
  }) => void
}

export function OrderForm({
  outcomeName,
  marketQuestion,
  currentPrice,
  maxAmount = 10000,
  onSubmit,
}: OrderFormProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [type, setType] = useState<'market' | 'limit'>('market')
  const [size, setSize] = useState(10)
  const [limitPrice, setLimitPrice] = useState(Math.round(currentPrice * 100))

  const price = type === 'market' ? currentPrice : limitPrice / 100
  const total = size * price
  const maxTotal = maxAmount * price

  const isValid =
    size > 0 && price > 0 && price < 1 && total <= maxTotal && total > 0

  function adjustSize(delta: number) {
    setSize((prev) => Math.max(1, Math.min(maxAmount, prev + delta)))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValid) return
    onSubmit({ side, size, price, type })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 p-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{marketQuestion}</p>
          <p className="text-sm font-semibold text-foreground">{outcomeName}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">当前价格</p>
          <p className="font-mono text-lg font-bold text-primary">{formatPercent(currentPrice)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={cn(
            'rounded-md px-3 py-2 text-sm font-medium transition-colors',
            side === 'BUY'
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'border border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          买入
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={cn(
            'rounded-md px-3 py-2 text-sm font-medium transition-colors',
            side === 'SELL'
              ? 'bg-rose-600 text-white hover:bg-rose-700'
              : 'border border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          卖出
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setType('market')}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            type === 'market'
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          市价
        </button>
        <button
          type="button"
          onClick={() => setType('limit')}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            type === 'limit'
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          限价
        </button>
      </div>

      {type === 'limit' && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">限价</label>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setLimitPrice((p) => Math.max(1, p - 1))}
              className="rounded-l-md border border-r-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              type="number"
              min={1}
              max={99}
              value={limitPrice}
              onChange={(e) => setLimitPrice(Math.max(1, Math.min(99, Number(e.target.value))))}
              className="h-9 w-full border-y border-border bg-background px-3 py-2 text-center text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => setLimitPrice((p) => Math.min(99, p + 1))}
              className="rounded-r-md border border-l-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-right text-xs text-muted-foreground">
            ≈ {formatPercent(price)}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">数量</label>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => adjustSize(-1)}
            className="rounded-l-md border border-r-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <input
            type="number"
            min={1}
            max={maxAmount}
            value={size}
            onChange={(e) => setSize(Math.max(1, Math.min(maxAmount, Number(e.target.value))))}
            className="h-9 w-full border-y border-border bg-background px-3 py-2 text-center text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => adjustSize(1)}
            className="rounded-r-md border border-l-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">单价</span>
          <span className="font-mono font-medium">{formatPercent(price)}</span>
        </div>
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">数量</span>
          <span className="font-mono font-medium">{size}</span>
        </div>
        <div className="flex justify-between border-t border-border py-1 pt-2">
          <span className="font-medium text-foreground">预估总额</span>
          <span className="font-mono font-bold text-foreground">${total.toFixed(2)}</span>
        </div>
      </div>

      {!isValid && (
        <div className="flex items-center gap-1.5 text-xs text-error">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>请检查价格和数量（总价不能超过 ${maxTotal.toFixed(2)}）</span>
        </div>
      )}

      <button
        type="submit"
        disabled={!isValid}
        className={cn(
          'w-full rounded-md py-2.5 text-sm font-semibold text-white transition-colors',
          side === 'BUY'
            ? 'bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50'
            : 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-600/50',
        )}
      >
        {side === 'BUY' ? '买入' : '卖出'} {outcomeName} · ${total.toFixed(2)}
      </button>
    </form>
  )
}
