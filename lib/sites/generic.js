/**
 * Generic adapter — the catch-all for any URL no site adapter claims.
 *
 * This is what makes the plugin useful beyond the sites it knows by name. It
 * works entirely from what the address and the document already contain:
 *
 * 1. a direct caption file (`.vtt`, `.srt`, `.ass`, `.lrc`, timed JSON) is
 *    downloaded and parsed as-is — this alone covers "I found the subtitle URL
 *    in devtools, read it for me";
 * 2. an `.m3u8` master playlist is read for `#EXT-X-MEDIA:TYPE=SUBTITLES`
 *    renditions, and each rendition's WebVTT segments are concatenated;
 * 3. an `.mpd` manifest is read for `AdaptationSet` text tracks;
 * 4. an HTML page is scanned (see `page-scan.js`) and every candidate is
 *    *probed* before being offered, so a random JSON next to a player never
 *    becomes a fake "subtitle track";
 * 5. a JSON body that carries a caption envelope is parsed directly.
 *
 * @module dsh-video-srt/lib/sites/generic
 */

import { getText, SiteError, toHttps } from '../http.js'
import { looksLikeCaptions, parseDashSubtitles, parseHlsSubtitles } from '../page-scan.js'
import { detectFormat, finalizeDocument, parseSubtitles } from '../subtitle.js'
import { fetchHtml, tracksFromPage, readPageMeta } from './base.js'

export const id = 'generic'
export const label = '通用（任意站点）'
export const homepage = ''
export const referer = undefined
export const captions = true
export const limitation =
  '通用模式只依赖地址本身与页面内容：直接的字幕文件、HLS/DASH 里的字幕轨、以及页面状态里已有的字幕地址。' +
  '需要签名或登录的接口它无法替代，那种情况请用对应站点的适配器或浏览器插件。'

/**
 * Whether the generic adapter handles a URL.
 *
 * It handles every absolute HTTP(S) URL: it is the fallback, not a site.
 *
 * @param {string} url Candidate URL.
 * @returns {boolean} True for an absolute HTTP(S) URL.
 */
export function match(url) {
  return /^https?:\/\//i.test(String(url ?? '').trim())
}

/**
 * A parsed generic identity.
 *
 * @typedef {object} GenericRef
 * @property {'generic'} site
 * @property {string} url The URL.
 * @property {string} sourceUrl The URL as given.
 * @property {string} host Hostname.
 * @property {'caption-file'|'hls'|'dash'|'json'|'page'} kind What the URL itself implies.
 */

/** Extensions that are unambiguously caption files. */
const CAPTION_EXTENSIONS = /\.(vtt|srt|ass|ssa|lrc)(\?|#|$)/i

/**
 * Parse any URL into a generic identity.
 *
 * @param {string} url Source URL.
 * @returns {GenericRef|undefined} The identity, or undefined for a non-HTTP URL.
 */
export function parse(url) {
  const text = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(text)) return undefined
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  const path = parsed.pathname
  const kind = CAPTION_EXTENSIONS.test(path)
    ? 'caption-file'
    : /\.m3u8$/i.test(path)
      ? 'hls'
      : /\.mpd$/i.test(path)
        ? 'dash'
        : /\.json$/i.test(path)
          ? 'json'
          : 'page'
  return { site: 'generic', url: parsed.toString(), sourceUrl: text, host: parsed.hostname, kind }
}

/**
 * Resolve metadata for a generic URL.
 *
 * @param {GenericRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../types.js').VideoInfo>} Video info.
 */
export async function info(ref, http, signal) {
  if (ref.kind !== 'page') {
    return {
      site: id,
      id: ref.url,
      url: ref.url,
      title: guessTitleFromUrl(ref.url),
      owner: '',
      durationSeconds: 0,
      container: { kind: /** @type {const} */ ('url'), url: ref.url, resourceKind: ref.kind },
      parts: [],
      stats: {},
      notes: [`这是一个直接的 ${ref.kind} 资源，不是网页。`],
    }
  }
  const html = await fetchHtml(ref.url, http, { siteId: id }, signal)
  const meta = readPageMeta(html, guessTitleFromUrl(ref.url))
  return {
    site: id,
    id: ref.url,
    url: ref.url,
    title: meta.title,
    owner: '',
    cover: meta.cover,
    durationSeconds: meta.durationSeconds ?? 0,
    description: meta.description,
    container: { kind: /** @type {const} */ ('page'), site: id, url: ref.url },
    parts: [],
    stats: {},
    notes: [],
  }
}

/**
 * Derive a readable title from a URL when the page offers none.
 *
 * @param {string} url Source URL.
 * @returns {string} Title guess.
 */
export function guessTitleFromUrl(url) {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter((entry) => entry !== '').pop() ?? parsed.hostname
    return decodeURIComponent(last.replace(/\.[a-z0-9]{1,5}$/i, '')) || parsed.hostname
  } catch {
    return url
  }
}

/**
 * List caption tracks for a generic URL.
 *
 * @param {GenericRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @param {import('../types.js').VideoInfo} [knownInfo] Already-resolved info.
 * @returns {Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], help?: string}>} Tracks and diagnostics.
 */
export async function tracks(ref, http, signal, knownInfo) {
  void knownInfo
  if (ref.kind === 'caption-file' || ref.kind === 'json') {
    return {
      tracks: [
        {
          id: 'direct',
          site: id,
          url: ref.url,
          format: detectFormat('', ref.url),
          label: '地址本身就是字幕文件',
        },
      ],
      notes: [],
    }
  }
  if (ref.kind === 'hls') return await hlsTracks(ref.url, http, signal)
  if (ref.kind === 'dash') return await dashTracks(ref.url, http, signal)

  const html = await fetchHtml(ref.url, http, { siteId: id }, signal)
  if (html === '') {
    return {
      tracks: [],
      notes: ['页面为空或站点拒绝了这次请求（可能需要登录，或对非浏览器请求返回了空壳页面）。'],
      help: '如果这个站点有专门的适配器，请使用它；否则可以在浏览器里打开视频，从开发者工具的网络面板复制字幕文件地址，再把这个地址直接交给 video_subtitle_fetch。',
    }
  }
  const scan = tracksFromPage(html, ref.url, id, undefined)
  const notes = scan.notes.slice()
  const verified = []
  for (const track of scan.tracks) {
    if (track.url === undefined) continue
    const probe = await probeCandidate(track.url, http, signal)
    if (probe === undefined) {
      notes.push(`候选地址被排除（内容不像字幕）：${shorten(track.url)}`)
      continue
    }
    verified.push({ ...track, format: probe.format, note: `${track.note ?? ''} [已确认：${probe.summary}]`.trim() })
  }
  for (const [ordinal, value] of scan.inline.entries()) {
    const text = JSON.stringify(value)
    const document = parseSubtitles(text, 'json')
    if (document.cues.length === 0) continue
    verified.push({
      id: `inline-${ordinal + 1}`,
      site: id,
      label: `页面内时间轴文本 ${ordinal + 1}`,
      lang: undefined,
      format: 'json',
      note: `来自页面状态，已解析出 ${document.cues.length} 条字幕。`,
      inline: text,
    })
  }
  if (verified.length === 0 && notes.length === 0) {
    notes.push('通用扫描没有在页面里找到字幕地址或时间轴文本。')
  }
  return {
    tracks: verified,
    notes,
    help:
      verified.length === 0
        ? '可以在浏览器里打开该视频，从开发者工具的网络面板筛选 vtt/srt/subtitle 请求，把字幕文件地址直接交给 video_subtitle_fetch。'
        : undefined,
  }
}

/**
 * Read subtitle renditions out of an HLS master playlist.
 *
 * @param {string} url Playlist URL.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[]}>} Tracks.
 */
async function hlsTracks(url, http, signal) {
  const response = await getText(url, { siteId: id, headers: { accept: 'application/vnd.apple.mpegurl,text/plain,*/*' } }, http, signal)
  const candidates = parseHlsSubtitles(response.text, url)
  const notes = []
  if (candidates.length === 0) {
    notes.push('这个 m3u8 里没有 #EXT-X-MEDIA:TYPE=SUBTITLES 字幕轨（它可能是媒体播放列表而不是主播放列表）。')
  }
  return {
    tracks: candidates.map((candidate, ordinal) => ({
      id: `hls-${ordinal + 1}`,
      site: id,
      url: candidate.url,
      lang: candidate.lang,
      label: candidate.label ?? `HLS 字幕 ${ordinal + 1}`,
      auto: candidate.auto === true,
      // A subtitle rendition is itself an m3u8 of WebVTT segments.
      format: /\.m3u8(\?|$)/i.test(candidate.url) ? 'hls-vtt' : 'vtt',
    })),
    notes,
  }
}

/**
 * Read caption adaptations out of a DASH manifest.
 *
 * @param {string} url Manifest URL.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[]}>} Tracks.
 */
async function dashTracks(url, http, signal) {
  const response = await getText(url, { siteId: id, headers: { accept: 'application/dash+xml,text/xml,*/*' } }, http, signal)
  const candidates = parseDashSubtitles(response.text, url)
  const notes = []
  if (candidates.length === 0) notes.push('这个 MPD 里没有文本类 AdaptationSet。')
  return {
    tracks: candidates.map((candidate, ordinal) => ({
      id: `dash-${ordinal + 1}`,
      site: id,
      url: candidate.url,
      lang: candidate.lang,
      label: candidate.label ?? `DASH 字幕 ${ordinal + 1}`,
      format: /\.vtt(\?|$)/i.test(candidate.url) ? 'vtt' : 'auto',
      note: candidate.mimeType,
    })),
    notes,
  }
}

/**
 * Probe a candidate URL to see whether it really carries captions.
 *
 * The probe is what keeps the generic scan honest: a URL is only offered as a
 * track once its body parses into cues or its manifest declares subtitle
 * renditions.
 *
 * @param {string} url Candidate URL.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<{format: string, summary: string}|undefined>} Probe result, or undefined when it is not captions.
 */
export async function probeCandidate(url, http, signal) {
  try {
    if (/\.m3u8(\?|$)/i.test(url)) {
      const response = await getText(url, { siteId: id, headers: { accept: 'application/vnd.apple.mpegurl,text/plain,*/*' } }, http, signal)
      if (!/#EXTM3U/.test(response.text)) return undefined
      const cueLines = response.text.split(/\r?\n/).filter((line) => line.includes('-->')).length
      return { format: 'hls-vtt', summary: cueLines > 0 ? `播放列表内含 ${cueLines} 条时间轴` : 'HLS 字幕播放列表' }
    }
    if (/\.mpd(\?|$)/i.test(url)) {
      const response = await getText(url, { siteId: id, headers: { accept: 'application/dash+xml,text/xml,*/*' } }, http, signal)
      const candidates = parseDashSubtitles(response.text, url)
      return candidates.length > 0 ? { format: 'auto', summary: `DASH 内含 ${candidates.length} 条文本轨` } : undefined
    }
    const response = await getText(url, { siteId: id, headers: { accept: 'text/plain,application/json,text/vtt,*/*' } }, http, signal)
    if (!looksLikeCaptions(response.text, response.contentType)) return undefined
    const document = parseSubtitles(response.text, response.contentType === '' ? undefined : response.contentType)
    if (document.cues.length === 0) return undefined
    return { format: document.format, summary: `${document.cues.length} 条字幕（${document.format}）` }
  } catch {
    return undefined
  }
}

/**
 * Download a generic track, expanding HLS subtitle playlists into cues.
 *
 * @param {import('../subtitle.js').SubtitleTrack} track Track to fetch.
 * @param {GenericRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../subtitle.js').SubtitleDocument>} Parsed captions.
 */
export async function download(track, ref, http, signal) {
  void ref
  // An inline payload needs no network hop: it was already parsed by the scan.
  if (typeof track.inline === 'string') {
    const document = parseSubtitles(track.inline, 'json')
    if (document.cues.length === 0) {
      throw new SiteError('页面内时间轴文本没有解析出字幕行。', { site: id, code: 'empty-captions' })
    }
    return document
  }
  if (track.url === undefined) {
    throw new SiteError('这条记录没有可下载的地址。', { site: id, code: 'no-url' })
  }
  const url = toHttps(track.url)
  if (track.format === 'hls-vtt' || /\.m3u8(\?|$)/i.test(url)) {
    return await downloadHlsSubtitle(url, http, signal)
  }
  const response = await getText(url, { siteId: id, headers: { accept: 'text/plain,application/json,text/vtt,*/*' } }, http, signal)
  const document = parseSubtitles(response.text, response.contentType === '' ? track.format : response.contentType)
  if (document.cues.length === 0) {
    throw new SiteError(`下载成功（${response.text.length} 字节）但没有解析出字幕行：${document.warnings.join('; ')}`, {
      site: id,
      code: 'empty-captions',
      detail: { head: response.text.slice(0, 200) },
    })
  }
  return document
}

/**
 * Concatenate the WebVTT segments of an HLS subtitle rendition.
 *
 * A subtitle rendition playlist lists one `.vtt` per segment; the cues are
 * already absolute in each segment for the formats in use here, but a segment
 * may also carry its own `X-TIMESTAMP-MAP`. Segments are concatenated in order
 * and re-finalized, which repairs cross-segment ordering.
 *
 * @param {string} url Rendition playlist URL.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../subtitle.js').SubtitleDocument>} Parsed captions.
 */
export async function downloadHlsSubtitle(url, http, signal) {
  const playlist = await getText(url, { siteId: id, headers: { accept: 'application/vnd.apple.mpegurl,text/plain,*/*' } }, http, signal)
  if (!/#EXTM3U/.test(playlist.text)) {
    // Not actually a playlist: it may be the VTT body itself.
    const direct = parseSubtitles(playlist.text, 'vtt')
    if (direct.cues.length > 0) return direct
    throw new SiteError('这个地址既不是 m3u8 播放列表，也不是 WebVTT 字幕。', { site: id, code: 'not-captions' })
  }
  const segments = playlist.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  /** @type {import('../subtitle.js').SubtitleCue[]} */
  const cues = []
  const warnings = []
  let fetched = 0
  for (const segment of segments) {
    let absolute
    try {
      absolute = new URL(segment, url).toString()
    } catch {
      continue
    }
    // A nested playlist is a variant list; following one level is enough.
    if (/\.m3u8(\?|$)/i.test(absolute)) {
      const nested = await downloadHlsSubtitle(absolute, http, signal)
      cues.push(...nested.cues)
      fetched += 1
      continue
    }
    try {
      const response = await getText(absolute, { siteId: id, headers: { accept: 'text/vtt,text/plain,*/*' } }, http, signal)
      const document = parseSubtitles(response.text, 'vtt')
      cues.push(...document.cues)
      warnings.push(...document.warnings)
      fetched += 1
    } catch (error) {
      warnings.push(`分片 ${shorten(absolute)} 获取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (cues.length === 0) {
    throw new SiteError(`HLS 字幕播放列表里有 ${segments.length} 个分片，但没能取到任何字幕。`, {
      site: id,
      code: 'empty-hls',
      detail: { segments: segments.length, fetched, warnings: warnings.slice(0, 5) },
    })
  }
  return finalizeDocument(cues, 'vtt', warnings)
}

/**
 * Fetch a generic page's HTML.
 *
 * @param {GenericRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<string>} Page HTML.
 */
export async function fetchPageHtml(ref, http, signal) {
  return await fetchHtml(ref.url, http, { siteId: id }, signal)
}

/**
 * Shorten a URL for a diagnostic note.
 *
 * @param {string} url Source URL.
 * @returns {string} At most 100 characters.
 */
function shorten(url) {
  return url.length <= 100 ? url : `${url.slice(0, 97)}…`
}
