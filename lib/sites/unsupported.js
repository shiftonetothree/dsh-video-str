/**
 * Adapters for sites that cannot serve captions from a server-side request.
 *
 * Each of these still resolves the video and still runs the generic page scan —
 * a site's own page state occasionally carries a caption URL even when its API
 * does not — but when the scan comes back empty they answer with the *specific*
 * reason instead of a shrug. The reasons are researched, not guessed:
 *
 * | site | why captions are out of reach |
 * | ---- | ----------------------------- |
 * | 优酷 | subtitles are external `.ass` files delivered over a private player command; the public API never returns them |
 * | 爱奇艺 | the request needs `cmd5x`/`authKey`/`vf`, produced by VM-obfuscated JS that must be *executed* |
 * | 抖音 / 西瓜 | `a_bogus` signature plus `ttwid`/`msToken` identity; the page ships as an empty body + JSVMP blob |
 * | 快手 | `__NS_sig3` signature, and its canonical GraphQL query exposes no subtitle field at all |
 * | 微博 | the API answers the "Sina Visitor System" interstitial for anonymous callers |
 *
 * @module dsh-video-srt/lib/sites/unsupported
 */

import { SiteError } from '../http.js'
import { parseSubtitles } from '../subtitle.js'
import { downloadCandidate, tracksFromPage, unsupported, fetchHtml, readPageMeta } from './base.js'

/**
 * Note attached when the page turns out to be a client-rendered shell.
 *
 * Stated separately from the site's caption limitation because it explains a
 * different loss: not "subtitles are unreachable" but "there was no video
 * metadata on this page to begin with".
 */
const SHELL_NOTE =
  '这个页面由浏览器里的 JS 渲染：服务端返回的 HTML 里没有任何视频信息（连视频 id 都不出现），' +
  '所以标题、时长、封面都读不到。这不是插件读错了页面，是这个地址在纯服务端视角下就是空的。'

/**
 * Build a full adapter for a site whose captions are out of reach server-side.
 *
 * @param {object} spec Adapter specification.
 * @param {string} spec.id Adapter id.
 * @param {string} spec.label Human-readable site name.
 * @param {string} spec.homepage Site origin.
 * @param {string} spec.referer `Referer` header.
 * @param {string} spec.hostPattern Host match pattern.
 * @param {(url: string) => object|undefined} spec.parseId Identity parser.
 * @param {string} spec.limitation Why captions cannot be served.
 * @param {boolean} [spec.pageScan] Whether the page scan is worth running.
 * @returns {import('../sites.js').SiteAdapter} The adapter.
 */
export function buildUnsupportedAdapter(spec) {
  const fetchPage = async (ref, http, signal) => {
    if (spec.pageScan === false) return ''
    return await fetchHtml(ref.url, http, { siteId: spec.id, referer: spec.referer }, signal)
  }
  return {
    id: spec.id,
    label: spec.label,
    homepage: spec.homepage,
    referer: spec.referer,
    captions: false,
    limitation: spec.limitation,
    match(url) {
      try {
        return new RegExp(spec.hostPattern, 'i').test(new URL(String(url)).hostname)
      } catch {
        return false
      }
    },
    parse(url) {
      const parsed = spec.parseId(String(url))
      return parsed === undefined ? undefined : { site: spec.id, ...parsed }
    },
    async info(ref, http, signal) {
      const html = await fetchPage(ref, http, signal)
      const meta = readPageMeta(html, ref.fallbackTitle, ref.id)
      return {
        site: spec.id,
        id: ref.id ?? '',
        url: ref.url,
        title: meta.title,
        owner: '',
        cover: meta.cover,
        // Left undefined for a shell: `0` would render as a real duration of
        // 0:00 and read as "this video is empty" rather than "unknown".
        durationSeconds: meta.durationSeconds,
        description: meta.description,
        container: { kind: /** @type {const} */ ('page'), site: spec.id, id: ref.id ?? '' },
        parts: [],
        stats: {},
        notes: meta.shell === true ? [SHELL_NOTE, spec.limitation] : [spec.limitation],
      }
    },
    async tracks(ref, http, signal, knownInfo) {
      const videoInfo = knownInfo ?? (await this.info(ref, http, signal))
      const html = await fetchPage(ref, http, signal)
      /** Notes about candidates that were thrown away, appended to every result. */
      const rejections = []
      if (html !== '') {
        const scan = tracksFromPage(html, ref.url, spec.id, undefined)
        // Verify every candidate before offering it. The page-state walk finds
        // plenty of URL-shaped strings that are navigation, not captions — Youku's
        // `$.pageTabs` yields `detail` and `planet` — and offering those would
        // fabricate a subtitle track that then "downloads" a CSS rule.
        /** @type {import('../subtitle.js').SubtitleTrack[]} */
        const verified = []
        for (const track of scan.tracks) {
          if (track.url === undefined) continue
          try {
            const document = await downloadCandidate(
              track.url,
              http,
              { siteId: spec.id, referer: spec.referer },
              signal,
            )
            if (document.cues.length === 0) {
              rejections.push(`${track.url}（解析后 0 条）`)
              continue
            }
            verified.push({
              ...track,
              format: document.format,
              note: `${track.note ?? ''} [已确认：${document.cues.length} 条字幕]`.trim(),
            })
          } catch (error) {
            rejections.push(`${track.url}（${error instanceof Error ? error.message.slice(0, 60) : String(error)}）`)
          }
        }
        const rejectedNote =
          rejections.length === 0 ? [] : [`已排除 ${rejections.length} 个候选地址（下载验证后不是字幕）：${rejections.slice(0, 3).join('；')}`]
        if (verified.length > 0) {
          return {
            tracks: verified,
            notes: [
              ...scan.notes,
              `注意：${spec.label} 没有给出字幕接口，下面这些是通用页面扫描并逐个下载验证过的结果，可能不是官方字幕。`,
              ...rejectedNote,
            ],
          }
        }
        if (scan.inline.length > 0) {
          return {
            tracks: scan.inline.map((_, ordinal) => ({
              id: `inline-${ordinal + 1}`,
              site: spec.id,
              label: `页面内时间轴文本 ${ordinal + 1}`,
              format: 'json',
              note: '来自页面状态里的时间轴文本，不是字幕文件地址。',
            })),
            notes: [`注意：${spec.label} 没有给出字幕接口，下面这些是通用页面扫描的结果。`, ...rejectedNote],
          }
        }
      }
      // Carry the shell explanation into the refusal as well. `fetchDocument`
      // surfaces `help` as the thrown error, so a shell page would otherwise be
      // reported as "only the site's captions are unreachable" while silently
      // dropping the fact that no metadata was readable at all.
      const shell = Array.isArray(videoInfo?.notes) && videoInfo.notes.includes(SHELL_NOTE)
      const limitation = shell === true ? `${SHELL_NOTE} 另外，${spec.limitation}` : spec.limitation
      return unsupported(
        spec.id,
        limitation,
        [
          '可以改用浏览器插件或工具（如 yt-dlp / BBDown 等本项目未内置的工具）抓取后再导入文本。',
          ...(rejections.length === 0 ? [] : [`页面扫描找到 ${rejections.length} 个候选地址，但下载验证后都不是字幕。`]),
        ].join(' '),
      )
    },
    async download(track, ref, http, signal) {
      void ref
      if (track.url === undefined) {
        throw new SiteError(`${spec.label} 的这条记录不是可下载的字幕文件。`, { site: spec.id, code: 'no-url', hint: spec.limitation })
      }
      if (typeof track.inline === 'string') {
        const document = parseSubtitles(track.inline, 'json')
        if (document.cues.length > 0) return document
      }
      return await downloadCandidate(track.url, http, { siteId: spec.id, referer: spec.referer }, signal)
    },
    async fetchPageHtml(ref, http, signal) {
      return await fetchPage(ref, http, signal)
    },
  }
}
