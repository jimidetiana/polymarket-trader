import { useEffect, useState } from 'react'
import { Wallet, RefreshCw, ChevronDown, Plus, ArrowDownUp, BadgeCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { fetchWallet, syncWalletBalance, fetchChainBalances, type WalletInfo, type ChainBalance, fetchProfile, type PolymarketProfile } from '@/lib/api'
import { cn, formatUsdc } from '@/lib/utils'

export function WalletBalance() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [profile, setProfile] = useState<PolymarketProfile | null>(null)
  const [chainBalances, setChainBalances] = useState<ChainBalance[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    loadWallet()
    loadProfile()
    loadChainBalances()
    // 每 30 秒刷新一次
    const timer = setInterval(() => {
      loadWallet()
      loadChainBalances()
    }, 30000)
    return () => clearInterval(timer)
  }, [])

  async function loadWallet() {
    try {
      const w = await fetchWallet()
      setWallet(w)
    } catch (err) {
      console.error('加载钱包失败:', err)
    }
  }

  async function loadProfile() {
    try {
      const p = await fetchProfile()
      setProfile(p)
    } catch (err) {
      console.error('加载资料失败:', err)
    }
  }

  async function loadChainBalances() {
    try {
      const balances = await fetchChainBalances()
      setChainBalances(balances)
    } catch (err) {
      console.error('加载链上余额失败:', err)
    }
  }

  async function handleRefresh() {
    setLoading(true)
    try {
      const result = await syncWalletBalance()
      setWallet(result.wallet)
      await loadChainBalances()
    } catch (err) {
      console.error('同步余额失败:', err)
    } finally {
      setLoading(false)
    }
  }

  // 生成头像颜色（基于用户名哈希）
  function getAvatarColor(name: string): string {
    const colors = [
      'bg-purple-500', 'bg-blue-500', 'bg-green-500',
      'bg-yellow-500', 'bg-red-500', 'bg-pink-500',
      'bg-indigo-500', 'bg-teal-500',
    ]
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash)
    }
    return colors[Math.abs(hash) % colors.length]
  }

  function getInitials(name: string): string {
    if (!name) return '?'
    return name.slice(0, 2).toUpperCase()
  }

  // 从链上余额中提取 pUSD (Polymarket CLOB 交易余额)
  const pUsdBalance = chainBalances.find((b) => b.chain === 'polymarket' && b.symbol === 'pUSD')
  const displayBalance = pUsdBalance ? pUsdBalance.balance : (wallet ? wallet.balance_usdc : 0)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
      >
        <Wallet className="h-3.5 w-3.5 text-primary" />
        <span className="text-foreground">
          ${displayBalance.toFixed(4)}
        </span>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
            {/* 用户资料 */}
            {profile && (
              <div className="mb-3 flex items-center gap-3 border-b border-border pb-3">
                <div className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white',
                  getAvatarColor(profile.name),
                )}>
                  {getInitials(profile.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-foreground truncate">
                      {profile.name}
                    </span>
                    {profile.verifiedBadge && (
                      <BadgeCheck className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      {profile.takerTierName}
                    </span>
                    <span className="truncate">@{profile.pseudonym}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">钱包余额</span>
              <button
                type="button"
                onClick={handleRefresh}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                title="刷新"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </button>
            </div>

            {wallet ? (
              <div className="space-y-3">
                <div className="rounded-md bg-primary/5 p-3">
                  <p className="text-xs text-muted-foreground">可用余额 (pUSD)</p>
                  <p className="mt-1 text-xl font-bold text-foreground">
                    ${displayBalance.toFixed(6)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Polymarket CLOB 交易余额，可用于下单
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-muted/30 p-2">
                    <p className="text-muted-foreground">累计充值</p>
                    <p className="font-medium text-success">
                      ${formatUsdc(wallet.total_deposited)}
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/30 p-2">
                    <p className="text-muted-foreground">累计盈亏</p>
                    <p className={cn(
                      'font-medium',
                      wallet.total_pnl >= 0 ? 'text-success' : 'text-error',
                    )}>
                      {wallet.total_pnl >= 0 ? '+' : ''}${formatUsdc(wallet.total_pnl)}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Link
                    to="/wallet"
                    onClick={() => setOpen(false)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
                  >
                    <Plus className="h-3 w-3" />
                    充值
                  </Link>
                  <Link
                    to="/wallet"
                    onClick={() => setOpen(false)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted"
                  >
                    <ArrowDownUp className="h-3 w-3" />
                    流水
                  </Link>
                </div>

                <div className="pt-1 space-y-1">
                  <p className="text-[10px] text-muted-foreground break-all">
                    钱包地址: {wallet.address}
                  </p>
                  {profile && (
                    <p className="text-[10px] text-muted-foreground break-all">
                      代理钱包: {profile.proxyWallet}
                    </p>
                  )}
                </div>

                {chainBalances.length > 0 && (
                  <div className="border-t border-border pt-2">
                    <p className="text-[10px] font-medium text-muted-foreground mb-1">链上余额</p>
                    <div className="space-y-0.5">
                      {chainBalances
                        .filter((b) => b.balance > 0)
                        .map((b, i) => (
                          <div key={i} className="flex items-center justify-between text-[10px]">
                            <span className="text-muted-foreground">{b.chain} {b.symbol}</span>
                            <span className="font-medium text-foreground">{b.balance.toFixed(4)}</span>
                          </div>
                        ))}
                      {chainBalances.every((b) => b.balance === 0) && (
                        <p className="text-[10px] text-muted-foreground">所有链上余额为 0</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-muted-foreground">
                加载中...
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
