/**
 * HTTP transport for site adapters: identification, cookies, timeouts, and a
 * single retry policy.
 *
 * Chinese video sites reject requests that look scripted, so every request
 * carries a desktop-browser identity and the site's own `Referer`/`Origin`.
 * Cookies come from three places, most specific first:
 *
 * 1. the plugin's `cookies` config map (per site id),
 * 2. the DSH credential record `video-srt/<site>` (set through the Host's
 *    credential UI, so the secret never lands in a config file),
 * 3. the site's conventional environment variable (handy for a headless run).
 *
 * Outbound requests honor `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`: Node's
 * global `fetch` ignores them, and a viewer behind a proxy otherwise cannot
 * reach these sites at all.
 *
 * @module dsh-video-srt/lib/http
 */

/** Default desktop-Chrome identity. Some sites 403 an unknown UA outright. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * Conventional environment variable holding one site's cookie header.
 *
 * @param {string} siteId Adapter id (`bilibili`, `youku`, ...).
 * @returns {string} Environment variable name.
 */
export function cookieEnvName(siteId) {
  return `DSH_VIDEO_SRT_${String(siteId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_COOKIE`
}

/** Error raised for a transport-level failure, carrying the HTTP status. */
export class HttpError extends Error {
  /**
   * @param {string} message Human-readable failure.
   * @param {{status?: number, url?: string, body?: string, kind?: string}} [info] Failure detail.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = info.status
    this.url = info.url
    this.body = info.body
    this.kind = info.kind ?? 'http'
  }
}

/** Error raised when a site answers with a well-formed but unsuccessful payload. */
export class SiteError extends Error {
  /**
   * @param {string} message Human-readable failure.
   * @param {{site?: string, code?: number|string, hint?: string, detail?: unknown}} [info] Site detail.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'SiteError'
    this.site = info.site
    this.code = info.code
    this.hint = info.hint
    this.detail = info.detail
  }
}

/**
 * Normalize a cookie header or cookie list into a single `name=value; ...` header.
 *
 * @param {string|Array<{name: string, value: string}>|undefined} value Cookie source.
 * @returns {string|undefined} Header value, or undefined when empty.
 */
export function normalizeCookie(value) {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) {
    const parts = value
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string')
      .map((entry) => `${entry.name}=${entry.value ?? ''}`)
    return parts.length === 0 ? undefined : parts.join('; ')
  }
  const text = String(value).trim()
  return text === '' ? undefined : text
}

/**
 * Merge two cookie headers, letting the later one win per cookie name.
 *
 * @param {string|undefined} base Lower-priority header.
 * @param {string|undefined} extra Higher-priority header.
 * @returns {string|undefined} Merged header.
 */
export function mergeCookies(base, extra) {
  const left = normalizeCookie(base)
  const right = normalizeCookie(extra)
  if (left === undefined) return right
  if (right === undefined) return left
  /** @type {Map<string, string>} */
  const jar = new Map()
  for (const chunk of `${left}; ${right}`.split(';')) {
    const trimmed = chunk.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim())
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Read one cookie value out of a header.
 *
 * @param {string|undefined} header Cookie header.
 * @param {string} name Cookie name.
 * @returns {string|undefined} Value, when present and non-empty.
 */
export function readCookie(header, name) {
  const text = normalizeCookie(header)
  if (text === undefined) return undefined
  for (const chunk of text.split(';')) {
    const trimmed = chunk.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim() === name) {
      const value = trimmed.slice(eq + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/**
 * Build the per-request context one adapter needs.
 *
 * @typedef {object} HttpContext
 * @property {(siteId: string) => string|undefined} cookie Resolve a site's cookie header.
 * @property {number} timeoutMs Per-request timeout.
 * @property {number} retries Extra attempts for a transient failure.
 * @property {number} minIntervalMs Minimum spacing between requests to one host.
 * @property {(message: string, detail?: unknown) => void} [log] Debug sink.
 */

/**
 * Create an {@link HttpContext} bound to one plugin configuration.
 *
 * @param {object} options Context options.
 * @param {(siteId: string) => string|undefined} options.cookie Cookie resolver.
 * @param {number} [options.timeoutMs] Request timeout.
 * @param {number} [options.retries] Retry count.
 * @param {number} [options.minIntervalMs] Per-host rate limit.
 * @param {(message: string, detail?: unknown) => void} [options.log] Debug sink.
 * @returns {HttpContext} The context adapters receive.
 */
export function createHttpContext(options) {
  return {
    cookie: options.cookie,
    timeoutMs: Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : 15000,
    retries: Number.isFinite(options.retries) ? Math.max(0, Math.min(5, options.retries)) : 2,
    minIntervalMs: Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : 200,
    log: options.log,
  }
}

/** Last request start time per host, for the rate limiter. */
const hostLastRequest = new Map()

/** Cached env-derived dispatcher, or `null` once we know there is none. */
let cachedDispatcher
/** Tracks whether the proxy environment has been inspected yet. */
let dispatcherProbed = false

/**
 * Build (once) an undici dispatcher that honors the proxy environment.
 *
 * Node's global `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` entirely, so a user
 * behind a proxy silently cannot reach any of these sites. `EnvHttpProxyAgent`
 * reads those variables plus `NO_PROXY`; when none is set it is skipped so the
 * common direct case keeps the default pool. Failure to load undici is not
 * fatal — the request then simply goes out unproxied.
 *
 * @returns {Promise<unknown|undefined>} A dispatcher, or undefined for direct.
 */
async function outboundDispatcher() {
  if (dispatcherProbed) return cachedDispatcher ?? undefined
  dispatcherProbed = true
  const configured = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (configured === undefined || configured.trim() === '') return undefined
  try {
    const undici = await import('undici')
    const Agent = undici.EnvHttpProxyAgent ?? undici.ProxyAgent
    if (typeof Agent !== 'function') return undefined
    cachedDispatcher = new Agent()
    return cachedDispatcher
  } catch {
    return undefined
  }
}

/**
 * Wait until the per-host minimum spacing has elapsed.
 *
 * @param {string} url Target URL.
 * @param {number} minIntervalMs Minimum spacing.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<void>} Resolves when the request may start.
 */
async function respectRateLimit(url, minIntervalMs, signal) {
  if (minIntervalMs <= 0) return
  let host
  try {
    host = new URL(url).host
  } catch {
    return
  }
  const previous = hostLastRequest.get(host)
  if (previous !== undefined) {
    const wait = previous + minIntervalMs - Date.now()
    if (wait > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, wait)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new HttpError('request aborted while waiting for the rate limit', { kind: 'aborted', url }))
        }
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
  hostLastRequest.set(host, Date.now())
}

/**
 * Whether a failed attempt is worth retrying.
 *
 * @param {unknown} error Failure to classify.
 * @returns {boolean} True for timeouts, socket errors, 429, and 5xx.
 */
export function isRetryable(error) {
  if (error instanceof HttpError) {
    if (error.kind === 'aborted') return false
    if (error.status === undefined) return true
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return false
}

/**
 * Pause before a retry, honoring an abort signal.
 *
 * @param {number} ms Delay.
 * @param {AbortSignal|undefined} signal Caller cancellation.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Perform one HTTP request with retries, a timeout, and a rate limit.
 *
 * @param {string} url Absolute URL.
 * @param {RequestInit & {siteId?: string, cookie?: string, retryOnStatus?: number[]}} [init] Request options.
 * @param {HttpContext} context Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<Response>} The successful response (never a 4xx/5xx).
 */
export async function request(url, init = {}, context, signal) {
  const { siteId, cookie, retryOnStatus, ...rest } = init
  // A per-call cookie (a track's own token, say) wins over the site's jar.
  const jar = mergeCookies(context.cookie(siteId ?? ''), typeof cookie === 'string' ? cookie : undefined)
  const headers = new Headers(rest.headers ?? {})
  if (!headers.has('user-agent')) headers.set('user-agent', DESKTOP_UA)
  if (!headers.has('accept-language')) headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
  if (jar !== undefined && !headers.has('cookie')) headers.set('cookie', jar)
  const dispatcher = await outboundDispatcher()
  const attempts = context.retries + 1
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await respectRateLimit(url, context.minIntervalMs, signal)
    const timeout = AbortSignal.timeout(context.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      const response = await fetch(url, {
        ...rest,
        headers,
        signal: combined,
        redirect: rest.redirect ?? 'follow',
        // `dispatcher` is undici's socket-pool option; global fetch passes it through.
        ...(dispatcher === undefined ? {} : { dispatcher }),
      })
      if (response.ok) return response
      const body = await safeText(response)
      const retryable = (retryOnStatus ?? []).includes(response.status) || response.status === 429 || response.status >= 500
      lastError = new HttpError(`HTTP ${response.status} ${response.statusText} for ${shorten(url)}`, {
        status: response.status,
        url,
        body: body.slice(0, 800),
        kind: 'status',
      })
      if (!retryable || attempt === attempts) throw lastError
    } catch (error) {
      if (error instanceof HttpError && error.kind === 'status' && !isRetryable(error)) throw error
      if (signal?.aborted === true) {
        throw new HttpError(`request to ${shorten(url)} was cancelled`, { url, kind: 'aborted' })
      }
      if (error instanceof HttpError) lastError = error
      else if (error instanceof Error && error.name === 'TimeoutError') {
        lastError = new HttpError(`request to ${shorten(url)} timed out after ${context.timeoutMs}ms`, { url, kind: 'timeout' })
      } else {
        lastError = new HttpError(
          `request to ${shorten(url)} failed: ${error instanceof Error ? error.message : String(error)}`,
          { url, kind: 'network' },
        )
      }
      if (attempt === attempts) throw lastError
    }
    context.log?.(`retrying ${shorten(url)} after attempt ${attempt}`, lastError?.message)
    await delay(Math.min(2500, 300 * 2 ** (attempt - 1)), signal)
  }
  throw lastError ?? new HttpError(`request to ${shorten(url)} failed`, { url })
}

/**
 * Read a response body as text without ever throwing.
 *
 * @param {Response} response Response to read.
 * @returns {Promise<string>} Body text, or an empty string on failure.
 */
export async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * Request a URL and parse the body as JSON.
 *
 * @param {string} url Absolute URL.
 * @param {RequestInit & {siteId?: string, cookie?: string}} [init] Request options.
 * @param {HttpContext} context Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<unknown>} Parsed JSON.
 */
export async function getJson(url, init, context, signal) {
  const response = await request(url, { ...init, headers: { accept: 'application/json, text/plain, */*', ...(init?.headers ?? {}) } }, context, signal)
  const text = await safeText(response)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new HttpError(`expected JSON from ${shorten(url)} but the body did not parse: ${error instanceof Error ? error.message : String(error)}`, {
      url,
      body: text.slice(0, 400),
      kind: 'parse',
    })
  }
}

/**
 * Request a URL and return the body as text.
 *
 * @param {string} url Absolute URL.
 * @param {RequestInit & {siteId?: string, cookie?: string}} [init] Request options.
 * @param {HttpContext} context Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<{text: string, contentType: string, finalUrl: string}>} Body and metadata.
 */
export async function getText(url, init, context, signal) {
  const response = await request(url, init, context, signal)
  return {
    text: await safeText(response),
    contentType: response.headers.get('content-type') ?? '',
    finalUrl: response.url === '' ? url : response.url,
  }
}

/**
 * Shorten a URL for an error message.
 *
 * @param {string} url Source URL.
 * @returns {string} At most 120 characters.
 */
export function shorten(url) {
  return url.length <= 120 ? url : `${url.slice(0, 117)}…`
}

/**
 * Upgrade a protocol-relative or schemeless URL to HTTPS.
 *
 * @param {string} url Source URL.
 * @returns {string} Absolute HTTPS URL, or the input unchanged when unusable.
 */
export function toHttps(url) {
  const text = String(url ?? '').trim()
  if (text === '') return text
  if (text.startsWith('//')) return `https:${text}`
  if (/^https?:\/\//i.test(text)) return text
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(text)) return `https://${text}`
  return text
}
