/**
 * Login-flow tests.
 *
 * Everything here runs offline: the Bilibili endpoints are replaced by a stubbed
 * global `fetch`, which is exactly what `lib/http.js` calls, so the real
 * transport, retry and cookie code still executes.
 *
 * Two behaviours are worth more than the rest and are covered explicitly:
 *
 * - the **inner** `data.code` decides the poll state (the envelope `code` is `0`
 *   even for "not scanned yet", so reading the wrong one reports success far too
 *   early);
 * - the session is recovered from **either** `Set-Cookie` **or** the
 *   `crossDomain` URL, because Bilibili sends both and either can go missing.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractSession, pollQrLogin, startQrLogin } from '../lib/login.js'
import { qrMatrix, qrPng, qrSvg } from '../lib/qr.js'
import { clearSession, describeCookie, readSession, sessionPath, writeSession } from '../lib/session.js'
import { apply } from '../index.js'
import { Config } from '../index.js'
import { sessionWorkspace } from '../index.js'
import { harness } from './harness.mjs'

/** Real `fetch`, restored after the suite. */
const realFetch = globalThis.fetch

/** Directory used for session files. */
let sessionHome

/** Put the session file in a scratch directory, and keep Bilibili cookie env out. */
before(() => {
  sessionHome = mkdtempSync(join(tmpdir(), 'video-srt-login-'))
  process.env.DSH_VIDEO_SRT_HOME = sessionHome
  delete process.env.DSH_VIDEO_SRT_BILIBILI_COOKIE
})

/** Restore the environment and the real fetch. */
after(() => {
  globalThis.fetch = realFetch
  delete process.env.DSH_VIDEO_SRT_HOME
  rmSync(sessionHome, { recursive: true, force: true })
})

/** Remove any session file between tests. */
beforeEach(() => {
  globalThis.fetch = realFetch
  rmSync(join(sessionHome, 'session.json'), { force: true })
})

/**
 * Replace `fetch` with one canned response.
 *
 * @param {{status?: number, body: string, cookies?: string[]}} reply What to answer.
 * @returns {string[]} The requested URLs, filled in as they are called.
 */
function stubFetch(reply) {
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return replyFor(String(url), reply)
  }
  return seen
}

/**
 * Replace `fetch` with a queue of canned responses, one per request.
 *
 * The last reply repeats, so a background watcher that polls again does not
 * fall off the end of the queue.
 *
 * @param {Array<{status?: number, body: string, cookies?: string[]}>} replies Answers, in order.
 * @returns {string[]} The requested URLs, filled in as they are called.
 */
function stubFetchQueue(replies) {
  const seen = []
  let index = 0
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    return replyFor(String(url), reply)
  }
  return seen
}

/**
 * Build the minimal `Response` shape `lib/http.js` reads.
 *
 * @param {string} url Requested URL.
 * @param {{status?: number, body: string, cookies?: string[]}} reply What to answer.
 * @returns {any} A response stand-in.
 */
function replyFor(url, reply) {
  return {
    ok: true,
    status: reply.status ?? 200,
    statusText: 'OK',
    url,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
      getSetCookie: () => reply.cookies ?? [],
    },
    text: async () => reply.body,
    json: async () => JSON.parse(reply.body),
  }
}

/** Poll a predicate until it holds, so a background wait can be observed deterministically. */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the background scan')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A transport context with no retries and no rate limit. */
function transport() {
  return { cookie: () => undefined, timeoutMs: 5000, retries: 0, minIntervalMs: 0 }
}

// ---------------------------------------------------------------------------
// Session extraction
// ---------------------------------------------------------------------------

test('extractSession reads SESSDATA and mid from Set-Cookie', () => {
  const session = extractSession(
    [
      'SESSDATA=abc%2C123%2Cdef; Path=/; Domain=bilibili.com; Expires=Sat, 04 Mar 2023 07:30:09 GMT; HttpOnly',
      'bili_jct=token; Path=/',
      'DedeUserID=42; Path=/',
    ],
    '',
  )
  assert.equal(session.cookie, 'SESSDATA=abc%2C123%2Cdef')
  assert.equal(session.mid, '42')
})

test('extractSession falls back to the crossDomain URL and keeps its expiry', () => {
  const session = extractSession(
    [],
    'https://passport.biligame.com/crossDomain?DedeUserID=7&SESSDATA=xyz&SESSDATA%3D&Expires=1700000000&bili_jct=t',
  )
  assert.equal(session.cookie, 'SESSDATA=xyz')
  assert.equal(session.mid, '7')
  assert.equal(session.expiresAt, 1700000000)
})

test('extractSession reports nothing when the response carries no session', () => {
  assert.deepEqual(extractSession([], ''), {})
  assert.deepEqual(extractSession(['bili_jct=token'], ''), {})
})

// ---------------------------------------------------------------------------
// Poll state machine
// ---------------------------------------------------------------------------

test('an unscanned QR is waiting, not success', async () => {
  stubFetch({ body: JSON.stringify({ code: 0, data: { url: '', code: 86101, message: '未扫码' } }) })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'waiting')
  assert.equal(result.cookie, undefined)
})

test('a scanned but unconfirmed QR is reported as scanned', async () => {
  stubFetch({ body: JSON.stringify({ code: 0, data: { code: 86090, message: '二维码已扫码未确认' } }) })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'scanned')
})

test('an expired QR is reported as expired', async () => {
  stubFetch({ body: JSON.stringify({ code: 0, data: { code: 86038, message: '二维码已失效' } }) })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'expired')
})

test('confirmation yields the session from Set-Cookie', async () => {
  stubFetch({
    body: JSON.stringify({ code: 0, data: { code: 0, url: '', message: '' } }),
    cookies: ['SESSDATA=from-header; Path=/; HttpOnly', 'DedeUserID=99; Path=/'],
  })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'confirmed')
  assert.equal(result.cookie, 'SESSDATA=from-header')
  assert.equal(result.mid, '99')
})

test('confirmation still yields the session when only the crossDomain URL carries it', async () => {
  stubFetch({
    body: JSON.stringify({
      code: 0,
      data: { code: 0, url: 'https://passport.biligame.com/crossDomain?SESSDATA=from-url&Expires=1700000001', message: '' },
    }),
  })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'confirmed')
  assert.equal(result.cookie, 'SESSDATA=from-url')
  assert.equal(result.expiresAt, 1700000001)
})

test('a confirmation without any session is not reported as success', async () => {
  stubFetch({ body: JSON.stringify({ code: 0, data: { code: 0, url: '', message: '' } }) })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'unknown')
  assert.match(result.message, /SESSDATA/)
})

test('a non-JSON poll body is unknown rather than a crash', async () => {
  stubFetch({ body: '<html>nope</html>' })
  const result = await pollQrLogin('key', transport())
  assert.equal(result.state, 'unknown')
})

// ---------------------------------------------------------------------------
// Challenge minting
// ---------------------------------------------------------------------------

test('startQrLogin returns the key, the URL and a three-minute deadline', async () => {
  stubFetch({
    body: JSON.stringify({ code: 0, data: { url: 'https://account.bilibili.com/scan?qrcode_key=k', qrcode_key: 'k' } }),
  })
  const before = Date.now()
  const challenge = await startQrLogin(transport())
  assert.equal(challenge.key, 'k')
  assert.equal(challenge.url, 'https://account.bilibili.com/scan?qrcode_key=k')
  const ttl = challenge.expiresAt - before
  assert.ok(ttl >= 179_000 && ttl <= 181_000, `ttl was ${ttl}`)
})

test('startQrLogin refuses an incomplete envelope', async () => {
  stubFetch({ body: JSON.stringify({ code: 0, data: { url: '', qrcode_key: '' } }) })
  await assert.rejects(() => startQrLogin(transport()), /不完整/)
})

test('startQrLogin surfaces a bilibili error envelope', async () => {
  stubFetch({ body: JSON.stringify({ code: -101, message: '账号未登录' }) })
  await assert.rejects(() => startQrLogin(transport()), /code=-101/)
})

// ---------------------------------------------------------------------------
// QR rendering
// ---------------------------------------------------------------------------

test('qrPng emits a real grayscale PNG at the requested size', async () => {
  const png = await qrPng('https://example.com/x?y=1', { scale: 4, margin: 2 })
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')
  const { count } = await qrMatrix('https://example.com/x?y=1')
  const expected = (count + 4) * 4
  assert.equal(png.readUInt32BE(16), expected)
  assert.equal(png.readUInt32BE(20), expected)
  assert.equal(png[24], 8, 'bit depth')
  assert.equal(png[25], 0, 'grayscale colour type')
  assert.ok(png.subarray(-8, -4).equals(Buffer.from('IEND', 'ascii')))
})

test('the matrix has the finder pattern in its top-left corner', async () => {
  const { count, isDark } = await qrMatrix('https://example.com/finder')
  assert.ok(count >= 21)
  // A finder pattern is a solid 7x7 ring: dark border, light ring, dark core.
  assert.equal(isDark(0, 0), true)
  assert.equal(isDark(0, 6), true)
  assert.equal(isDark(1, 1), false)
  assert.equal(isDark(3, 3), true)
  assert.equal(isDark(7, 7), false, 'the separator around a finder is light')
})

test('qrSvg draws one rect per dark module inside an svg root', async () => {
  const svg = await qrSvg('https://example.com/svg', { scale: 2, margin: 1 })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  const { count, isDark } = await qrMatrix('https://example.com/svg')
  let dark = 0
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) if (isDark(row, col)) dark += 1
  }
  assert.equal((svg.match(/<rect /g) ?? []).length, dark + 1, 'one background rect plus one per dark module')
})

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

test('a session round-trips and its file is private', () => {
  const stored = writeSession('bilibili', { cookie: 'SESSDATA=roundtrip', expiresAt: 1700000000, mid: '5' })
  assert.equal(stored.path, sessionPath())
  const read = readSession('bilibili')
  assert.equal(read.cookie, 'SESSDATA=roundtrip')
  assert.equal(read.expiresAt, 1700000000)
  assert.equal(read.mid, '5')
  assert.equal(read.expired, true, 'a 2023 deadline is in the past')
  // Windows mode bits do not map onto POSIX permissions, so the bit check only
  // means something on a POSIX filesystem.
  if (process.platform !== 'win32') {
    assert.equal(statSync(sessionPath()).mode & 0o777, 0o600)
  }
})

test('an expired record is flagged, not hidden', () => {
  writeSession('bilibili', { cookie: 'SESSDATA=old', expiresAt: 1 })
  const read = readSession('bilibili')
  assert.equal(read.expired, true)
  assert.equal(read.cookie, 'SESSDATA=old')
})

test('a damaged session file degrades to no session', () => {
  writeFileSync(sessionPath(), '{ this is not json')
  assert.equal(readSession('bilibili'), undefined)
  writeFileSync(sessionPath(), '[1,2,3]')
  assert.equal(readSession('bilibili'), undefined)
  writeFileSync(sessionPath(), JSON.stringify({ bilibili: { cookie: 42 } }))
  assert.equal(readSession('bilibili'), undefined)
})

test('clearSession removes the record and reports whether it existed', () => {
  writeSession('bilibili', { cookie: 'SESSDATA=gone' })
  assert.equal(clearSession('bilibili'), true)
  assert.equal(readSession('bilibili'), undefined)
  assert.equal(clearSession('bilibili'), false)
})

test('writeSession refuses an empty cookie', () => {
  assert.throws(() => writeSession('bilibili', { cookie: '   ' }), /非空/)
})

test('describeCookie never reveals the whole secret', () => {
  const described = describeCookie('SESSDATA=0123456789abcdef')
  assert.ok(!described.includes('0123456789abcdef'))
  assert.match(described, /^SESSDATA=…cdef/)
  assert.match(described, /16 字符/)
  assert.equal(describeCookie(undefined), '（未登录）')
})

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

/**
 * Mount the plugin on a capture harness.
 *
 * @param {Record<string, unknown>} [overrides] Config overrides.
 * @returns {ReturnType<typeof harness>} Harness.
 */
function mount(overrides = {}) {
  const h = harness()
  apply(h.ctx, Config({ requestRetries: 0, minRequestIntervalMs: 0, ...overrides }))
  return h
}

test('the login tool is registered alongside the caption tools', () => {
  const h = mount()
  const tool = h.tool('video_subtitle_login')
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.deepEqual(tool.parameters.properties.action.enum, ['start', 'poll', 'status', 'logout'])
})

test('status reports no login when nothing is configured or stored', async () => {
  const h = mount()
  const value = await h.tool('video_subtitle_login').execute({ action: 'status' }, { signal: undefined })
  assert.equal(value.source, 'none')
  assert.equal(value.cookie, '（未登录）')
})

test('a stored session becomes the effective cookie source', async () => {
  writeSession('bilibili', { cookie: 'SESSDATA=stored' })
  const h = mount()
  const value = await h.tool('video_subtitle_login').execute({ action: 'status' }, { signal: undefined })
  assert.equal(value.source, 'session')
  assert.match(value.cookie, /^SESSDATA=…ored/)
})

test('an explicit config cookie outranks the stored session', async () => {
  writeSession('bilibili', { cookie: 'SESSDATA=stored' })
  const h = mount({ cookies: { bilibili: 'SESSDATA=from-config' } })
  const value = await h.tool('video_subtitle_login').execute({ action: 'status' }, { signal: undefined })
  assert.equal(value.source, 'config')
})

test('the environment variable outranks the stored session', async () => {
  writeSession('bilibili', { cookie: 'SESSDATA=stored' })
  process.env.DSH_VIDEO_SRT_BILIBILI_COOKIE = 'SESSDATA=from-env'
  try {
    const h = mount()
    const value = await h.tool('video_subtitle_login').execute({ action: 'status' }, { signal: undefined })
    assert.equal(value.source, 'env')
  } finally {
    delete process.env.DSH_VIDEO_SRT_BILIBILI_COOKIE
  }
})

test('poll without a key is refused with a readable message', async () => {
  const h = mount()
  await assert.rejects(() => h.tool('video_subtitle_login').execute({ action: 'poll' }, { signal: undefined }), /需要 key/)
})

test('an unknown action is refused', async () => {
  const h = mount()
  await assert.rejects(
    () => h.tool('video_subtitle_login').execute({ action: 'dance' }, { signal: undefined }),
    /未知的 action/,
  )
})

test('start writes a QR image into the session workspace and watches the code', async () => {
  stubFetch({
    body: JSON.stringify({ code: 0, data: { url: 'https://account.bilibili.com/scan?qrcode_key=chalk', qrcode_key: 'chalk' } }),
  })
  const workspace = mkdtempSync(join(tmpdir(), 'video-srt-qr-'))
  const h = mount()
  try {
    const value = await h.tool('video_subtitle_login').execute(
      { action: 'start' },
      { signal: undefined, agent: { session: { header: { cwd: workspace } } } },
    )
    assert.equal(value.state, 'waiting')
    assert.equal(value.qrKey, 'chalk')
    assert.equal(value.watching, true)
    // Named per attempt: a fixed path would be cached by the chat view and show
    // a code that already expired.
    assert.equal(value.image, 'bilibili-login-qr-chalk.png')
    // The chat can only render what is inside the session workspace, not the
    // directory the DSH process happens to have been started in.
    assert.ok(existsSync(join(workspace, value.image)), `expected ${value.image} under ${workspace}`)
    assert.ok(readFileSync(join(workspace, value.image)).length > 100)
  } finally {
    h.effectCleanups.at(-1)?.()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('sessionWorkspace ignores anything but the session header', () => {
  assert.equal(sessionWorkspace(undefined), undefined)
  assert.equal(sessionWorkspace({}), undefined)
  assert.equal(sessionWorkspace({ agent: { session: { header: {} } } }), undefined)
  assert.equal(sessionWorkspace({ agent: { session: { header: { cwd: '   ' } } } }), undefined)
  assert.equal(sessionWorkspace({ agent: { session: { header: { cwd: 'F:/code/video-srt' } } } }), 'F:/code/video-srt')
})

test('a scan confirms in the background and wakes the agent without action="poll"', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'video-srt-qr-'))
  stubFetchQueue([
    { body: JSON.stringify({ code: 0, data: { url: 'https://account.bilibili.com/scan?qrcode_key=watched', qrcode_key: 'watched' } }) },
    { body: JSON.stringify({ code: 0, data: { code: 0, message: '0', url: 'https://www.bilibili.com' } }), cookies: ['SESSDATA=watched; Path=/'] },
  ])
  const wakes = []
  const h = mount()
  try {
    const value = await h.tool('video_subtitle_login').execute(
      { action: 'start' },
      {
        signal: undefined,
        agent: {
          followup: (message) => wakes.push(message),
          session: { header: { cwd: workspace } },
        },
      },
    )
    assert.equal(value.state, 'waiting')

    await waitFor(() => readSession('bilibili') !== undefined && wakes.length === 1)

    assert.equal(readSession('bilibili')?.cookie, 'SESSDATA=watched')
    assert.equal(wakes[0].role, 'user')
    assert.match(wakes[0].content[0].text, /登录成功|已扫码完成/)
  } finally {
    h.effectCleanups.at(-1)?.()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('logout forgets the session', async () => {
  writeSession('bilibili', { cookie: 'SESSDATA=bye' })
  const h = mount()
  const value = await h.tool('video_subtitle_login').execute({ action: 'logout' }, { signal: undefined })
  assert.equal(value.removed, true)
  assert.equal(readSession('bilibili'), undefined)
})
