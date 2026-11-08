/**
 * Bilibili QR-code login.
 *
 * Bilibili's caption list is the one login-gated step in the whole read path
 * (see `lib/sites/bilibili.js`), so the plugin needs a way to obtain `SESSDATA`
 * without sending the user to browser devtools. QR login is the only variant
 * that works server-side: it is two plain HTTPS calls, with no browser, no
 * geetest widget and no obfuscated client JavaScript.
 *
 * ```
 * GET passport.bilibili.com/x/passport-login/web/qrcode/generate
 *   → { data: { url, qrcode_key } }            the URL to encode as a QR code
 * GET passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…
 *   → { code: 0, data: { code: 86101 | 86090 | 86038 | 0, … } }
 * ```
 *
 * The inner `data.code` is the real state; the outer `code` is `0` even while
 * nobody has scanned yet, which is why a naive `code === 0` check would report
 * success on an unscanned code.
 *
 * On confirmation the session arrives **twice**, and both are used: as
 * `Set-Cookie` headers on the poll response, and as a `SESSDATA=` parameter on
 * the `crossDomain` URL in `data.url`. Taking either alone would be brittle.
 *
 * @module dsh-video-srt/lib/login
 */

import { getJson, request, safeText } from './http.js'

/** Endpoint that mints a new QR challenge. */
export const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'

/** Endpoint that reports a QR challenge's state. */
export const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'

/** How long a minted challenge stays valid (documented: 180 s). */
export const QR_TTL_MS = 180_000

/**
 * Poll state codes, as documented by bilibili-API-collect.
 *
 * Note these are the **inner** `data.code` values, not the envelope `code`.
 */
export const POLL_STATES = {
  0: 'confirmed',
  86038: 'expired',
  86090: 'scanned',
  86101: 'waiting',
}

/** Human-readable state, for a tool result. */
export const STATE_LABELS = {
  confirmed: '登录成功',
  scanned: '已扫码，等待手机上点「确认」',
  waiting: '等待扫码',
  expired: '二维码已失效，需要重新生成',
  unknown: '未知状态',
}

/** The site id this flow logs into. */
export const SITE_ID = 'bilibili'

/** Headers the real passport pages send; the API is friendlier with them. */
const HEADERS = { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }

/**
 * Mint a QR challenge.
 *
 * @param {import('./http.js').HttpContext} http Transport context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<{key: string, url: string, expiresAt: number}>} Challenge to encode and poll.
 */
export async function startQrLogin(http, signal) {
  const body = await getJson(GENERATE_URL, { headers: HEADERS }, http, signal)
  const envelope = /** @type {any} */ (body)
  if (Number(envelope?.code) !== 0) {
    throw new Error(`B 站没有下发二维码：code=${envelope?.code ?? '?'} message=${envelope?.message ?? '（无）'}`)
  }
  const key = String(envelope?.data?.qrcode_key ?? '')
  const url = String(envelope?.data?.url ?? '')
  if (key === '' || url === '') {
    throw new Error('B 站返回的二维码数据不完整（缺少 qrcode_key 或 url）')
  }
  return { key, url, expiresAt: Date.now() + QR_TTL_MS }
}

/**
 * Poll one QR challenge.
 *
 * @param {string} key The `qrcode_key` from {@link startQrLogin}.
 * @param {import('./http.js').HttpContext} http Transport context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<{state: string, message: string, cookie?: string, expiresAt?: number, mid?: string}>}
 *   Current state, plus the session when `state === 'confirmed'`.
 */
export async function pollQrLogin(key, http, signal) {
  const response = await request(`${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`, { headers: HEADERS }, http, signal)
  // Read the cookies before the body: `getSetCookie` is on the headers object,
  // and on a confirmed login it is the only place the session appears.
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const text = await safeText(response)

  let inner = {}
  try {
    inner = JSON.parse(text)?.data ?? {}
  } catch {
    // A non-JSON body here means the challenge is not understood by the server;
    // report `unknown` rather than pretending to know the state.
    return { state: 'unknown', message: 'B 站返回的内容不是 JSON，无法判断扫码状态。' }
  }

  const stateCode = Number(inner.code)
  const state = POLL_STATES[stateCode] ?? 'unknown'
  const message = String(inner.message ?? '')

  if (state !== 'confirmed') {
    return { state, message }
  }

  const session = extractSession(setCookies, String(inner.url ?? ''))
  if (session.cookie === undefined) {
    return {
      state: 'unknown',
      message: '扫码已确认，但响应里没有找到 SESSDATA。可能是 B 站改动了登录响应，请手动配置 cookies.bilibili。',
    }
  }
  return { state, message: message === '' ? STATE_LABELS.confirmed : message, ...session }
}

/**
 * Pull `SESSDATA` out of a confirmed login.
 *
 * @param {string[]} setCookies `Set-Cookie` header values.
 * @param {string} crossDomainUrl The `crossDomain` URL from `data.url`.
 * @returns {{cookie?: string, expiresAt?: number, mid?: string}} Whatever could be recovered.
 */
export function extractSession(setCookies, crossDomainUrl) {
  /** @type {{cookie?: string, expiresAt?: number, mid?: string}} */
  const result = {}

  for (const header of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(header).split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (name === 'SESSDATA' && value !== '') result.cookie = `SESSDATA=${value}`
    if (name === 'DedeUserID' && value !== '') result.mid = value
    // `Expires` here is a date string; the crossDomain URL carries the same
    // deadline as a Unix timestamp, which is what this module stores.
  }

  // Fallback: the crossDomain URL repeats the session as query parameters.
  if (typeof crossDomainUrl === 'string' && crossDomainUrl !== '') {
    let params
    try {
      params = new URL(crossDomainUrl).searchParams
    } catch {
      params = undefined
    }
    if (params !== undefined) {
      const sessdata = params.get('SESSDATA')
      if (result.cookie === undefined && sessdata !== null && sessdata !== '') {
        result.cookie = `SESSDATA=${sessdata}`
      }
      const expires = Number(params.get('Expires'))
      if (Number.isFinite(expires) && expires > 0) result.expiresAt = expires
      const dede = params.get('DedeUserID')
      if (result.mid === undefined && dede !== null && dede !== '') result.mid = dede
    }
  }

  return result
}
