import { useState, useEffect, useRef } from 'react'
import { Minus, Plus, AlertCircle } from 'lucide-react'
import { cn, formatPercent } from '@/lib/utils'

interface ExternalPriceUpdate {
  priceCents: number
  side: 'BUY' | 'SELL'
  timestamp: number
}

interface OrderFormProps {
  outcomeName: string
  marketQuestion: string
  currentPrice: number
  maxAmount?: number
  externalPrice?: ExternalPriceUpdate | null
  submitting?: boolean
  onSubmit: (values: {
    side: 'BUY' | 'SELL'
    size: number
    price: number
    type: 'market' | 'limit'
  }) => void
}

const MIN_SHARES = 5
const MIN_AMOUNT = 1

export function OrderForm({
  outcomeName,
  marketQuestion,
  currentPrice,
  maxAmount = 10000,
  externalPrice,
  submitting = false,
  onSubmit,
}: OrderFormProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [type, setType] = useState<'market' | 'limit'>('market')
  const [mode, setMode] = useState<'shares' | 'amount'>('shares')
  const [sizeStr, setSizeStr] = useState('5')
  const [amountStr, setAmountStr] = useState('5')
  const [limitPriceStr, setLimitPriceStr] = useState(String(Math.round(currentPrice * 100)))
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (externalPrice) {
      setSide(externalPrice.side)
      setType('limit')
      setLimitPriceStr(String(externalPrice.priceCents))
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [externalPrice?.timestamp])

  const limitPrice = parseInt(limitPriceStr) || 0
  const price = type === 'market' ? currentPrice : limitPrice / 100
  const size = mode === 'shares' ? parseInt(sizeStr) || 0 : price > 0 ? Math.floor((parseFloat(amountStr) || 0) / price) : 0
  const total = size * price

  const isValid =
    size >= MIN_SHARES && price > 0 && price < 1 && total <= maxAmount && total >= MIN_AMOUNT

  function adjustSize(delta: number) {
    const next = Math.max(MIN_SHARES, (parseInt(sizeStr) || 0) + delta)
    setSizeStr(String(next))
  }

  function adjustAmount(delta: number) {
    const next = Math.max(MIN_AMOUNT, (parseFloat(amountStr) || 0) + delta)
    setAmountStr(String(next))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValid || submitting) return
    onSubmit({ side, size, price, type })
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
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
          <label className="text-xs font-medium text-foreground">限价 (¢)</label>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => {
                const n = parseInt(limitPriceStr) || 1
                setLimitPriceStr(String(Math.max(1, n - 1)))
              }}
              className="rounded-l-md border border-r-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={limitPriceStr}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || /^\d+$/.test(v)) setLimitPriceStr(v)
              }}
              onBlur={() => {
                const n = parseInt(limitPriceStr) || 0
                if (n < 1) setLimitPriceStr('1')
                else if (n > 99) setLimitPriceStr('99')
              }}
              className="h-9 w-full border-y border-border bg-background px-3 py-2 text-center text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => {
                const n = parseInt(limitPriceStr) || 1
                setLimitPriceStr(String(Math.min(99, n + 1)))
              }}
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

      {/* Mode toggle: shares / amount */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setMode('shares')}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            mode === 'shares'
              ? 'bg-foreground text-background'
              : 'border border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          按份额
        </button>
        <button
          type="button"
          onClick={() => setMode('amount')}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            mode === 'amount'
              ? 'bg-foreground text-background'
              : 'border border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          按金额
        </button>
      </div>

      {mode === 'shares' ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">
            数量（份额）<span className="text-muted-foreground"> · 最少 {MIN_SHARES} 份</span>
          </label>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => adjustSize(-5)}
              className="rounded-l-md border border-r-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              type="number"
              min={MIN_SHARES}
              value={sizeStr}
              onChange={(e) => {
                const v = e.target.value
                setSizeStr(v)
              }}
              onBlur={() => {
                const n = parseInt(sizeStr) || 0
                if (n < MIN_SHARES) setSizeStr(String(MIN_SHARES))
              }}
              className="h-9 w-full border-y border-border bg-background px-3 py-2 text-center text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => adjustSize(5)}
              className="rounded-r-md border border-l-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">
            金额（USDC）<span className="text-muted-foreground"> · 最少 ${MIN_AMOUNT}</span>
          </label>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => adjustAmount(-1)}
              className="rounded-l-md border border-r-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              type="number"
              min={MIN_AMOUNT}
              step="0.01"
              value={amountStr}
              onChange={(e) => {
                setAmountStr(e.target.value)
              }}
              onBlur={() => {
                const n = parseFloat(amountStr) || 0
                if (n < MIN_AMOUNT) setAmountStr(String(MIN_AMOUNT))
              }}
              className="h-9 w-full border-y border-border bg-background px-3 py-2 text-center text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => adjustAmount(1)}
              className="rounded-r-md border border-l-0 border-border bg-muted px-3 py-2 hover:bg-muted/80"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {price > 0 && (
            <p className="text-right text-xs text-muted-foreground">
              ≈ {Math.floor((parseFloat(amountStr) || 0) / price)} 份
            </p>
          )}
        </div>
      )}

      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">单价</span>
          <span className="font-mono font-medium">{formatPercent(price)}</span>
        </div>
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">份额</span>
          <span className="font-mono font-medium">{size}</span>
        </div>
        <div className="flex justify-between border-t border-border py-1 pt-2">
          <span className="font-medium text-foreground">预估总额</span>
          <span className="font-mono font-bold text-foreground">${total.toFixed(2)}</span>
        </div>
      </div>

      {!isValid && size > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-error">
          <AlertCircle className="h-3.5 w-3.5" />
          {size < MIN_SHARES
            ? `最少购买 ${MIN_SHARES} 份`
            : total > maxAmount
              ? `总价超过可用余额 $${maxAmount.toFixed(2)}`
              : `请检查价格和数量`}
        </div>
      )}

      <button
        type="submit"
        disabled={!isValid || submitting}
        className={cn(
          'w-full rounded-md py-2.5 text-sm font-semibold text-white transition-colors',
          side === 'BUY'
            ? 'bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50'
            : 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-600/50',
        )}
      >
        {submitting ? '处理中...' : `${side === 'BUY' ? '买入' : '卖出'} ${outcomeName} · $${total.toFixed(2)}`}
      </button>
    </form>
  )
}
