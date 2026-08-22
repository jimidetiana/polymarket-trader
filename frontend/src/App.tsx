import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import DashboardPage from '@/pages/dashboard'
import SoccerPage from '@/pages/soccer'
import TranslationsPage from '@/pages/translations'

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/soccer" element={<SoccerPage />} />
          <Route path="/translations" element={<TranslationsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
