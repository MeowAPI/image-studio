export function readLegacyAPIKey(): string {
  try {
    const raw = localStorage.getItem('codex2api_image_studio_api_key')
    if (raw) {
      const value = JSON.parse(raw)
      if (typeof value.key === 'string') return value.key.trim()
    }
    return localStorage.getItem('image_atelier_api_key')?.trim() || ''
  } catch { return '' }
}
export function clearLegacyAPIKey() {
  localStorage.removeItem('codex2api_image_studio_api_key')
  localStorage.removeItem('image_atelier_api_key')
}
export function readAccountNoticeDismissed(owner: string): boolean {
  try { return localStorage.getItem(`image_studio_account_notice:${owner}`) === '1' } catch { return false }
}
export function dismissAccountNotice(owner: string) {
  try {
    localStorage.setItem(`image_studio_account_notice:${owner}`, '1')
  } catch { /* Without storage the notice simply shows again on the next visit. */ }
}
