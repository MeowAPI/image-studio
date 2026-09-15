import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { BrandingProvider } from './branding'
import { ThemeProvider } from './hooks/useTheme'
import ImageStudio from './pages/ImageStudio'
import { ToastProvider } from './components/ToastProvider'
import StudioKeyDialog from './components/StudioKeyDialog'
import { importURLKey } from './lib/studioKey'
import './i18n'

// Before routing or rendering; URL imports also work on a history/gallery deep link.
importURLKey()
createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><ThemeProvider><BrandingProvider><ToastProvider><StudioKeyDialog />
    <main className="studio-app-shell"><Routes>
      <Route path="/images/:view" element={<ImageStudio />} />
      <Route path="/" element={<ImageStudio />} />
      <Route path="/image-studio/:view" element={<ImageStudio />} />
      <Route path="*" element={<ImageStudio />} />
    </Routes></main>
  </ToastProvider></BrandingProvider></ThemeProvider></BrowserRouter></StrictMode>,
)
