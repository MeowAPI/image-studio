import './index.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { BrandingProvider } from './branding'
import { ThemeProvider } from './hooks/useTheme'
import ImageStudio from './pages/ImageStudio'
import { ToastProvider } from './components/ToastProvider'
import StudioLoginDialog from './components/StudioLoginDialog'
import { initializeAuth, readUser } from './lib/auth'
import { migrateLegacyHistory } from './api'
import './i18n'

await initializeAuth()
await migrateLegacyHistory()
function StudioRoutes() {
  const [owner, setOwner] = useState(() => readUser()?.owner || '')
  useEffect(() => {
    const changed = () => setOwner(readUser()?.owner || '')
    window.addEventListener('studio:auth-changed', changed)
    return () => window.removeEventListener('studio:auth-changed', changed)
  }, [])
  const page = <ImageStudio key={owner} />
  return <Routes>
    <Route path="/images/:view" element={page} />
    <Route path="/" element={page} />
    <Route path="/image-studio/:view" element={page} />
    <Route path="*" element={page} />
  </Routes>
}
createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><ThemeProvider><BrandingProvider><ToastProvider><StudioLoginDialog />
    <main className="studio-app-shell"><StudioRoutes /></main>
  </ToastProvider></BrandingProvider></ThemeProvider></BrowserRouter></StrictMode>,
)
