import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import SoccerPage from '@/pages/soccer'
import TranslationsPage from '@/pages/translations'
import WalletPage from '@/pages/wallet'
import LiveMonitorPage from '@/pages/live-monitor'
import ValueBotPage from '@/pages/value-bot'
import PriceBotPage from '@/pages/price-bot'
import OrdersPage from '@/pages/orders'

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/soccer" replace />} />
          <Route path="/soccer" element={<SoccerPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/live" element={<LiveMonitorPage />} />
          <Route path="/value-bot" element={<ValueBotPage />} />
          <Route path="/price-bot" element={<PriceBotPage />} />
          <Route path="/translations" element={<TranslationsPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="*" element={<Navigate to="/soccer" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
