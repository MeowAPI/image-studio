export const STORAGE_KEY = 'codex2api_image_studio_api_key'
let temporaryKey = ''
export function readStoredAPIKey(): { key: string; remember: boolean } {
  if (temporaryKey) return { key: temporaryKey, remember: false }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const value = JSON.parse(raw)
      if (typeof value.key === 'string') return { key: value.key.trim(), remember: value.remember !== false }
    }
    // Migrate the previous standalone prototype's key.
    return { key: localStorage.getItem('image_atelier_api_key') || '', remember: true }
  } catch { return { key: '', remember: true } }
}
export function writeStoredAPIKey(key: string, remember: boolean) {
  temporaryKey = key
  try {
    localStorage.removeItem('image_atelier_api_key')
    if (remember) { localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, remember })); temporaryKey = '' }
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* Keep the key in memory when storage is unavailable. */ }
}
export function clearStoredAPIKey() {
  temporaryKey = ''
  try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem('image_atelier_api_key') } catch { /* unavailable */ }
}
// The history warning is re-shown whenever the API key changes, because that is
// the moment history created under the previous key becomes unreachable.
export const HISTORY_WARNING_DISMISSED_KEY = 'codex2api_image_studio_history_warning_dismissed'
export function readHistoryWarningDismissed(): boolean {
  try { return localStorage.getItem(HISTORY_WARNING_DISMISSED_KEY) === '1' } catch { return false }
}
export function writeHistoryWarningDismissed(dismissed: boolean) {
  try {
    if (dismissed) localStorage.setItem(HISTORY_WARNING_DISMISSED_KEY, '1')
    else localStorage.removeItem(HISTORY_WARNING_DISMISSED_KEY)
  } catch { /* Without storage the notice simply shows again on the next visit. */ }
}
export function importURLKey() {
  const url = new URL(location.href)
  if (!url.searchParams.has('key')) return
  const key = url.searchParams.get('key')?.trim()
  url.searchParams.delete('key')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  if (key) {
    writeStoredAPIKey(key, true)
    // This runs before React mounts, so no studio:key-changed event can carry the
    // change; clear the dismissal here instead so the warning re-arms for the new key.
    writeHistoryWarningDismissed(false)
  }
}
