/**
 * 微博视频 (weibo.com/tv) adapter.
 *
 * **Captions are not reachable server-side.** The component API that serves a
 * video's data answers anonymous callers with the "Sina Visitor System"
 * interstitial (HTML, not JSON), and the site exposes no subtitle feature.
 *
 * @module dsh-video-srt/lib/sites/weibo
 */

import { buildUnsupportedAdapter } from './unsupported.js'

/** The researched, specific reason Weibo video captions are out of reach. */
export const limitation =
  '微博视频的组件接口对匿名请求返回「新浪访客系统」拦截页（HTML 而不是 JSON），需要访客 cookie 才能通过；' +
  '而且微博视频本身没有对外提供字幕轨道。本插件取不到微博视频字幕。'

/**
 * Parse a Weibo video URL into a minimal identity.
 *
 * @param {string} url Source URL.
 * @returns {{url: string, id?: string} | undefined} Identity, or undefined.
 */
function parseId(url) {
  const tv = /\/tv\/show\/([A-Za-z0-9:_-]+)/.exec(url)
  if (tv !== null) return { url, id: tv[1] }
  const detail = /\/\d+\/([A-Za-z0-9]{10,})/.exec(url)
  if (detail !== null) return { url, id: detail[1] }
  const fid = /[?&]fid=([A-Za-z0-9:_-]+)/.exec(url)
  if (fid !== null) return { url, id: fid[1] }
  const oid = /[?&]oid=(\d+)/.exec(url)
  if (oid !== null) return { url, id: oid[1] }
  return undefined
}

export const id = 'weibo'
export const label = '微博视频'
export const homepage = 'https://weibo.com'
export const referer = 'https://weibo.com/'
export const captions = false

const adapter = buildUnsupportedAdapter({
  id,
  label,
  homepage,
  referer,
  hostPattern: '(^|\\.)(weibo\\.com|weibo\\.cn|m\\.weibo\\.cn)$',
  parseId,
  limitation,
})

export const match = adapter.match
export const parse = adapter.parse
export const info = adapter.info
export const tracks = adapter.tracks
export const download = adapter.download
export const fetchPageHtml = adapter.fetchPageHtml
