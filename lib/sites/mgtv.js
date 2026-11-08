/**
 * MangoTV (芒果TV) adapter.
 *
 * The best-behaved of the Chinese commercial platforms, because its request
 * signature is a pure client-side transform with no secret: `tk2` is
 * `base64url(...)` with the characters reversed. Getting a *stream* also needs
 * a second call whose `pm2` comes from the first, but the caption list and the
 * caption files themselves do not — so this adapter skips that hop entirely.
 *
 * Chain:
 *
 * 1. `pcweb.api.mgtv.com/player/video` for title/duration,
 * 2. `pcweb.api.mgtv.com/video/title` for the caption track list,
 * 3. each track's own `url` for a JSON envelope whose `info` field is the `.srt`,
 * 4. that `.srt`.
 *
 * @module dsh-video-srt/lib/sites/mgtv
 */

import { getJson, getText, SiteError, toHttps } from '../http.js'
import { parseSubtitles } from '../subtitle.js'
import { fetchHtml } from './base.js'

export const id = 'mgtv'
export const label = '芒果TV'
export const homepage = 'https://www.mgtv.com'
export const referer = 'https://www.mgtv.com/'
/**
 * False: the track list is real, the files are not reachable.
 *
 * `video/title` returns a genuine caption list (18 rows with names like
 * 简体中文 / English / ภาษาไทย), but every row's `vod.do` address 404s on
 * `pcweb.api.mgtv.com` and `player/video` exposes no `stream_domain` to resolve
 * it against, so no `.srt` can be fetched. Listing tracks that cannot download
 * would be the same overclaim as claiming captions outright.
 */
export const captions = false
/** Shown wherever an empty track list needs explaining. */
export const limitation =
  '芒果TV 的元信息（标题、时长）可以读到，video/title 接口也确实返回真字幕列表，' +
  '但每轨的 vod.do 地址在 pcweb.api.mgtv.com 上不存在（No handler found），取不到实际 .srt 文件。'

/** Documented code for "the parameters were wrong". */
const CODE_BAD_PARAMS = 30001

/**
 * Whether this adapter handles a URL.
 *
 * @param {string} url Candidate URL.
 * @returns {boolean} True when the host belongs to mgtv.
 */
export function match(url) {
  return /(^|\.)mgtv\.com$/i.test(hostOf(url) ?? '')
}

/**
 * Extract the lowercase host of a URL.
 *
 * @param {string} url Candidate URL.
 * @returns {string|undefined} Host, when parseable.
 */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * A parsed MangoTV identity.
 *
 * @typedef {object} MgtvRef
 * @property {'mgtv'} site
 * @property {string} url Canonical watch URL.
 * @property {string} [videoId] Numeric video id.
 * @property {string} [collectionId] Series id (`/b/<id>/`).
 * @property {string} sourceUrl The URL as given.
 */

/**
 * Parse a MangoTV URL.
 *
 * Understands `/b/<collection>/<videoId>.html` (the show page form) and
 * `/play/<videoId>.html`, plus a bare numeric id.
 *
 * @param {string} url Source URL.
 * @returns {MgtvRef|undefined} The identity, or undefined when unrecognized.
 */
export function parse(url) {
  const text = String(url ?? '').trim()
  if (/^\d{4,}$/.test(text)) return { site: 'mgtv', url: `https://www.mgtv.com/b/${text}.html`, videoId: text, sourceUrl: text }
  if (hostOf(text) === undefined) return undefined
  const path = new URL(text).pathname
  const show = /\/b\/(\d+)\/(\d+)\.html/.exec(path)
  if (show !== null) {
    return { site: 'mgtv', url: new URL(text).toString(), collectionId: show[1], videoId: show[2], sourceUrl: text }
  }
  const collection = /\/b\/(\d+)(?:\.html)?/.exec(path)
  const play = /\/play\/(\d+)(?:\.html)?/.exec(path)
  const videoId = play?.[1]
  if (collection !== null || videoId !== undefined) {
    return {
      site: 'mgtv',
      url: new URL(text).toString(),
      videoId,
      collectionId: collection?.[1],
      sourceUrl: text,
    }
  }
  return undefined
}

/**
 * Build the `tk2` request token.
 *
 * `tk2 = reverse(base64url('did=<uuid>|pno=1030|ver=0.3.0301|clit=<unix seconds>'))`.
 * There is no secret in it; the reversal is the whole obfuscation.
 *
 * @param {number} [now] Unix seconds; defaults to now.
 * @param {string} [deviceId] Stable device id; defaults to a random UUID.
 * @returns {string} The token.
 */
export function buildTk2(now, deviceId) {
  const payload = `did=${deviceId ?? randomUuid()}|pno=1030|ver=0.3.0301|clit=${now ?? Math.floor(Date.now() / 1000)}`
  const encoded = Buffer.from(payload, 'utf8').toString('base64url')
  return [...encoded].reverse().join('')
}

/**
 * A random UUID, so `tk2` is not a stable device fingerprint.
 *
 * @returns {string} UUID text.
 */
function randomUuid() {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** JSON headers for the mgtv API. */
const API_HEADERS = { accept: 'application/json, text/plain, */*', referer }

/**
 * Turn an mgtv envelope into its `data`.
 *
 * @param {unknown} payload Parsed response.
 * @param {string} what Operation name for the message.
 * @returns {unknown} The `data` member.
 */
function unwrap(payload, what) {
  if (payload === null || typeof payload !== 'object') {
    throw new SiteError(`芒果TV ${what} 返回了非对象响应。`, { site: id, code: 'shape' })
  }
  const record = /** @type {Record<string, unknown>} */ (payload)
  const code = record.code
  if (code === 200 || code === '200') return record.data
  const text = String(code)
  throw new SiteError(`芒果TV ${what} 失败：code=${text} ${typeof record.msg === 'string' ? record.msg : ''}`.trim(), {
    site: id,
    code: text,
    hint:
      text === String(CODE_BAD_PARAMS)
        ? '参数错误（30001）：通常是 tk2 缺失或过期，插件已自动生成，请重试。'
        : text === '40005'
          ? '地区限制（40005）：该内容在当前网络所在地不可用。'
          : undefined,
  })
}

/**
 * Read a nested value out of an unknown JSON value.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {unknown} The value, or undefined.
 */
function at(value, path) {
  let cursor = value
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key]
  }
  return cursor
}

/**
 * Read a nested non-empty string.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {string|undefined} The string, when present.
 */
function str(value, path) {
  const found = at(value, path)
  return typeof found === 'string' && found !== '' ? found : undefined
}

/**
 * Read a nested finite number.
 *
 * @param {unknown} value Source value.
 * @param {string[]} path Key path.
 * @returns {number|undefined} The number, when present.
 */
function num(value, path) {
  const found = at(value, path)
  if (typeof found === 'number' && Number.isFinite(found)) return found
  if (typeof found === 'string') {
    const parsed = Number.parseInt(found, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Resolve a video's metadata.
 *
 * @param {MgtvRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../types.js').VideoInfo>} Video info.
 */
export async function info(ref, http, signal) {
  const videoId = ref.videoId
  if (videoId === undefined) {
    throw new SiteError(
      '芒果TV 的这个地址没有定位到具体某一集，请给出形如 https://www.mgtv.com/b/<合集id>/<视频id>.html 的地址。',
      { site: id, code: 'no-video-id', detail: { url: ref.sourceUrl } },
    )
  }
  const payload = await getJson(
    `https://pcweb.api.mgtv.com/player/video?tk2=${encodeURIComponent(buildTk2())}&video_id=${videoId}&type=pch5`,
    { siteId: id, headers: API_HEADERS },
    http,
    signal,
  )
  const data = unwrap(payload, 'player/video 接口')
  const duration = num(data, ['info', 'duration']) ?? 0
  return {
    site: id,
    id: videoId,
    url: ref.url,
    title: str(data, ['info', 'title']) ?? '',
    owner: str(data, ['info', 'partName']) ?? '',
    cover: str(data, ['info', 'thumb']),
    durationSeconds: duration,
    description: undefined,
    container: { kind: /** @type {const} */ ('mgtv'), videoId, collectionId: ref.collectionId },
    parts: [],
    stats: {},
    notes: [],
  }
}

/**
 * List a video's caption tracks.
 *
 * @param {MgtvRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @param {import('../types.js').VideoInfo} [knownInfo] Already-resolved info.
 * @returns {Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], help?: string}>} Tracks and diagnostics.
 */
export async function tracks(ref, http, signal, knownInfo) {
  const videoInfo = knownInfo ?? (await info(ref, http, signal))
  const videoId = videoInfo.container.videoId
  const payload = await getJson(`https://pcweb.api.mgtv.com/video/title?videoId=${videoId}`, { siteId: id, headers: API_HEADERS }, http, signal)
  const data = unwrap(payload, 'video/title 接口')
  const rows = at(data, ['title'])
  const notes = []
  if (!Array.isArray(rows)) {
    notes.push('video/title 接口没有返回预期的 title 数组。')
    return { tracks: [], notes }
  }
  const tracks = []
  for (const [ordinal, row] of rows.entries()) {
    if (row === null || typeof row !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (row)
    const url = typeof record.url === 'string' && record.url !== '' ? record.url : undefined
    if (url === undefined) continue
    const locale = typeof record.captionSimpleName === 'string' && record.captionSimpleName !== '' ? record.captionSimpleName : 'en'
    tracks.push({
      id: String(ordinal + 1),
      site: id,
      // Not a caption file: an envelope whose `info` field is one. `download`
      // unwraps it, which is why the format hint is `json-envelope`.
      url: absoluteUrl(url, videoInfo.container),
      lang: localeToTag(locale),
      label: typeof record.name === 'string' && record.name !== '' ? record.name : locale,
      format: 'json-envelope',
    })
  }
  if (tracks.length === 0) {
    notes.push('该视频在芒果TV 上没有外挂字幕轨道（title 数组为空）。')
    return { tracks, notes }
  }

  // The list is genuine data — a real video returns 18 rows with names like
  // 简体中文 / English / ภาษาไทย — but a listed row is only useful if its
  // `vod.do` address actually resolves to a caption file. Probing one is enough
  // to settle it: every row in a response shares one resolution path, so either
  // they all download or none do.
  try {
    const sample = await download(tracks[0], ref, http, signal)
    if (sample.cues.length === 0) throw new Error('解析后 0 条字幕')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const sample_labels = tracks
      .slice(0, 4)
      .map((track) => track.label)
      .join('、')
    const note =
      `芒果TV 的 video/title 接口确实返回了 ${tracks.length} 条字幕轨（${sample_labels} 等），` +
      `但取不到实际字幕文件：${reason}。插件因此不把它们当作可用字幕轨——宁可说「没有」，也不列一条下载不了的轨。`
    return { tracks: [], notes: [...notes, note], help: note }
  }
  return { tracks, notes }
}

/**
 * Resolve a track URL that may be relative to the stream domain.
 *
 * The documented chain prefixes the per-track URL with the `stream_domain` the
 * `getSource` call returns. Fetching the stream is not needed for captions, so
 * the sibling `pcweb.api.mgtv.com` host is used instead when the URL is not
 * already absolute — which is what the endpoint actually serves.
 *
 * @param {string} url Raw track URL.
 * @param {{videoId: string}} _container Unused container, kept for the call shape.
 * @returns {string} Absolute URL.
 */
function absoluteUrl(url, _container) {
  void _container
  const upgraded = toHttps(url)
  if (/^https?:\/\//i.test(upgraded)) return upgraded
  if (upgraded.startsWith('/')) return `https://pcweb.api.mgtv.com${upgraded}`
  return `https://pcweb.api.mgtv.com/${upgraded}`
}

/**
 * Map a MangoTV locale label onto a language tag.
 *
 * @param {string} locale Site label such as `中文（简体）` or `en`.
 * @returns {string|undefined} Language tag, when recognizable.
 */
function localeToTag(locale) {
  const text = String(locale ?? '')
  if (/简体|中文|chinese|zh/i.test(text)) return 'zh-CN'
  if (/繁體|繁体|traditional/i.test(text)) return 'zh-TW'
  if (/英文|english|^en/i.test(text)) return 'en'
  return text === '' ? undefined : text
}

/**
 * Download and parse one caption track, unwrapping the JSON envelope.
 *
 * @param {import('../subtitle.js').SubtitleTrack} track Track to fetch.
 * @param {MgtvRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../subtitle.js').SubtitleDocument>} Parsed captions.
 */
export async function download(track, ref, http, signal) {
  if (track.url === undefined) throw new SiteError('这条芒果TV 字幕没有可下载的地址。', { site: id, code: 'no-url' })
  const envelope = await getJson(track.url, { siteId: id, headers: API_HEADERS }, http, signal)
  const srtUrl = typeof at(envelope, ['info']) === 'string' ? at(envelope, ['info']) : undefined
  if (typeof srtUrl !== 'string' || srtUrl === '') {
    // Some responses serve the SRT body directly rather than an envelope.
    const document = parseSubtitles(JSON.stringify(envelope), 'json')
    if (document.cues.length > 0) return document
    throw new SiteError('芒果TV 字幕信封里没有 info 字段（也就是没有真正的 .srt 地址）。', {
      site: id,
      code: 'no-srt-url',
      detail: { keys: envelope !== null && typeof envelope === 'object' ? Object.keys(envelope) : [] },
    })
  }
  const response = await getText(toHttps(srtUrl), { siteId: id, headers: { accept: 'text/plain, */*', referer } }, http, signal)
  const document = parseSubtitles(response.text, detectCaptionFormat(srtUrl))
  if (document.cues.length === 0) {
    throw new SiteError(`芒果TV 字幕文件已下载（${response.text.length} 字节）但没有解析出字幕行：${document.warnings.join('; ')}`, {
      site: id,
      code: 'empty-captions',
    })
  }
  return document
}

/**
 * Guess a caption format from a URL.
 *
 * @param {string} url Caption URL.
 * @returns {string} Format hint.
 */
function detectCaptionFormat(url) {
  if (/\.vtt(\?|$)/i.test(url)) return 'vtt'
  if (/\.ass(\?|$)/i.test(url)) return 'ass'
  if (/\.json(\?|$)/i.test(url)) return 'json'
  return 'srt'
}

/**
 * Fetch the page's HTML for the generic scan.
 *
 * @param {MgtvRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<string>} Page HTML.
 */
export async function fetchPageHtml(ref, http, signal) {
  return await fetchHtml(ref.url, http, { siteId: id, referer }, signal)
}
