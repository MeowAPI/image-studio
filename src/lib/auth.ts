export type StudioUser = { id: number; issuer: string; owner: string }
export type LoginRequest = { resolve: (user: StudioUser) => void; reject: (error: Error) => void }
let user: StudioUser | null = null
let startupError = ''
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('image-studio-auth') : null

export function readUser() { return user }
export function readAuthError() { return startupError }
export function setUser(value: StudioUser | null) {
  if (user?.owner === value?.owner) return
  user = value
  window.dispatchEvent(new Event('studio:auth-changed'))
}
export async function sessionFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.method && init.method !== 'GET') headers.set('X-Studio-Request', '1')
  const response = await fetch(input, { signal: AbortSignal.timeout(35_000), ...init, headers, credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && input !== '/api/auth/legacy-owner') setUser(null)
    throw new Error(body?.error?.message || `Request failed (${response.status})`)
  }
  if (!body) throw new Error('The server returned invalid JSON.')
  return body
}
export async function refreshSession() {
  const body = await sessionFetch('/api/auth/session')
  const value = body.user
  if (value && (!Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.issuer !== 'string' ||
      value.owner !== `new-api:${value.issuer}:${value.id}`)) throw new Error('Invalid account identity.')
  setUser(value || null)
}
export async function initializeAuth() {
  const url = new URL(location.href)
  if (url.searchParams.has('auth_error')) startupError = 'imageStudioPortal.authFailed'
  // Retire URL key login and remove callback values before rendering the page.
  for (const name of ['key', 'apikey', 'code', 'state', 'auth_error']) url.searchParams.delete(name)
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  try {
    await refreshSession()
    channel?.postMessage('changed')
  } catch { startupError = 'imageStudioPortal.sessionUnavailable' }
}
export function requireUser(): Promise<StudioUser> {
  if (user) return Promise.resolve(user)
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent<LoginRequest>('studio:request-login', { detail: { resolve, reject } }))
  })
}
export async function startLogin() {
  if (!window.dispatchEvent(new Event('studio:before-login', { cancelable: true }))) throw new Error('Unable to save the login draft.')
  const body = await sessionFetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_to: location.pathname + location.search + location.hash }),
  })
  location.assign(body.url)
}
export async function logout() {
  await sessionFetch('/api/auth/logout', { method: 'POST' })
  setUser(null)
  channel?.postMessage('changed')
}
channel?.addEventListener('message', () => { void refreshSession().catch(() => {}) })
