import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { writeStoredAPIKey } from '../lib/studioKey'
import type { KeyRequest } from '../lib/requestKey'
export default function StudioKeyDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [remember, setRemember] = useState(true)
  const requests = useRef<KeyRequest[]>([])
  useEffect(() => {
    const handler = (event: Event) => { requests.current.push((event as CustomEvent<KeyRequest>).detail); setOpen(true) }
    window.addEventListener('studio:request-key', handler)
    return () => window.removeEventListener('studio:request-key', handler)
  }, [])
  function close() { setOpen(false); requests.current.splice(0).forEach(r => r.reject(new Error('已取消输入 API Key'))); setKey('') }
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}><DialogContent className="sm:max-w-md">
    <DialogHeader><DialogTitle>{t('imageStudioPortal.loginTitle')}</DialogTitle><DialogDescription>{t('imageStudioPortal.loginSubtitle')}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); const value = key.trim(); if (!value) return; writeStoredAPIKey(value, remember); window.dispatchEvent(new Event('studio:key-changed')); setOpen(false); setKey(''); requests.current.splice(0).forEach(r => r.resolve(value)) }}>
      <Input aria-label="API Key" type="password" placeholder="sk-..." value={key} onChange={e => setKey(e.target.value)} autoFocus />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />{t('imageStudioPortal.rememberKey')}</label>
      <Button type="submit" className="w-full" disabled={!key.trim()}>保存并继续</Button>
    </form>
  </DialogContent></Dialog>
}
