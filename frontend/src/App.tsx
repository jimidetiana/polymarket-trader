import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import SoccerPage from '@/pages/soccer'
import TranslationsPage from '@/pages/translations'
import WalletPage from '@/pages/wallet'

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/soccer" replace />} />
          <Route path="/soccer" element={<SoccerPage />} />
          <Route path="/translations" element={<TranslationsPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="*" element={<Navigate to="/soccer" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
