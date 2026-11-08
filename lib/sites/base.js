/**
 * Shared adapter building blocks.
 *
 * Most adapters in this plugin can do one of two things: serve captions
 * properly (bilibili, MangoTV), or explain precisely why they cannot. The
 * second case is not a failure mode to hide — a model that asks for 优酷
 * captions deserves to be told "Youku keeps subtitles in external `.ass` files
 * fetched by a private player command, and the public API never returns them"
 * rather than a bare "unsupported".
 *
 * This module holds the parts both cases share: the page fetcher, the scanner
 * bridge, and the construction of an explained, honest empty result.
 *
 * @module dsh-video-srt/lib/sites/base
 */

import { getText, HttpError } from '../http.js'
import { looksLikeCaptions, scanHtml } from '../page-scan.js'
import { parseSubtitles } from '../subtitle.js'

/**
 * Fetch a page's HTML, returning an empty string rather than throwing when the
 * site refuses the request. A page we cannot read is a normal outcome for every
 * adapter here, not an error worth propagating.
 *
 * @param {string} url Page URL.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {{siteId: string, referer?: string}} options Request identity.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<string>} Page HTML, or an empty string.
 */
export async function fetchHtml(url, http, options, signal) {
  try {
    const response = await getText(
      url,
      {
        siteId: options.siteId,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(options.referer === undefined ? {} : { referer: options.referer }),
        },
      },
      http,
      signal,
    )
    return response.text
  } catch (error) {
    if (error instanceof HttpError) return ''
    throw error
  }
}

/**
 * Read a `<title>` out of HTML, for sites that expose nothing else.
 *
 * @param {string} html Page HTML.
 * @returns {string|undefined} Decoded page title.
 */
export function readHtmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return undefined
  const text = match[1].replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text
}

/**
 * Read an Open Graph or `meta name` content value.
 *
 * @param {string} html Page HTML.
 * @param {string[]} names Meta property/name values to try.
 * @returns {string|undefined} Content value.
 */
export function readMeta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')
    const match = re.exec(html)
    if (match !== null && match[1].trim() !== '') return match[1].trim()
    const reversed = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i')
    const other = reversed.exec(html)
    if (other !== null && other[1].trim() !== '') return other[1].trim()
  }
  return undefined
}

/**
 * Run the generic page scan and turn its findings into caption tracks.
 *
 * Inline timed-text payloads are registered as synthetic `inline:<n>` tracks so
 * the caller can fetch them without a second network round trip; real caption
 * URLs become ordinary tracks.
 *
 * @param {string} html Page HTML.
 * @param {string} baseUrl Page URL.
 * @param {string} siteId Adapter id.
 * @param {(url: string, http: import('../http.js').HttpContext, signal?: AbortSignal) => Promise<import('../subtitle.js').SubtitleDocument>} downloader
 *   How this adapter downloads an ordinary track URL.
 * @returns {{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], inline: unknown[]}} Scan result.
 */
export function tracksFromPage(html, baseUrl, siteId, downloader) {
  const result = scanHtml(html, baseUrl)
  const tracks = result.candidates.map((candidate, ordinal) => ({
    id: `scan-${ordinal + 1}`,
    site: siteId,
    url: candidate.url,
    lang: candidate.lang,
    label: candidate.label ?? `${sourceLabel(candidate.source)} ${ordinal + 1}`,
    auto: candidate.auto === true,
    format: 'auto',
    note: candidate.source,
  }))
  const notes = result.notes.slice()
  if (tracks.length === 0 && result.inline.length === 0) {
    notes.push('通用页面扫描没有在 HTML / 页面状态里找到字幕文件地址或时间轴文本。')
  }
  void downloader
  return { tracks, notes, inline: result.inline.map((entry) => entry.value) }
}

/**
 * Human-readable label for a scan source tag.
 *
 * @param {string} source Source tag such as `json-state:$.props.x`.
 * @returns {string} Label.
 */
function sourceLabel(source) {
  if (source.startsWith('json-state')) return '页面状态里的字幕'
  if (source === 'track-element') return '<track> 标签'
  if (source === 'hls-master') return 'HLS 字幕轨'
  if (source === 'dash-mpd') return 'DASH 字幕轨'
  if (source === 'url-scan') return '页面内字幕链接'
  return '扫描到的字幕'
}

/**
 * Try to download a candidate and parse it, tolerating a non-caption body.
 *
 * @param {string} url Candidate URL.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {{siteId: string, referer?: string}} options Request identity.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../subtitle.js').SubtitleDocument>} Parsed captions.
 */
export async function downloadCandidate(url, http, options, signal) {
  const response = await getText(
    url,
    { siteId: options.siteId, headers: { accept: 'text/plain,application/json,*/*', ...(options.referer === undefined ? {} : { referer: options.referer }) } },
    http,
    signal,
  )
  if (!looksLikeCaptions(response.text, response.contentType)) {
    throw new Error(`该地址返回的内容不像字幕文件（${response.contentType || '未知类型'}，${response.text.length} 字节）。`)
  }
  return parseSubtitles(response.text, response.contentType === '' ? undefined : response.contentType)
}

/**
 * Build the "this site cannot serve captions here" result.
 *
 * @param {string} id Adapter id.
 * @param {string} limitation Why captions are unavailable.
 * @param {string} [extra] Additional note to attach.
 * @returns {{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], help: string}} Empty result with explanation.
 */
export function unsupported(id, limitation, extra) {
  const notes = [limitation]
  if (extra !== undefined && extra !== '') notes.push(extra)
  return { tracks: [], notes, help: limitation }
}

/**
 * Site metadata that could not be read through an API, taken from the page.
 *
 * @typedef {object} PageMeta
 * @property {string} title Empty when the page carried no real video title.
 * @property {string} [description]
 * @property {string} [cover]
 * @property {number} [durationSeconds]
 * @property {boolean} [shell] True when the page is a client-rendered shell.
 */

/**
 * Read the metadata a page exposes through `<title>` and Open Graph tags.
 *
 * **Shell detection.** A client-rendered page (爱奇艺, 抖音, 西瓜 …) returns a
 * full-size HTML document whose only title is the *site's* boilerplate — "爱奇艺
 * -在线视频网站-海量正版高清视频在线观看" — with no Open Graph tags at all and not
 * even the video id anywhere in the markup. Reporting that as the video title is
 * worse than reporting nothing: it looks like a successful read of the wrong
 * video. When a caller supplies the id and the page fails every test for being
 * about that video, the title comes back empty so the caller can say "读不到".
 *
 * @param {string} html Page HTML.
 * @param {string} [fallbackTitle] Title to use when the page exposes none.
 * @param {string} [id] The video id, when the adapter has one; enables shell detection.
 * @returns {PageMeta} Page metadata.
 */
export function readPageMeta(html, fallbackTitle, id) {
  const pageTitle = readMeta(html, ['og:title', 'twitter:title', 'title'])
  const known = typeof id === 'string' && id !== ''
  // Only an id-bearing page can be judged a shell; without an id there is
  // nothing to look for in the markup.
  const shell = known && pageTitle === undefined && !html.includes(id)
  if (shell) {
    return { title: '', shell: true }
  }
  const title = pageTitle ?? readHtmlTitle(html) ?? fallbackTitle ?? ''
  const description = readMeta(html, ['og:description', 'description', 'twitter:description'])
  const cover = readMeta(html, ['og:image', 'twitter:image'])
  const durationText = readMeta(html, ['og:video:duration', 'video:duration', 'duration'])
  const duration = durationText === undefined ? undefined : Number.parseInt(durationText, 10)
  return {
    title: cleanTitle(title),
    description,
    cover,
    durationSeconds: Number.isFinite(duration) ? duration : undefined,
  }
}

/**
 * Strip the site-name suffix Chinese video sites append to `<title>`.
 *
 * @param {string} title Raw title.
 * @returns {string} Cleaned title.
 */
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/[_\-|]\s*(腾讯视频|优酷|爱奇艺|芒果TV|抖音|快手|西瓜视频|微博|哔哩哔哩|bilibili|AcFun)\s*$/i, '')
    .trim()
}
