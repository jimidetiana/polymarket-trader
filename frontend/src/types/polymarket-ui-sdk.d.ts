/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'polymarket-ui-sdk' {
  import type { ComponentType, ReactNode } from 'react'

  export interface ThemeContextValue {
    isDarkMode: boolean
    toggleDarkMode: () => void
  }

  export interface NavbarItem {
    label: string
    href?: string
    onClick?: () => void
  }

  export interface NavbarAuth {
    isLoggedIn: boolean
    userName?: string
    onLogin?: () => void
    onSignUp?: () => void
    onProfileClick?: () => void
  }

  export interface NavbarProps {
    logo?: ReactNode
    search?: ReactNode
    menuItems?: NavbarItem[]
    auth?: NavbarAuth
    darkMode?: {
      enabled: boolean
      onToggle: () => void
    }
    className?: string
  }

  export interface OrderBookEntry {
    price: number
    quantity: number
    total: number
  }

  export interface OrderBookConfig {
    priceUnit?: string
    quantityLabel?: string
    totalLabel?: string
    askColor?: string
    bidColor?: string
  }

  export interface OrderBookProps {
    title?: string
    asks?: OrderBookEntry[]
    bids?: OrderBookEntry[]
    summary?: Record<string, unknown>
    config?: OrderBookConfig
    onOrderClick?: (entry: OrderBookEntry, side: 'ask' | 'bid') => void
    className?: string
  }

  export interface TradingPanelConfig {
    buyButtonText?: string
    sellButtonText?: string
    buyButtonColor?: string
    sellButtonColor?: string
    disclaimer?: string
  }

  export interface TradingPanelProps {
    currentPrice?: number
    selectedTab?: 'buy' | 'sell'
    selectedOption?: string
    tradeType?: 'market' | 'limit'
    limitPrice?: number
    amount?: number
    maxAmount?: number
    isDropdownOpen?: boolean
    priceUnit?: string
    quickAmounts?: Array<number | string>
    config?: TradingPanelConfig
    onTabChange?: (tab: 'buy' | 'sell') => void
    onOptionChange?: (option: string) => void
    onTradeTypeChange?: (type: 'market' | 'limit') => void
    onLimitPriceChange?: (price: number) => void
    setIsDropdownOpen?: (open: boolean) => void
    onAmountChange?: (amount: number) => void
    onQuickAmountClick?: (amount: number | string) => void
    onSubmit?: () => void
    className?: string
    isMoreMenuOpen?: boolean
    setIsMoreMenuOpen?: (open: boolean) => void
  }

  export interface MarketPageProps {
    marketId?: string
    className?: string
  }

  export const ThemeProvider: ComponentType<{ children?: ReactNode }>
  export const useDarkMode: () => ThemeContextValue
  export const Navbar: ComponentType<NavbarProps>
  export const NavbarUI: ComponentType<NavbarProps>
  export const OrderBook: ComponentType<OrderBookProps>
  export const OrderBookUI: ComponentType<OrderBookProps>
  export const TradingPanel: ComponentType<TradingPanelProps>
  export const TradingPanelUI: ComponentType<TradingPanelProps>
  export const MarketPage: ComponentType<MarketPageProps>
  export const MarketPageUI: ComponentType<MarketPageProps>
  export const MarketChart: ComponentType<Record<string, any>>
  export const Comments: ComponentType<Record<string, any>>
}
