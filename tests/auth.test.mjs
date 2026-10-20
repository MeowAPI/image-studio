import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { newApiFixture, studioFixture, browserCookies, beginLogin, finishLogin } from './auth-fixture.mjs'
import { trustedURL } from '../auth.mjs'

test('account authorization binds callbacks, rotates sessions, hides credentials, and survives restart', async t => {
  const upstream = await newApiFixture(t)
  const studio = await studioFixture(t, upstream)
  const cookies = browserCookies()
  const headers = () => ({ Cookie: cookies.header(), Origin: studio.origin, 'X-Studio-Request': '1', 'X-Studio-User': '1', 'Content-Type': 'application/json' })
  const profile = async () => {
    const response = await fetch(studio.origin + '/api/auth/session', { headers: headers() })
    assert.equal(response.status, 200)
    return response.json()
  }
  assert.deepEqual(await profile(), { user: null })
  const directKey = await fetch(studio.origin + '/api/images/generations', { method: 'POST', headers: { ...headers(), Authorization: 'Bearer sk-legacy-user-1' }, body: '{}' })
  assert.equal(directKey.status, 401)

  const destination = await beginLogin(studio, cookies, '/images/gallery?keep=yes')
  assert.equal(destination.origin, upstream.origin)
  assert.equal(destination.pathname, '/client-connect')
  assert.equal(destination.searchParams.get('callback_url'), studio.origin + '/api/auth/callback')
  const state = destination.searchParams.get('state')
  assert.equal(state.length, 43)
  for (const query of [
    { code: 'unclaimed-code', state: 'wrong-state' },
    { code: 'unclaimed-code', state: '汉'.repeat(43) },
  ]) {
    const response = await fetch(studio.origin + '/api/auth/callback?' + new URLSearchParams(query), { headers: headers(), redirect: 'manual' })
    assert.equal(response.headers.get('location'), '/?auth_error=invalid_callback')
  }
  assert.equal(upstream.exchanges, 0)
  const duplicate = await fetch(`${studio.origin}/api/auth/callback?code=x&state=${state}&state=${state}`, { headers: headers(), redirect: 'manual' })
  assert.equal(duplicate.headers.get('location'), '/?auth_error=invalid_callback')
  const { response, callback } = await finishLogin(studio, upstream, cookies, destination)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/images/gallery?keep=yes')
  const sessionCookie = response.headers.getSetCookie().find(line => line.startsWith('image_studio_session='))
  assert.match(sessionCookie, /HttpOnly/)
  assert.match(sessionCookie, /SameSite=Lax/)
  assert.match(sessionCookie, /Path=\//)
  const firstCookie = cookies.header()
  const first = await profile()
  assert.deepEqual(first.user, { id: 1, issuer: upstream.origin, owner: `new-api:${upstream.origin}:1` })
  assert.equal(JSON.stringify(first).includes('sk-'), false)
  const replay = await fetch(callback, { headers: headers(), redirect: 'manual' })
  assert.equal(replay.headers.get('location'), '/?auth_error=invalid_callback')
  assert.equal(upstream.exchanges, 1)

  for (const changed of [
    { Origin: 'https://other.example' },
    { Origin: '' },
    { 'X-Studio-Request': '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await fetch(studio.origin + '/api/auth/logout', { method: 'POST', headers: { ...headers(), ...changed } })
    assert.equal(response.status, 403)
  }
  assert.equal((await profile()).user.id, 1)
  const key = upstream.lastKey
  const image = await fetch(studio.origin + '/api/images/generations', { method: 'POST', headers: { ...headers(), Authorization: 'Bearer attacker-key' }, body: '{"prompt":"test"}' })
  assert.equal(image.status, 200)
  assert.equal(upstream.requests[0].authorization, `Bearer ${key}`)
  const stale = await fetch(studio.origin + '/api/images/generations', { method: 'POST', headers: { ...headers(), 'X-Studio-User': '2' }, body: '{}' })
  assert.equal(stale.status, 409)
  assert.equal(upstream.requests.length, 1)
  const batches = await readdir(join(studio.dataRoot, 'images'))
  const manifest = JSON.parse(await readFile(join(studio.dataRoot, 'images', batches[0], 'manifest.json'), 'utf8'))
  assert.equal(manifest.user_id, 1)
  assert.equal(manifest.issuer, upstream.origin)
  assert.equal(JSON.stringify(manifest).includes(key), false)

  const sessionFiles = await readdir(join(studio.dataRoot, 'auth', 'sessions'))
  const encrypted = await readFile(join(studio.dataRoot, 'auth', 'sessions', sessionFiles[0]))
  assert.equal(encrypted.includes(Buffer.from(key)), false)
  await studio.stop()
  await studio.start()
  assert.deepEqual(await profile(), first)

  const renewed = await beginLogin(studio, cookies)
  await finishLogin(studio, upstream, cookies, renewed)
  assert.notEqual(upstream.lastKey, key)
  assert.deepEqual(await profile(), first)
  const old = await fetch(studio.origin + '/api/auth/session', { headers: { Cookie: firstCookie } })
  assert.deepEqual(await old.json(), { user: null })
  const activeCookie = cookies.header()
  const logout = await fetch(studio.origin + '/api/auth/logout', { method: 'POST', headers: headers() })
  cookies.update(logout)
  assert.equal(logout.status, 200)
  assert.deepEqual(await profile(), { user: null })
  const oldAfterLogout = await fetch(studio.origin + '/api/auth/session', { headers: { Cookie: activeCookie } })
  assert.deepEqual(await oldAfterLogout.json(), { user: null })
})

test('legacy history requires matching key ownership; revoked and idle sessions expire', async t => {
  const upstream = await newApiFixture(t)
  const studio = await studioFixture(t, upstream)
  const cookies = browserCookies()
  await finishLogin(studio, upstream, cookies, await beginLogin(studio, cookies))
  const post = key => fetch(studio.origin + '/api/auth/legacy-owner', {
    method: 'POST', headers: { Cookie: cookies.header(), Origin: studio.origin, 'X-Studio-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  })
  const matching = await post('sk-legacy-user-1')
  assert.equal(matching.status, 200)
  assert.equal((await matching.json()).owner, createHash('sha256').update('sk-legacy-user-1').digest('hex'))
  assert.equal((await post('sk-legacy-user-2')).status, 403)
  assert.equal((await post('sk-invalid')).status, 401)
  assert.equal((await (await fetch(studio.origin + '/api/auth/session', { headers: { Cookie: cookies.header() } })).json()).user.id, 1)
  upstream.revoked.add(upstream.lastKey)
  assert.deepEqual(await (await fetch(studio.origin + '/api/auth/session', { headers: { Cookie: cookies.header() } })).json(), { user: null })

  await finishLogin(studio, upstream, cookies, await beginLogin(studio, cookies))
  const root = join(studio.dataRoot, 'auth', 'sessions')
  const file = (await readdir(root))[0]
  const expired = new Date(Date.now() - 2 * 24 * 60 * 60_000)
  await utimes(join(root, file), expired, expired)
  assert.deepEqual(await (await fetch(studio.origin + '/api/auth/session', { headers: { Cookie: cookies.header() } })).json(), { user: null })
})

test('invalid identity, ambiguous callbacks, open redirects, and upstream redirects are rejected', async t => {
  const upstream = await newApiFixture(t)
  const studio = await studioFixture(t, upstream)
  const cookies = browserCookies()
  const destination = await beginLogin(studio, cookies, '//evil.example/steal')
  upstream.exchangePatch = { user_id: 999 }
  const failed = await finishLogin(studio, upstream, cookies, destination)
  assert.equal(failed.response.headers.get('location'), '/?auth_error=exchange_failed')
  const anonymous = await fetch(studio.origin + '/api/auth/session', { headers: { Cookie: cookies.header() } })
  assert.deepEqual(await anonymous.json(), { user: null })
  upstream.exchangePatch = { user_id: undefined }
  const missingIdentity = await finishLogin(studio, upstream, cookies, await beginLogin(studio, cookies))
  assert.equal(missingIdentity.response.headers.get('location'), '/?auth_error=exchange_failed')
  upstream.exchangePatch = {}
  await finishLogin(studio, upstream, cookies, await beginLogin(studio, cookies))
  upstream.imageStatus = 302
  const redirected = await fetch(studio.origin + '/api/images/generations', {
    method: 'POST', headers: { Cookie: cookies.header(), Origin: studio.origin, 'X-Studio-Request': '1', 'X-Studio-User': '1' }, body: '{}',
  })
  assert.equal(redirected.status, 502)
  assert.equal(upstream.unexpected, undefined)
  assert.equal(studio.output().includes(upstream.lastKey), false)
})

test('production URL configuration requires HTTPS and rejects credentials or query values', () => {
  for (const value of ['http://public.example', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#fragment']) {
    assert.throws(() => trustedURL(value))
  }
  assert.equal(trustedURL('http://127.0.0.1:1234', true).protocol, 'http:')
  assert.throws(() => trustedURL('http://public.example', true))
})

test('HTTPS deployments issue host-only Secure and HttpOnly cookies', async t => {
  const upstream = await newApiFixture(t)
  const studio = await studioFixture(t, upstream, { publicOrigin: 'https://studio.example' })
  const cookies = browserCookies()
  const destination = await beginLogin(studio, cookies)
  assert.equal(destination.searchParams.get('callback_url'), 'https://studio.example/api/auth/callback')
  const { response } = await finishLogin(studio, upstream, cookies, destination)
  const session = response.headers.getSetCookie().find(value => value.startsWith('__Host-image_studio_session='))
  assert.ok(session)
  assert.match(session, /; Secure/)
  assert.match(session, /; HttpOnly/)
  assert.match(session, /; Path=\//)
  assert.equal(session.includes('Domain='), false)
})
