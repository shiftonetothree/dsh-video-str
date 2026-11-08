/**
 * Bilibili (哔哩哔哩) adapter — the fully implemented site.
 *
 * Request chain:
 *
 * 1. parse the URL into a `bvid`/`aid`/`ep_id` identity plus the part number,
 * 2. `x/web-interface/view` for UGC, `pgc/view/web/season` for 番剧/影视,
 * 3. `x/player/wbi/v2` for the caption track list,
 * 4. the track's own `subtitle_url` for the cue body.
 *
 * Three traps this module exists to get right:
 *
 * - **The sign-in gate is a flag, not a status code.** For a signed-out viewer
 *   the track list is empty whether or not the video has captions; only
 *   `need_login_subtitle` distinguishes "go sign in" from "this video has
 *   none". Reporting the second when the first is true is the single most
 *   misleading thing this adapter could do, so the flag is threaded all the way
 *   into the tool result.
 * - **PGC and UGC use different envelopes and different time units.** The season
 *   endpoint answers `result`, not `data`, and its `duration` is milliseconds
 *   while UGC's is seconds.
 * - **`id` is an int64.** Values such as `13643112644608002` lose precision
 *   through a JS `Number`, so the track id comes from `id_str`.
 *
 * @module dsh-video-srt/lib/sites/bilibili
 */

import { getJson, getText, HttpError, readCookie, SiteError, toHttps } from '../http.js'
import { parseSubtitles } from '../subtitle.js'

export const id = 'bilibili'
export const label = '哔哩哔哩'
export const homepage = 'https://www.bilibili.com'
/** The site's own pages send this `Referer`; API calls look scripted without it. */
export const referer = 'https://www.bilibili.com/'
/** True: this adapter really serves captions (given a session cookie). */
export const captions = true

/** Guidance shown whenever the caption list comes back empty. */
export const subtitleHelp =
  'B 站对未登录访客不返回字幕列表（CC 和 AI 字幕都不返回），但接口仍会以 HTTP 200 + code 0 作答。' +
  '判断依据是响应里的 need_login_subtitle：为 true 表示“需要登录”，为 false 才是“这个视频确实没有字幕”。' +
  '请在插件配置的 cookies.bilibili 填 SESSDATA（只要 SESSDATA 就够，bili_jct 是 CSRF 用的，读取字幕不需要），' +
  '或设置环境变量 DSH_VIDEO_SRT_BILIBILI_COOKIE 后重试。'

/** Hosts this adapter claims. */
const HOSTS = ['bilibili.com', 'b23.tv', 'bili2233.cn']

/**
 * Bilibili API error codes we can explain, keyed by `code`.
 *
 * @type {Record<string, string>}
 */
const API_ERRORS = {
  '-352': '触发风控（-352）：常见于 WBI 签名错误、缺少 buvid3 指纹或登录态异常。插件已内置 WBI 签名，可稍后重试。',
  '-400': '请求参数错误（-400）：常见于用 ep_id 直接请求 UGC 接口——番剧必须先经 pgc/view/web/season 解析出 aid。',
  '-403': '访问权限不足（-403）：可能是仅限登录、付费或地区限制的内容。',
  '-404': '接口或稿件不存在（-404）。',
  '-412': '请求被风控拦截（-412）：通常是 IP 层面的频控，请降低频率或稍后重试。',
  '-509': '请求过于频繁（-509），请稍后重试。',
  '-799': '请求过于频繁（-799），请稍后重试。',
  '62002': '稿件不可见（62002）：可能已被设为私密或删除。',
  '62004': '稿件审核中（62004）。',
  '62012': '仅 UP 主自己可见（62012）。',
  '62013': '根据版权方要求无法查看（62013，地区限制）。',
  '-689': '内容被版权方限制（-689）。',
}

/**
 * Error codes that will never succeed on a retry, so the transport must not
 * waste attempts on them.
 */
const TERMINAL_CODES = new Set(['62002', '62004', '62012', '62013', '-403', '-404', '-689'])

/**
 * Whether this adapter handles a URL.
 *
 * @param {string} url Candidate URL.
 * @returns {boolean} True when the host belongs to bilibili.
 */
export function match(url) {
  return hostOf(url) !== undefined
}

/**
 * Extract the lowercase host of a URL, when it belongs to bilibili.
 *
 * @param {string} url Candidate URL.
 * @returns {string|undefined} Host, when claimed.
 */
function hostOf(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`)) ? host : undefined
  } catch {
    return undefined
  }
}

/**
 * A parsed bilibili video identity.
 *
 * @typedef {object} BilibiliRef
 * @property {'bilibili'} site
 * @property {string} url Canonical watch URL.
 * @property {string} [bvid] `BV...` id.
 * @property {number} [aid] Numeric `av` id.
 * @property {number} [epId] 番剧/影视 episode id.
 * @property {number} [seasonId] 番剧/影视 season id.
 * @property {number} page 1-based part index (`?p=`).
 * @property {boolean} pgc True for 番剧/影视/课程 pages.
 * @property {string} [shortUrl] The short link, when it still needs expanding.
 * @property {string} sourceUrl The URL as given.
 */

/**
 * Parse a bilibili URL into an identity.
 *
 * Understands `bilibili.com/video/BV...`, `/video/av123`, `/video/BV...?p=2`,
 * `b23.tv/xxxx`, `/bangumi/play/ep123`, `/bangumi/play/ss123`,
 * `/cheese/play/ep123`, and the `?bvid=`/`?aid=`/`?ep_id=` query forms.
 *
 * @param {string} url Source URL.
 * @returns {BilibiliRef|undefined} The identity, or undefined when unrecognized.
 */
export function parse(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return undefined
  }
  const host = hostOf(parsed.toString())
  if (host === undefined) return undefined
  const path = parsed.pathname.replace(/\/+$/, '')
  const query = parsed.searchParams
  /** @type {BilibiliRef} */
  const ref = {
    site: 'bilibili',
    url: parsed.toString(),
    sourceUrl: parsed.toString(),
    page: 1,
    pgc: false,
  }
  const pageParam = Number.parseInt(query.get('p') ?? '1', 10)
  if (Number.isFinite(pageParam) && pageParam > 0) ref.page = pageParam

  if (host === 'b23.tv' || host === 'bili2233.cn') {
    ref.shortUrl = parsed.toString()
    return ref
  }

  const queryBvid = query.get('bvid')
  if (queryBvid !== null && /^BV[0-9A-Za-z]+$/.test(queryBvid)) ref.bvid = queryBvid
  const queryAid = query.get('aid')
  if (ref.bvid === undefined && queryAid !== null && /^\d+$/.test(queryAid)) ref.aid = Number.parseInt(queryAid, 10)

  const videoMatch = /\/(?:video|list)\/(BV[0-9A-Za-z]+|av(\d+))/i.exec(path)
  if (videoMatch !== null) {
    if (videoMatch[2] !== undefined) ref.aid = Number.parseInt(videoMatch[2], 10)
    else ref.bvid = videoMatch[1]
  }
  if (/\/(?:bangumi|cheese)\/(?:play|media)\//.test(path)) ref.pgc = true
  const epMatch = /\/(?:bangumi|cheese)\/play\/ep(\d+)/i.exec(path)
  if (epMatch !== null) {
    ref.epId = Number.parseInt(epMatch[1], 10)
    ref.pgc = true
  }
  const ssMatch = /\/(?:bangumi|cheese)\/play\/ss(\d+)/i.exec(path)
  if (ssMatch !== null) {
    ref.seasonId = Number.parseInt(ssMatch[1], 10)
    ref.pgc = true
  }
  const queryEp = query.get('ep_id')
  if (ref.epId === undefined && queryEp !== null && /^\d+$/.test(queryEp)) {
    ref.epId = Number.parseInt(queryEp, 10)
    ref.pgc = true
  }
  const querySeason = query.get('season_id')
  if (ref.seasonId === undefined && querySeason !== null && /^\d+$/.test(querySeason)) {
    ref.seasonId = Number.parseInt(querySeason, 10)
    ref.pgc = true
  }
  if (ref.bvid !== undefined) {
    ref.url = ref.page > 1 ? `https://www.bilibili.com/video/${ref.bvid}?p=${ref.page}` : `https://www.bilibili.com/video/${ref.bvid}`
  } else if (ref.aid !== undefined) {
    ref.url = `https://www.bilibili.com/video/av${ref.aid}`
  } else if (ref.epId !== undefined) {
    ref.url = `https://www.bilibili.com/bangumi/play/ep${ref.epId}`
  } else if (ref.seasonId !== undefined) {
    ref.url = `https://www.bilibili.com/bangumi/play/ss${ref.seasonId}`
  }
  return ref
}

/** JSON headers for the bilibili API. */
const API_HEADERS = {
  accept: 'application/json, text/plain, */*',
  referer,
  origin: 'https://www.bilibili.com',
}

/**
 * Follow a `b23.tv` short link into a canonical identity.
 *
 * The redirect is followed deliberately: b23.tv answers 302 to the watch URL,
 * and `redirect: 'follow'` leaves the resolved URL on the response.
 *
 * @param {string} url Short link.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<BilibiliRef>} The resolved identity.
 */
export async function expandShortLink(url, http, signal) {
  const response = await getText(url, { siteId: id, redirect: 'follow' }, http, signal)
  const resolved = parse(response.finalUrl)
  // Landing on a bilibili page is not enough: it must name a video. A short
  // link that resolves to a channel or the ranking page has no identity to use.
  if (resolved === undefined || !hasVideoIdentity(resolved)) {
    throw new SiteError(`b23.tv 短链 ${url} 展开到 ${response.finalUrl}，但这不是可识别的 B 站视频地址。`, {
      site: id,
      code: 'short-link',
    })
  }
  return resolved
}

/**
 * Whether a parsed identity actually names one video.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @returns {boolean} True when a video id is present.
 */
function hasVideoIdentity(ref) {
  return ref.bvid !== undefined || ref.aid !== undefined || ref.epId !== undefined || ref.seasonId !== undefined
}

// ---------------------------------------------------------------------------
// WBI signing
// ---------------------------------------------------------------------------

/**
 * The WBI mixing-key permutation, as published by the API documentation
 * mirrors. Every value is an index into `imgKey + subKey`.
 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7,
  16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/**
 * Read the WBI mixin key from a `nav` payload.
 *
 * @param {unknown} navValue `x/web-interface/nav` response.
 * @returns {string|undefined} The 32-character mixin key.
 */
export function mixinKeyFromNav(navValue) {
  const img = readString(navValue, ['data', 'wbi_img', 'img_url'])
  const sub = readString(navValue, ['data', 'wbi_img', 'sub_url'])
  if (img === undefined || sub === undefined) return undefined
  const imgKey = img.slice(img.lastIndexOf('/') + 1).split('.')[0]
  const subKey = sub.slice(sub.lastIndexOf('/') + 1).split('.')[0]
  if (imgKey === '' || subKey === '') return undefined
  return mixinKey(imgKey, subKey)
}

/**
 * Apply the permutation table to `imgKey + subKey`.
 *
 * @param {string} imgKey Raw image key.
 * @param {string} subKey Raw sub key.
 * @returns {string} The 32-character mixin key.
 */
export function mixinKey(imgKey, subKey) {
  const source = `${imgKey}${subKey}`
  let out = ''
  for (const index of MIXIN_KEY_ENC_TAB) {
    const char = source[index]
    if (char !== undefined) out += char
    if (out.length >= 32) break
  }
  return out
}

/**
 * Percent-encode one WBI parameter value the way the reference algorithm does.
 *
 * `encodeURIComponent` leaves `!'()*` alone and encodes a space as `%20`, which
 * differs from the Python `urlencode` the signature was defined against. The
 * value is filtered first, then encoded, so both agree.
 *
 * @param {string} value Raw value.
 * @returns {string} Encoded value.
 */
export function wbiEncode(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''))
}

/**
 * Sign a query with WBI, mutating the given `URLSearchParams`.
 *
 * @param {URLSearchParams} params Query parameters.
 * @param {string} mixin The 32-character mixin key.
 * @param {number} [timestamp] Unix seconds; defaults to now.
 * @returns {string} The signed query string.
 */
export function signWbi(params, mixin, timestamp) {
  params.set('wts', String(timestamp ?? Math.floor(Date.now() / 1000)))
  const sorted = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const query = sorted.map(([key, value]) => `${wbiEncode(key)}=${wbiEncode(value)}`).join('&')
  const wRid = md5Hex(`${query}${mixin}`)
  params.set('w_rid', wRid)
  return `${query}&w_rid=${wRid}`
}

/**
 * Fetch the current WBI mixin key, tolerating failure.
 *
 * WBI is not currently enforced on the endpoints this plugin calls, so a
 * failure here only means the request goes out unsigned — which still works.
 *
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<string|undefined>} The mixin key, when available.
 */
export async function fetchMixinKey(http, signal) {
  try {
    const payload = await getJson('https://api.bilibili.com/x/web-interface/nav', { siteId: id, headers: API_HEADERS }, http, signal)
    return mixinKeyFromNav(payload)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Read a nested string out of an unknown JSON value.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {string|undefined} The string, when present.
 */
function readString(value, path) {
  let cursor = value
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key]
  }
  return typeof cursor === 'string' && cursor !== '' ? cursor : undefined
}

/**
 * Read a nested finite number out of an unknown JSON value.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {number|undefined} The number, when present.
 */
function readNumber(value, path) {
  let cursor = value
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key]
  }
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return cursor
  if (typeof cursor === 'string') {
    const parsed = Number.parseFloat(cursor)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Read a nested boolean out of an unknown JSON value.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {boolean} The boolean, or false.
 */
function readBoolean(value, path) {
  let cursor = value
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return false
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key]
  }
  return cursor === true
}

/**
 * Read a nested array out of an unknown JSON value.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {unknown[]} The array, or an empty array.
 */
function readArray(value, path) {
  let cursor = value
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return []
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key]
  }
  return Array.isArray(cursor) ? cursor : []
}

/**
 * Turn a bilibili API envelope into its payload, or throw an explained error.
 *
 * UGC endpoints answer `{code, message, data}`; the PGC season endpoint answers
 * `{code, message, result}` — the envelope key is a parameter here rather than
 * an assumption.
 *
 * @param {unknown} payload Parsed response.
 * @param {string} what Human-readable operation name for the message.
 * @param {string} [key] Payload key (`data` by default).
 * @returns {unknown} The payload member.
 */
function unwrap(payload, what, key = 'data') {
  if (payload === null || typeof payload !== 'object') {
    throw new SiteError(`B站 ${what} 返回了非对象响应。`, { site: id, code: 'shape' })
  }
  const record = /** @type {Record<string, unknown>} */ (payload)
  const code = record.code
  if (code === 0 || code === '0') return record[key]
  const text = String(code)
  throw new SiteError(`B站 ${what} 失败：code=${text} ${typeof record.message === 'string' ? record.message : ''}`.trim(), {
    site: id,
    code: text,
    hint: API_ERRORS[text] ?? '这是接口返回的业务错误码，插件没有内置解释。',
    detail: { message: record.message, terminal: TERMINAL_CODES.has(text) },
  })
}

// ---------------------------------------------------------------------------
// Video info
// ---------------------------------------------------------------------------

/**
 * Video metadata plus the container its captions belong to.
 *
 * @typedef {import('../types.js').VideoInfo} VideoInfo
 */

/**
 * Fetch a video's metadata and the `cid` of the requested part.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<VideoInfo>} Video info.
 */
export async function info(ref, http, signal) {
  const resolved = ref.shortUrl === undefined ? ref : await expandShortLink(ref.shortUrl, http, signal)
  const canonical = `https://www.bilibili.com${canonicalPath(resolved)}`
  const withUrl = { ...resolved, url: canonical, sourceUrl: ref.sourceUrl }
  if (withUrl.pgc === true) return await pgcInfo(withUrl, http, signal)
  return await ugcInfo(withUrl, http, signal)
}

/**
 * Build the canonical watch path for an identity.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @returns {string} A path beginning with `/`.
 */
function canonicalPath(ref) {
  if (ref.bvid !== undefined) return `/video/${ref.bvid}${ref.page > 1 ? `?p=${ref.page}` : ''}`
  if (ref.aid !== undefined) return `/video/av${ref.aid}`
  if (ref.epId !== undefined) return `/bangumi/play/ep${ref.epId}`
  if (ref.seasonId !== undefined) return `/bangumi/play/ss${ref.seasonId}`
  return '/'
}

/**
 * Resolve a UGC (投稿) video through `x/web-interface/view`.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<VideoInfo>} Video info.
 */
async function ugcInfo(ref, http, signal) {
  const query = ref.bvid !== undefined ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${ref.aid}`
  const payload = await getJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { siteId: id, headers: API_HEADERS }, http, signal)
  const data = unwrap(payload, 'view 接口')
  // A UGC endpoint that points at a PGC page: hand off rather than guess.
  const redirect = readString(data, ['redirect_url'])
  if (redirect !== undefined && redirect !== '') {
    const redirected = parse(redirect)
    if (redirected !== undefined && redirected.pgc === true) return await pgcInfo(redirected, http, signal)
  }
  const title = readString(data, ['title']) ?? ''
  const parts = readArray(data, ['pages']).map((entry, position) => ({
    page: readNumber(entry, ['page']) ?? position + 1,
    cid: readNumber(entry, ['cid']) ?? 0,
    title: readString(entry, ['part']) ?? `P${position + 1}`,
    duration: readNumber(entry, ['duration']) ?? 0,
  }))
  const selected = parts.find((entry) => entry.page === ref.page) ?? parts[0]
  const cid = selected?.cid ?? readNumber(data, ['cid'])
  if (cid === undefined || cid === 0) {
    throw new SiteError('B站 view 接口没有返回可用的 cid，无法定位该分 P。', {
      site: id,
      code: 'no-cid',
      detail: { bvid: ref.bvid, aid: ref.aid },
    })
  }
  return {
    site: id,
    id: readString(data, ['bvid']) ?? ref.bvid ?? String(ref.aid ?? ''),
    url: ref.url,
    title: parts.length > 1 && selected !== undefined ? `${title} - ${selected.title}` : title,
    owner: readString(data, ['owner', 'name']) ?? '',
    cover: readString(data, ['pic']),
    durationSeconds: selected?.duration ?? readNumber(data, ['duration']) ?? 0,
    publishedAt: readNumber(data, ['pubdate']),
    description: readString(data, ['desc']),
    container: { kind: /** @type {const} */ ('bilibili-ugc'), aid: readNumber(data, ['aid']) ?? ref.aid ?? 0, bvid: readString(data, ['bvid']) ?? ref.bvid ?? '', cid, page: selected?.page ?? ref.page },
    parts: parts.map((entry) => ({ id: String(entry.page), label: entry.title, durationSeconds: entry.duration, cid: entry.cid })),
    stats: { views: readNumber(data, ['stat', 'view']), danmaku: readNumber(data, ['stat', 'danmaku']), replies: readNumber(data, ['stat', 'reply']) },
    notes: [],
  }
}

/**
 * Resolve a 番剧/影视 episode through `pgc/view/web/season`.
 *
 * The season endpoint answers `result` rather than `data`, and its durations are
 * **milliseconds** while UGC's are seconds.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<VideoInfo>} Video info.
 */
async function pgcInfo(ref, http, signal) {
  const query = ref.seasonId !== undefined ? `season_id=${ref.seasonId}` : `ep_id=${ref.epId}`
  const payload = await getJson(`https://api.bilibili.com/pgc/view/web/season?${query}`, { siteId: id, headers: API_HEADERS }, http, signal)
  const data = unwrap(payload, 'pgc/view/web/season 接口', 'result')
  const seasonId = readNumber(data, ['season_id']) ?? ref.seasonId ?? 0
  // `episodes` holds the main line; `section[]` holds 花絮/PV blocks.
  const main = readArray(data, ['episodes'])
  const extras = readArray(data, ['section']).flatMap((section) => readArray(section, ['episodes']))
  const all = main.length > 0 ? main : extras
  const selected = all.find((entry) => isWantedEpisode(entry, ref.epId)) ?? all[0]
  if (selected === undefined) {
    throw new SiteError('B站 PGC 接口没有返回任何剧集，无法定位该 ep。', { site: id, code: 'no-episode', detail: { epId: ref.epId, seasonId } })
  }
  const cid = readNumber(selected, ['cid'])
  if (cid === undefined) {
    throw new SiteError('B站 PGC 剧集数据缺少 cid。', { site: id, code: 'no-cid', detail: { epId: ref.epId } })
  }
  // PGC durations are milliseconds; UGC's are seconds. Normalize once here.
  const title = [readString(data, ['season_title']) ?? readString(data, ['title']) ?? '', readString(selected, ['long_title']) ?? readString(selected, ['title']) ?? '']
    .filter((entry) => entry !== '')
    .join(' - ')
  return {
    site: id,
    id: readNumber(selected, ['ep_id']) !== undefined ? `ep${readNumber(selected, ['ep_id'])}` : String(ref.epId ?? seasonId),
    url: ref.url,
    title,
    owner: readString(data, ['up_info', 'uname']) ?? readString(data, ['up_info', 'name']) ?? '',
    cover: readString(selected, ['cover']) ?? readString(data, ['cover']),
    durationSeconds: toSeconds(readNumber(selected, ['duration'])),
    publishedAt: readNumber(selected, ['pub_time']) ?? readNumber(data, ['publish', 'pub_time']),
    description: readString(data, ['evaluate']) ?? readString(data, ['subtitle']),
    container: {
      kind: /** @type {const} */ ('bilibili-pgc'),
      aid: readNumber(selected, ['aid']) ?? 0,
      bvid: readString(selected, ['bvid']) ?? '',
      cid,
      epId: readNumber(selected, ['ep_id']),
      seasonId,
    },
    parts: all.map((entry, position) => ({
      id: String(readNumber(entry, ['ep_id']) ?? position + 1),
      label: readString(entry, ['long_title']) ?? readString(entry, ['title']) ?? `EP${position + 1}`,
      durationSeconds: toSeconds(readNumber(entry, ['duration'])),
      cid: readNumber(entry, ['cid']) ?? 0,
    })),
    stats: { views: readNumber(data, ['stat', 'views']), danmaku: readNumber(data, ['stat', 'danmaku']) },
    notes: ['这是番剧/影视（PGC）内容，时长单位已在适配器内从毫秒换算为秒。'],
  }
}

/**
 * Heuristic millisecond-to-second normalization for PGC durations.
 *
 * A 24-minute episode is 1_441_000 ms. Any value above 100_000 is treated as
 * milliseconds: the longest legitimate episode length in seconds would be
 * 27.7 hours, and no episode is that long while plenty exceed 100_000 ms.
 *
 * @param {number|undefined} value Raw duration.
 * @returns {number} Seconds.
 */
function toSeconds(value) {
  if (value === undefined || !Number.isFinite(value)) return 0
  return value > 100000 ? Math.round(value / 1000) : value
}

/**
 * Whether an episode row is the requested `ep_id`.
 *
 * @param {unknown} entry Candidate row.
 * @param {number|undefined} epId Wanted episode id.
 * @returns {boolean} True when the row matches.
 */
function isWantedEpisode(entry, epId) {
  if (epId === undefined) return false
  return readNumber(entry, ['ep_id']) === epId || readNumber(entry, ['id']) === epId
}

// ---------------------------------------------------------------------------
// Caption tracks
// ---------------------------------------------------------------------------

/**
 * Map a site language code onto a BCP-47-ish tag.
 *
 * @param {string} lan Site code such as `zh-CN`, `ai-zh`, `en-US`.
 * @returns {string|undefined} Normalized tag, when non-empty.
 */
function normalizeLang(lan) {
  const text = String(lan ?? '').replace(/^ai-/, '')
  return text === '' ? undefined : text
}

/**
 * Describe one caption track row.
 *
 * @param {Record<string, unknown>} entry Raw track row.
 * @param {number} ordinal Position, for a stable fallback id.
 * @returns {import('../subtitle.js').SubtitleTrack} Normalized track.
 */
function trackOf(entry, ordinal) {
  const lan = String(entry.lan ?? '')
  const url = String(entry.subtitle_url ?? '')
  // `id` is an int64 that overflows a JS Number; `id_str` is the safe form.
  const idText = typeof entry.id_str === 'string' && entry.id_str !== '' ? entry.id_str : `${lan || 'track'}#${ordinal + 1}`
  const aiStatus = entry.ai_status
  const isAi = lan.startsWith('ai-') || aiStatus === 1 || aiStatus === 2
  // An AI track whose URL is still empty is "generating", not broken.
  const pending = url === '' && (aiStatus === 2 || lan.startsWith('ai-'))
  return {
    id: idText,
    site: id,
    url: url === '' ? undefined : toHttps(url),
    lang: normalizeLang(lan),
    label: String(entry.lan_doc ?? '') || (lan.startsWith('ai-') ? `AI 字幕（${normalizeLang(lan) ?? 'zh'}）` : lan) || `字幕 ${ordinal + 1}`,
    auto: isAi,
    locked: entry.is_lock === true,
    format: 'json',
    note: entry.is_lock === true
      ? '该字幕被 UP 主锁定，需要登录且可能有额外权限要求。'
      : pending
        ? 'AI 字幕仍在生成中（subtitle_url 为空），稍后重试。'
        : undefined,
  }
}

/**
 * List the caption tracks of a video.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @param {VideoInfo} [knownInfo] Already-resolved info, to avoid a second lookup.
 * @returns {Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], help?: string}>} Tracks and diagnostics.
 */
export async function tracks(ref, http, signal, knownInfo) {
  // A short link carries no identity at all, so it must be expanded before the
  // container can be read; `info()` reports the canonical URL it settled on.
  const videoInfo = knownInfo ?? (await info(ref, http, signal))
  const canonicalRef = ref.shortUrl === undefined ? ref : parse(videoInfo.url) ?? ref
  const container = videoInfo.container
  const query = new URLSearchParams()
  if (container.bvid !== '') query.set('bvid', container.bvid)
  if (container.aid !== 0) query.set('aid', String(container.aid))
  query.set('cid', String(container.cid))
  query.set('isGaiaAvoided', 'false')
  const mixin = await fetchMixinKey(http, signal)
  if (mixin !== undefined) signWbi(query, mixin)
  const headers = { ...API_HEADERS }
  const cookie = http.cookie(id)
  if (cookie !== undefined) {
    const buvid = readCookie(cookie, 'buvid3')
    if (buvid !== undefined) headers['x-bili-buvid'] = buvid
  }
  const payload = await getJson(`https://api.bilibili.com/x/player/wbi/v2?${query.toString()}`, { siteId: id, headers }, http, signal)
  const data = unwrap(payload, 'player/wbi/v2 接口')
  const needLogin = readBoolean(data, ['need_login_subtitle'])
  const rows = [...readArray(data, ['subtitle', 'subtitles']), ...readArray(data, ['subtitle', 'ai_subtitles'])]
  const notes = []
  if (mixin === undefined) notes.push('未能取得 WBI 签名密钥（nav 接口不可用），本次请求未签名；该接口当前不强制校验，通常仍然可用。')
  if (needLogin) {
    notes.push(
      '接口返回 need_login_subtitle = true：该视频存在字幕，但只有登录后才返回字幕列表。' +
        '这不是“没有字幕”，请配置 SESSDATA 或环境变量后重试。',
    )
  }
  const tracks = []
  const seen = new Set()
  for (const [ordinal, entry] of rows.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const track = trackOf(/** @type {Record<string, unknown>} */ (entry), ordinal)
    // A track with no URL and no "generating" story is not offered at all.
    if (track.url === undefined && track.note === undefined) continue
    const key = track.url ?? `${track.id}:pending`
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push(track)
  }
  if (tracks.length === 0 && rows.length === 0) {
    notes.push(needLogin ? '字幕列表为空且需要登录。' : '字幕列表为空，且接口未标记需要登录：这个视频目前没有 CC 或 AI 字幕。')
  }
  return { tracks, notes, help: needLogin ? subtitleHelp : undefined }
}

/**
 * Download and parse one caption track.
 *
 * @param {import('../subtitle.js').SubtitleTrack} track Track to fetch.
 * @param {BilibiliRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../subtitle.js').SubtitleDocument>} Parsed captions.
 */
export async function download(track, ref, http, signal) {
  if (track.url === undefined) {
    throw new SiteError('这条 B 站字幕没有可下载的地址（subtitle_url 为空）。', { site: id, code: 'no-url', hint: subtitleHelp })
  }
  // The URL carries a minute-scale `auth_key`; fetch it immediately and never
  // truncate it (a shortened URL answers 403).
  const response = await getText(toHttps(track.url), { siteId: id, headers: { accept: 'application/json, text/plain, */*', referer } }, http, signal)
  const document = parseSubtitles(response.text, 'json')
  if (document.cues.length === 0) {
    throw new SiteError(`B站字幕文件已下载（${response.text.length} 字节）但没有解析出任何字幕行：${document.warnings.join('; ')}`, {
      site: id,
      code: 'empty-captions',
      hint: '字幕链接里的 auth_key 只有分钟级有效期，若间隔过久请重新抓取一次字幕列表。',
    })
  }
  return document
}

/**
 * Fetch a page's HTML, used only by the generic page scan.
 *
 * @param {BilibiliRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<string>} Page HTML, or an empty string when unreachable.
 */
export async function fetchPageHtml(ref, http, signal) {
  try {
    const response = await getText(ref.url, { siteId: id, headers: { accept: 'text/html,application/xhtml+xml,*/*', referer } }, http, signal)
    return response.text
  } catch (error) {
    if (error instanceof HttpError) return ''
    throw error
  }
}

// ---------------------------------------------------------------------------
// MD5 (WBI needs it; Node has no built-in hash for a string without crypto)
// ---------------------------------------------------------------------------

/** Lazily-created MD5 implementation. */
let md5Impl

/**
 * Hex-encoded MD5 of a UTF-8 string.
 *
 * Prefers Node's `crypto` (present in every DSH host) and falls back to a local
 * implementation so the module also runs in a plain browser bundler context.
 *
 * @param {string} text Input text.
 * @returns {string} 32 lowercase hex characters.
 */
export function md5Hex(text) {
  if (md5Impl === undefined) md5Impl = createMd5()
  return md5Impl(text)
}

/**
 * Build the MD5 function for this runtime.
 *
 * @returns {(text: string) => string} MD5 as lowercase hex.
 */
function createMd5() {
  try {
    // `node:crypto` is available in the DSH host; the import is dynamic so a
    // bundle that never signs anything does not need it.
    const require = typeof globalThis.process?.getBuiltinModule === 'function' ? globalThis.process.getBuiltinModule('node:crypto') : undefined
    if (require !== undefined && typeof require.createHash === 'function') {
      return (text) => require.createHash('md5').update(text, 'utf8').digest('hex')
    }
  } catch {
    /* fall through to the pure implementation */
  }
  return md5Pure
}

/** Per-round left-rotate amounts. */
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** Per-round sine-derived constants. */
const MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296))

/**
 * Pure-JS MD5 for UTF-8 input, used when `node:crypto` is unavailable.
 *
 * @param {string} text Input text.
 * @returns {string} 32 lowercase hex characters.
 */
export function md5Pure(text) {
  const bytes = new TextEncoder().encode(text)
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64
  const buffer = new Uint8Array(paddedLength)
  buffer.set(bytes)
  buffer[bytes.length] = 0x80
  const view = new DataView(buffer.buffer)
  // Length is little-endian in the last eight bytes; >512MB inputs lose the high word.
  view.setUint32(paddedLength - 8, bitLength >>> 0, true)
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const words = new Uint32Array(16)
  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(chunk + index * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let index = 0; index < 64; index += 1) {
      let f
      let g
      if (index < 16) {
        f = (b & c) | (~b & d)
        g = index
      } else if (index < 32) {
        f = (d & b) | (~d & c)
        g = (5 * index + 1) % 16
      } else if (index < 48) {
        f = b ^ c ^ d
        g = (3 * index + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * index) % 16
      }
      const rotated = rotateLeft((a + f + MD5_CONSTANTS[index] + words[g]) >>> 0, MD5_SHIFTS[index])
      a = d
      d = c
      c = b
      b = (b + rotated) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  return [a0, b0, c0, d0].map(littleEndianHex).join('')
}

/**
 * Rotate a 32-bit word left.
 *
 * @param {number} value Word.
 * @param {number} count Bits to rotate.
 * @returns {number} Rotated word.
 */
function rotateLeft(value, count) {
  return ((value << count) | (value >>> (32 - count))) >>> 0
}

/**
 * Render one 32-bit word as four hex bytes in MD5's little-endian order.
 *
 * @param {number} word Word.
 * @returns {string} Eight hex characters.
 */
function littleEndianHex(word) {
  let out = ''
  for (let index = 0; index < 4; index += 1) {
    out += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, '0')
  }
  return out
}
