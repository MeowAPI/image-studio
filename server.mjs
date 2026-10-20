import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname, join, sep } from 'node:path'
import { loadEnvFile } from 'node:process'
import { createAuth, trustedURL } from './auth.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
try { loadEnvFile(resolve(directory, '.env')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const dev = process.argv.includes('--dev')
const port = Number(process.env.PORT || (dev ? 5173 : 3000))
const endpoint = process.env.IMAGE_API_ENDPOINT || process.env.VITE_IMAGE_API_ENDPOINT || ''
const editEndpoint = process.env.IMAGE_EDIT_ENDPOINT || endpoint.replace(/\/generations\/?$/, '/edits')
const dist = resolve(directory, 'dist')
const dataRoot = resolve(directory, process.env.IMAGE_DATA_DIR || 'data')
const auth = createAuth({ port, endpoint, dataRoot })
for (const target of [endpoint, editEndpoint].filter(Boolean)) {
  if (trustedURL(target, process.env.IMAGE_STUDIO_ALLOW_LOOPBACK_HTTP === '1').origin !== new URL(auth.issuer).origin) {
    throw new Error('Image endpoints must use the configured new-api origin.')
  }
}
let vite = null
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const supportedFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'])
function safeExtension(value) {
  const normalized = String(value || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!supportedFormats.has(normalized)) return 'bin'
  return normalized === 'jpeg' ? 'jpg' : normalized
}
async function persistImageResponse(body, requestPath, session) {
  const payload = JSON.parse(body.toString('utf8'))
  if (!Array.isArray(payload?.data) || !payload.data.length) return 0
  const batchDirectory = join(dataRoot, 'images', `${Date.now()}-${randomUUID()}`)
  const assets = []
  for (const [index, item] of payload.data.entries()) {
    let bytes
    let extension = safeExtension(item?.output_format || item?.format || 'png')
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      bytes = Buffer.from(item.b64_json, 'base64')
    } else if (typeof item?.url === 'string' && /^https?:\/\//i.test(item.url)) {
      const response = await fetch(item.url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`asset download failed (${response.status})`)
      bytes = Buffer.from(await response.arrayBuffer())
      extension = safeExtension(response.headers.get('content-type')?.split(';', 1)[0]?.split('/', 2)[1] || extension)
    }
    if (!bytes?.length) continue
    const filename = `image-${String(index + 1).padStart(2, '0')}.${extension}`
    await mkdir(batchDirectory, { recursive: true })
    await writeFile(join(batchDirectory, filename), bytes, { flag: 'wx' })
    assets.push({ filename, bytes: bytes.byteLength, format: extension })
  }
  if (!assets.length) return 0
  await writeFile(join(batchDirectory, 'manifest.json'), `${JSON.stringify({ created_at: new Date().toISOString(), request_path: requestPath, user_id: session.userId, issuer: session.issuer, assets }, null, 2)}\n`)
  return assets.length
}
const server = createServer(async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (!vite && decodeURIComponent(path).split('/').some(part => part.startsWith('.'))) { res.writeHead(404); res.end('Not found'); return }
    if (await auth.handle(req, res, url)) return
    if (path === '/api/branding') return json(res, 200, { site_name: process.env.SITE_NAME || 'CodexProxy', site_logo: process.env.SITE_LOGO || '' })
    if (['/api/images/generations', '/api/images/edits'].includes(path)) {
      if (req.method !== 'POST') return json(res, 405, { error: { message: 'Method not allowed' } })
      const session = await auth.requireSession(req, res)
      const target = path.endsWith('/edits') ? editEndpoint : endpoint
      if (!target) return json(res, 503, { error: { message: '请在服务器 .env 中设置 IMAGE_API_ENDPOINT，然后重启服务。' } })
      if (!['https:', 'http:'].includes(new URL(target).protocol)) throw new Error('Invalid upstream URL')
      const chunks = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 40 * 1024 * 1024) return json(res, 413, { error: { message: '参考图片请求超过 40 MB' } }); chunks.push(chunk) }
      const upstream = await fetch(target, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${session.apiKey}`, 'Content-Type': req.headers['content-type'] || 'application/json' },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(590_000),
      })
      const responseBody = Buffer.from(await upstream.arrayBuffer())
      if (upstream.ok) {
        try {
          const saved = await persistImageResponse(responseBody, path, session)
          if (saved) console.log(`Persisted ${saved} generated image(s) under ${dataRoot}`)
        } catch (error) {
          console.warn(`Unable to persist generated image(s) under ${dataRoot}: ${error.message}`)
        }
      }
      if (upstream.status === 401) await auth.destroy(req, res)
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
      res.end(responseBody)
      return
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: { message: 'Not found' } })
    if (vite) return vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found') })
    const candidate = resolve(dist, '.' + decodeURIComponent(path))
    if (!candidate.startsWith(dist + sep) && candidate !== dist) { res.writeHead(403); res.end(); return }
    let file = candidate
    if (!(await stat(file).catch(() => null))?.isFile()) {
      if (extname(path)) { res.writeHead(404); res.end('Not found'); return }
      file = resolve(dist, 'index.html')
    }
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(body)
  } catch (error) {
    if (res.headersSent) res.destroy()
    else json(res, error.status || 502, { error: { message: error.status ? error.message : error.name === 'TimeoutError' ? '图片服务请求超时' : '请求未完成，请检查服务端端点配置及上游连接。' } })
  }
})
if (dev) vite = await (await import('vite')).createServer({ root: directory, server: { middlewareMode: true, hmr: { server } } })
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Image Studio: http://localhost:${port}`))
void auth.prune().catch(() => console.warn('Image Studio session cleanup could not complete.'))
setInterval(() => { void auth.prune().catch(() => {}) }, 60 * 60_000).unref()
