import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII='

export async function newApiFixture(t) {
  const fixture = { account: 1, exchanges: 0, requests: [], keys: new Map([['sk-legacy-user-1', 1], ['sk-legacy-user-2', 2]]), revoked: new Set(), codes: new Map(), imageStatus: 200, exchangePatch: {} }
  fixture.issueCode = (state, userId = fixture.account) => {
    const code = `test-code-${fixture.codes.size}-${Date.now()}`
    fixture.codes.set(code, { state, userId })
    return code
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/client-connect') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      // The fake authorization server shows a consent step without real accounts.
      const params = new URLSearchParams({ callback_url: url.searchParams.get('callback_url'), state: url.searchParams.get('state') })
      res.end(`<html lang="zh"><body><h1>new-api test consent</h1><a href="/approve?${params}">确认授权</a></body></html>`)
      return
    }
    if (url.pathname === '/approve') {
      const target = new URL(url.searchParams.get('callback_url'))
      assert.equal(target.origin, fixture.studioOrigin)
      assert.equal(target.pathname, '/api/auth/callback')
      const state = url.searchParams.get('state')
      target.searchParams.set('code', fixture.issueCode(state))
      target.searchParams.set('state', state)
      res.writeHead(303, { Location: target.href }); res.end(); return
    }
    if (url.pathname === '/api/token/client-connect/exchange') {
      fixture.exchanges++
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      const grant = fixture.codes.get(body.code)
      if (!grant || grant.state !== body.state) return json(400, { success: false })
      fixture.codes.delete(body.code)
      const key = `sk-studio-test-${grant.userId}-${fixture.exchanges}`
      fixture.lastKey = key
      fixture.keys.set(key, grant.userId)
      return json(200, { success: true, data: { user_id: grant.userId, state: grant.state, apikey: key, name: 'test-client', baseurl: fixture.origin, ...fixture.exchangePatch } })
    }
    if (url.pathname === '/api/usage/token/') {
      const key = req.headers.authorization?.replace(/^Bearer /, '')
      const userId = fixture.keys.get(key)
      if (!userId || fixture.revoked.has(key)) return json(401, { success: false })
      return json(200, { code: true, data: { user_id: userId, object: 'token_usage', name: 'test-client' } })
    }
    if (url.pathname.startsWith('/v1/images/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      fixture.requests.push({ path: url.pathname, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() })
      if (fixture.imageStatus === 302) { res.writeHead(302, { Location: fixture.origin + '/credential-leak' }); res.end(); return }
      return json(fixture.imageStatus, fixture.imageStatus === 200 ? { data: [{ b64_json: png }] } : { error: { message: 'Test upstream rejection' } })
    }
    fixture.unexpected = url.pathname
    return json(404, { error: { message: 'Not found' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  fixture.origin = `http://127.0.0.1:${server.address().port}`
  return fixture
}

export async function studioFixture(t, upstream, { dev = false, publicOrigin } = {}) {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const dataRoot = await mkdtemp(join(tmpdir(), 'image-studio-auth-test-'))
  const origin = `http://127.0.0.1:${port}`
  upstream.studioOrigin = publicOrigin || origin
  let app
  let output = ''
  const start = async () => {
    output = ''
    app = spawn(process.execPath, ['server.mjs', ...(dev ? ['--dev'] : [])], {
      cwd: resolve(import.meta.dirname, '..'), windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), IMAGE_API_ENDPOINT: `${upstream.origin}/v1/images/generations`,
        IMAGE_EDIT_ENDPOINT: '', NEW_API_BASE_URL: upstream.origin, IMAGE_STUDIO_ORIGIN: publicOrigin || origin, IMAGE_STUDIO_ALLOW_LOOPBACK_HTTP: '1', IMAGE_DATA_DIR: dataRoot },
      stdio: 'pipe',
    })
    app.stdout.on('data', chunk => { output += chunk })
    app.stderr.on('data', chunk => { output += chunk })
    for (let attempt = 0; attempt < 150; attempt++) {
      if (app.exitCode !== null) throw new Error(`Studio exited: ${output}`)
      try { if ((await fetch(origin + '/api/branding')).ok) return } catch {}
      await delay(100)
    }
    throw new Error(`Studio did not start: ${output}`)
  }
  const stop = async () => {
    if (!app || app.exitCode !== null) return
    await new Promise(resolve => { app.once('exit', resolve); app.kill() })
  }
  t.after(async () => { await stop(); await rm(dataRoot, { recursive: true, force: true }) })
  await start()
  return { origin, publicOrigin: publicOrigin || origin, dataRoot, start, stop, output: () => output }
}

export function browserCookies() {
  const jar = new Map()
  return {
    header: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    update(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';')
        const index = pair.indexOf('=')
        const name = pair.slice(0, index), value = pair.slice(index + 1)
        if (value) jar.set(name, value); else jar.delete(name)
      }
    },
  }
}

export async function beginLogin(studio, cookies, returnTo = '/') {
  const response = await fetch(studio.origin + '/api/auth/login', {
    method: 'POST', headers: { Origin: studio.publicOrigin, Cookie: cookies.header(), 'X-Studio-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_to: returnTo }),
  })
  assert.equal(response.status, 200)
  cookies.update(response)
  return new URL((await response.json()).url)
}

export async function finishLogin(studio, upstream, cookies, destination, account = 1) {
  const state = destination.searchParams.get('state')
  const code = upstream.issueCode(state, account)
  const callback = `${studio.origin}/api/auth/callback?${new URLSearchParams({ code, state })}`
  const response = await fetch(callback, { headers: { Cookie: cookies.header() }, redirect: 'manual' })
  cookies.update(response)
  return { response, callback }
}

export async function signIn(page) {
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '使用 KurumiAI 账号登录', exact: true }).click()
  await page.getByRole('link', { name: '确认授权', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor()
}
