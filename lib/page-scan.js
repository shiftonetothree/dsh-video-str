/**
 * Generic caption discovery: find caption files in a page, and in HLS/MPD
 * manifests, without knowing which site produced them.
 *
 * This is the fallback every adapter leans on for the part of the job it cannot
 * do through a documented API. It is deliberately conservative: it reports what
 * it found and why, and never guesses that a random `.json` next to a player is
 * a caption file — a candidate must look like captions before it is offered.
 *
 * Sources probed, in order:
 *
 * 1. `<track kind="subtitles|captions" src="...">`,
 * 2. the page's own JSON state (`window.__INITIAL_DATA__`, `__NEXT_DATA__`,
 *    `__INITIAL_STATE__`, `__NUXT__`, ...) walked for caption-looking subtrees,
 * 3. `<script type="application/json">` blocks,
 * 4. HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` renditions (absolute or relative to the
 *    master playlist),
 * 5. DASH `AdaptationSet` entries whose `mimeType`/`contentType` marks text,
 * 6. direct `.vtt` / `.srt` / `.ass` URLs anywhere in the document,
 * 7. a player config object (`player`, `playerConfig`, `playInfo`) carrying a
 *    caption/subtitle array.
 *
 * @module dsh-video-srt/lib/page-scan
 */

import { toHttps } from './http.js'

/** Keys whose value is very likely a list of caption tracks. */
const TRACK_KEYS = ['subtitles', 'subtitle', 'captions', 'caption', 'sub', 'sublist', 'subtitleList', 'cc', 'ccList', 'langs', 'language']

/** Keys that mark one row as a caption track. */
const TRACK_URL_KEYS = ['url', 'src', 'subtitle_url', 'subtitleUrl', 'sub_url', 'subUrl', 'vtt', 'srt', 'ass', 'webvtt', 'path', 'file', 'fileUrl', 'file_url', 'subtitlePath']

/** Keys that mark one row as a machine transcript rather than a caption file. */
const INLINE_TEXT_KEYS = ['content', 'text', 'body', 'captions', 'cues', 'lines', 'sentences', 'utterances', 'words']

/**
 * One discovered caption candidate.
 *
 * @typedef {object} CaptionCandidate
 * @property {string} url Absolute caption URL.
 * @property {string} source Which probe found it (`track-element`, `json-state`, ...).
 * @property {string} [lang] Language tag, when the payload named one.
 * @property {string} [label] Human-readable name, when the payload named one.
 * @property {boolean} [auto] True when the payload marks it machine-generated.
 * @property {string} [mimeType] Declared MIME type, when known.
 */

/**
 * Read every `<track>` element that declares captions.
 *
 * @param {string} html Page HTML.
 * @param {string} baseUrl Page URL, for relative resolution.
 * @returns {CaptionCandidate[]} Candidates.
 */
export function scanTrackElements(html, baseUrl) {
  const found = []
  const tag = /<track\b[^>]*>/gi
  let match
  while ((match = tag.exec(html)) !== null) {
    const attrs = parseAttributes(match[0])
    const kind = (attrs.kind ?? 'subtitles').toLowerCase()
    if (kind !== 'subtitles' && kind !== 'captions') continue
    const src = attrs.src
    if (src === undefined || src === '') continue
    const url = resolveUrl(src, baseUrl)
    if (url === undefined) continue
    found.push({
      url,
      source: 'track-element',
      lang: attrs.srclang,
      label: attrs.label,
      mimeType: attrs.type,
    })
  }
  return found
}

/**
 * Parse the attributes of one HTML tag.
 *
 * @param {string} tag Tag text.
 * @returns {Record<string, string>} Attribute map, lowercased keys.
 */
export function parseAttributes(tag) {
  /** @type {Record<string, string>} */
  const attrs = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let match
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attrs
}

/**
 * Resolve a possibly-relative URL against a base.
 *
 * @param {string} value Candidate URL.
 * @param {string} baseUrl Base URL.
 * @returns {string|undefined} Absolute URL, or undefined when unusable.
 */
export function resolveUrl(value, baseUrl) {
  const text = toHttps(String(value ?? '').trim())
  if (text === '') return undefined
  try {
    return new URL(text, baseUrl).toString()
  } catch {
    return undefined
  }
}

/**
 * Extract an assigned JSON object from a script by its global name.
 *
 * Balanced-brace scanning, so a `}` inside a string literal does not end the
 * object — the failure mode that makes a naive regex useless on real pages.
 *
 * @param {string} text Script text.
 * @param {string[]} names Assignment targets, e.g. `window.__INITIAL_DATA__`.
 * @returns {{name: string, json: string}|undefined} Raw JSON text and its source name.
 */
export function extractAssignedJson(text, names) {
  for (const name of names) {
    const at = text.indexOf(name)
    if (at < 0) continue
    const eq = text.indexOf('=', at + name.length)
    if (eq < 0) continue
    const brace = findFirstBrace(text, eq, 200)
    if (brace < 0) continue
    const end = matchBrace(text, brace)
    if (end < 0) continue
    return { name, json: text.slice(brace, end + 1) }
  }
  return undefined
}

/**
 * Find the first `{` or `[` after a position, within a small window.
 *
 * @param {string} text Source text.
 * @param {number} from Search start.
 * @param {number} window Maximum distance to look.
 * @returns {number} Index, or -1.
 */
function findFirstBrace(text, from, window) {
  const limit = Math.min(text.length, from + window)
  for (let index = from; index < limit; index += 1) {
    const char = text[index]
    if (char === '{' || char === '[') return index
  }
  return -1
}

/**
 * Find the matching close brace for an open brace, ignoring string literals.
 *
 * @param {string} text Source text.
 * @param {number} open Index of the opening brace.
 * @returns {number} Index of the matching close, or -1.
 */
export function matchBrace(text, open) {
  const opener = text[open]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Walk a parsed JSON value for caption-looking subtrees.
 *
 * A subtree qualifies when it is an array whose rows carry a caption URL, or
 * whose rows carry timed inline text (`from`/`to` with `content`).
 *
 * @param {unknown} value Parsed JSON.
 * @param {string} baseUrl Base URL for relative resolution.
 * @param {{maxDepth?: number, limit?: number}} [options] Walk bounds.
 * @returns {CaptionCandidate[]} Candidates plus inline-caption markers.
 */
export function walkForCaptionTracks(value, baseUrl, options = {}) {
  const maxDepth = options.maxDepth ?? 12
  const limit = options.limit ?? 24
  /** @type {CaptionCandidate[]} */
  const found = []
  const seen = new Set()
  const queue = [{ node: value, path: '$', depth: 0 }]
  while (queue.length > 0 && found.length < limit) {
    const task = queue.shift()
    if (task === undefined) break
    const { node, path, depth } = task
    if (node === null || typeof node !== 'object' || depth > maxDepth) continue
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const row = node[index]
        if (row === null || typeof row !== 'object') continue
        const record = /** @type {Record<string, unknown>} */ (row)
        const url = firstString(record, TRACK_URL_KEYS)
        if (url !== undefined) {
          const absolute = resolveUrl(url, baseUrl)
          if (absolute !== undefined && !seen.has(absolute)) {
            seen.add(absolute)
            found.push({
              url: absolute,
              source: `json-state:${path}`,
              lang: firstString(record, ['lan', 'lang', 'language', 'srclang', 'locale', 'code']),
              label: firstString(record, ['lan_doc', 'label', 'name', 'title', 'langName', 'displayName']),
              auto:
                record.is_ai === true ||
                record.ai === true ||
                record.auto === true ||
                record.ai_status === 1 ||
                record.ai_status === 2 ||
                String(record.lan ?? '').startsWith('ai-'),
            })
          }
        }
        queue.push({ node: row, path: `${path}[${index}]`, depth: depth + 1 })
      }
      continue
    }
    const record = /** @type {Record<string, unknown>} */ (node)
    for (const [key, child] of Object.entries(record)) {
      if (child === null || typeof child !== 'object') continue
      // Prioritize keys that name captions, so the walk finds them before limit.
      if (TRACK_KEYS.includes(key)) queue.unshift({ node: child, path: `${path}.${key}`, depth: depth + 1 })
      else queue.push({ node: child, path: `${path}.${key}`, depth: depth + 1 })
    }
  }
  return found
}

/**
 * Read the first present string among a set of keys.
 *
 * @param {Record<string, unknown>} record Source object.
 * @param {string[]} keys Candidate keys.
 * @returns {string|undefined} The value, when it is a non-empty string.
 */
export function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Read one subtitle rendition out of an HLS master playlist.
 *
 * @param {string} playlist `.m3u8` text.
 * @param {string} playlistUrl Playlist URL, for relative resolution.
 * @returns {CaptionCandidate[]} Subtitle renditions.
 */
export function parseHlsSubtitles(playlist, playlistUrl) {
  const found = []
  const seen = new Set()
  for (const line of playlist.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!/^#EXT-X-MEDIA:/i.test(trimmed)) continue
    const attrs = parseHlsAttributes(trimmed.slice(trimmed.indexOf(':') + 1))
    if ((attrs.TYPE ?? '').toUpperCase() !== 'SUBTITLES' && (attrs.TYPE ?? '').toUpperCase() !== 'CLOSED-CAPTIONS') continue
    const uri = attrs.URI
    const absolute = uri === undefined ? undefined : resolveUrl(uri, playlistUrl)
    if (absolute === undefined || seen.has(absolute)) continue
    seen.add(absolute)
    const isDefault = (attrs.DEFAULT ?? '').toUpperCase() === 'YES'
    found.push({
      url: absolute,
      source: 'hls-master',
      lang: attrs.LANGUAGE,
      label: attrs.NAME ?? attrs.LANGUAGE ?? (isDefault ? '默认字幕' : undefined),
      auto: (attrs.CHARACTERISTICS ?? '').toLowerCase().includes('autoselect') && isDefault,
    })
  }
  return found
}

/**
 * Parse the comma-separated `KEY=VALUE` attribute list of an HLS tag.
 *
 * @param {string} text Attribute text (quoted values may contain commas).
 * @returns {Record<string, string>} Attribute map, uppercased keys.
 */
export function parseHlsAttributes(text) {
  /** @type {Record<string, string>} */
  const attrs = {}
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi
  let match
  while ((match = re.exec(text)) !== null) {
    attrs[match[1].toUpperCase()] = (match[3] ?? match[2] ?? '').trim()
  }
  return attrs
}

/**
 * Read subtitle tracks out of a DASH manifest.
 *
 * @param {string} manifest MPD text.
 * @param {string} manifestUrl Manifest URL, for relative resolution.
 * @returns {CaptionCandidate[]} Caption adaptations.
 */
export function parseDashSubtitles(manifest, manifestUrl) {
  const found = []
  for (const match of manifest.matchAll(/<AdaptationSet\b([\s\S]*?)<\/AdaptationSet>/gi)) {
    const block = match[1]
    const mime = (/mimeType="([^"]*)"/i.exec(block) ?? [])[1] ?? ''
    const contentType = (/contentType="([^"]*)"/i.exec(block) ?? [])[1] ?? ''
    const isText = /text\/|application\/ttml|application\/mp4/i.test(mime) && !/video|audio/i.test(contentType)
    if (!isText) continue
    const lang = (/lang="([^"]*)"/i.exec(block) ?? [])[1]
    for (const rep of block.matchAll(/<Representation\b([\s\S]*?)<\/Representation>/gi)) {
      const id = (/id="([^"]*)"/i.exec(rep[1]) ?? [])[1]
      if (id === undefined) continue
      const absolute = resolveUrl(id, manifestUrl)
      if (absolute === undefined) continue
      found.push({ url: absolute, source: 'dash-mpd', lang, label: lang ?? id, mimeType: mime })
    }
  }
  return found
}

/**
 * Find caption-looking absolute URLs anywhere in a document.
 *
 * @param {string} html Page or manifest text.
 * @param {string} baseUrl Base URL.
 * @param {number} [limit] Maximum candidates.
 * @returns {CaptionCandidate[]} Candidates.
 */
export function scanCaptionUrls(html, baseUrl, limit = 12) {
  const found = []
  const seen = new Set()
  const re = /(?:https?:)?\/\/[^\s"'\\<>()]+?\.(?:vtt|srt|ass|ssa)(?:\?[^\s"'\\<>()]*)?/gi
  let match
  while ((match = re.exec(html)) !== null && found.length < limit) {
    const absolute = resolveUrl(match[0], baseUrl)
    if (absolute === undefined || seen.has(absolute)) continue
    seen.add(absolute)
    found.push({ url: absolute, source: 'url-scan' })
  }
  return found
}

/** Global names whose assigned value is a page's serialized state. */
export const STATE_GLOBALS = [
  'window.__INITIAL_DATA__',
  'window.__INITIAL_STATE__',
  'window.__NEXT_DATA__',
  'window.__NUXT__',
  'window.__PRELOADED_STATE__',
  'window.__APP_STATE__',
  'window.__DATA__',
  'window.__PAGE_DATA__',
  'window.__PLAYER_CONFIG__',
  'window.playerConfig',
  'window.__APOLLO_STATE__',
  '__INITIAL_DATA__',
  '__INITIAL_STATE__',
  '__NEXT_DATA__',
]

/**
 * Run every HTML-side probe.
 *
 * @param {string} html Page HTML.
 * @param {string} baseUrl Page URL.
 * @param {{limit?: number}} [options] Probe bounds.
 * @returns {{candidates: CaptionCandidate[], notes: string[], inline: {value: unknown, path: string}[]}} Findings.
 */
export function scanHtml(html, baseUrl, options = {}) {
  const limit = options.limit ?? 24
  /** @type {CaptionCandidate[]} */
  const candidates = []
  const notes = []
  /** @type {{value: unknown, path: string}[]} */
  const inline = []
  const push = (list) => {
    for (const entry of list) {
      if (candidates.length >= limit) return
      if (candidates.some((existing) => existing.url === entry.url)) continue
      candidates.push(entry)
    }
  }
  if (html.trim() === '') {
    notes.push('页面为空：站点拒绝了这次请求，或者该地址需要登录。')
    return { candidates, notes, inline }
  }
  push(scanTrackElements(html, baseUrl))
  push(scanCaptionUrls(html, baseUrl))

  const state = extractAssignedJson(html, STATE_GLOBALS)
  if (state !== undefined) {
    try {
      const parsed = JSON.parse(state.json)
      push(walkForCaptionTracks(parsed, baseUrl, { limit }))
      const inlineHits = findInlineCaptions(parsed)
      for (const hit of inlineHits.slice(0, 3)) inline.push(hit)
      if (candidates.length === 0 && inlineHits.length === 0) {
        notes.push(`已解析 ${state.name}，但没有找到字幕轨道或时间轴文本。`)
      }
    } catch (error) {
      notes.push(`${state.name} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），跳过页面状态扫描。`)
    }
  } else {
    notes.push('页面里没有找到已知的状态全局变量（__INITIAL_DATA__ / __NEXT_DATA__ / __INITIAL_STATE__ 等）。')
  }

  for (const match of html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1])
      push(walkForCaptionTracks(parsed, baseUrl, { limit }))
    } catch {
      /* an unparseable JSON script block is common and not worth a note */
    }
  }
  return { candidates, notes, inline }
}

/**
 * Find inline (timed-text) caption payloads inside parsed JSON state.
 *
 * @param {unknown} value Parsed JSON.
 * @param {number} [maxDepth] Walk bound.
 * @returns {{value: unknown, path: string}[]} Payloads whose rows carry times and text.
 */
export function findInlineCaptions(value, maxDepth = 12) {
  /** @type {{value: unknown, path: string}[]} */
  const found = []
  const queue = [{ node: value, path: '$', depth: 0 }]
  while (queue.length > 0 && found.length < 6) {
    const task = queue.shift()
    if (task === undefined) break
    const { node, path, depth } = task
    if (node === null || typeof node !== 'object' || depth > maxDepth) continue
    if (Array.isArray(node)) {
      if (node.length >= 3 && node.length <= 20000 && looksLikeTimedText(node)) {
        found.push({ value: node, path })
        continue
      }
      node.forEach((row, index) => queue.push({ node: row, path: `${path}[${index}]`, depth: depth + 1 }))
      continue
    }
    for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
      if (child === null || typeof child !== 'object') continue
      if (INLINE_TEXT_KEYS.includes(key)) queue.unshift({ node: child, path: `${path}.${key}`, depth: depth + 1 })
      else queue.push({ node: child, path: `${path}.${key}`, depth: depth + 1 })
    }
  }
  return found
}

/**
 * Whether an array's rows look like timed caption rows.
 *
 * @param {unknown[]} rows Candidate rows.
 * @returns {boolean} True when at least three rows carry a time and text.
 */
export function looksLikeTimedText(rows) {
  let hits = 0
  for (const row of rows.slice(0, 12)) {
    if (row === null || typeof row !== 'object') return false
    const record = /** @type {Record<string, unknown>} */ (row)
    const hasTime = ['from', 'start', 'startTime', 'begin', 's', 'startMs', 'tStartMs'].some((key) => typeof record[key] === 'number')
    const text = firstString(record, ['content', 'text', 'utf8', 'line'])
    const hasText = text !== undefined || Array.isArray(record.segs)
    if (hasTime && hasText) hits += 1
  }
  return hits >= 3
}

/**
 * A real cue line: a timestamp, the arrow, a timestamp.
 *
 * Deliberately anchored on both timestamps rather than on the bare `-->`: HTML
 * comments close with `-->`, so matching the arrow alone accepts any web page
 * that happens to carry a comment. That is how a Youku navigation JSON
 * (`$.pageTabs` → `detail`, `planet`) once became a "caption track" whose single
 * cue was the text `html { min-width: 1239px;`.
 */
const CUE_ARROW = /\b\d{1,3}:\d{2}(?::\d{2})?[.,]?\d{0,3}\s*-->\s*\d{1,3}:\d{2}(?::\d{2})?[.,]?\d{0,3}/

/**
 * Whether a text body is a caption file rather than, say, a JSON API response.
 *
 * @param {string} text Candidate body.
 * @param {string} contentType Response content type.
 * @returns {boolean} True for recognizable captions.
 */
export function looksLikeCaptions(text, contentType = '') {
  const head = text.slice(0, 2048)
  // An HTML document is never a caption file, whatever it contains. Checked
  // before everything else so a page cannot slip through on an incidental match.
  if (/text\/html|application\/xhtml/i.test(contentType)) return false
  if (/^\s*<(!doctype|html|head|body|meta|script)\b/i.test(head)) return false
  if (/text\/vtt|application\/ttml|subrip|x-subtitle/i.test(contentType)) return true
  if (/^\ufeff?WEBVTT/.test(head)) return true
  if (CUE_ARROW.test(head)) return true
  if (/^\ufeff?\[Script Info\]/i.test(head) || /^Dialogue:/im.test(head)) return true
  if (/^\s*\{\s*"/.test(head) && /"(from|start|content|text|body)"\s*:/.test(head)) return true
  if (/^\s*\[\d{1,3}:\d{1,2}/m.test(head)) return true
  return false
}
