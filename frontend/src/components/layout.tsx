import { Link, useLocation } from 'react-router-dom'
import { Activity, LayoutDashboard, Trophy, Languages, Moon, Sun, Wallet, Radio, Bot, ClipboardList, LineChart } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDarkMode } from '@/components/theme-provider'
import { WalletBalance } from '@/components/wallet-balance'

interface LayoutProps {
  title: string
  subtitle: string
  children: React.ReactNode
  actions?: React.ReactNode
}

export function Layout({ title, subtitle, children, actions }: LayoutProps) {
  const location = useLocation()
  const { isDarkMode, toggleDarkMode } = useDarkMode()

  const nav = [
    { to: '/', label: '主控台', icon: LayoutDashboard },
    { to: '/soccer', label: '足球赛事', icon: Trophy },
    { to: '/orders', label: '订单管理', icon: ClipboardList },
    { to: '/live', label: '赛事监听', icon: Radio },
    { to: '/value-bot', label: '价值机器人', icon: Bot },
    { to: '/price-bot', label: '价格监控', icon: LineChart },
    { to: '/translations', label: '翻译', icon: Languages },
    { to: '/wallet', label: '钱包', icon: Wallet },
  ]

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight text-foreground">
                {title}
              </h1>
              <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <WalletBalance />
            <nav className="hidden items-center gap-2 sm:flex">
              {nav.map((item) => {
                const active = location.pathname === item.to
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-foreground hover:bg-muted',
                    )}
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                )
              })}
            </nav>
            <button
              type="button"
              onClick={toggleDarkMode}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted"
              aria-label="切换主题"
            >
              {isDarkMode ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
            {actions}
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto p-4">{children}</main>
    </div>
  )
}
