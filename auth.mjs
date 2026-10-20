import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const token = () => randomBytes(32).toString('base64url')
const hash = value => createHash('sha256').update(value).digest('hex')
const loginLifetime = 5 * 60_000
const sessionLifetime = 7 * 24 * 60 * 60_000
const idleLifetime = 24 * 60 * 60_000
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true }
const fail = (status, message) => Object.assign(new Error(message), { status })

export function trustedURL(raw, allowLoopbackHttp = false) {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Configure HTTPS URLs; HTTP is allowed only for loopback development.')
  }
  return url
}

export async function readJSON(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw fail(413, 'Request is too large.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw fail(400, 'Invalid JSON request.') }
}

async function remoteJSON(response) {
  if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? 401 : 502, 'Unable to verify the new-api account. Please sign in again.')
  if (!response.body) throw fail(502, 'Invalid new-api response.')
  return readJSON(response.body, 64 * 1024)
}

function returnPath(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/'
  const url = new URL(value, origin)
  if (url.origin !== origin || url.pathname.startsWith('/api/')) return '/'
  for (const name of ['code', 'state', 'key', 'apikey', 'auth_error']) url.searchParams.delete(name)
  return url.pathname + url.search + url.hash
}

export function createAuth({ env = process.env, port, endpoint, dataRoot, transport = fetch }) {
  const attempts = new Map()
  const allowHttp = env.IMAGE_STUDIO_ALLOW_LOOPBACK_HTTP === '1'
  const base = trustedURL(env.NEW_API_BASE_URL || (endpoint ? endpoint.replace(/\/v1\/images\/generations\/?$/, '') : 'https://www.kurumiai.net'), allowHttp)
  base.pathname = base.pathname.replace(/\/+$/, '') + '/'
  const issuer = base.href.replace(/\/$/, '')
  const publicURL = env.IMAGE_STUDIO_ORIGIN || (env.NODE_ENV !== 'production' ? `http://localhost:${port}` : '')
  const origin = publicURL ? trustedURL(publicURL, env.NODE_ENV !== 'production') : null
  if (origin && origin.pathname !== '/') throw new Error('IMAGE_STUDIO_ORIGIN must contain only the scheme and host (including port).')
  const secure = origin?.protocol === 'https:'
  const sessionCookie = `${secure ? '__Host-' : ''}image_studio_session`
  const loginCookie = `${secure ? '__Host-' : ''}image_studio_login`
  const authRoot = join(dataRoot, 'auth')
  const sessionsRoot = join(authRoot, 'sessions')
  let encryptionKey

  const cookie = (name, value, lifetime) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(lifetime / 1000))}${secure ? '; Secure' : ''}`
  function cookies(req, name) {
    const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='))
    return values.length === 1 ? values[0].slice(name.length + 1) : ''
  }
  function requireOrigin(req) {
    if (!origin) throw fail(503, 'Configure IMAGE_STUDIO_ORIGIN before enabling sign-in.')
    if (req.headers.origin !== origin.origin || req.headers['x-studio-request'] !== '1' ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw fail(403, 'Invalid request origin.')
    }
  }
  async function key() {
    return encryptionKey ??= (async () => {
      await mkdir(sessionsRoot, { recursive: true, mode: 0o700 })
      const filename = join(authRoot, 'session-key')
      try { return await readFile(filename) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        const value = randomBytes(32)
        try { await writeFile(filename, value, { flag: 'wx', mode: 0o600 }); return value }
        catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; return readFile(filename) }
      }
    })()
  }
  async function save(id, session) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await key(), iv)
    const bytes = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()])
    await writeFile(join(sessionsRoot, hash(id)), Buffer.concat([iv, cipher.getAuthTag(), bytes]), { mode: 0o600, flag: 'wx' })
  }
  async function destroy(req, res) {
    const id = cookies(req, sessionCookie)
    if (/^[\w-]{43}$/.test(id)) await rm(join(sessionsRoot, hash(id)), { force: true })
    res.setHeader('Set-Cookie', cookie(sessionCookie, '', 0))
  }
  async function identity(apiKey) {
    const response = await transport(new URL('api/usage/token/', base), {
      headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    const reply = await remoteJSON(response)
    if (reply?.code !== true || !Number.isSafeInteger(reply.data?.user_id) || reply.data.user_id <= 0) {
      throw fail(502, 'The new-api server needs the user identity update.')
    }
    return reply.data.user_id
  }
  async function session(req, res, verify = false) {
    const id = cookies(req, sessionCookie)
    if (!/^[\w-]{43}$/.test(id)) return null
    let value
    let info
    const filename = join(sessionsRoot, hash(id))
    try {
      const bytes = await readFile(filename)
      info = await stat(filename)
      const decipher = createDecipheriv('aes-256-gcm', await key(), bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Image Studio session could not be restored.')
      await destroy(req, res)
      return null
    }
    const now = Date.now()
    if (value.issuer !== issuer || value.expiresAt <= now || info.mtimeMs + idleLifetime <= now) {
      await destroy(req, res)
      return null
    }
    if (verify) {
      try {
        if (await identity(value.apiKey) !== value.userId) throw fail(401, 'The account identity changed. Please sign in again.')
      } catch (error) {
        if (error.status !== 401) throw error
        await destroy(req, res)
        return null
      }
    }
    if (now - info.mtimeMs > 60_000) {
      try { await utimes(filename, new Date(now), new Date(now)) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }
    return value
  }
  const user = value => value ? { id: value.userId, issuer: value.issuer, owner: `new-api:${value.issuer}:${value.userId}` } : null

  async function handle(req, res, url) {
    const path = url.pathname
    if (!path.startsWith('/api/auth/')) return false
    res.setHeader('Cache-Control', 'no-store')
    if (path === '/api/auth/session' && req.method === 'GET') {
      return json(res, 200, { user: user(await session(req, res, true)) })
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      requireOrigin(req)
      const body = await readJSON(req)
      const now = Date.now()
      for (const [id, attempt] of attempts) if (attempt.expiresAt <= now) attempts.delete(id)
      const previous = cookies(req, loginCookie)
      if (previous) attempts.delete(hash(previous))
      if (attempts.size >= 1000) throw fail(429, 'Too many sign-in attempts. Please try again later.')
      const id = token()
      const state = token()
      attempts.set(hash(id), { state, returnTo: returnPath(body.return_to, origin.origin), expiresAt: now + loginLifetime })
      const destination = new URL('client-connect', base)
      destination.searchParams.set('callback_url', new URL('/api/auth/callback', origin).href)
      destination.searchParams.set('state', state)
      res.setHeader('Set-Cookie', cookie(loginCookie, id, loginLifetime))
      return json(res, 200, { url: destination.href })
    }
    if (path === '/api/auth/callback' && req.method === 'GET') {
      if (!origin) throw fail(503, 'Configure IMAGE_STUDIO_ORIGIN before enabling sign-in.')
      const id = cookies(req, loginCookie)
      const attempt = attempts.get(hash(id))
      const code = url.searchParams.get('code')
      if (!attempt || attempt.expiresAt <= Date.now() || !equal(url.searchParams.get('state'), attempt.state) ||
          url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 ||
          url.searchParams.has('apikey') || !code?.trim() || code.length > 512) {
        res.writeHead(303, { Location: '/?auth_error=invalid_callback' }); res.end(); return true
      }
      attempts.delete(hash(id))
      res.setHeader('Set-Cookie', cookie(loginCookie, '', 0))
      try {
        const response = await transport(new URL('api/token/client-connect/exchange', base), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ code, state: attempt.state }), signal: AbortSignal.timeout(30_000),
        })
        const reply = await remoteJSON(response)
        const data = reply?.data
        if (reply.success !== true || data?.state !== attempt.state || !/^sk-\S+$/.test(data?.apikey || '') ||
            !Number.isSafeInteger(data.user_id) || data.user_id <= 0 || typeof data.baseurl !== 'string' ||
            trustedURL(data.baseurl, allowHttp).href.replace(/\/$/, '') !== issuer) {
          throw fail(502, 'Invalid account identity.')
        }
        if (await identity(data.apikey) !== data.user_id) throw fail(401, 'The account identity did not match.')
        await destroy(req, res)
        const sessionId = token()
        const now = Date.now()
        await save(sessionId, { userId: data.user_id, issuer, apiKey: data.apikey, createdAt: now, expiresAt: now + sessionLifetime })
        res.setHeader('Set-Cookie', [cookie(loginCookie, '', 0), cookie(sessionCookie, sessionId, sessionLifetime)])
        res.writeHead(303, { Location: attempt.returnTo }); res.end()
      } catch {
        console.warn('Image Studio sign-in failed during account verification.')
        const target = new URL(attempt.returnTo, origin)
        target.searchParams.set('auth_error', 'exchange_failed')
        res.writeHead(303, { Location: target.pathname + target.search + target.hash }); res.end()
      }
      return true
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      requireOrigin(req)
      await destroy(req, res)
      const attemptId = cookies(req, loginCookie)
      if (attemptId) attempts.delete(hash(attemptId))
      res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0), cookie(loginCookie, '', 0)])
      return json(res, 200, { success: true })
    }
    if (path === '/api/auth/legacy-owner' && req.method === 'POST') {
      requireOrigin(req)
      const current = await session(req, res, true)
      if (!current) throw fail(401, 'Please sign in first.')
      const body = await readJSON(req, 4096)
      if (typeof body.key !== 'string' || !/^sk-\S+$/.test(body.key) || body.key.length > 512) throw fail(400, 'Invalid legacy key.')
      if (await identity(body.key) !== current.userId) throw fail(403, 'This history belongs to a different account.')
      return json(res, 200, { owner: hash(body.key), user: user(current) })
    }
    json(res, 405, { error: { message: 'Method not allowed.' } })
    return true
  }
  async function requireSession(req, res) {
    requireOrigin(req)
    const current = await session(req, res, true)
    if (!current) throw fail(401, 'Please sign in with your new-api account.')
    if (req.headers['x-studio-user'] !== String(current.userId)) throw fail(409, 'The signed-in account changed. Refresh the page before generating images.')
    return current
  }
  async function prune() {
    await key()
    await chmod(authRoot, 0o700)
    for (const name of await readdir(sessionsRoot)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const filename = join(sessionsRoot, name)
      const info = await stat(filename).catch(() => null)
      if (info && Date.now() - info.mtimeMs > idleLifetime) await rm(filename, { force: true })
    }
  }
  return { handle, requireSession, destroy, issuer, prune }
}
