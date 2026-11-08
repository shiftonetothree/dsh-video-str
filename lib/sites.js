/**
 * Site adapter registry.
 *
 * One adapter per site. An adapter answers four questions and inherits every
 * tool, every export format, and the whole caching/segmentation layer:
 *
 * - {@link SiteAdapter.match} — is this URL mine?
 * - {@link SiteAdapter.parse} — what video does it name?
 * - {@link SiteAdapter.info} — what is that video?
 * - {@link SiteAdapter.tracks} — which captions does it offer?
 * - {@link SiteAdapter.download} — give me one caption track's cues.
 *
 * An adapter that cannot serve captions for its site still earns its place: it
 * answers `info` and reports a specific, actionable reason. That is how the
 * plugin tells a model "腾讯视频的字幕需要浏览器内的签名请求" instead of a bare
 * "unsupported".
 *
 * @module dsh-video-srt/lib/sites
 */

import * as bilibili from './sites/bilibili.js'
import * as youku from './sites/youku.js'
import * as qq from './sites/qq.js'
import * as mgtv from './sites/mgtv.js'
import * as douyin from './sites/douyin.js'
import * as ixigua from './sites/ixigua.js'
import * as kuaishou from './sites/kuaishou.js'
import * as weibo from './sites/weibo.js'
import * as acfun from './sites/acfun.js'
import * as generic from './sites/generic.js'

/**
 * A site adapter.
 *
 * @typedef {object} SiteAdapter
 * @property {string} id Stable adapter id.
 * @property {string} label Human-readable site name.
 * @property {string} homepage Site origin.
 * @property {string} referer `Referer` header the site's own pages send.
 * @property {(url: string) => boolean} match Whether this adapter claims a URL.
 * @property {(url: string) => object|undefined} parse Parse a URL into an identity.
 * @property {(ref: object, http: import('../http.js').HttpContext, signal?: AbortSignal) => Promise<import('../types.js').VideoInfo>} info
 *   Resolve a video's metadata and the container the captions belong to.
 * @property {(ref: object, http: import('../http.js').HttpContext, signal?: AbortSignal) => Promise<{tracks: import('../subtitle.js').SubtitleTrack[], notes: string[], help?: string}>} tracks
 *   List caption tracks, with notes explaining an empty result.
 * @property {(track: import('../subtitle.js').SubtitleTrack, ref: object, http: import('../http.js').HttpContext, signal?: AbortSignal) => Promise<import('../subtitle.js').SubtitleDocument>} download
 *   Download and parse one track.
 * @property {boolean} [captions] Whether this adapter can really serve captions.
 * @property {string} [limitation] Why it cannot, when `captions` is false.
 * @property {number} [priority] Higher wins when several adapters match.
 */

/** Every registered adapter, most specific first. */
export const ADAPTERS = /** @type {SiteAdapter[]} */ ([
  bilibili,
  youku,
  qq,
  mgtv,
  douyin,
  ixigua,
  kuaishou,
  weibo,
  acfun,
])

/** The catch-all adapter, used when no site adapter claims a URL. */
export { generic }

/**
 * Resolve the adapter for a URL.
 *
 * @param {string} url Candidate URL.
 * @returns {{adapter: SiteAdapter, ref: object}|undefined} The adapter and parsed identity.
 */
export function resolve(url) {
  const text = String(url ?? '').trim()
  if (text === '') return undefined
  for (const adapter of ADAPTERS) {
    if (!adapter.match(text)) continue
    const ref = adapter.parse(text)
    if (ref !== undefined) return { adapter, ref }
  }
  const ref = generic.parse(text)
  if (ref === undefined) return undefined
  return { adapter: generic, ref }
}

/**
 * Whether any adapter claims a URL at all.
 *
 * @param {string} url Candidate URL.
 * @returns {boolean} True when the URL is usable.
 */
export function supports(url) {
  return resolve(url) !== undefined
}

/**
 * Describe the adapter roster, for the `video_subtitle_sites` tool.
 *
 * @returns {{id: string, label: string, homepage: string, captions: boolean, limitation?: string}[]} Roster.
 */
export function roster() {
  const entries = ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    homepage: adapter.homepage,
    captions: adapter.captions !== false,
    limitation: adapter.limitation,
  }))
  entries.push({
    id: generic.id,
    label: generic.label,
    homepage: generic.homepage,
    captions: true,
    limitation: generic.limitation,
  })
  // `undefined` is not lossless JSON, and the tool registry rejects a canonical
  // value that carries it — so an adapter without a limitation must simply omit
  // the field rather than set it to undefined.
  return entries.map((entry) => (entry.limitation === undefined ? { id: entry.id, label: entry.label, homepage: entry.homepage, captions: entry.captions } : entry))
}
