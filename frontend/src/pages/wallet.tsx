import { useEffect, useState } from 'react'
import {
  Wallet,
  ArrowDownCircle,
  ArrowUpCircle,
  TrendingUp,
  RefreshCw,
  Plus,
  Minus,
  History,
  Copy,
  CheckCircle,
  Filter,
  BadgeCheck,
} from 'lucide-react'
import { Layout } from '@/components/layout'
import { cn, formatUsdc, formatTime } from '@/lib/utils'
import {
  fetchWallet,
  syncWalletBalance,
  depositWallet,
  withdrawWallet,
  fetchWalletTransactions,
  fetchChainBalances,
  fetchProfile,
  type WalletInfo,
  type WalletTransaction,
  type ChainBalance,
  type PolymarketProfile,
} from '@/lib/api'

const TX_PAGE_SIZE = 20

const TX_TYPE_LABELS: Record<string, string> = {
  deposit: '充值',
  withdraw: '提现',
  trade_pnl: '交易盈亏',
  fee: '手续费',
  other: '其他',
}

const TX_TYPE_COLORS: Record<string, string> = {
  deposit: 'text-success bg-success/10',
  withdraw: 'text-error bg-error/10',
  trade_pnl: 'text-primary bg-primary/10',
  fee: 'text-warning bg-warning/10',
  other: 'text-muted-foreground bg-muted/30',
}

export default function WalletPage() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [profile, setProfile] = useState<PolymarketProfile | null>(null)
  const [chainBalances, setChainBalances] = useState<ChainBalance[]>([])
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [txPage, setTxPage] = useState(1)
  const [txTypeFilter, setTxTypeFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [txLoading, setTxLoading] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [actionMsg, setActionMsg] = useState('')
  const [actionError, setActionError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    loadWallet()
    loadProfile()
    loadChainBalances()
    const timer = setInterval(() => {
      loadWallet()
      loadChainBalances()
    }, 30000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    loadTransactions()
  }, [txPage, txTypeFilter])

  async function loadWallet() {
    setLoading(true)
    try {
      const w = await fetchWallet()
      setWallet(w)
    } catch (err) {
      console.error('加载钱包失败:', err)
    } finally {
      setLoading(false)
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

  async function handleSyncBalance() {
    setLoading(true)
    try {
      const result = await syncWalletBalance()
      setWallet(result.wallet)
      await loadChainBalances()
    } catch (err) {
      console.error('同步链上余额失败:', err)
    } finally {
      setLoading(false)
    }
  }

  async function loadTransactions() {
    setTxLoading(true)
    try {
      const result = await fetchWalletTransactions({
        limit: TX_PAGE_SIZE,
        offset: (txPage - 1) * TX_PAGE_SIZE,
        tx_type: txTypeFilter || undefined,
      })
      setTransactions(result.transactions)
      setTxTotal(result.total)
    } catch (err) {
      console.error('加载流水失败:', err)
    } finally {
      setTxLoading(false)
    }
  }

  async function handleDeposit() {
    const amount = parseFloat(depositAmount)
    if (!amount || amount <= 0) {
      setActionError('请输入有效的充值金额')
      return
    }
    setActionMsg('')
    setActionError('')
    try {
      const res = await depositWallet(amount, '手动充值')
      setActionMsg(res.message)
      setDepositAmount('')
      await loadWallet()
      await loadTransactions()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '充值失败')
    }
  }

  async function handleWithdraw() {
    const amount = parseFloat(withdrawAmount)
    if (!amount || amount <= 0) {
      setActionError('请输入有效的提现金额')
      return
    }
    setActionMsg('')
    setActionError('')
    try {
      const res = await withdrawWallet(amount, '手动提现')
      setActionMsg(res.message)
      setWithdrawAmount('')
      await loadWallet()
      await loadTransactions()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '提现失败')
    }
  }

  async function copyAddress() {
    if (!wallet) return
    try {
      await navigator.clipboard.writeText(wallet.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  const txTotalPages = Math.max(1, Math.ceil(txTotal / TX_PAGE_SIZE))

  // 从链上余额中提取 pUSD (Polymarket CLOB 交易余额)
  const pUsdBalance = chainBalances.find((b) => b.chain === 'polymarket' && b.symbol === 'pUSD')
  const displayBalance = pUsdBalance ? pUsdBalance.balance : (wallet ? wallet.balance_usdc : 0)

  // 生成头像颜色
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

  return (
    <Layout
      title="钱包管理"
      subtitle="管理账户余额、充值提现和交易流水"
      actions={
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            handleSyncBalance()
            loadTransactions()
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          同步链上余额
        </button>
      }
    >
      <div className="mx-auto max-w-5xl space-y-4">
        {/* Profile + Balance Card */}
        <div className="rounded-xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-6">
          {/* Profile section */}
          {profile && (
            <div className="mb-4 flex items-center gap-4 border-b border-border pb-4">
              <div className={cn(
                'flex h-12 w-12 items-center justify-center rounded-full text-sm font-bold text-white',
                getAvatarColor(profile.name),
              )}>
                {getInitials(profile.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-foreground">{profile.name}</span>
                  {profile.verifiedBadge && (
                    <BadgeCheck className="h-4 w-4 text-blue-500 flex-shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {profile.takerTierName}
                  </span>
                  <span className="truncate">@{profile.pseudonym}</span>
                  {profile.weightedVolume > 0 && (
                    <span className="text-[10px]">交易额: ${profile.weightedVolume.toFixed(2)}</span>
                  )}
                </div>
              </div>
              {profile.proxyWallet && (
                <div className="text-right">
                  <p className="text-[10px] text-muted-foreground">代理钱包</p>
                  <code className="text-[11px] text-muted-foreground break-all">
                    {profile.proxyWallet.slice(0, 8)}...{profile.proxyWallet.slice(-6)}
                  </code>
                </div>
              )}
            </div>
          )}

          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Wallet className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium text-foreground">可用余额</span>
              </div>
              <p className="mt-2 text-4xl font-bold text-foreground">
                ${formatUsdc(displayBalance)}
                <span className="ml-2 text-sm font-normal text-muted-foreground">pUSD</span>
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Polymarket CLOB 交易余额，可用于下单交易
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="text-[11px] text-muted-foreground break-all max-w-[300px]">
                  {wallet?.address}
                </code>
                <button
                  type="button"
                  onClick={copyAddress}
                  className="text-muted-foreground hover:text-foreground"
                  title="复制地址"
                >
                  {copied ? (
                    <CheckCircle className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const amt = prompt('请输入充值金额（USDC）：', '1000')
                    if (amt) {
                      setDepositAmount(amt)
                      setTimeout(handleDeposit, 100)
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-xs font-medium text-white hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  充值
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const amt = prompt('请输入提现金额（USDC）：', '100')
                    if (amt) {
                      setWithdrawAmount(amt)
                      setTimeout(handleWithdraw, 100)
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <Minus className="h-3.5 w-3.5" />
                  提现
                </button>
              </div>
            </div>
          </div>

          {/* Chain balance breakdown */}
          {chainBalances.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-[10px] text-muted-foreground">链上余额明细</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {chainBalances.filter(b => b.balance > 0).map((b, i) => (
                  <div key={i} className="rounded-md bg-muted/30 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">{b.chain} {b.symbol}</p>
                    <p className="text-xs font-medium text-foreground">{formatUsdc(b.balance)}</p>
                  </div>
                ))}
                {chainBalances.filter(b => b.balance > 0).length === 0 && (
                  <p className="text-[10px] text-muted-foreground">链上无可用余额</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Quick deposit / withdraw */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <ArrowDownCircle className="h-4 w-4 text-success" />
              <h3 className="text-sm font-semibold text-foreground">快速充值</h3>
            </div>
            <div className="space-y-2">
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="输入充值金额 (USDC)"
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <div className="flex gap-2">
                {[100, 500, 1000, 5000].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDepositAmount(String(v))}
                    className="flex-1 rounded border border-border bg-background py-1 text-xs text-foreground hover:bg-muted"
                  >
                    ${v}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={handleDeposit}
                className="w-full rounded-md bg-success py-2 text-xs font-medium text-white hover:opacity-90"
              >
                确认充值
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <ArrowUpCircle className="h-4 w-4 text-error" />
              <h3 className="text-sm font-semibold text-foreground">快速提现</h3>
            </div>
            <div className="space-y-2">
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="输入提现金额 (USDC)"
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <div className="flex gap-2">
                {[100, 500, 1000].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setWithdrawAmount(String(v))}
                    className="flex-1 rounded border border-border bg-background py-1 text-xs text-foreground hover:bg-muted"
                  >
                    ${v}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setWithdrawAmount(String(displayBalance))}
                  className="flex-1 rounded border border-border bg-background py-1 text-xs text-foreground hover:bg-muted"
                >
                  全部
                </button>
              </div>
              <button
                type="button"
                onClick={handleWithdraw}
                className="w-full rounded-md border border-error/30 bg-error/10 py-2 text-xs font-medium text-error hover:bg-error/20"
              >
                确认提现
              </button>
            </div>
          </div>
        </div>

        {actionMsg && (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
            {actionMsg}
          </div>
        )}
        {actionError && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {actionError}
          </div>
        )}

        {/* Stats */}
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard
            icon={ArrowDownCircle}
            label="累计充值"
            value={`$${wallet ? formatUsdc(wallet.total_deposited) : '0.00'}`}
            color="success"
          />
          <StatCard
            icon={ArrowUpCircle}
            label="累计提现"
            value={`$${wallet ? formatUsdc(wallet.total_withdrawn) : '0.00'}`}
            color="error"
          />
          <StatCard
            icon={TrendingUp}
            label="累计盈亏"
            value={`${wallet && wallet.total_pnl >= 0 ? '+' : ''}$${wallet ? formatUsdc(wallet.total_pnl) : '0.00'}`}
            color={wallet && wallet.total_pnl >= 0 ? 'success' : 'error'}
          />
          <StatCard
            icon={History}
            label="流水记录"
            value={`${txTotal} 条`}
            color="primary"
          />
        </div>

        {/* Transaction history */}
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border p-3">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">交易流水</h3>
            </div>
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={txTypeFilter}
                onChange={(e) => {
                  setTxTypeFilter(e.target.value)
                  setTxPage(1)
                }}
                className="h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground outline-none focus:border-primary"
              >
                <option value="">全部类型</option>
                {Object.entries(TX_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          {txLoading ? (
            <div className="p-8 text-center text-xs text-muted-foreground">加载中...</div>
          ) : !transactions.length ? (
            <div className="p-8 text-center text-xs text-muted-foreground">暂无流水记录</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">类型</th>
                      <th className="px-3 py-2">金额</th>
                      <th className="px-3 py-2">余额</th>
                      <th className="px-3 py-2">说明</th>
                      <th className="px-3 py-2">状态</th>
                      <th className="px-3 py-2 text-right">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {transactions.map((tx) => (
                      <tr key={tx.id} className="hover:bg-white/[0.03]">
                        <td className="px-3 py-2">
                          <span className={cn(
                            'inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium',
                            TX_TYPE_COLORS[tx.tx_type] || TX_TYPE_COLORS.other,
                          )}>
                            {TX_TYPE_LABELS[tx.tx_type] || tx.tx_type}
                          </span>
                        </td>
                        <td className={cn(
                          'px-3 py-2 font-medium',
                          tx.amount >= 0 ? 'text-success' : 'text-error',
                        )}>
                          {tx.amount >= 0 ? '+' : ''}${formatUsdc(tx.amount)}
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          ${tx.balance_after !== null ? formatUsdc(tx.balance_after) : '--'}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {tx.description || '--'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn(
                            'text-[11px]',
                            tx.status === 'completed' ? 'text-success' :
                            tx.status === 'failed' ? 'text-error' : 'text-warning',
                          )}>
                            {tx.status === 'completed' ? '已完成' :
                             tx.status === 'failed' ? '失败' : '处理中'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {formatTime(tx.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between border-t border-border px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  共 {txTotal} 条记录
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setTxPage(Math.max(1, txPage - 1))}
                    disabled={txPage === 1}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="text-xs">‹</span>
                  </button>
                  <span className="min-w-[60px] text-center text-xs text-foreground">
                    {txPage} / {txTotalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTxPage(Math.min(txTotalPages, txPage + 1))}
                    disabled={txPage === txTotalPages}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="text-xs">›</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
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
  color: 'primary' | 'warning' | 'success' | 'error'
}) {
  const colorClass =
    color === 'primary'
      ? 'bg-primary/10 text-primary'
      : color === 'warning'
        ? 'bg-warning/10 text-warning'
        : color === 'success'
          ? 'bg-success/10 text-success'
          : 'bg-error/10 text-error'
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
