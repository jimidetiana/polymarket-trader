import { useMemo, useState } from 'react'
import { TradingPanelUI } from 'polymarket-ui-sdk'
import { ErrorBoundary } from '@/components/error-boundary'

interface SdkTradingPanelAdapterProps {
  currentPrice: number
  maxAmount?: number
  outcomeName?: string
  onSubmit: (values: {
    side: 'BUY' | 'SELL'
    size: number
    price: number
    type: 'market' | 'limit'
  }) => void
}

export function SdkTradingPanelAdapter({
  currentPrice,
  maxAmount = 10000,
  outcomeName = '',
  onSubmit,
}: SdkTradingPanelAdapterProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [selectedOption, setSelectedOption] = useState<'yes' | 'no'>(
    outcomeName.toLowerCase().includes('no') ? 'no' : 'yes',
  )
  const [tradeType, setTradeType] = useState<'market' | 'limit'>('limit')
  const [amount, setAmount] = useState(10)
  const [limitPrice, setLimitPrice] = useState(Math.round(currentPrice * 100))
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)

  const effectivePrice = useMemo(
    () => (selectedOption === 'yes' ? currentPrice : 1 - currentPrice),
    [currentPrice, selectedOption],
  )

  return (
    <ErrorBoundary>
      <TradingPanelUI
        currentPrice={Math.round(effectivePrice * 100)}
        selectedTab={side}
        selectedOption={selectedOption}
        tradeType={tradeType}
        limitPrice={limitPrice}
        amount={amount}
        maxAmount={maxAmount}
        priceUnit="¢"
        quickAmounts={[10, 50, 100, 'Max']}
        isDropdownOpen={isDropdownOpen}
        isMoreMenuOpen={isMoreMenuOpen}
        setIsDropdownOpen={setIsDropdownOpen}
        setIsMoreMenuOpen={setIsMoreMenuOpen}
        onTabChange={(tab) => setSide(tab)}
        onOptionChange={(option) => setSelectedOption(option as 'yes' | 'no')}
        onTradeTypeChange={(type) => setTradeType(type)}
        onAmountChange={(value) => setAmount(value)}
        onLimitPriceChange={(value) => setLimitPrice(value)}
        onQuickAmountClick={(value) => {
          if (value === 'Max') {
            setAmount(maxAmount)
          } else {
            setAmount(Number(value))
          }
        }}
        onSubmit={() =>
          onSubmit({
            side: side === 'buy' ? 'BUY' : 'SELL',
            size: amount,
            price: tradeType === 'market' ? effectivePrice : limitPrice / 100,
            type: tradeType,
          })
        }
        config={{
          buyButtonText: '买入',
          sellButtonText: '卖出',
          buyButtonColor: 'bg-emerald-600 hover:bg-emerald-700',
          sellButtonColor: 'bg-rose-600 hover:bg-rose-700',
          disclaimer: '点击下单即表示同意服务条款',
        }}
        className="!w-full"
      />
    </ErrorBoundary>
  )
}
