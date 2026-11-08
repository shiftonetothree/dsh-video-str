/**
 * Tencent Video (腾讯视频) adapter.
 *
 * Captions are reachable server-side, but only through a signed request:
 * `h5vv6.video.qq.com/getvinfo` demands a `cKey` computed as
 * AES-128-CBC over a checksum-prefixed payload with a fixed key/IV and
 * **whitespace** padding (pad with `0x20`, last byte = pad length — not
 * PKCS#7). The response is not JSON: it is the JavaScript assignment
 * `QZOutputJson={...};`.
 *
 * Two subtleties that silently produce garbage when missed:
 *
 * - the user agent enters the checksum and is truncated to 48 characters, so the
 *   UA used for signing **must** be the UA sent on the wire (this adapter passes
 *   the transport's own {@link DESKTOP_UA} into the signer for that reason);
 * - the caption format is chosen *per request* by `spcaptiontype` (`1` = VTT,
 *   `0` = SRT), so a site that only serves one of the two needs the other asked
 *   for explicitly.
 *
 * @module dsh-video-srt/lib/sites/qq
 */

import { DESKTOP_UA, getText, SiteError, toHttps } from '../http.js'
import { parseSubtitles } from '../subtitle.js'
import { cleanTitle, fetchHtml, readMeta, readPageMeta } from './base.js'

export const id = 'qq'
export const label = '腾讯视频'
export const homepage = 'https://v.qq.com'
export const referer = 'https://v.qq.com/'
/**
 * False: metadata works, captions have never been observed.
 *
 * The signing chain and the `getvinfo` envelope are implemented and verified, but
 * every real sample inspected (`tools/audit-sites.mjs`, several variety and movie
 * pages) returned an empty `sfl.fi[]`. Claiming caption support on unverified
 * field names is what this audit set out to stop, so the roster says 仅元信息.
 */
export const captions = false
/** Shown wherever an empty track list needs explaining. */
export const limitation =
  '腾讯视频的元信息（标题、时长）可以读到，但字幕轨在多个真实样本上恒为 0 条：' +
  '签名字段 sfl.fi[] 来自第三方实现，从未观察到非空样本。未登录访客也拿不到需要 vqq_vusession 的会员字幕。'

/** The AES-128 key Tencent's web player uses. */
const CKEY_KEY = Buffer.from('4f6bdaa39e2f8cb07f5e722d9edef314', 'hex')
/** The AES-CBC initialisation vector that pairs with {@link CKEY_KEY}. */
const CKEY_IV = Buffer.from('01504af356e619cf2e42bba68c3f70f9', 'hex')
/** Constant that appears in the signed plaintext. */
const CKEY_TAG = 'mg3c3b04ba'
/** `appVer` participates in the checksum. */
const APP_VER = '3.5.57'
/** `platform` participates in the checksum. */
const PLATFORM = '10901'

/**
 * Whether this adapter handles a URL.
 *
 * @param {string} url Candidate URL.
 * @returns {boolean} True when the host belongs to v.qq.com.
 */
export function match(url) {
  return /(^|\.)(v\.qq\.com|film\.qq\.com|m\.v\.qq\.com)$/i.test(hostOf(url) ?? '')
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
 * A parsed Tencent Video identity.
 *
 * @typedef {object} QqRef
 * @property {'qq'} site
 * @property {string} url Canonical watch URL.
 * @property {string} [vid] 11-character video id.
 * @property {string} [cid] Series/cover id.
 * @property {string} sourceUrl The URL as given.
 */

/**
 * Parse a Tencent Video URL.
 *
 * Understands `/x/cover/<cid>/<vid>.html`, `/x/page/<vid>.html`,
 * `/x/cover/<cid>.html`, and a bare `vid`.
 *
 * @param {string} url Source URL.
 * @returns {QqRef|undefined} The identity, or undefined when unrecognized.
 */
export function parse(url) {
  const text = String(url ?? '').trim()
  if (/^[a-z0-9]{11}$/i.test(text)) return { site: 'qq', url: `https://v.qq.com/x/page/${text}.html`, vid: text, sourceUrl: text }
  if (hostOf(text) === undefined) return undefined
  const path = new URL(text).pathname
  const cover = /\/x\/cover\/([a-z0-9]+)\/([a-z0-9]+)\.html/i.exec(path)
  if (cover !== null) return { site: 'qq', url: new URL(text).toString(), cid: cover[1], vid: cover[2], sourceUrl: text }
  const page = /\/x\/page\/([a-z0-9]+)\.html/i.exec(path)
  if (page !== null) return { site: 'qq', url: new URL(text).toString(), vid: page[1], sourceUrl: text }
  const coverOnly = /\/x\/cover\/([a-z0-9]+)\.html/i.exec(path)
  if (coverOnly !== null) return { site: 'qq', url: new URL(text).toString(), cid: coverOnly[1], sourceUrl: text }
  // `/x/cover/<cid>/<vid>` without the extension also appears in the wild.
  const bare = /\/x\/(?:cover|page)\/([a-z0-9]+)(?:\/([a-z0-9]+))?/i.exec(path)
  if (bare !== null) {
    return { site: 'qq', url: new URL(text).toString(), cid: bare[2] === undefined ? undefined : bare[1], vid: bare[2] ?? bare[1], sourceUrl: text }
  }
  return undefined
}

/**
 * Compute the `cKey` signature for a `getvinfo` request.
 *
 * @param {object} input Signing inputs.
 * @param {string} input.vid Video id.
 * @param {string} input.pageUrl Page URL (truncated to 48 characters).
 * @param {string} input.userAgent User agent (lowercased, truncated to 48).
 * @param {number} input.timestamp Unix seconds.
 * @param {string} input.guid Random 16-character id.
 * @param {string} [input.appVer] Player version.
 * @param {string} [input.platform] Platform id.
 * @returns {string} Uppercase hex ciphertext.
 */
export function buildCkey(input) {
  const payload =
    `${input.vid}|${input.timestamp}|${CKEY_TAG}|${input.appVer ?? APP_VER}|${input.guid}|${input.platform ?? PLATFORM}|` +
    `${input.pageUrl.slice(0, 48)}|${input.userAgent.toLowerCase().slice(0, 48)}||Mozilla|Netscape|Windows x86_64|00|`
  let checksum = 0
  for (const char of payload) checksum += char.codePointAt(0) ?? 0
  const plain = `|${checksum}|${payload}`
  return aesCbcEncryptHex(plain, CKEY_KEY, CKEY_IV)
}

/**
 * AES-128-CBC encrypt with **whitespace** padding, as lowercase-free uppercase hex.
 *
 * Whitespace padding fills with `0x20` and writes the pad length into the final
 * byte, which is not what PKCS#7 does: a PKCS#7 implementation produces a
 * different (and rejected) signature.
 *
 * @param {string} plaintext Input text.
 * @param {Uint8Array} key 16-byte key.
 * @param {Uint8Array} iv 16-byte IV.
 * @returns {string} Uppercase hex ciphertext.
 */
function aesCbcEncryptHex(plaintext, key, iv) {
  const crypto = nodeCrypto()
  const blockSize = 16
  const input = Buffer.from(plaintext, 'utf8')
  const padLength = blockSize - (input.length % blockSize)
  const padded = Buffer.alloc(input.length + padLength, 0x20)
  input.copy(padded)
  padded[padded.length - 1] = padLength
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  return encrypted.toString('hex').toUpperCase()
}

/**
 * Load Node's `crypto` module.
 *
 * The signature scheme is unreachable without AES, so a runtime that cannot
 * provide it gets an explained error rather than a wrong signature.
 *
 * @returns {typeof import('node:crypto')} The crypto module.
 */
function nodeCrypto() {
  const module = typeof globalThis.process?.getBuiltinModule === 'function' ? globalThis.process.getBuiltinModule('node:crypto') : undefined
  if (module === undefined || typeof module.createCipheriv !== 'function') {
    throw new SiteError('腾讯视频的字幕签名需要 Node 的 crypto 模块（AES-128-CBC），当前运行环境没有提供。', {
      site: id,
      code: 'no-crypto',
    })
  }
  return module
}

/**
 * Generate a random lowercase alphanumeric id.
 *
 * @param {number} length Character count.
 * @returns {string} Random id.
 */
function randomId(length) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let out = ''
  for (let index = 0; index < length; index += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/**
 * Strip the `QZOutputJson=` envelope and parse the payload.
 *
 * @param {string} text Response body.
 * @param {string} what Operation name for the message.
 * @returns {Record<string, unknown>} Parsed payload.
 */
export function parseQzOutput(text, what) {
  const marker = text.indexOf('QZOutputJson=')
  if (marker < 0) {
    throw new SiteError(`腾讯视频 ${what} 的响应不是 QZOutputJson 形式（前 120 字符：${text.slice(0, 120)}）。`, {
      site: id,
      code: 'envelope',
    })
  }
  let json = text.slice(marker + 'QZOutputJson='.length).trim()
  if (json.endsWith(';')) json = json.slice(0, -1)
  try {
    return JSON.parse(json)
  } catch (error) {
    throw new SiteError(`腾讯视频 ${what} 的 QZOutputJson 负载无法解析：${error instanceof Error ? error.message : String(error)}`, {
      site: id,
      code: 'parse',
      detail: { head: json.slice(0, 200) },
    })
  }
}

/**
 * Read the `vid` out of a page, so a cover-only URL can still be resolved.
 *
 * @param {string} html Page HTML.
 * @returns {string|undefined} The first plausible video id.
 */
export function vidFromHtml(html) {
  const direct = /"vid"\s*:\s*"([a-z0-9]{11})"/i.exec(html)
  if (direct !== null) return direct[1]
  const og = readMeta(html, ['og:videosrc', 'og:url'])
  if (og !== undefined) {
    const fromUrl = /\/x\/(?:cover\/[a-z0-9]+\/|page\/)([a-z0-9]{11})/i.exec(og)
    if (fromUrl !== null) return fromUrl[1]
  }
  const pageUrl = /video\.qq\.com\/[a-z0-9/]*?([a-z0-9]{11})\.html/i.exec(html)
  return pageUrl?.[1]
}

/**
 * Call `getvinfo` with a freshly signed request.
 *
 * @param {object} input Request inputs.
 * @param {string} input.vid Video id.
 * @param {string|undefined} input.cid Series id.
 * @param {string} input.pageUrl Page URL used in the signature.
 * @param {'srt'|'vtt'} [input.format] Caption format to ask for.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<Record<string, unknown>>} The parsed payload.
 */
export async function callGetVinfo(input, http, signal) {
  const guid = randomId(16)
  const flowid = randomId(32)
  const cKey = buildCkey({
    vid: input.vid,
    pageUrl: input.pageUrl,
    // The transport sends DESKTOP_UA; the checksum must use the same string.
    userAgent: DESKTOP_UA,
    timestamp: Math.floor(Date.now() / 1000),
    guid,
  })
  const params = new URLSearchParams({
    vid: input.vid,
    cid: input.cid ?? '',
    cKey,
    encryptVer: '8.1',
    spcaptiontype: (input.format ?? 'srt') === 'vtt' ? '1' : '0',
    spsrt: '2',
    sphls: '2',
    defn: 'shd',
    sphttps: '1',
    otype: 'json',
    spwm: '1',
    hevclv: '28',
    drm: '40',
    spvideo: '4',
    spsfrhdr: '100',
    host: 'v.qq.com',
    referer: 'v.qq.com',
    ehost: input.pageUrl,
    appVer: APP_VER,
    platform: PLATFORM,
    guid,
    flowid,
  })
  const response = await getText(`https://h5vv6.video.qq.com/getvinfo?${params.toString()}`, { siteId: id, headers: { accept: '*/*', referer } }, http, signal)
  const payload = parseQzOutput(response.text, 'getvinfo 接口')
  const em = payload.em
  if (em !== undefined && em !== 0 && em !== '0') {
    throw new SiteError(`腾讯视频 getvinfo 返回错误码 em=${String(em)} code=${String(payload.code ?? '')}。`, {
      site: id,
      code: String(em),
      hint:
        String(em) === '85'
          ? 'em=85 表示签名未被接受：cKey 与请求不匹配（插件已用固定 key/iv 与发送时同一个 User-Agent 计算，若持续出现说明腾讯改了方案）。'
          : '这是腾讯视频的业务错误码，插件没有内置解释。',
    })
  }
  return payload
}

/**
 * Resolve a video's metadata.
 *
 * @param {QqRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../types.js').VideoInfo>} Video info.
 */
export async function info(ref, http, signal) {
  let vid = ref.vid
  let html = ''
  if (vid === undefined) {
    html = await fetchHtml(ref.url, http, { siteId: id, referer }, signal)
    vid = vidFromHtml(html)
    if (vid === undefined) {
      throw new SiteError(
        '腾讯视频的这个地址没有定位到具体某个视频（页面里没有 vid）。请给出形如 https://v.qq.com/x/cover/<cid>/<vid>.html 或 /x/page/<vid>.html 的地址。',
        { site: id, code: 'no-vid', detail: { url: ref.sourceUrl } },
      )
    }
  }
  const pageUrl = `https://v.qq.com/x/page/${vid}.html`
  const payload = await callGetVinfo({ vid, cid: ref.cid, pageUrl, format: 'srt' }, http, signal)
  const vi = findVideoEntry(payload, vid)
  const meta = html === '' ? undefined : readPageMeta(html)
  const title = firstString(vi, ['ti', 'title']) ?? meta?.title ?? ''
  return {
    site: id,
    id: vid,
    url: ref.url,
    title: cleanTitle(title),
    owner: firstString(vi, ['pl', 'uploader']) ?? '',
    cover: firstString(vi, ['pic', 'thumb']) ?? meta?.cover,
    durationSeconds: firstNumber(vi, ['td', 'duration']) ?? meta?.durationSeconds ?? 0,
    description: firstString(vi, ['desc']) ?? meta?.description,
    container: { kind: /** @type {const} */ ('qq'), vid, cid: ref.cid, pageUrl },
    parts: [],
    stats: {},
    notes: [],
  }
}

/**
 * Find the `vl.vi[]` entry matching a `vid`.
 *
 * @param {Record<string, unknown>} payload `getvinfo` payload.
 * @param {string} vid Video id.
 * @returns {Record<string, unknown>|undefined} The entry.
 */
function findVideoEntry(payload, vid) {
  const rows = nested(payload, ['vl', 'vi'])
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && /** @type {any} */ (row).vid === vid) return /** @type {any} */ (row)
  }
  return rows.length > 0 && typeof rows[0] === 'object' ? /** @type {any} */ (rows[0]) : undefined
}

/**
 * Read a nested value.
 *
 * @param {unknown} value Source.
 * @param {string[]} path Key path.
 * @returns {unknown} The value, or undefined.
 */
function nested(value, path) {
  let cursor = value
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key]
  }
  return cursor
}

/**
 * Read the first present string among keys.
 *
 * @param {unknown} value Source object.
 * @param {string[]} keys Keys to try.
 * @returns {string|undefined} The string, when present.
 */
function firstString(value, keys) {
  if (value === null || typeof value !== 'object') return undefined
  for (const key of keys) {
    const found = /** @type {Record<string, unknown>} */ (value)[key]
    if (typeof found === 'string' && found !== '') return found
  }
  return undefined
}

/**
 * Read the first present finite number among keys.
 *
 * @param {unknown} value Source object.
 * @param {string[]} keys Keys to try.
 * @returns {number|undefined} The number, when present.
 */
function firstNumber(value, keys) {
  if (value === null || typeof value !== 'object') return undefined
  for (const key of keys) {
    const found = /** @type {Record<string, unknown>} */ (value)[key]
    if (typeof found === 'number' && Number.isFinite(found)) return found
    if (typeof found === 'string') {
      const parsed = Number.parseInt(found, 10)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * List a video's caption tracks.
 *
 * @param {QqRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @param {import('../types.js').VideoInfo} [knownInfo] Already-resolved info.
 * @returns {Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], help?: string}>} Tracks and diagnostics.
 */
export async function tracks(ref, http, signal, knownInfo) {
  const videoInfo = knownInfo ?? (await info(ref, http, signal))
  const container = videoInfo.container
  // Ask for SRT first, then VTT: the site serves whichever it has, and the
  // format is a per-request parameter rather than a property of the track.
  const notes = []
  const collected = []
  for (const format of ['srt', 'vtt']) {
    let payload
    try {
      payload = await callGetVinfo({ vid: container.vid, cid: container.cid, pageUrl: container.pageUrl, format }, http, signal)
    } catch (error) {
      notes.push(`请求 ${format} 格式字幕失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const entry of subtitleFileEntries(payload)) collected.push(entry)
    if (collected.length > 0) break
  }
  const tracks = []
  const seen = new Set()
  for (const [ordinal, entry] of collected.entries()) {
    const url = firstString(entry, ['url'])
    if (url === undefined) continue
    const absolute = toHttps(url)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    const lang = firstString(entry, ['lang', 'language']) ?? `track-${ordinal + 1}`
    tracks.push({
      id: `${lang}#${ordinal + 1}`,
      site: id,
      url: absolute,
      lang: normalizeLang(lang),
      label: lang,
      format: entry.captionType === 1 || /\.vtt(\?|$)/i.test(absolute) ? 'vtt' : 'srt',
    })
  }
  if (tracks.length === 0) {
    notes.push(
      '腾讯视频这次没有返回任何字幕文件（sfl.fi 为空或 sfl.cnt 为 0）。未登录访客只能拿到公开字幕；' +
        '会员 / 付费内容的字幕需要 vqq_vusession 之类的登录 cookie。',
    )
  }
  return { tracks, notes }
}

/**
 * Read the `sfl.fi[]` native caption file list, when present.
 *
 * @param {Record<string, unknown>} payload `getvinfo` payload.
 * @returns {Record<string, unknown>[]} Caption file entries.
 */
export function subtitleFileEntries(payload) {
  const list = nested(payload, ['sfl', 'fi'])
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (entry)
    const url = firstString(record, ['url'])
    if (url === undefined) continue
    out.push(record)
  }
  return out
}

/**
 * Map a Tencent language label onto a language tag.
 *
 * @param {string} lang Site label (`zh`, `en`, `中文`).
 * @returns {string|undefined} Language tag.
 */
function normalizeLang(lang) {
  const text = String(lang ?? '').trim()
  if (text === '') return undefined
  if (/^zh/i.test(text) || /中文|简体/.test(text)) return 'zh-CN'
  if (/繁体|traditional/i.test(text)) return 'zh-TW'
  if (/^en/i.test(text) || /英文|english/i.test(text)) return 'en'
  return text
}

/**
 * Download and parse one caption track.
 *
 * @param {import('../subtitle.js').SubtitleTrack} track Track to fetch.
 * @param {QqRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<import('../subtitle.js').SubtitleDocument>} Parsed captions.
 */
export async function download(track, ref, http, signal) {
  if (track.url === undefined) throw new SiteError('这条腾讯视频字幕没有可下载的地址。', { site: id, code: 'no-url' })
  const response = await getText(toHttps(track.url), { siteId: id, headers: { accept: 'text/plain, */*', referer } }, http, signal)
  const document = parseSubtitles(response.text, track.format)
  if (document.cues.length === 0) {
    throw new SiteError(`腾讯视频字幕文件已下载（${response.text.length} 字节）但没有解析出字幕行：${document.warnings.join('; ')}`, {
      site: id,
      code: 'empty-captions',
    })
  }
  return document
}

/**
 * Fetch the page's HTML for the generic scan.
 *
 * @param {QqRef} ref Parsed identity.
 * @param {import('../http.js').HttpContext} http Adapter context.
 * @param {AbortSignal} [signal] Caller cancellation.
 * @returns {Promise<string>} Page HTML.
 */
export async function fetchPageHtml(ref, http, signal) {
  return await fetchHtml(ref.url, http, { siteId: id, referer }, signal)
}

/** Exposed for tests that want the signing inputs without a network hop. */
export const signingConstants = { CKEY_KEY, CKEY_IV, CKEY_TAG, APP_VER, PLATFORM, DESKTOP_UA }
