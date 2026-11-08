/**
 * Subtitle formats: parsing, normalization, and serialization.
 *
 * Everything in this plugin — every site adapter, every tool, the export
 * writer — speaks one in-memory shape, {@link SubtitleDocument}, so a new site
 * only has to produce `from`/`to`/`text` triples and inherits search, paging,
 * SRT/VTT/TXT export, and deduplication for free.
 *
 * Supported inputs: SubRip (`.srt`), WebVTT (`.vtt`), ASS/SSA (`.ass`,
 * `.ssa`), LRC (`.lrc`), bilibili's JSON caption body, and the several JSON
 * caption envelopes found in page state (`body`, `cues`, `captions`,
 * `subtitles`, `events`, `lines`, plain arrays).
 *
 * Every parser is total: malformed input yields a document with whatever cues
 * could be recovered plus `warnings`, never a throw. Callers decide whether a
 * zero-cue result is an error.
 *
 * @module dsh-video-srt/lib/subtitle
 */

/**
 * One normalized caption cue.
 *
 * @typedef {object} SubtitleCue
 * @property {number} index 1-based position in the document.
 * @property {number} start Start time in seconds (may be fractional).
 * @property {number} end End time in seconds; never less than `start`.
 * @property {number} duration `end - start`, in seconds.
 * @property {string} text Cue text with markup stripped, lines joined by `\n`.
 * @property {string[]} lines The same text split into individual display lines.
 */

/**
 * One selectable caption track of a video.
 *
 * @typedef {object} SubtitleTrack
 * @property {string} id Stable within one video; what `fetch` takes.
 * @property {string} site Adapter id that produced the track.
 * @property {string} [url] Direct caption file URL, when the site exposes one.
 * @property {string} [lang] BCP-47-ish language tag (`zh-CN`, `en`, ...).
 * @property {string} [label] Human-readable name as the site shows it.
 * @property {boolean} [auto] True for machine-generated captions (AI 字幕).
 * @property {boolean} [translated] True for a machine translation of another track.
 * @property {boolean} [locked] True when the site requires login/permission.
 * @property {string} [format] Hint for the parser: `json`|`srt`|`vtt`|`ass`|`lrc`.
 * @property {string} [note] Why a track is unavailable, when it is.
 */

/**
 * A parsed subtitle document.
 *
 * @typedef {object} SubtitleDocument
 * @property {string} format Source format that was parsed.
 * @property {SubtitleCue[]} cues Normalized cues in source order.
 * @property {number} duration End of the last cue, in seconds.
 * @property {number} characters Total non-whitespace character count.
 * @property {string[]} warnings Non-fatal parsing problems.
 * @property {string} [language] Language the file's own header declared, when it did.
 */

/** Matches a `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` timestamp. */
const TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/

/** Matches an `MM:SS.mmm` LRC timestamp with any number of `[..]` prefixes. */
const LRC_LINE = /^(?:\s*\[[^\]]*\])+/g

/** A complete LRC timestamp group. */
const LRC_STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** Named and numeric HTML entities that appear in real caption payloads. */
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  times: '\u00d7',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  prime: '\u2032',
  Prime: '\u2033',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '',
  zwj: '',
}

/**
 * Decode the HTML/XML entities and CJK full-width escapes that caption payloads
 * carry. `&amp;#39;`, `&#x27;` and `&nbsp;` all appear in the wild, sometimes
 * double-encoded, so the pass runs twice.
 *
 * @param {string} input Raw text.
 * @returns {string} Decoded text.
 */
export function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') < 0) return input ?? ''
  let text = input
  for (let pass = 0; pass < 2; pass += 1) {
    const before = text
    text = text.replace(/&#x([0-9a-f]+);/gi, (whole, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : whole
    })
    text = text.replace(/&#(\d+);/g, (whole, dec) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : whole
    })
    text = text.replace(/&([a-z][a-z0-9]*);/gi, (whole, name) => {
      const known = ENTITIES[name]
      if (known !== undefined) return known
      const lower = name.toLowerCase()
      return ENTITIES[lower] ?? whole
    })
    if (text === before) break
  }
  return text
}

/**
 * Convert a code point without ever throwing on a lone surrogate.
 *
 * @param {number} code Code point.
 * @returns {string} One-character string, or a replacement character.
 */
function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return '\ufffd'
  }
}

/**
 * Parse one timestamp into seconds.
 *
 * Accepts `HH:MM:SS.mmm`, `HH:MM:SS,mmm`, `MM:SS.mmm`, and the bare seconds /
 * bare milliseconds forms that bilibili's JSON and ASS use.
 *
 * @param {string|number} value Timestamp text or a number already in seconds.
 * @param {number} [assScale] Divisor applied to a bare number (ASS uses 1/100 s).
 * @returns {number} Seconds, or `NaN` when unparseable.
 */
export function parseTimecode(value, assScale) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.NaN
    return assScale === undefined ? value : value / assScale
  }
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (text === '') return Number.NaN
  const match = TIMECODE.exec(text)
  if (match !== null) {
    const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10)
    const minutes = Number.parseInt(match[2], 10)
    const seconds = Number.parseInt(match[3], 10)
    const fraction = match[4] === undefined ? 0 : Number.parseInt(match[4].padEnd(3, '0'), 10) / 1000
    return hours * 3600 + minutes * 60 + seconds + fraction
  }
  const bare = Number.parseFloat(text)
  if (!Number.isFinite(bare)) return Number.NaN
  return assScale === undefined ? bare : bare / assScale
}

/**
 * Format seconds as an SRT/WebVTT timestamp.
 *
 * @param {number} seconds Time in seconds.
 * @param {'.'|','} [separator] Fraction separator: `.` for VTT, `,` for SRT.
 * @returns {string} `HH:MM:SS<sep>mmm`.
 */
export function formatTimecode(seconds, separator = ',') {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalMs = Math.round(safe * 1000)
  const ms = totalMs % 1000
  const totalSeconds = (totalMs - ms) / 1000
  const s = totalSeconds % 60
  const totalMinutes = (totalSeconds - s) / 60
  const m = totalMinutes % 60
  const h = (totalMinutes - m) / 60
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms, 3)}`
}

/**
 * Render seconds as a short `1:02:03` / `2:03` clock, for prompts and headings.
 *
 * @param {number} seconds Time in seconds.
 * @returns {string} Clock text.
 */
export function formatClock(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const s = safe % 60
  const totalMinutes = (safe - s) / 60
  const m = totalMinutes % 60
  const h = (totalMinutes - m) / 60
  const pad = (value) => String(value).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Strip the inline markup that caption payloads use, keeping the words.
 *
 * Handles WebVTT/HTML tags (`<v Roger>`, `<00:00:01.000>`, `<b>`, `<c.yellow>`),
 * ASS override blocks (`{\an8}`) and ASS drawing commands, and the `\N` / `\n` /
 * `\h` escapes.
 *
 * @param {string} input Raw cue text.
 * @returns {string} Plain text.
 */
export function stripCueMarkup(input) {
  if (typeof input !== 'string' || input === '') return ''
  let text = input
  // An ASS drawing command carries vector coordinates, not words: it opens with
  // `\p1`, may sit in its own override block, and closes with `\p0`. The whole
  // run is dropped before the generic markup passes run.
  text = text.replace(/\{[^}]*\\p\s*[1-9][^}]*\}[\s\S]*?(?:\{[^}]*\\p\s*0[^}]*\}|$)/gi, '')
  text = text.replace(/\{[^}]*\}/g, '')
  // WebVTT inline timestamps (`<00:00:01.000>`) are karaoke markers, not words.
  text = text.replace(/<\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?>/g, '')
  text = text.replace(/<\/?[a-z][^>]*>/gi, '')
  text = text.replace(/\\[Nn]/g, '\n')
  text = text.replace(/\\h/g, ' ')
  text = decodeEntities(text)
  return text
}

/**
 * Collapse one cue's markup into display lines.
 *
 * @param {string} input Raw cue text.
 * @returns {string} Normalized multi-line text.
 */
export function normalizeCueText(input) {
  const stripped = stripCueMarkup(input)
  const lines = stripped
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
  // Interior blank lines are caption-internal spacing; only the edges are noise.
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * Drop consecutive repeated lines inside one cue.
 *
 * Rolling captions (the "two lines, second repeats as first" shape produced by
 * YouTube-style auto-captions and by several Chinese players) duplicate most of
 * their text. Collapsing exact repeats inside one cue keeps the reading list
 * short without touching legitimate repetition across cues.
 *
 * @param {string} text Normalized cue text.
 * @returns {string} Text with consecutive duplicate lines removed.
 */
export function dedupeLines(text) {
  const lines = text.split('\n')
  const kept = []
  for (const line of lines) {
    if (kept.length > 0 && kept[kept.length - 1] === line) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Sort cues by start time and give them fresh sequential indices.
 *
 * @param {SubtitleCue[]} cues Cues in any order.
 * @returns {SubtitleCue[]} New, ordered, indexed array.
 */
export function indexCues(cues) {
  return cues
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((cue, position) => ({ ...cue, index: position + 1 }))
}

/**
 * Build one cue, repairing an inverted or missing end time.
 *
 * A cue whose `end` is not after its `start` is extended to the next cue's
 * start (or by a small default) rather than dropped: rolling captions routinely
 * emit `to === from` for the final fragment.
 *
 * @param {number} start Start seconds.
 * @param {number} end End seconds.
 * @param {string} text Cue text.
 * @param {number} [fallback] Seconds to add when `end` is unusable.
 * @returns {SubtitleCue|null} A cue, or null for an empty-text cue.
 */
export function makeCue(start, end, text, fallback = 2) {
  const body = normalizeCueText(text)
  if (body === '') return null
  const from = roundMs(Number.isFinite(start) ? Math.max(0, start) : 0)
  const rawTo = Number.isFinite(end) && end > from ? end : from + fallback
  const to = roundMs(Math.max(rawTo, from + MIN_CUE_SECONDS))
  return { index: 0, start: from, end: to, duration: roundMs(to - from), text: body, lines: body.split('\n') }
}

/** Shortest cue this module will emit, so a zero-length fragment stays visible. */
const MIN_CUE_SECONDS = 0.04

/**
 * Quantize seconds to milliseconds.
 *
 * Site payloads arrive as binary floats (`2.1 - 0.1` is `1.9999999999999996`),
 * which then leaks into durations, prompts, and exported SRT text. Rounding at
 * the boundary keeps every downstream number exact.
 *
 * @param {number} seconds Time in seconds.
 * @returns {number} The same time, rounded to the nearest millisecond.
 */
export function roundMs(seconds) {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Finish a document from raw cues: order, index, repair overlaps, measure.
 *
 * @param {SubtitleCue[]} cues Cues to finalize.
 * @param {string} format Source format label.
 * @param {string[]} [warnings] Problems collected while parsing.
 * @param {string} [language] Language declared by the file's own header, when it has one.
 * @returns {SubtitleDocument} The finished document.
 */
export function finalizeDocument(cues, format, warnings = [], language) {
  const ordered = indexCues(cues)
  let characters = 0
  for (const cue of ordered) characters += cue.text.replace(/\s/g, '').length
  const duration = ordered.length === 0 ? 0 : ordered[ordered.length - 1].end
  return { format, cues: ordered, duration, characters, warnings, language }
}

/**
 * Split a `KEY: value` metadata header, tolerating junk lines.
 *
 * @param {string} block Header lines (VTT/ASS header metadata).
 * @param {boolean} upper Normalize keys to uppercase.
 * @returns {Map<string, string>} First value wins per key.
 */
export function parseHeaderBlock(block, upper) {
  const map = new Map()
  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = (upper ? line.slice(0, colon).toUpperCase() : line.slice(0, colon)).trim()
    if (!map.has(key)) map.set(key, line.slice(colon + 1).trim())
  }
  return map
}

/**
 * Parse SubRip.
 *
 * @param {string} text SRT source.
 * @returns {{cues: SubtitleCue[], warnings: string[]}} Raw cues.
 */
export function parseSrt(text) {
  const warnings = []
  const cues = []
  const normalized = text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n')
  const blocks = normalized.split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((line, index) => !(index === 0 && line.trim() === ''))
    if (lines.length === 0) continue
    // Skip a pure numeric index line.
    let cursor = 0
    if (/^\s*\d+\s*$/.test(lines[0]) && lines.length > 1) cursor = 1
    const timing = lines[cursor]
    if (timing === undefined || timing.indexOf('-->') < 0) {
      if (block.trim() !== '') warnings.push(`srt: block without a timing line skipped: ${truncate(block, 60)}`)
      continue
    }
    const [rawStart, rawRest] = timing.split('-->')
    if (rawRest === undefined) continue
    const start = parseTimecode(rawStart)
    const end = parseTimecode(rawRest.trim().split(/\s+/)[0])
    const body = lines.slice(cursor + 1).join('\n')
    const cue = makeCue(start, end, body)
    if (cue === null) continue
    cue.text = dedupeLines(cue.text)
    cue.lines = cue.text.split('\n')
    cues.push(cue)
  }
  return { cues, warnings }
}

/**
 * Parse WebVTT.
 *
 * Handles `NOTE`/`STYLE`/`REGION` blocks, cue identifiers, `HH:MM:SS.mmm` and
 * `MM:SS.mmm` timings, cue settings after the arrow, and `X-TIMESTAMP-MAP`.
 *
 * @param {string} text WebVTT source.
 * @returns {{cues: SubtitleCue[], warnings: string[], language?: string}} Raw cues.
 */
export function parseVtt(text) {
  const warnings = []
  const cues = []
  const normalized = text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n')
  const blocks = normalized.split(/\n{2,}/)
  let sawHeader = false
  let warnedMissingHeader = false
  /** Language the header declares, when it does. */
  let language
  for (const block of blocks) {
    const trimmed = block.trim()
    if (trimmed === '') continue
    if (/^WEBVTT\b/.test(trimmed)) {
      sawHeader = true
      // `WEBVTT` may be followed by header metadata such as `Language: zh-CN`.
      const header = parseHeaderBlock(trimmed, false)
      const declared = header.get('Language') ?? header.get('language')
      if (declared !== undefined && declared !== '') language = declared
      continue
    }
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue
    const lines = block.split('\n')
    let cursor = 0
    if (lines[0] !== undefined && lines[0].indexOf('-->') < 0) {
      // A cue identifier may be any text without an arrow.
      cursor = 1
    }
    const timing = lines[cursor]
    if (timing === undefined || timing.indexOf('-->') < 0) {
      if (!sawHeader) warnings.push(`vtt: block before the WEBVTT header skipped: ${truncate(trimmed, 60)}`)
      continue
    }
    if (!sawHeader && !warnedMissingHeader) {
      // Cues without a header still parse; the file is malformed, not empty.
      warnings.push('vtt: no WEBVTT header before the first cue (the file is malformed but the cues were read)')
      warnedMissingHeader = true
    }
    const [rawStart, rawRest] = timing.split('-->')
    if (rawRest === undefined) continue
    const start = parseTimecode(rawStart)
    const end = parseTimecode(rawRest.trim().split(/\s+/)[0])
    const body = lines.slice(cursor + 1).join('\n')
    const cue = makeCue(start, end, body)
    if (cue === null) continue
    cue.text = dedupeLines(cue.text)
    cue.lines = cue.text.split('\n')
    cues.push(cue)
  }
  if (!sawHeader && cues.length === 0) warnings.push('vtt: no WEBVTT header and no cues found')
  return { cues, warnings, language }
}

/**
 * Parse ASS/SSA.
 *
 * @param {string} text ASS source.
 * @returns {{cues: SubtitleCue[], warnings: string[], language?: string}} Raw cues.
 */
export function parseAss(text) {
  const warnings = []
  const cues = []
  const normalized = text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n')
  const lines = normalized.split('\n')
  let inEvents = false
  /** Language declared in `[Script Info]`, when it is. */
  let language
  /** Column order from the `Format:` line of the `[Events]` section. */
  let columns = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(line)
      continue
    }
    if (!inEvents) {
      const info = /^Language:\s*(.+)$/i.exec(line)
      if (info !== null && info[1] !== undefined && info[1].trim() !== '') language = info[1].trim()
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1)
    if (key === 'format') {
      columns = value.split(',').map((entry) => entry.trim())
      continue
    }
    if (key !== 'dialogue') continue
    const textIndex = columns.findIndex((entry) => entry.toLowerCase() === 'text')
    const startIndex = columns.findIndex((entry) => entry.toLowerCase() === 'start')
    const endIndex = columns.findIndex((entry) => entry.toLowerCase() === 'end')
    if (textIndex < 0 || startIndex < 0 || endIndex < 0) {
      warnings.push('ass: [Events] Format line lacks Start/End/Text; using the default column order')
      continue
    }
    // Only the LAST column may contain commas, so split on the first
    // `columns.length - 1` of them and hand the remainder to the final column.
    const limit = columns.length
    const source = value.trimStart()
    // The character classes exclude newlines: a plain `[^,]` would let the
    // quantifier run past the end of this Dialogue line into the next one.
    // A `null` Effect field makes two commas adjacent, so the class must accept
    // an empty field between separators (hence `*`, not `+`).
    const head = new RegExp(`^[^,\\n]*(?:,[^,\\n]*){${limit - 2}},`)
    const headMatch = head.exec(source)
    if (headMatch === null) {
      warnings.push(`ass: dialogue line has fewer than ${limit} fields; skipped`)
      continue
    }
    const fields = headMatch[0].slice(0, -1).split(',')
    fields.push(source.slice(headMatch[0].length))
    const start = parseTimecode(fields[startIndex] ?? '', 100)
    const end = parseTimecode(fields[endIndex] ?? '', 100)
    const body = fields.slice(textIndex).join(',')
    const cue = makeCue(start, end, body)
    if (cue === null) continue
    cues.push(cue)
  }
  if (cues.length === 0) warnings.push('ass: no Dialogue lines found')
  return { cues, warnings, language }
}

/**
 * Parse LRC (the format 腾讯/网易云-style lyric captions use).
 *
 * @param {string} text LRC source.
 * @returns {{cues: SubtitleCue[], warnings: string[]}} Raw cues.
 */
export function parseLrc(text) {
  const warnings = []
  const cues = []
  const normalized = text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n')
  /** Collected per timestamp so a multi-timestamp line yields one cue each. */
  const collected = []
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (/^\[[a-z]+:/i.test(line)) continue
    LRC_STAMP.lastIndex = 0
    const stamps = []
    let match
    while ((match = LRC_STAMP.exec(line)) !== null) stamps.push(match)
    if (stamps.length === 0) continue
    const body = line.replace(LRC_LINE, '').trim()
    if (body === '') continue
    for (const stamp of stamps) {
      const minutes = Number.parseInt(stamp[1], 10)
      const seconds = Number.parseInt(stamp[2], 10)
      const fraction = stamp[3] === undefined ? 0 : Number.parseInt(stamp[3].padEnd(3, '0').slice(0, 3), 10) / 1000
      collected.push({ start: minutes * 60 + seconds + fraction, text: body })
    }
  }
  collected.sort((a, b) => a.start - b.start)
  for (let i = 0; i < collected.length; i += 1) {
    const current = collected[i]
    const next = collected[i + 1]
    const cue = makeCue(current.start, next === undefined ? current.start + 4 : next.start, current.text)
    if (cue === null) continue
    cues.push(cue)
  }
  if (cues.length === 0) warnings.push('lrc: no timestamped lines found')
  return { cues, warnings }
}

/**
 * Parse one bilibili caption body (`{body:[{from,to,content,location}]}`).
 *
 * Kept separate from the generic JSON reader because a bilibili body is the one
 * envelope whose field names are fixed by a documented producer rather than
 * guessed, so it can be parsed without the key-probing the generic path needs.
 *
 * @param {unknown} value Parsed JSON.
 * @returns {{cues: SubtitleCue[], warnings: string[]}} Raw cues.
 */
export function parseBilibiliBody(value) {
  const warnings = []
  const cues = []
  const rows = Array.isArray(value) ? value : value?.body
  if (!Array.isArray(rows)) return { cues, warnings: ['bilibili: caption body has no "body" array'] }
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const start = typeof row.from === 'number' ? row.from : Number.parseFloat(String(row.from))
    const end = typeof row.to === 'number' ? row.to : Number.parseFloat(String(row.to))
    const content = typeof row.content === 'string' ? row.content : ''
    const cue = makeCue(start, end, content)
    if (cue === null) continue
    cue.text = dedupeLines(cue.text)
    cue.lines = cue.text.split('\n')
    cues.push(cue)
  }
  if (cues.length === 0) warnings.push('bilibili: caption body carried no usable cues')
  return { cues, warnings }
}

/**
 * Find the cue array inside one of the JSON caption envelopes seen in the wild.
 *
 * Probed keys, in order: `body` (bilibili), `cues`, `captions`, `subtitles`,
 * `events`, `lines`, `items`, `data`, plus the value itself and one level of
 * `data`/`result` nesting.
 *
 * @param {unknown} value Parsed JSON value.
 * @returns {{rows: unknown[], path: string}|null} The rows and the key path used.
 */
export function findCueArray(value, depth = 0) {
  if (Array.isArray(value)) return { rows: value, path: '$' }
  if (value === null || typeof value !== 'object' || depth > 4) return null
  const record = /** @type {Record<string, unknown>} */ (value)
  const keys = ['body', 'cues', 'captions', 'subtitles', 'events', 'lines', 'items', 'data', 'result', 'subtitle']
  for (const key of keys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) return { rows: candidate, path: key }
  }
  // `result`/`data` may themselves be single-key wrappers, so descend into the
  // object-valued candidates as well as the array-valued ones above.
  for (const key of ['data', 'result', 'subtitle', 'body', 'payload']) {
    const candidate = record[key]
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = findCueArray(candidate, depth + 1)
      if (nested !== null) return { rows: nested.rows, path: `${key}.${nested.path}` }
    }
  }
  return null
}

/**
 * Normalize one unknown JSON row into a cue.
 *
 * Accepts `{from,to,content}`, `{start,end,text}`, `{startTime,endTime,text}`,
 * `{s,e,t}`, `{begin,end,content}`, `{startMs,endMs,text}`, `{time,text}` and
 * YouTube-style `{tStartMs,dDurationMs,segs:[{utf8}]}`.
 *
 * @param {unknown} row Candidate row.
 * @param {number} ordinal Position, used when a row carries no timing.
 * @returns {{start: number, end: number, text: string, timed: boolean}|null} Normalized row.
 */
export function normalizeJsonRow(row, ordinal) {
  if (row === null || typeof row !== 'object') return null
  const record = /** @type {Record<string, unknown>} */ (row)
  const pick = (...names) => {
    for (const name of names) {
      if (Object.hasOwn(record, name)) return record[name]
    }
    return undefined
  }
  const asNumber = (value) => {
    if (typeof value === 'number') return value
    // Only a string that is *entirely* numeric counts: `Number.parseFloat`
    // would read `"a"` as NaN but `"1abc"` as 1, which turns a text field into
    // a bogus timestamp.
    if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number.parseFloat(value)
    return Number.NaN
  }
  // YouTube timedtext shape.
  const tStartMs = asNumber(pick('tStartMs', 'tstartms'))
  if (Number.isFinite(tStartMs) && Array.isArray(record.segs)) {
    const text = record.segs.map((seg) => (seg !== null && typeof seg === 'object' ? String(/** @type {any} */ (seg).utf8 ?? '') : '')).join('')
    const duration = asNumber(pick('dDurationMs', 'ddurationms'))
    return { start: tStartMs / 1000, end: (tStartMs + (Number.isFinite(duration) ? duration : 2000)) / 1000, text, timed: true }
  }
  let start = asNumber(pick('from', 'start', 'startTime', 'begin', 's', 'startSec', 'st', 'start_time'))
  let end = asNumber(pick('to', 'end', 'endTime', 'e', 'endSec', 'et', 'end_time'))
  if (!Number.isFinite(start)) {
    const startMs = asNumber(pick('startMs', 'start_ms', 'fromMs'))
    if (Number.isFinite(startMs)) start = startMs / 1000
  }
  if (!Number.isFinite(end)) {
    const endMs = asNumber(pick('endMs', 'end_ms', 'toMs'))
    if (Number.isFinite(endMs)) end = endMs / 1000
  }
  // `t` is the minified key some players use for cue text; it is only consulted
  // when the value is not numeric, so a numeric `t` (a timestamp elsewhere)
  // never becomes the caption body.
  const text = pick('content', 'text', 'utf8', 'line', 'value', 'caption', 'body')
  const shortText = record.t
  let body = ''
  if (typeof text === 'string') body = text
  else if (Array.isArray(text)) body = text.map((entry) => (typeof entry === 'string' ? entry : '')).join('')
  else if (typeof shortText === 'string' && !Number.isFinite(asNumber(shortText))) body = shortText
  if (body === '' && typeof record.segs === 'string') body = record.segs
  if (body === '') return null
  if (!Number.isFinite(start)) {
    // Untimed JSON caption lists come from lyric-style payloads; space them out.
    return { start: ordinal * 4, end: ordinal * 4 + 4, text: body, timed: false }
  }
  return { start, end: Number.isFinite(end) ? end : start + 2, text: body, timed: true }
}

/**
 * Parse JSON caption text in any of its known envelopes.
 *
 * @param {string} text JSON source.
 * @returns {{cues: SubtitleCue[], warnings: string[]}} Raw cues.
 */
export function parseJsonCaptions(text) {
  const warnings = []
  const cues = []
  let value
  try {
    value = JSON.parse(text.replace(/^\ufeff/, ''))
  } catch (error) {
    return { cues, warnings: [`json: not valid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  const found = findCueArray(value)
  if (found === null) return { cues, warnings: ['json: no cue array found (looked for body/cues/captions/subtitles/events/lines/items/data)'] }
  found.rows.forEach((row, ordinal) => {
    const normalized = normalizeJsonRow(row, ordinal)
    if (normalized === null) return
    const cue = makeCue(normalized.start, normalized.end, normalized.text)
    if (cue === null) return
    cues.push(cue)
  })
  if (cues.length === 0) warnings.push(`json: the ${found.path} array carried no usable cue rows`)
  return { cues, warnings }
}

/**
 * Guess a caption format from a content type, URL, or the text itself.
 *
 * @param {string} text Raw caption text.
 * @param {string} [hint] URL, extension, or content type.
 * @returns {'srt'|'vtt'|'ass'|'lrc'|'json'|'bilibili'} Detected format.
 */
export function detectFormat(text, hint = '') {
  const haystack = hint.toLowerCase()
  if (/\.srt\b|subrip/.test(haystack)) return 'srt'
  if (/\.vtt\b|text\/vtt|webvtt/.test(haystack)) return 'vtt'
  if (/\.(ass|ssa)\b/.test(haystack)) return 'ass'
  if (/\.lrc\b/.test(haystack)) return 'lrc'
  if (/json/.test(haystack)) return 'json'
  const head = text.slice(0, 4096).replace(/^\ufeff/, '').trimStart()
  if (/^WEBVTT/.test(head)) return 'vtt'
  if (/^\[Script Info\]/i.test(head) || /^\[Events\]/im.test(head) || /^Dialogue:/im.test(head)) return 'ass'
  if (/^\{\s*"/.test(head) || /^\[/.test(head)) {
    if (/^\{\s*"/.test(head)) {
      try {
        const value = JSON.parse(text.replace(/^\ufeff/, ''))
        if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'body')) return 'bilibili'
        return 'json'
      } catch {
        /* fall through to the text probes below */
      }
    }
    if (/^\[\d{1,3}:\d{1,2}/m.test(text)) return 'lrc'
  }
  if (/-->/.test(text)) {
    if (/^\d+\s*\n\s*\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return 'srt'
    return 'vtt'
  }
  return 'srt'
}

/**
 * Parse caption text, detecting the format unless one is supplied.
 *
 * The `bilibili` and `json` formats converge on the same reader, because
 * bilibili's JSON body is one envelope among several.
 *
 * @param {string} text Raw caption text.
 * @param {string} [format] Explicit format, or a URL/hint to detect from.
 * @returns {SubtitleDocument} The parsed document.
 */
export function parseSubtitles(text, format) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const explicit = format !== undefined && ['srt', 'vtt', 'ass', 'lrc', 'json', 'bilibili'].includes(String(format).toLowerCase())
  const resolved = explicit ? /** @type {any} */ (String(format).toLowerCase()) : detectFormat(source, format ?? '')
  const parsed = resolved === 'vtt'
    ? parseVtt(source)
    : resolved === 'ass'
      ? parseAss(source)
      : resolved === 'lrc'
        ? parseLrc(source)
        : resolved === 'json' || resolved === 'bilibili'
          ? parseJsonCaptions(source)
          : parseSrt(source)
  const warnings = parsed.warnings.slice()
  // A bilibili caption body answered when `json` was asked for is still a
  // bilibili body; label it so the caller can tell the two envelopes apart.
  let resolvedFormat = resolved
  if ((resolved === 'json' || resolved === 'bilibili') && parsed.cues.length > 0 && /"body"\s*:\s*\[/.test(source.slice(0, 512))) {
    resolvedFormat = 'bilibili'
  }
  if (parsed.cues.length === 0 && (resolved === 'srt' || resolved === 'vtt')) {
    // A mislabeled payload is common: fall back once to the JSON reader.
    const retry = parseJsonCaptions(source)
    if (retry.cues.length > 0) {
      warnings.push(`${resolved}: no cues, but the payload parsed as JSON captions`)
      return finalizeDocument(retry.cues, 'json', warnings)
    }
  }
  return finalizeDocument(parsed.cues, resolvedFormat, warnings, parsed.language)
}

/**
 * Serialize a document as SubRip.
 *
 * @param {SubtitleDocument} document Document to write.
 * @param {{bom?: boolean}} [options] `bom` prepends a UTF-8 BOM (Chinese players).
 * @returns {string} SRT text.
 */
export function toSrt(document, options = {}) {
  const parts = []
  document.cues.forEach((cue, position) => {
    parts.push(`${position + 1}`)
    parts.push(`${formatTimecode(cue.start, ',')} --> ${formatTimecode(cue.end, ',')}`)
    parts.push(cue.text)
    parts.push('')
  })
  return (options.bom === true ? '\ufeff' : '') + parts.join('\n')
}

/**
 * Serialize a document as WebVTT.
 *
 * @param {SubtitleDocument} document Document to write.
 * @param {{header?: string}} [options] Extra header text after `WEBVTT`.
 * @returns {string} VTT text.
 */
export function toVtt(document, options = {}) {
  const lines = ['WEBVTT']
  if (typeof options.header === 'string' && options.header !== '') lines.push(options.header)
  lines.push('')
  for (const cue of document.cues) {
    lines.push(`${formatTimecode(cue.start, '.')} --> ${formatTimecode(cue.end, '.')}`)
    lines.push(cue.text)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Serialize a document as a timestamped plain-text transcript.
 *
 * @param {SubtitleDocument} document Document to write.
 * @param {{timestamps?: boolean, paragraph?: boolean}} [options] Output shape.
 * @returns {string} Transcript text.
 */
export function toText(document, options = {}) {
  const withTimestamps = options.timestamps !== false
  if (options.paragraph === true) {
    return document.cues
      .map((cue) => cue.text.replace(/\n/g, ' '))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return document.cues
    .map((cue) => {
      const body = cue.text.replace(/\n/g, ' ')
      return withTimestamps ? `[${formatClock(cue.start)}] ${body}` : body
    })
    .join('\n')
}

/**
 * Serialize a document as LRC.
 *
 * @param {SubtitleDocument} document Document to write.
 * @returns {string} LRC text.
 */
export function toLrc(document) {
  return document.cues
    .map((cue) => {
      const total = Math.max(0, cue.start)
      const minutes = Math.floor(total / 60)
      const seconds = total - minutes * 60
      const stamp = `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
      return `[${stamp}]${cue.text.replace(/\n/g, ' ')}`
    })
    .join('\n')
}

/**
 * Serialize a document in one of the supported output formats.
 *
 * @param {SubtitleDocument} document Document to write.
 * @param {string} format `srt`|`vtt`|`txt`|`lrc`|`json`.
 * @param {{bom?: boolean, timestamps?: boolean, paragraph?: boolean}} [options] Format options.
 * @returns {string} Serialized text.
 */
export function serialize(document, format, options = {}) {
  switch (String(format).toLowerCase()) {
    case 'vtt':
    case 'webvtt':
      return toVtt(document, options)
    case 'txt':
    case 'text':
    case 'transcript':
      return toText(document, options)
    case 'lrc':
      return toLrc(document)
    case 'json':
      return `${JSON.stringify({ format: document.format, duration: document.duration, cues: document.cues }, null, 2)}\n`
    case 'srt':
    case 'subrip':
    default:
      return toSrt(document, options)
  }
}

/**
 * Slice a document to a time window or a cue range.
 *
 * @param {SubtitleDocument} document Source document.
 * @param {{start?: number, end?: number, fromCue?: number, toCue?: number, limit?: number}} window Selection.
 * @returns {SubtitleCue[]} Selected cues, in order.
 */
export function selectCues(document, window = {}) {
  let cues = document.cues
  if (typeof window.fromCue === 'number' || typeof window.toCue === 'number') {
    const from = Math.max(1, Math.floor(window.fromCue ?? 1))
    const to = Math.floor(window.toCue ?? cues.length)
    cues = cues.filter((cue) => cue.index >= from && cue.index <= to)
  }
  if (typeof window.start === 'number') cues = cues.filter((cue) => cue.end > window.start)
  if (typeof window.end === 'number') cues = cues.filter((cue) => cue.start < window.end)
  if (typeof window.limit === 'number' && window.limit > 0) cues = cues.slice(0, Math.floor(window.limit))
  return cues
}

/**
 * Find cues whose text contains a query, returning match offsets for context.
 *
 * @param {SubtitleDocument} document Source document.
 * @param {string} query Needle; case-insensitive by default.
 * @param {{caseSensitive?: boolean, limit?: number, context?: number, regex?: boolean}} [options] Search options.
 * @returns {{cue: SubtitleCue, matches: number[], context: string}[]} Search hits.
 */
export function searchCues(document, query, options = {}) {
  const needle = String(query ?? '')
  if (needle === '') return []
  const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 50
  const contextCues = typeof options.context === 'number' && options.context > 0 ? Math.min(20, Math.floor(options.context)) : 1
  let matcher
  if (options.regex === true) {
    try {
      matcher = new RegExp(needle, options.caseSensitive === true ? 'g' : 'gi')
    } catch {
      return []
    }
  } else {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    matcher = new RegExp(escaped, options.caseSensitive === true ? 'g' : 'gi')
  }
  const hits = []
  document.cues.forEach((cue, index) => {
    matcher.lastIndex = 0
    const offsets = []
    let match
    while ((match = matcher.exec(cue.text)) !== null) {
      offsets.push(match.index)
      if (match[0] === '') matcher.lastIndex += 1
      if (offsets.length > 32) break
    }
    if (offsets.length === 0) return
    const from = Math.max(0, index - contextCues)
    const to = Math.min(document.cues.length, index + contextCues + 1)
    const context = document.cues
      .slice(from, to)
      .map((entry) => `${entry.index === cue.index ? '>' : ' '} [${formatClock(entry.start)}] ${entry.text.replace(/\n/g, ' ')}`)
      .join('\n')
    hits.push({ cue, matches: offsets, context })
  })
  return hits.slice(0, limit)
}

/**
 * Count CJK characters and whitespace-separated words.
 *
 * @param {string} text Text to measure.
 * @returns {{cjk: number, words: number, characters: number}} Counts.
 */
export function measureText(text) {
  const han = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)
  const cjk = han === null ? 0 : han.length
  const words = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ')
    .split(/\s+/)
    .filter((entry) => /[\p{L}\p{N}]/u.test(entry)).length
  return { cjk, words, characters: text.replace(/\s/g, '').length }
}

/**
 * Shorten text for a diagnostic line.
 *
 * @param {string} text Source text.
 * @param {number} max Maximum characters.
 * @returns {string} Possibly-truncated text.
 */
function truncate(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
