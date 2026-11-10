/**
 * dsh-video-srt — read video-subtitle text out of Chinese video sites from an
 * agent turn.
 *
 * The plugin gives DSH one capability it does not have natively: turning a video
 * URL (or a subtitle file found by hand) into text a model can read, search, cite
 * by timestamp, and export. `video_subtitle_get` is the one-call entry point;
 * the other tools exist so a long caption track never has to enter the context
 * whole — they read windows, search, and summarize.
 *
 * @module dsh-video-srt
 */

import z from '@deepseek-ai/schemastery'
import { createHttpContext, cookieEnvName, normalizeCookie, SiteError } from './lib/http.js'
import { measureText, parseSubtitles, searchCues, selectCues, serialize, formatClock, toText } from './lib/subtitle.js'
import { resolve as resolveSite, roster, supports, generic } from './lib/sites.js'
import { STATE_LABELS, pollQrLogin, startQrLogin } from './lib/login.js'
import { qrPng } from './lib/qr.js'
import { clearSession, describeCookie, readSession, sessionPath, writeSession } from './lib/session.js'
import { watchLogin } from './lib/watcher.js'
import { notifyAgent } from './lib/wake.js'

/** Cordis plugin name (diagnostics only; the patch row supplies the specifier). */
export const name = 'dsh-video-srt'

/**
 * Services this plugin needs before it starts.
 *
 * Only two are required: the tool registry to register into, and the system
 * prompt so the model learns the tools exist. Everything else — the credential
 * store, the filesystem — is consumed opportunistically with `ctx.get(...)`, so
 * a deployment that composes no credential service still mounts this plugin.
 */
export const inject = ['tools', 'systemPrompt']

/** Section name; must be unique among registered prompt sections. */
const SECTION_NAME = 'plugin:dsh-video-srt'

/** Placement among the tool-guidance sections (the unallocated 2500–4900 band). */
const SECTION_ORDER = 2550

/** Every tool this plugin registers, for the visibility-gated announcement. */
export const TOOL_NAMES = [
  'video_subtitle_get',
  'video_subtitle_info',
  'video_subtitle_read',
  'video_subtitle_search',
  'video_subtitle_text',
  'video_subtitle_export',
  'video_subtitle_parse',
  'video_site_detect',
  'video_subtitle_sites',
  'video_subtitle_login',
]

/** Model-facing announcement: what the tools are for and when to reach for them. */
export const VIDEO_SRT_GUIDANCE = [
  '本机已安装 @commonworks/dsh-video-str 插件：让 Agent 直接读到视频网站的字幕文本，不必先下载视频再语音识别。',
  '',
  '用户给出视频链接（B站 / 腾讯视频 / 芒果TV / 优酷 / 抖音 / 西瓜 / 快手 / 微博视频 / AcFun，或其他任何站点）并想要「内容/讲了什么/字幕/台词/逐字稿/总结/翻译/某句话在第几分钟」时，先调用 video_subtitle_get，它一次完成「识别站点 → 拿元信息 → 列字幕轨 → 取字幕」，返回视频元信息、字幕摘要和一小段开头。',
  '',
  '长字幕不要整段读进上下文：用 video_subtitle_read 按「页码 / 时间窗 / 字幕序号」取窗口，用 video_subtitle_search 按关键词或正则定位后带上下文取回，用 video_subtitle_text 取压缩后的纯文本（可按段落合并、限制字数）。video_subtitle_export 把字幕写成 SRT/VTT/TXT/LRC/JSON 文件到工作区。',
  '',
  'B站的字幕列表需要登录：匿名请求会返回空列表并带 need_login_subtitle=true。遇到这种结果要如实告诉用户「需要登录」，不要报告成「这个视频没有字幕」。解决办法有两条，优先第一条：① 用 video_subtitle_login（action="start"）生成二维码，把图片给用户用 B 站手机客户端扫——插件会在后台自己盯着这个码，扫完确认后开新一轮通知你、并把登录态保存好，所以不要说「扫完告诉我」，也不要反复 action="poll"；② 手动配置 cookies.bilibili（SESSDATA 即可，bili_jct 不需要）或环境变量 DSH_VIDEO_SRT_BILIBILI_COOKIE。',
  '',
  '各站点的真实能力已经逐站实测过，不要凭站点名气推断：**只有 B站 能真正拿到字幕**（且需登录）。腾讯视频、芒果TV、优酷能拿到元信息（标题/时长），但列不出可用的字幕轨。AcFun、抖音、西瓜、快手、微博视频连元信息都不保证——它们的页面由浏览器 JS 渲染或被访客系统拦截，服务端只拿到空壳，插件会明确说「读不到」。这些情况都应改用通用兜底（video_subtitle_get 传 directUrl，或让用户从浏览器开发者工具复制字幕文件地址），并如实说明限制，绝不要编造字幕内容或标题。',
].join('\n')

/** Longest text this plugin will ever place in one tool result. */
const MAX_TOOL_TEXT_CHARS = 120_000

/** Default plugin configuration values, applied for a programmatic mount. */
export const DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  cookies: {},
  cookieEnv: true,
  requestTimeoutMs: 15000,
  requestRetries: 2,
  minRequestIntervalMs: 200,
  cacheTtlSeconds: 600,
  maxCaptionChars: 120_000,
  defaultReadLimit: 80,
}

/**
 * Plugin configuration.
 *
 * Every field is `.volatile()`, so the DSH settings card edits them in place:
 * the Loader commits a new value into the running fiber without remounting the
 * row, and this plugin re-reads each field at use time through
 * {@link readLive}. A field without the marker could not be edited live at all
 * — the settings write path fences on volatility.
 *
 * `cookies` is a per-site map rather than one field per site so a newly added
 * adapter needs no schema change. Prefer the environment variable
 * (`DSH_VIDEO_SRT_<SITE>_COOKIE`) for a secret, so it never lands in a config
 * file; the config field exists for users who would rather keep it there.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  announceToAgent: z.boolean().default(DEFAULTS.announceToAgent).volatile(),
  /** Per-site cookie header, keyed by adapter id (`bilibili`, `qq`, ...). */
  cookies: z.dict(z.string()).default(DEFAULTS.cookies).volatile(),
  /** Read each site's conventional environment variable as a cookie fallback. */
  cookieEnv: z.boolean().default(DEFAULTS.cookieEnv).volatile(),
  requestTimeoutMs: z.number().min(1000).max(120000).default(DEFAULTS.requestTimeoutMs).volatile(),
  requestRetries: z.number().min(0).max(5).default(DEFAULTS.requestRetries).volatile(),
  minRequestIntervalMs: z.number().min(0).max(5000).default(DEFAULTS.minRequestIntervalMs).volatile(),
  cacheTtlSeconds: z.number().min(0).max(86400).default(DEFAULTS.cacheTtlSeconds).volatile(),
  maxCaptionChars: z.number().min(2000).max(2000000).default(DEFAULTS.maxCaptionChars).volatile(),
  defaultReadLimit: z.number().min(1).max(1000).default(DEFAULTS.defaultReadLimit).volatile(),
})

/**
 * Read one config field that may be a live volatile reference.
 *
 * The Loader hands a `.volatile()` field as a stable reference it commits in
 * place, so the current value must be read at use time. A plain value (a
 * programmatic mount, or a field the schema does not mark volatile) is returned
 * as it stands.
 *
 * @param {{get?: () => unknown}|unknown} field The field as the Loader handed it.
 * @param {unknown} fallback Value to use when absent.
 * @returns {unknown} The effective value.
 */
export function readLive(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof (/** @type {{get?: unknown}} */ (field).get) === 'function') {
    const value = /** @type {{get: () => unknown}} */ (field).get()
    return value === undefined ? fallback : value
  }
  return field
}

/**
 * A fetched document plus the identity it came from, kept in the session cache.
 *
 * @typedef {object} CacheEntry
 * @property {string} key
 * @property {number} at Epoch milliseconds when stored.
 * @property {import('./lib/subtitle.js').SubtitleDocument} document
 * @property {Record<string, unknown>} video
 * @property {import('./lib/subtitle.js').SubtitleTrack} track
 */

/**
 * Activate the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {Record<string, unknown>} [config] Resolved plugin config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const field = (key) => readLive(config[key], DEFAULTS[key])
  const enabled = () => field('enabled') !== false
  const announceToAgent = () => field('announceToAgent') !== false
  const maxCaptionChars = () => clampNumber(field('maxCaptionChars'), 2000, 2_000_000, DEFAULTS.maxCaptionChars)
  const defaultReadLimit = () => clampNumber(field('defaultReadLimit'), 1, 1000, DEFAULTS.defaultReadLimit)

  /** @type {Map<string, CacheEntry>} */
  const cache = new Map()

  /**
   * Resolve one site's cookie header, most specific source first.
   *
   * Order: the site's own `cookies[<id>]` config entry, then the conventional
   * environment variable, then a session written by `video_subtitle_login`.
   * The two explicit sources outrank the automatic one, so a deliberately
   * configured cookie is never silently overridden by an earlier scan; when both
   * exist, `video_subtitle_login` with `action=status` names the winner so a user
   * who scanned and saw no change can tell why.
   *
   * The DSH credential store is deliberately not read here: its record key is
   * namespaced by the *provider* component that owns the secret, so a consumer
   * cannot address another component's record, and inventing a namespace this
   * plugin never writes would only produce a credential that can never be set.
   * Config plus environment plus this plugin's own session file covers the
   * "keep it in my profile", "keep it out of the file", and "just scan a QR code"
   * cases.
   *
   * @param {string} siteId Adapter id.
   * @returns {Promise<string|undefined>} Cookie header, when configured.
   */
  const resolveCookie = async (siteId) => {
    /** @type {Record<string, string>} */
    const table = /** @type {any} */ (field('cookies')) ?? {}
    const direct = normalizeCookie(table[siteId])
    if (direct !== undefined) return direct
    if (field('cookieEnv') !== false) {
      const fromEnv = normalizeCookie(process.env[cookieEnvName(siteId)])
      if (fromEnv !== undefined) return fromEnv
    }
    const session = readSession(siteId)
    return session?.cookie
  }

  /**
   * Where a site's cookie came from, for the login tool's status report.
   *
   * @param {string} siteId Adapter id.
   * @returns {'config'|'env'|'session'|'none'} The winning source.
   */
  const cookieSource = (siteId) => {
    /** @type {Record<string, string>} */
    const table = /** @type {any} */ (field('cookies')) ?? {}
    if (normalizeCookie(table[siteId]) !== undefined) return 'config'
    if (field('cookieEnv') !== false && normalizeCookie(process.env[cookieEnvName(siteId)]) !== undefined) return 'env'
    if (readSession(siteId) !== undefined) return 'session'
    return 'none'
  }

  /** Synchronous cookie reader for the transport (best-effort cache). */
  /** @type {Map<string, string|undefined>} */
  const cookieCache = new Map()
  const cookieFor = (siteId) => {
    if (cookieCache.has(siteId)) return cookieCache.get(siteId)
    // Kick off the async resolution and answer with whatever is already known so
    // the transport stays synchronous; the awaited path below fills the cache.
    void resolveCookie(siteId).then((value) => {
      cookieCache.set(siteId, value)
    })
    return undefined
  }

  /**
   * Warm the cookie cache for the sites a call will touch.
   *
   * @param {string[]} siteIds Adapter ids.
   * @returns {Promise<void>} Resolves once every cookie is resolved.
   */
  const warmCookies = async (siteIds) => {
    await Promise.all(
      siteIds.map(async (siteId) => {
        cookieCache.set(siteId, await resolveCookie(siteId))
      }),
    )
  }

  const http = createHttpContext({
    cookie: cookieFor,
    timeoutMs: clampNumber(field('requestTimeoutMs'), 1000, 120_000, DEFAULTS.requestTimeoutMs),
    retries: clampNumber(field('requestRetries'), 0, 5, DEFAULTS.requestRetries),
    minIntervalMs: clampNumber(field('minRequestIntervalMs'), 0, 5000, DEFAULTS.minRequestIntervalMs),
  })

  /**
   * Fetch and cache a caption document for a video.
   *
   * @param {object} input Call selection.
   * @param {string} input.url Video or direct resource URL.
   * @param {string|number} [input.track] Track id, language, or 1-based index.
   * @param {boolean} [input.force] Ignore a cached document.
   * @param {AbortSignal} [signal] Caller cancellation.
   * @returns {Promise<{entry: CacheEntry, notes: string[], help?: string}>} The cached entry and diagnostics.
   */
  const fetchDocument = async (input, signal) => {
    const target = resolveSite(input.url)
    if (target === undefined) {
      throw new Error(`无法识别的视频地址（既不是受支持的站点，也不是 http/https 地址）：${input.url}`)
    }
    const { adapter, ref } = target
    await warmCookies([adapter.id])
    const videoInfo = await adapter.info(ref, http, signal)
    const listing = await adapter.tracks(ref, http, signal, videoInfo)
    const wanted = chooseTrack(listing.tracks, input.track)
    if (wanted === undefined) {
      const reason = listing.help ?? listing.notes.join(' ') ?? '没有可用的字幕轨道。'
      throw new SiteError(
        `没有取到可用的字幕：${reason}`,
        { site: adapter.id, code: 'no-track', detail: { title: videoInfo.title, tracks: listing.tracks.length, notes: listing.notes } },
      )
    }
    const key = `${adapter.id}:${videoInfo.id}:${wanted.id}`
    const ttl = clampNumber(field('cacheTtlSeconds'), 0, 24 * 3600, DEFAULTS.cacheTtlSeconds) * 1000
    const cached = cache.get(key)
    if (input.force !== true && cached !== undefined && Date.now() - cached.at < ttl) {
      return { entry: cached, notes: listing.notes }
    }
    const document = await adapter.download(wanted, ref, http, signal)
    const entry = {
      key,
      at: Date.now(),
      document,
      track: wanted,
      video: {
        site: adapter.id,
        siteLabel: adapter.label,
        url: videoInfo.url,
        id: videoInfo.id,
        title: videoInfo.title,
        owner: videoInfo.owner,
        durationSeconds: videoInfo.durationSeconds,
        publishedAt: videoInfo.publishedAt,
        description: videoInfo.description,
        parts: videoInfo.parts,
        stats: videoInfo.stats,
        availableTracks: listing.tracks.map((track) => ({ id: track.id, lang: track.lang, label: track.label, auto: track.auto === true, locked: track.locked === true })),
      },
    }
    cache.set(key, entry)
    pruneCache(cache, 12)
    return { entry, notes: listing.notes, help: listing.help }
  }

  /**
   * Resolve a cached document for read/search/export, fetching it when needed.
   *
   * @param {object} input Call selection.
   * @param {AbortSignal} [signal] Caller cancellation.
   * @returns {Promise<CacheEntry>} The cached entry.
   */
  const requireDocument = async (input, signal) => {
    const key = typeof input.cacheKey === 'string' && input.cacheKey !== '' ? input.cacheKey : undefined
    if (key !== undefined) {
      const hit = cache.get(key)
      if (hit !== undefined) return hit
    }
    if (typeof input.url !== 'string' || input.url === '') {
      throw new Error('需要给出 video_subtitle_get 返回的 cacheKey，或者一个 url。')
    }
    const { entry } = await fetchDocument({ url: input.url, track: input.track, force: input.force === true }, signal)
    return entry
  }

  /**
   * Register one tool, enforcing the registry's lossless-JSON contract.
   *
   * A tool's canonical value must survive the registry's JSON materialization,
   * and an optional field left `undefined` — a track without a language, a video
   * without a cover — would fail the whole call with `INVALID_TOOL_OUTPUT`. The
   * adapter layer legitimately produces such fields, and threading `undefined`
   * checks through every one of them would be both tedious and easy to miss, so
   * every definition is wrapped once here instead.
   *
   * @param {Record<string, any>} definition Tool definition.
   * @returns {() => void} The registry's disposer.
   */
  const register = (definition) => {
    const body = definition.execute
    // `parameters` must be an object-rooted schema with an explicit, closed
    // `properties` map: the contract is shown verbatim to the model, and a
    // missing `properties` on a zero-argument tool would read as "anything
    // goes" rather than "no arguments".
    const parameters = definition.parameters ?? { type: 'object', additionalProperties: false }
    return ctx.tools.register({
      ...definition,
      parameters: {
        type: 'object',
        additionalProperties: false,
        ...parameters,
        properties: parameters.properties ?? {},
      },
      async execute(args, exec) {
        return jsonSafe(await body(args, exec))
      },
    })
  }
  /**
   * Disposers for every registration this activation owns.
   *
   * A disabled plugin registers nothing at all: `apply` still returns (the
   * Loader may re-enter it on a config change), but an unused tool surface is
   * never exposed to the model.
   */
  const disposers = []

  /**
   * Background waits started by `action="start"`, keyed by `qrcode_key`.
   *
   * Declared out here, not inside the `if (enabled())` block: the effect below
   * has to stop them on unload, and a disabled plugin still runs that teardown.
   *
   * @type {Map<string, {stop: () => void}>}
   */
  const loginWatchers = new Map()

  if (enabled()) {
  // ---------------------------------------------------------------------
  // video_subtitle_get — the one-call entry point
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_get',
      description:
        'Fetch a video\'s subtitles: identifies the site, reads the video metadata, lists every caption track, downloads the best one, and returns a short preview. Use this first for any video link when the user wants the content, a summary, the transcript, or a specific quote. The result carries a cacheKey used by video_subtitle_read / _search / _text / _export.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Video page URL (bilibili.com/video/BV..., v.qq.com/..., mgtv.com/b/..., youtu.be/..., or any site) or a direct subtitle file URL (.vtt/.srt/.ass/.lrc/.json).' },
          track: { type: 'string', description: 'Which caption track: a track id, a language tag such as zh-CN or en, or a 1-based index. Omit to take the best available (manual Chinese, then manual other, then AI Chinese).' },
          previewCues: { type: 'integer', description: 'How many opening cues to include in the preview (default 12, max 60).', minimum: 0, maximum: 60 },
          force: { type: 'boolean', description: 'Ignore the session cache and fetch again.' },
          directUrl: { type: 'string', description: 'A subtitle file URL to read directly, bypassing site detection. Use this when the user pasted a subtitle URL from browser devtools.' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderGetResult(/** @type {any} */ (value)) }],
        presentationMeta: (_args, value) => ({ kind: 'read', title: /** @type {any} */ (value)?.video?.title ?? '字幕', meta: /** @type {any} */ (value)?.cacheKey }),
      },
      presentCall: (args) => ({ kind: 'fetch', title: `读取字幕：${String(/** @type {any} */ (args).url ?? '').slice(0, 80)}` }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const url = typeof input.directUrl === 'string' && input.directUrl !== '' ? input.directUrl : input.url
        if (typeof url !== 'string' || url === '') throw new Error('url 是必需的（或者用 directUrl 给出字幕文件地址）。')
        const { entry, notes } = await fetchDocument({ url, track: input.track, force: input.force === true }, exec.signal)
        const previewCount = clampNumber(input.previewCues, 0, 60, 12)
        const preview = entry.document.cues.slice(0, previewCount)
        const summary = summarizeDocument(entry.document)
        return {
          ok: true,
          cacheKey: entry.key,
          video: entry.video,
          track: { id: entry.track.id, lang: entry.track.lang, label: entry.track.label, auto: entry.track.auto === true, format: entry.document.format },
          subtitles: {
            cueCount: entry.document.cues.length,
            durationSeconds: entry.document.duration,
            characters: entry.document.characters,
            measure: measureText(entry.document.cues.map((cue) => cue.text).join(' ')),
            firstCueAt: entry.document.cues[0]?.start ?? 0,
            lastCueAt: entry.document.duration,
            warnings: entry.document.warnings,
          },
          preview: preview.map(cueLine),
          notes: [...notes, ...(entry.document.warnings.length > 0 ? [`解析告警：${entry.document.warnings.join('; ')}`] : [])],
          next: `用 video_subtitle_read（cacheKey=${entry.key}）分页读取正文，或用 video_subtitle_text 取压缩纯文本。`,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_info — metadata and track list without downloading
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_info',
      description:
        'Read only a video\'s metadata and the list of available caption tracks, without downloading any captions. Use it to check whether subtitles exist before committing to a fetch, or to tell the user which languages are available.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Video page URL or a direct resource URL.' },
        },
        required: ['url'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderInfoResult(/** @type {any} */ (value)) }],
      },
      presentCall: (args) => ({ kind: 'read', title: `查询视频信息：${String(/** @type {any} */ (args).url ?? '').slice(0, 80)}` }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const target = resolveSite(String(input.url ?? ''))
        if (target === undefined) throw new Error(`无法识别的视频地址：${input.url}`)
        const { adapter, ref } = target
        await warmCookies([adapter.id])
        const videoInfo = await adapter.info(ref, http, exec.signal)
        const listing = await adapter.tracks(ref, http, exec.signal, videoInfo)
        return {
          ok: true,
          site: { id: adapter.id, label: adapter.label, captionsSupported: adapter.captions !== false, limitation: adapter.limitation },
          video: {
            id: videoInfo.id,
            url: videoInfo.url,
            title: videoInfo.title,
            owner: videoInfo.owner,
            durationSeconds: videoInfo.durationSeconds,
            publishedAt: videoInfo.publishedAt,
            description: truncate(videoInfo.description, 600),
            parts: videoInfo.parts.slice(0, 60),
            partCount: videoInfo.parts.length,
            stats: videoInfo.stats,
          },
          tracks: listing.tracks.map((track) => ({
            id: track.id,
            lang: track.lang,
            label: track.label,
            format: track.format,
            auto: track.auto === true,
            locked: track.locked === true,
            note: track.note,
            hasUrl: track.url !== undefined || typeof track.inline === 'string',
          })),
          notes: listing.notes,
          help: listing.help,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_read — windowed reading
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_read',
      description:
        'Read a window of already-fetched subtitles as timestamped lines. Select by page (page/pageSize), by time window (startSeconds/endSeconds), or by cue index range (fromCue/toCue). Use this instead of reading a whole long transcript at once.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cacheKey: { type: 'string', description: 'The cacheKey returned by video_subtitle_get. Preferred over url.' },
          url: { type: 'string', description: 'Video URL, used only when cacheKey is unknown.' },
          track: { type: 'string', description: 'Track selector, when fetching by url.' },
          page: { type: 'integer', description: '1-based page number (default 1).', minimum: 1 },
          pageSize: { type: 'integer', description: `Cues per page (default ${DEFAULTS.defaultReadLimit}, max 500).`, minimum: 1, maximum: 500 },
          startSeconds: { type: 'number', description: 'Only cues overlapping this time or later.', minimum: 0 },
          endSeconds: { type: 'number', description: 'Only cues overlapping this time or earlier.', minimum: 0 },
          fromCue: { type: 'integer', description: 'First cue index to include (1-based).', minimum: 1 },
          toCue: { type: 'integer', description: 'Last cue index to include (1-based).', minimum: 1 },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderReadResult(/** @type {any} */ (value)) }],
      },
      presentCall: () => ({ kind: 'read', title: '读取字幕片段' }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const entry = await requireDocument(input, exec.signal)
        const document = entry.document
        const useTimeWindow = Number.isFinite(input.startSeconds) || Number.isFinite(input.endSeconds)
        const useCueWindow = Number.isFinite(input.fromCue) || Number.isFinite(input.toCue)
        if (useTimeWindow || useCueWindow) {
          const cues = selectCues(document, {
            start: Number.isFinite(input.startSeconds) ? input.startSeconds : undefined,
            end: Number.isFinite(input.endSeconds) ? input.endSeconds : undefined,
            fromCue: Number.isFinite(input.fromCue) ? input.fromCue : undefined,
            toCue: Number.isFinite(input.toCue) ? input.toCue : undefined,
            limit: clampNumber(input.pageSize, 1, 500, defaultReadLimit()),
          })
          return {
            ok: true,
            cacheKey: entry.key,
            video: entry.video,
            window: { kind: 'selection', startSeconds: input.startSeconds ?? null, endSeconds: input.endSeconds ?? null, fromCue: input.fromCue ?? null, toCue: input.toCue ?? null },
            totalCues: document.cues.length,
            returned: cues.length,
            lines: cues.map(cueLine),
          }
        }
        const pageSize = clampNumber(input.pageSize, 1, 500, defaultReadLimit())
        const pageCount = Math.max(1, Math.ceil(document.cues.length / pageSize))
        const page = Math.min(clampNumber(input.page, 1, pageCount, 1), pageCount)
        const from = (page - 1) * pageSize
        const cues = document.cues.slice(from, from + pageSize)
        return {
          ok: true,
          cacheKey: entry.key,
          video: entry.video,
          window: { kind: 'page', page, pageCount, pageSize, fromCue: from + 1, toCue: from + cues.length },
          totalCues: document.cues.length,
          returned: cues.length,
          lines: cues.map(cueLine),
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_search — locate lines by keyword or regex
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_search',
      description:
        'Search already-fetched subtitles for a keyword or regular expression and return each hit with its timestamp and surrounding lines. Use this to answer "where does it mention X" or to find a quote before reading a window around it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Keyword (literal) or regular expression when regex is true.' },
          cacheKey: { type: 'string', description: 'The cacheKey returned by video_subtitle_get.' },
          url: { type: 'string', description: 'Video URL, used only when cacheKey is unknown.' },
          track: { type: 'string', description: 'Track selector, when fetching by url.' },
          regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
          caseSensitive: { type: 'boolean', description: 'Match case-sensitively.' },
          context: { type: 'integer', description: 'Context lines to include on each side of a hit (default 1, max 20).', minimum: 0, maximum: 20 },
          limit: { type: 'integer', description: 'Maximum hits to return (default 40, max 200).', minimum: 1, maximum: 200 },
        },
        required: ['query'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderSearchResult(/** @type {any} */ (value)) }],
      },
      presentCall: (args) => ({ kind: 'search', title: `搜索字幕：${String(/** @type {any} */ (args).query ?? '').slice(0, 60)}` }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const entry = await requireDocument(input, exec.signal)
        const hits = searchCues(entry.document, String(input.query ?? ''), {
          regex: input.regex === true,
          caseSensitive: input.caseSensitive === true,
          context: clampNumber(input.context, 0, 20, 1),
          limit: clampNumber(input.limit, 1, 200, 40),
        })
        return {
          ok: true,
          cacheKey: entry.key,
          video: entry.video,
          query: String(input.query ?? ''),
          totalCues: entry.document.cues.length,
          hitCount: hits.length,
          hits: hits.map((hit) => ({
            cueIndex: hit.cue.index,
            at: formatClock(hit.cue.start),
            startSeconds: hit.cue.start,
            text: hit.cue.text,
            context: hit.context,
          })),
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_text — compact plain text for summarization
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_text',
      description:
        'Return the subtitle transcript as compact plain text, for reading or summarizing in one pass when the whole thing is not too long. Supports merging cues into paragraphs and a character ceiling. The result reports whether it was truncated.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cacheKey: { type: 'string', description: 'The cacheKey returned by video_subtitle_get.' },
          url: { type: 'string', description: 'Video URL, used only when cacheKey is unknown.' },
          track: { type: 'string', description: 'Track selector, when fetching by url.' },
          timestamps: { type: 'boolean', description: 'Prefix each line with [m:ss] (default true).' },
          paragraph: { type: 'boolean', description: 'Join everything into one flowing paragraph (default false).' },
          maxChars: { type: 'integer', description: 'Character ceiling; the text is truncated at a line boundary when exceeded (default 60000).', minimum: 500, maximum: 400000 },
          startSeconds: { type: 'number', description: 'Start of the range to render.', minimum: 0 },
          endSeconds: { type: 'number', description: 'End of the range to render.', minimum: 0 },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(/** @type {any} */ (value)?.text ?? '') }],
      },
      presentCall: () => ({ kind: 'read', title: '读取字幕全文' }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const entry = await requireDocument(input, exec.signal)
        const range = Number.isFinite(input.startSeconds) || Number.isFinite(input.endSeconds) ? selectCues(entry.document, { start: input.startSeconds, end: input.endSeconds }) : entry.document.cues
        const slice = { ...entry.document, cues: range }
        const maxChars = clampNumber(input.maxChars, 500, Math.min(400_000, maxToolChars()), 60_000)
        const full = toText(slice, { timestamps: input.timestamps !== false, paragraph: input.paragraph === true })
        const truncated = full.length > maxChars
        const text = truncated ? `${cutAtLine(full, maxChars)}\n…（已截断：完整文本 ${full.length} 字，当前返回 ${maxChars} 字；用 video_subtitle_read 分页取剩余部分）` : full
        return {
          text,
          cacheKey: entry.key,
          video: entry.video,
          cueCount: range.length,
          totalCues: entry.document.cues.length,
          characters: text.length,
          truncated,
          range: { startSeconds: input.startSeconds ?? null, endSeconds: input.endSeconds ?? null },
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_export — write a subtitle file
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_export',
      description:
        'Write fetched subtitles to a file in the workspace as SRT, VTT, TXT, LRC, or JSON. Returns the path written. Use it when the user wants a subtitle file they can play alongside the video or keep as a transcript.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cacheKey: { type: 'string', description: 'The cacheKey returned by video_subtitle_get.' },
          url: { type: 'string', description: 'Video URL, used only when cacheKey is unknown.' },
          track: { type: 'string', description: 'Track selector, when fetching by url.' },
          format: { type: 'string', description: 'Output format.', enum: ['srt', 'vtt', 'txt', 'lrc', 'json'] },
          path: { type: 'string', description: 'Workspace-relative output path. Omit to derive it from the video title.' },
          overwrite: { type: 'boolean', description: 'Replace an existing file (default true).' },
          bom: { type: 'boolean', description: 'Prefix the file with a UTF-8 BOM (some Chinese players need it for SRT).' },
          timestamps: { type: 'boolean', description: 'Include [m:ss] prefixes in txt output (default true).' },
          paragraph: { type: 'boolean', description: 'Merge txt output into one paragraph.' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderExportResult(/** @type {any} */ (value)) }],
      },
      presentCall: () => ({ kind: 'edit', title: '导出字幕文件' }),
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const entry = await requireDocument(input, exec.signal)
        const format = ['srt', 'vtt', 'txt', 'lrc', 'json'].includes(String(input.format)) ? String(input.format) : 'srt'
        const relative = typeof input.path === 'string' && input.path.trim() !== '' ? input.path.trim() : suggestedPath(entry, format)
        const content = serialize(entry.document, format, { bom: input.bom === true, timestamps: input.timestamps !== false, paragraph: input.paragraph === true })
        const written = await writeTextFile(ctx, relative, content, input.overwrite !== false)
        return {
          ok: true,
          cacheKey: entry.key,
          video: entry.video,
          format,
          path: written.relative,
          absolutePath: written.absolute,
          bytes: Buffer.byteLength(content, 'utf8'),
          cueCount: entry.document.cues.length,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_parse — parse subtitle text or a file
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_parse',
      description:
        'Parse subtitle content that is already available: pass SRT/VTT/ASS/LRC/JSON caption text directly, or a workspace file path, or a caption file URL. Use it when the user pastes captions or when a site\'s captions could only be obtained by hand.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Raw subtitle content (SRT/VTT/ASS/LRC/JSON).' },
          path: { type: 'string', description: 'Workspace-relative path of a subtitle file to read.' },
          url: { type: 'string', description: 'Caption file URL to download and parse.' },
          format: { type: 'string', description: 'Force a format instead of detecting it.', enum: ['srt', 'vtt', 'ass', 'lrc', 'json', 'bilibili'] },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderParseResult(/** @type {any} */ (value)) }],
      },
      presentCall: () => ({ kind: 'read', title: '解析字幕内容' }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        let text = typeof input.text === 'string' ? input.text : undefined
        let origin = 'inline text'
        if (text === undefined && typeof input.path === 'string' && input.path !== '') {
          text = await readTextFile(ctx, input.path)
          origin = `workspace file ${input.path}`
        }
        if (text === undefined && typeof input.url === 'string' && input.url !== '') {
          const target = resolveSite(input.url)
          if (target === undefined) throw new Error(`无法识别的字幕地址：${input.url}`)
          await warmCookies([target.adapter.id])
          const document = await target.adapter.download({ id: 'direct', site: target.adapter.id, url: input.url, format: input.format }, target.ref, http, exec.signal)
          return parseResult(document, `downloaded ${input.url}`)
        }
        if (text === undefined) throw new Error('需要给出 text、path 或 url 之一。')
        const document = parseSubtitles(text, input.format)
        return parseResult(document, origin)
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_site_detect — which adapter claims a URL
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_site_detect',
      description:
        'Report which site adapter handles a URL, whether that adapter can actually serve subtitles, and why not when it cannot. Use it to plan before fetching, or to explain a limitation to the user.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'A video page URL, or a bare video id for a known site.' },
        },
        required: ['url'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderDetectResult(/** @type {any} */ (value)) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = /** @type {any} */ (args ?? {})
        const url = String(input.url ?? '').trim()
        // A plain registry definition has its `required` list shown to the model
        // but not enforced at dispatch — the harness enforces it through the
        // provider's function-calling schema, and a model that omits it anyway
        // must get a usable message rather than a confusing miss.
        if (url === '') throw new Error('url 是必需的：请给出视频页面地址，或已知站点的视频 id。')
        const target = resolveSite(url)
        if (target === undefined) {
          return { ok: false, url, matched: false, reason: '这个地址既不是已知站点，也不是 http/https 地址。' }
        }
        return {
          ok: true,
          url,
          matched: true,
          site: { id: target.adapter.id, label: target.adapter.label, homepage: target.adapter.homepage, captionsSupported: target.adapter.captions !== false, limitation: target.adapter.limitation },
          identity: {
            ...target.ref,
            // Keeping the parsed identity shows the model when a page number
            // was picked up, which `?p=` URLs make easy to get wrong.
          },
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_sites — the coverage roster
  // ---------------------------------------------------------------------
  disposers.push(
    register({
      name: 'video_subtitle_sites',
      description:
        'List the video sites this plugin supports, which of them can actually return subtitles server-side, and how to make the cookie-gated ones work. Use it when the user asks what is supported or why a site fails.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderSitesResult(/** @type {any} */ (value)) }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const sites = roster()
        const cookieSummary = await Promise.all(
          sites.map(async (site) => ({
            id: site.id,
            configured: (await resolveCookie(site.id)) !== undefined,
            source: cookieSource(site.id),
            configKey: `cookies.${site.id}`,
            envVar: cookieEnvName(site.id),
          })),
        )
        return {
          ok: true,
          sites,
          cookies: cookieSummary.filter((entry) => entry.id === 'bilibili' || entry.configured),
          notes: [
            'B站的字幕列表需要 SESSDATA；不配置也能取到元信息，但字幕列表会是空的并带 need_login_subtitle=true。用 video_subtitle_login（action="start"）扫码即可，不必手动填 cookie。',
            '腾讯视频/芒果TV 走各自的公开接口，未登录访客只能拿到公开字幕；实测只验证到元信息，字幕轨仍为 0 条。',
            '优酷能拿到元信息，但没有可用的字幕接口；AcFun/抖音/西瓜/快手/微博视频 的页面是浏览器 JS 渲染或访客系统拦截的空壳，连元信息也不保证。这些站点请用通用兜底。',
            '任何站点都可以用「通用」兜底：把字幕文件地址（可在浏览器开发者工具的网络面板中筛选 vtt/srt/subtitle 找到）交给 video_subtitle_get 的 directUrl，或交给 video_subtitle_parse 的 url。',
          ],
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // video_subtitle_login — scan a QR code to unlock the login-gated sites
  // ---------------------------------------------------------------------
  /**
   * Challenges minted in this activation, keyed by `qrcode_key`.
   *
   * Held in memory on purpose: the challenge is a three-minute handle, and
   * surviving a restart is worthless while the QR itself does not.
   *
   * @type {Map<string, {key: string, url: string, expiresAt: number, image?: string}>}
   */
  const challenges = new Map()

  /** Wake the agent that asked for the QR; silent when there is no agent (scripts, tests). */
  const wakeAgent = async (agent, text) => {
    const result = await notifyAgent(agent, text)
    if (!result.ok && result.error !== 'no agent attached') {
      // Nothing to roll back: the session is already stored, the agent simply
      // learns about it on its next turn instead of being woken.
      ctx.logger?.warn?.(`video-srt: 唤醒 Agent 失败：${result.error}`)
    }
  }

  /**
   * Stop a background wait, if there is one.
   *
   * Stopping before a waiter settles is what keeps one login from producing two
   * reports: a manual `poll` that confirms first, or a plugin unload.
   *
   * @param {string} key Challenge key.
   */
  const stopLoginWatcher = (key) => {
    const watcher = loginWatchers.get(key)
    if (watcher === undefined) return
    watcher.stop()
    loginWatchers.delete(key)
  }

  /**
   * Watch one QR in the background and report its outcome.
   *
   * @param {string} key Challenge key.
   * @param {unknown} agent The agent that minted the code.
   * @param {number} expiresAt Epoch ms when the QR dies.
   */
  const startLoginWatcher = (key, agent, expiresAt) => {
    stopLoginWatcher(key)
    const watcher = watchLogin({
      key,
      expiresAt,
      // A background wait belongs to no tool call, so there is no exec.signal.
      poll: (polledKey) => pollQrLogin(polledKey, http),
      onConfirmed: async (result) => {
        loginWatchers.delete(key)
        challenges.delete(key)
        if (result.cookie === undefined) return
        const stored = writeSession('bilibili', {
          cookie: result.cookie,
          ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
          ...(result.mid === undefined ? {} : { mid: result.mid }),
        })
        // The transport caches the cookie per site; drop it so the very next
        // fetch sees the session this waiter just stored.
        cookieCache.delete('bilibili')
        await wakeAgent(
          agent,
          `✅ 用户已扫码完成 B 站登录（mid ${result.mid ?? '未知'}），登录态已写入本机 session（${stored.path}）。` +
            '现在可以直接用 video_subtitle_get 读取 B 站视频字幕；先简短告诉用户登录成功，不要让他再确认一次。',
        )
      },
      onExpired: async (reason) => {
        loginWatchers.delete(key)
        challenges.delete(key)
        const why = reason === 'timeout' ? '用户没有在 3 分钟内扫码' : '二维码已过期'
        await wakeAgent(
          agent,
          `⏳ B 站登录二维码失效（${why}，key ${key.slice(0, 6)}…）。需要重新调用 video_subtitle_login action="start" 生成新码，并告诉用户。`,
        )
      },
    })
    loginWatchers.set(key, watcher)
  }

  disposers.push(
    register({
      name: 'video_subtitle_login',
      description:
        'Log in to a site whose caption list needs an account (bilibili today) by scanning a QR code with that site\'s phone app, then persist the session so later calls find the subtitles. Call with action="start" to get a QR code and show that image to the user: the plugin then watches the code in the background and wakes you with the result, so do not ask the user to confirm the scan and do not poll repeatedly. action="poll" is a manual fallback, action="status" reports the effective session, action="logout" forgets it. Use it when a fetch reported need_login_subtitle=true, or when the user asks why bilibili returns no captions.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'poll', 'status', 'logout'],
            description:
              'start: mint a QR code (default) and start watching it in the background. poll: report whether it has been scanned yet (manual fallback; pass the key from start). status: which cookie source is in effect. logout: forget the stored session.',
          },
          key: {
            type: 'string',
            description: 'The qrKey returned by action="start". Required for action="poll".',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderLoginResult(/** @type {any} */ (value)) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const input = /** @type {any} */ (args ?? {})
        const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'start'

        if (action === 'start') {
          // Prune expired challenges so a long-lived process does not grow a map
          // of dead handles.
          const now = Date.now()
          for (const [staleKey, challenge] of challenges) {
            if (challenge.expiresAt <= now) {
              // Drop the challenge *and* its waiter: an expired one would only
              // wake the agent to say the code it already replaced is dead.
              challenges.delete(staleKey)
              stopLoginWatcher(staleKey)
            }
          }
          const challenge = await startQrLogin(http, exec.signal)
          let image
          const notes = []
          try {
            const png = await qrPng(challenge.url, { scale: 8, margin: 4 })
            // A fresh name per attempt: a fixed path is cached by the chat view,
            // and the agent then shows a code that scans as "已失效".
            const written = await writeBinaryFile(`bilibili-login-qr-${challenge.key.slice(0, 6)}.png`, png, sessionWorkspace(exec))
            image = written.relative
          } catch (error) {
            // A renderer failure must not sink the login: the URL alone is still
            // usable by anyone who can turn it into a QR code themselves.
            notes.push(`二维码图片生成失败：${error instanceof Error ? error.message : String(error)}`)
          }
          challenges.set(challenge.key, { ...challenge, ...(image === undefined ? {} : { image }) })
          // One login, one watcher: an older code that expires later must not
          // wake the agent to report a QR the user has already replaced.
          for (const otherKey of [...loginWatchers.keys()]) {
            if (otherKey !== challenge.key) stopLoginWatcher(otherKey)
          }
          startLoginWatcher(challenge.key, exec.agent, challenge.expiresAt)
          return {
            ok: true,
            action,
            site: 'bilibili',
            state: 'waiting',
            qrKey: challenge.key,
            qrUrl: challenge.url,
            image,
            expiresAt: new Date(challenge.expiresAt).toISOString(),
            expiresInSeconds: Math.round((challenge.expiresAt - Date.now()) / 1000),
            watching: true,
            notes: [
              '把二维码图片展示给用户，让他用 B 站手机客户端扫码，并在手机上点「确认登录」。',
              '插件已经在后台盯着这个码：确认后会自动开新一轮通知你，不需要让用户再说「扫完了」，也不要反复 action="poll"。',
              '二维码约 3 分钟内有效；过期时插件也会通知你，届时用 action="start" 重新生成。',
              ...(image === undefined ? [] : [`二维码图片：${image}`]),
              ...notes,
            ],
          }
        }

        if (action === 'poll') {
          const key = typeof input.key === 'string' ? input.key.trim() : ''
          if (key === '') throw new Error('action="poll" 需要 key（用 action="start" 返回的 qrKey）。')
          const result = await pollQrLogin(key, http, exec.signal)
          if (result.state !== 'confirmed' || result.cookie === undefined) {
            if (result.state === 'expired') {
              // The manual answer is enough; do not also wake the agent for it.
              stopLoginWatcher(key)
              challenges.delete(key)
            }
            return {
              ok: result.state !== 'unknown',
              action,
              site: 'bilibili',
              state: result.state,
              label: STATE_LABELS[result.state] ?? STATE_LABELS.unknown,
              message: result.message,
              qrKey: key,
              next:
                result.state === 'waiting' || result.state === 'scanned'
                  ? '后台监视仍在进行：确认或过期时会自动通知你。除非怀疑插件重启丢了 watcher，否则不必继续手动 poll。'
                  : result.state === 'expired'
                    ? '二维码已失效，用 action="start" 重新生成。'
                    : '状态未知，请重新生成二维码或手动配置 cookies.bilibili。',
            }
          }
          const stored = writeSession('bilibili', {
            cookie: result.cookie,
            ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
            ...(result.mid === undefined ? {} : { mid: result.mid }),
          })
          challenges.delete(key)
          // This call already reported the login; the background waiter must not
          // wake the agent a second time for the same scan.
          stopLoginWatcher(key)
          // The transport caches the cookie per site; drop it so the very next
          // fetch sees the session this call just stored.
          cookieCache.delete('bilibili')
          return {
            ok: true,
            action,
            site: 'bilibili',
            state: 'confirmed',
            label: STATE_LABELS.confirmed,
            cookie: describeCookie(stored.cookie),
            sessionPath: stored.path,
            expiresAt:
              stored.expiresAt === undefined ? undefined : new Date(stored.expiresAt * 1000).toISOString(),
            mid: stored.mid,
            next: '登录态已保存。现在可以直接用 video_subtitle_get 读取 B 站视频字幕了。',
            notes: [
              cookieSource('bilibili') === 'session'
                ? '当前生效来源：本次扫码保存的 session。'
                : `注意：配置或环境变量里已有 B 站的 cookie，它的优先级更高，本次扫码结果不会生效——请先清掉 cookies.bilibili 或 DSH_VIDEO_SRT_BILIBILI_COOKIE。`,
            ],
          }
        }

        if (action === 'status') {
          const source = cookieSource('bilibili')
          const session = readSession('bilibili')
          return {
            ok: true,
            action,
            site: 'bilibili',
            source,
            sourceLabel:
              source === 'config'
                ? '配置文件 cookies.bilibili'
                : source === 'env'
                  ? '环境变量 DSH_VIDEO_SRT_BILIBILI_COOKIE'
                  : source === 'session'
                    ? '扫码登录保存的 session'
                    : '未登录',
            cookie: describeCookie(source === 'none' ? undefined : await resolveCookie('bilibili')),
            sessionPath: sessionPath(),
            session:
              session === undefined
                ? undefined
                : {
                    savedAt: new Date(session.savedAt).toISOString(),
                    expiresAt:
                      session.expiresAt === undefined ? undefined : new Date(session.expiresAt * 1000).toISOString(),
                    expired: session.expired,
                    mid: session.mid,
                  },
            notes: [
              source === 'none'
                ? '还没有登录态。用 action="start" 生成二维码，扫码即可。'
                : 'B 站的字幕列表需要 SESSDATA；登录态过期后会重新退回到 need_login_subtitle=true。',
            ],
          }
        }

        if (action === 'logout') {
          const removed = clearSession('bilibili')
          cookieCache.delete('bilibili')
          challenges.clear()
          return {
            ok: true,
            action,
            site: 'bilibili',
            removed,
            sessionPath: sessionPath(),
            notes: [
              removed ? '已删除扫码保存的登录态。' : '没有扫码保存的登录态可删除。',
              cookieSource('bilibili') === 'none'
                ? '现在没有可用的 B 站登录态。'
                : '配置或环境变量里仍有 B 站 cookie，它仍然生效。',
            ],
          }
        }

        throw new Error(`未知的 action：${action}（可用：start、poll、status、logout）。`)
      },
    }),
  )
  } // end `if (enabled())`

  // ---------------------------------------------------------------------
  // Announcement
  // ---------------------------------------------------------------------
  let disposeSection
  const syncAnnouncement = () => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (!enabled() || !announceToAgent()) return
    // Announce only while the tools are actually reachable: guidance naming
    // tools a session cannot call is worse than no guidance.
    const visible = ctx.tools.schemas().some((schema) => TOOL_NAMES.includes(schema.name))
    if (!visible) return
    disposeSection = ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: VIDEO_SRT_GUIDANCE })
  }

  ctx.effect(() => {
    syncAnnouncement()
    const off = ctx.on('loader/volatile-update', () => {
      // A settings edit lands in place; refresh both the announcement and the
      // cookie cache, which may name a site that was just configured.
      cookieCache.clear()
      syncAnnouncement()
    })
    return () => {
      if (typeof off === 'function') off()
      if (disposeSection !== undefined) {
        disposeSection()
        disposeSection = undefined
      }
      for (const watcher of loginWatchers.values()) watcher.stop()
      loginWatchers.clear()
      for (const dispose of disposers.splice(0)) dispose()
      cache.clear()
    }
  }, 'video-srt: tools, announcement, and cache')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a possibly-absent number into a range.
 *
 * @param {unknown} value Candidate value.
 * @param {number} min Minimum.
 * @param {number} max Maximum.
 * @param {number} fallback Value when absent or unusable.
 * @returns {number} The clamped number.
 */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Format a duration for a tool result, distinguishing "unknown" from "zero".
 *
 * A client-rendered page yields no duration at all; rendering that as `0:00`
 * states something false about the video, so an absent or non-positive value
 * becomes 未知 instead.
 *
 * @param {unknown} seconds Duration in seconds.
 * @returns {string} Clock text, or 未知.
 */
function describeDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '未知'
  return formatClock(seconds)
}

/**
 * Rebuild a value as lossless JSON.
 *
 * The tool registry enforces its "lossless JSON" contract on every successful
 * canonical value, and `undefined` is not part of it: an optional field left
 * unset — a track with no language, a video with no cover — fails the whole
 * call with `INVALID_TOOL_OUTPUT`. Every value that crosses the tool boundary
 * therefore passes through here, which turns "a missing field" from a runtime
 * failure into an absent key.
 *
 * Values that JSON cannot carry at all (functions, symbols, bigints) are
 * dropped for the same reason; a `NaN` or `Infinity` number becomes `null`,
 * because `JSON.stringify` would otherwise emit `null` anyway but only after
 * the registry had already rejected the value.
 *
 * @param {unknown} value Source value.
 * @param {number} [depth] Recursion guard.
 * @returns {unknown} A JSON-safe copy.
 */
function jsonSafe(value, depth = 0) {
  if (value === null || value === undefined) return undefined
  if (depth > 16) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return String(value)
    case 'function':
    case 'symbol':
      return undefined
    default:
      break
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const safe = jsonSafe(entry, depth + 1)
      return safe === undefined ? null : safe
    })
  }
  if (value instanceof Date) return value.toISOString()
  const output = {}
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const safe = jsonSafe(entry, depth + 1)
    if (safe !== undefined) output[key] = safe
  }
  return output
}

/**
 * The plugin-wide tool text ceiling, read from the environment when set.
 *
 * @returns {number} Character ceiling.
 */
function maxToolChars() {
  const configured = Number.parseInt(process.env.DSH_VIDEO_SRT_MAX_TOOL_CHARS ?? '', 10)
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, MAX_TOOL_TEXT_CHARS) : MAX_TOOL_TEXT_CHARS
}

/**
 * Cut text at the last line boundary within a ceiling.
 *
 * @param {string} text Source text.
 * @param {number} max Character ceiling.
 * @returns {string} Truncated text.
 */
function cutAtLine(text, max) {
  const slice = text.slice(0, max)
  const lastBreak = slice.lastIndexOf('\n')
  return lastBreak > max * 0.5 ? slice.slice(0, lastBreak) : slice
}

/**
 * Truncate a possibly-undefined string.
 *
 * @param {unknown} value Source value.
 * @param {number} max Character ceiling.
 * @returns {string|undefined} Truncated text.
 */
function truncate(value, max) {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Pick one caption track from a listing.
 *
 * Preference order, which matters because a bilibili video commonly offers a
 * hand-made track plus several machine ones: manual Chinese, any manual track,
 * AI Chinese, then the first track at all. An explicit selector always wins —
 * it is matched against the track id, the language tag, the label, and the
 * 1-based index, in that order of specificity.
 *
 * @param {import('./lib/subtitle.js').SubtitleTrack[]} tracks Available tracks.
 * @param {string|number|undefined} selector Caller's choice.
 * @returns {import('./lib/subtitle.js').SubtitleTrack|undefined} The chosen track.
 */
export function chooseTrack(tracks, selector) {
  if (tracks.length === 0) return undefined
  if (selector !== undefined && selector !== null && String(selector) !== '') {
    const text = String(selector)
    const lower = text.toLowerCase()
    const exact = tracks.find((track) => track.id === text)
    if (exact !== undefined) return exact
    const byLang = tracks.find((track) => (track.lang ?? '').toLowerCase() === lower)
    if (byLang !== undefined) return byLang
    const byLabel = tracks.find((track) => (track.label ?? '').toLowerCase() === lower)
    if (byLabel !== undefined) return byLabel
    const index = Number.parseInt(text, 10)
    if (Number.isFinite(index) && index >= 1 && index <= tracks.length) return tracks[index - 1]
    const partial = tracks.find((track) => (track.lang ?? '').toLowerCase().startsWith(lower) || (track.label ?? '').toLowerCase().includes(lower))
    if (partial !== undefined) return partial
    return undefined
  }
  const usable = tracks.filter((track) => track.url !== undefined || typeof track.inline === 'string')
  if (usable.length === 0) return tracks[0]
  const manual = usable.filter((track) => track.auto !== true)
  const zh = (track) => /^zh/i.test(track.lang ?? '') || /中文|简体|chinese/i.test(track.label ?? '')
  return manual.find(zh) ?? manual[0] ?? usable.find(zh) ?? usable[0]
}

/**
 * Format one cue as a timestamped line.
 *
 * @param {import('./lib/subtitle.js').SubtitleCue} cue Source cue.
 * @returns {{index: number, at: string, startSeconds: number, endSeconds: number, text: string}} Line record.
 */
function cueLine(cue) {
  return { index: cue.index, at: formatClock(cue.start), startSeconds: cue.start, endSeconds: cue.end, text: cue.text }
}

/**
 * Summarize a document's shape for a tool result.
 *
 * @param {import('./lib/subtitle.js').SubtitleDocument} document Source document.
 * @returns {Record<string, unknown>} Summary.
 */
function summarizeDocument(document) {
  const cues = document.cues
  return {
    cueCount: cues.length,
    durationSeconds: document.duration,
    characters: document.characters,
    medianCueSeconds: cues.length === 0 ? 0 : median(cues.map((cue) => cue.duration)),
    gaps: countGaps(cues),
  }
}

/**
 * Count cues separated by an unusually long silence.
 *
 * A transcript with many multi-minute gaps is usually music or silence, which
 * is worth telling the model before it summarizes "what was said".
 *
 * @param {import('./lib/subtitle.js').SubtitleCue[]} cues Ordered cues.
 * @param {number} [threshold] Seconds that count as a gap.
 * @returns {number} Gap count.
 */
function countGaps(cues, threshold = 8) {
  let gaps = 0
  for (let index = 1; index < cues.length; index += 1) {
    if (cues[index].start - cues[index - 1].end >= threshold) gaps += 1
  }
  return gaps
}

/**
 * Median of a numeric list.
 *
 * @param {number[]} values Values.
 * @returns {number} Median.
 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 100) / 100 : Math.round(sorted[middle] * 100) / 100
}

/**
 * Build the payload of a standalone parse result.
 *
 * @param {import('./lib/subtitle.js').SubtitleDocument} document Parsed document.
 * @param {string} origin Where the text came from.
 * @returns {Record<string, unknown>} Tool value.
 */
function parseResult(document, origin) {
  return {
    ok: true,
    origin,
    format: document.format,
    cueCount: document.cues.length,
    durationSeconds: document.duration,
    characters: document.characters,
    measure: measureText(document.cues.map((cue) => cue.text).join(' ')),
    warnings: document.warnings,
    preview: document.cues.slice(0, 12).map(cueLine),
  }
}

/**
 * Write a text file through the composed filesystem, returning both paths.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {string} relative Workspace-relative path.
 * @param {string} content File body.
 * @param {boolean} overwrite Whether an existing file may be replaced.
 * @returns {Promise<{relative: string, absolute: string}>} Written paths.
 */
async function writeTextFile(ctx, relative, content, overwrite) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const root = process.cwd()
  const absolute = path.isAbsolute(relative) ? relative : path.resolve(root, relative)
  const directory = path.dirname(absolute)
  await fs.mkdir(directory, { recursive: true })
  if (!overwrite) {
    const exists = await fs
      .access(absolute)
      .then(() => true)
      .catch(() => false)
    if (exists) throw new Error(`文件已存在且 overwrite 为 false：${absolute}`)
  }
  await fs.writeFile(absolute, content, 'utf8')
  // Report a workspace-relative path when the file really is inside it, so the
  // model can hand the path to `read` unchanged.
  const relativeOut = absolute.startsWith(root) ? path.relative(root, absolute).split(path.sep).join('/') : absolute
  void ctx
  return { relative: relativeOut, absolute }
}

/**
 * The directory a session is working in, as the host knows it.
 *
 * `process.cwd()` is NOT it: a running DSH is started from its profile
 * directory, so a file written relative to the cwd lands in
 * `.dsh/profiles/<name>/` where the chat can never show it (and where it
 * pollutes the profile). The workspace travels with the session header.
 *
 * @param {{agent?: {session?: {header?: {cwd?: unknown}}}} | undefined} exec Tool execution context.
 * @returns {string|undefined} Absolute workspace path, when there is one.
 */
function sessionWorkspace(exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Exported for tests: the workspace lookup is what makes the QR visible in chat. */
export { sessionWorkspace }

/**
 * Write a binary file to the workspace.
 *
 * Mirrors {@link writeTextFile}, but takes a Buffer and always overwrites: the
 * login QR is regenerated on demand and a stale image is worse than none.
 *
 * @param {string} relative Workspace-relative path.
 * @param {Buffer} content File bytes.
 * @param {string} [root] Workspace root; defaults to the process cwd.
 * @returns {Promise<{relative: string, absolute: string}>} Written paths.
 */
async function writeBinaryFile(relative, content, root = process.cwd()) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const absolute = path.isAbsolute(relative) ? relative : path.resolve(root, relative)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, content)
  const relativeOut = absolute.startsWith(root) ? path.relative(root, absolute).split(path.sep).join('/') : absolute
  return { relative: relativeOut, absolute }
}

/**
 * Read a workspace text file.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {string} relative Workspace-relative path.
 * @returns {Promise<string>} File contents.
 */
async function readTextFile(ctx, relative) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const absolute = path.isAbsolute(relative) ? relative : path.resolve(process.cwd(), relative)
  void ctx
  return await fs.readFile(absolute, 'utf8')
}

/**
 * Derive an output filename from a video's title.
 *
 * @param {CacheEntry} entry Fetched document entry.
 * @param {string} format Output format.
 * @returns {string} Workspace-relative path.
 */
function suggestedPath(entry, format) {
  const rawTitle = typeof entry.video.title === 'string' && entry.video.title !== '' ? entry.video.title : entry.video.id
  const safe = String(rawTitle)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const suffix = typeof entry.track.lang === 'string' && entry.track.lang !== '' ? `.${entry.track.lang}` : entry.track.auto === true ? '.ai' : ''
  const site = typeof entry.video.site === 'string' ? `${entry.video.site}-` : ''
  return `subtitles/${site}${safe || 'subtitles'}${suffix}.${format}`
}

/**
 * Keep a cache map bounded, dropping the oldest entries.
 *
 * @param {Map<string, CacheEntry>} cache Cache to prune.
 * @param {number} keep Maximum entries.
 * @returns {void}
 */
function pruneCache(cache, keep) {
  if (cache.size <= keep) return
  const ordered = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)
  for (const [key] of ordered.slice(0, cache.size - keep)) cache.delete(key)
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/**
 * Render the `video_subtitle_get` result for the model.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderGetResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const lines = []
  lines.push(`视频：${value.video?.title || '(未能解析标题)'}`)
  if (value.video?.owner) lines.push(`UP 主 / 作者：${value.video.owner}`)
  lines.push(`站点：${value.video?.siteLabel ?? value.video?.site ?? '?'}　时长：${describeDuration(value.video?.durationSeconds)}`)
  if (value.video?.url) lines.push(`地址：${value.video.url}`)
  const track = value.track ?? {}
  lines.push(`字幕轨：${track.label ?? track.id ?? '?'}${track.lang ? `（${track.lang}）` : ''}${track.auto ? ' [AI 生成]' : ''}　格式：${track.format ?? '?'}`)
  const subs = value.subtitles ?? {}
  lines.push(`规模：${subs.cueCount ?? 0} 条字幕 / ${subs.characters ?? 0} 字 / 覆盖 ${formatClock(subs.lastCueAt ?? 0)}`)
  if (Array.isArray(value.video?.availableTracks) && value.video.availableTracks.length > 1) {
    lines.push(`其他可用字幕轨：${value.video.availableTracks.map((entry) => `${entry.label ?? entry.id}${entry.auto ? '(AI)' : ''}`).join('、')}`)
  }
  if (Array.isArray(value.preview) && value.preview.length > 0) {
    lines.push('', '开头片段：')
    for (const line of value.preview) lines.push(`  [${line.at}] ${String(line.text).replace(/\n/g, ' / ')}`)
  }
  if (Array.isArray(value.notes) && value.notes.length > 0) {
    lines.push('', '说明：')
    for (const note of value.notes) lines.push(`  - ${note}`)
  }
  if (value.next) lines.push('', value.next)
  return lines.join('\n')
}

/**
 * Render the `video_subtitle_info` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderInfoResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const lines = [`视频：${value.video?.title || '(未能解析标题)'}　时长：${describeDuration(value.video?.durationSeconds)}`]
  if (value.video?.owner) lines.push(`作者：${value.video.owner}`)
  lines.push(`站点：${value.site?.label ?? '?'}（${value.site?.captionsSupported === true ? '可抓字幕' : '仅元信息'}）`)
  if (value.video?.partCount > 0) lines.push(`分 P / 剧集数：${value.video.partCount}`)
  lines.push('', `字幕轨（${Array.isArray(value.tracks) ? value.tracks.length : 0} 条）：`)
  if (Array.isArray(value.tracks) && value.tracks.length > 0) {
    for (const track of value.tracks) {
      lines.push(`  - ${track.label ?? track.id}${track.lang ? `（${track.lang}）` : ''}${track.auto ? ' [AI]' : ''}${track.locked ? ' [锁定]' : ''}${track.hasUrl === false ? ' [待生成/无地址]' : ''}${track.note ? ` — ${track.note}` : ''}`)
    }
  } else {
    lines.push('  （无）')
  }
  if (Array.isArray(value.notes) && value.notes.length > 0) {
    lines.push('', '说明：')
    for (const note of value.notes) lines.push(`  - ${note}`)
  }
  if (value.help) lines.push('', `提示：${value.help}`)
  return lines.join('\n')
}

/**
 * Render the `video_subtitle_read` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderReadResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const window = value.window ?? {}
  const header =
    window.kind === 'page'
      ? `第 ${window.page}/${window.pageCount} 页（第 ${window.fromCue}–${window.toCue} 条，共 ${value.totalCues} 条）`
      : `选中 ${value.returned} 条（共 ${value.totalCues} 条）`
  const lines = [`${value.video?.title ?? ''}　${header}`]
  if (Array.isArray(value.lines)) {
    for (const line of value.lines) lines.push(`[${line.at}] ${String(line.text).replace(/\n/g, ' / ')}`)
  }
  return lines.join('\n')
}

/**
 * Render the `video_subtitle_search` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderSearchResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const lines = [`在《${value.video?.title ?? ''}》中搜索「${value.query}」：命中 ${value.hitCount} 处（共 ${value.totalCues} 条字幕）`]
  if (Array.isArray(value.hits)) {
    for (const hit of value.hits) {
      lines.push('', `#${hit.cueIndex} @ ${hit.at}`)
      lines.push(String(hit.context ?? hit.text))
    }
  }
  return lines.join('\n')
}

/**
 * Render the `video_subtitle_export` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderExportResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  return [
    `已导出字幕：${value.path}`,
    `格式：${value.format}　条数：${value.cueCount}　大小：${value.bytes} 字节`,
    `视频：${value.video?.title ?? ''}`,
    `cacheKey：${value.cacheKey}`,
  ].join('\n')
}

/**
 * Render the `video_subtitle_parse` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderParseResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const lines = [`已解析 ${value.origin ?? ''}：格式 ${value.format}，${value.cueCount} 条字幕，时长 ${formatClock(value.durationSeconds ?? 0)}，${value.characters} 字`]
  if (Array.isArray(value.warnings) && value.warnings.length > 0) lines.push(`告警：${value.warnings.join('; ')}`)
  if (Array.isArray(value.preview)) {
    lines.push('开头片段：')
    for (const line of value.preview) lines.push(`  [${line.at}] ${String(line.text).replace(/\n/g, ' / ')}`)
  }
  return lines.join('\n')
}

/**
 * Render the `video_site_detect` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderDetectResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  if (value.matched !== true) return `未识别：${value.reason ?? ''}`
  const lines = [
    `站点：${value.site?.label ?? '?'}（adapter id: ${value.site?.id ?? '?'}）`,
    `是否可抓字幕：${value.site?.captionsSupported === true ? '可以' : '不可以（仅元信息）'}`,
  ]
  if (value.site?.limitation) lines.push(`原因：${value.site.limitation}`)
  if (value.identity !== undefined) lines.push(`解析结果：${JSON.stringify(value.identity)}`)
  return lines.join('\n')
}

/**
 * Render the `video_subtitle_sites` result.
 *
 * @param {any} value Tool value.
 * @returns {string} Model-facing text.
 */
function renderSitesResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const lines = ['已适配的站点：']
  for (const site of value.sites ?? []) {
    lines.push(`  - ${site.label}（${site.id}）：${site.captions === true ? '可抓字幕' : '仅元信息'}${site.limitation ? ` — ${site.limitation}` : ''}`)
  }
  const configured = (value.cookies ?? []).filter((entry) => entry.configured === true)
  lines.push('', configured.length > 0 ? `已配置 cookie 的站点：${configured.map((entry) => entry.id).join('、')}` : '尚未配置任何站点的 cookie（B站字幕列表需要 SESSDATA）。')
  if (Array.isArray(value.notes)) {
    lines.push('', '说明：')
    for (const note of value.notes) lines.push(`  - ${note}`)
  }
  return lines.join('\n')
}

/**
 * Render a `video_subtitle_login` result for the model.
 *
 * @param {any} value Canonical tool value.
 * @returns {string} Text.
 */
function renderLoginResult(value) {
  if (value === null || typeof value !== 'object') return '（无结果）'
  const lines = []
  const state = String(value.state ?? '')

  if (value.action === 'start') {
    lines.push('已生成 B 站扫码登录二维码。', '')
    if (typeof value.image === 'string') {
      lines.push(`二维码图片：${value.image}`)
      lines.push(`（用 B 站手机客户端扫码；在手机上点「确认登录」。）`)
    } else {
      lines.push('二维码图片生成失败，请把下面这个地址自己转成二维码：')
    }
    lines.push('', `二维码内容：${value.qrUrl}`)
    lines.push(`有效期：约 ${value.expiresInSeconds ?? 180} 秒（${value.expiresAt ?? ''} 之前）`)
    lines.push('', `qrKey：${value.qrKey}`)
    if (value.watching === true) {
      lines.push('', '插件已在后台等待扫码结果：确认或过期时会自动开启一轮通知你，不用让用户回报「扫完了」，也不用反复 action="poll"。')
    }
  } else if (value.action === 'poll') {
    lines.push(`扫码状态：${value.label ?? state}`)
    if (value.message) lines.push(`B 站返回：${value.message}`)
    if (typeof value.cookie === 'string') lines.push(`登录态：${value.cookie}`)
    if (typeof value.sessionPath === 'string') lines.push(`已保存到：${value.sessionPath}`)
    if (typeof value.expiresAt === 'string') lines.push(`有效期至：${value.expiresAt}`)
    if (typeof value.mid === 'string') lines.push(`用户 mid：${value.mid}`)
    if (typeof value.next === 'string') lines.push('', value.next)
  } else if (value.action === 'status') {
    lines.push(`B 站登录态来源：${value.sourceLabel ?? value.source ?? '未知'}`)
    lines.push(`当前凭据：${value.cookie ?? '（未登录）'}`)
    const session = value.session
    if (session && typeof session === 'object') {
      lines.push('', '扫码保存的 session：')
      lines.push(`  保存时间：${session.savedAt ?? '未知'}`)
      if (typeof session.expiresAt === 'string') lines.push(`  有效期至：${session.expiresAt}`)
      if (typeof session.mid === 'string') lines.push(`  用户 mid：${session.mid}`)
      if (session.expired === true) lines.push('  ⚠️ 已过期，需要重新扫码')
    } else if (typeof value.sessionPath === 'string') {
      lines.push(`（没有扫码保存的 session；文件位置：${value.sessionPath}）`)
    }
  } else if (value.action === 'logout') {
    lines.push(value.removed === true ? '已删除扫码保存的 B 站登录态。' : '没有扫码保存的 B 站登录态可删除。')
  } else {
    lines.push(`扫码登录：${state}`)
  }

  if (Array.isArray(value.notes) && value.notes.length > 0) {
    lines.push('', '说明：')
    for (const note of value.notes) lines.push(`  - ${note}`)
  }
  return lines.join('\n')
}

// Re-exported so tests and downstream plugins can reuse the resolved roster and
// the generic fallback without reaching into ./lib.
export { roster, supports, generic, parseSubtitles, serialize, formatClock }
