/**
 * 西瓜视频 (ixigua.com) adapter.
 *
 * **Captions are not reachable server-side.** The watch page is delivered as an
 * empty `<body>` plus a JSVMP-obfuscated script blob, so there is nothing to
 * scan in the HTML, and the API needs the same ByteDance signature family as
 * Douyin. The established extractors for this site implement no subtitle
 * support at all.
 *
 * @module dsh-video-srt/lib/sites/ixigua
 */

import { buildUnsupportedAdapter } from './unsupported.js'

/** The researched, specific reason Xigua captions are out of reach. */
export const limitation =
  '西瓜视频的页面主体是空的，真正的数据由 JSVMP 混淆脚本在浏览器里生成，接口又需要与抖音同源的签名参数，' +
  '所以服务端既扫不到页面状态、也签不出请求。本插件取不到西瓜视频字幕。'

/**
 * Parse an Xigua URL into a minimal identity.
 *
 * @param {string} url Source URL.
 * @returns {{url: string, id?: string} | undefined} Identity, or undefined.
 */
function parseId(url) {
  const video = /\/(\d{8,})/.exec(url)
  if (video !== null) return { url, id: video[1] }
  return undefined
}

export const id = 'ixigua'
export const label = '西瓜视频'
export const homepage = 'https://www.ixigua.com'
export const referer = 'https://www.ixigua.com/'
export const captions = false

const adapter = buildUnsupportedAdapter({
  id,
  label,
  homepage,
  referer,
  hostPattern: '(^|\\.)ixigua\\.com$',
  parseId,
  limitation,
})

export const match = adapter.match
export const parse = adapter.parse
export const info = adapter.info
export const tracks = adapter.tracks
export const download = adapter.download
export const fetchPageHtml = adapter.fetchPageHtml
