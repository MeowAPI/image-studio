import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { startLogin } from '../lib/auth'
import type { LoginRequest } from '../lib/auth'
import StudioAccountNotice from './image-studio/StudioAccountNotice'
export default function StudioLoginDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requests = useRef<LoginRequest[]>([])
  useEffect(() => {
    const handler = (event: Event) => { requests.current.push((event as CustomEvent<LoginRequest>).detail); setError(''); setOpen(true) }
    window.addEventListener('studio:request-login', handler)
    return () => window.removeEventListener('studio:request-login', handler)
  }, [])
  function close() { setOpen(false); requests.current.splice(0).forEach(r => r.reject(new Error(t('imageStudioPortal.loginCancelled')))) }
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}><DialogContent className="sm:max-w-md">
    <DialogHeader><DialogTitle>{t('imageStudioPortal.loginTitle')}</DialogTitle><DialogDescription>{t('imageStudioPortal.loginSubtitle')}</DialogDescription></DialogHeader>
    <StudioAccountNotice compact />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button className="w-full" disabled={loading} onClick={() => {
      setLoading(true); setError('')
      void startLogin().catch(() => { setError(t('imageStudioPortal.authFailed')); setLoading(false) })
    }}>{t(loading ? 'imageStudioPortal.redirecting' : 'imageStudioPortal.loginWithAccount')}</Button>
  </DialogContent></Dialog>
}
