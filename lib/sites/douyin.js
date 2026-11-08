/**
 * 抖音 (douyin.com) adapter.
 *
 * **Captions are not reachable server-side.** The detail endpoint needs an
 * `a_bogus` signature plus `msToken` and `ttwid` identity cookies; `a_bogus` is
 * produced by VM-obfuscated JavaScript, and the serious tools in this space mint
 * the identity with a headless browser rather than reimplementing it. An
 * anonymous request is refused outright ("Blocked by ArgusSecurityPlugin").
 *
 * @module dsh-video-srt/lib/sites/douyin
 */

import { buildUnsupportedAdapter } from './unsupported.js'

/** The researched, specific reason Douyin captions are out of reach. */
export const limitation =
  '抖音要求请求携带 a_bogus 签名以及 msToken / ttwid 身份 cookie，而 a_bogus 由虚拟机保护的混淆 JS 生成；' +
  '匿名请求会直接被 ArgusSecurityPlugin 拦截。纯服务端无法复现，所以本插件取不到抖音字幕。'

/**
 * Parse a Douyin URL into a minimal identity.
 *
 * @param {string} url Source URL.
 * @returns {{url: string, id?: string} | undefined} Identity, or undefined.
 */
function parseId(url) {
  const video = /\/video\/(\d+)/.exec(url)
  if (video !== null) return { url, id: video[1] }
  const note = /\/note\/(\d+)/.exec(url)
  if (note !== null) return { url, id: note[1] }
  const modal = /[?&]modal_id=(\d+)/.exec(url)
  if (modal !== null) return { url, id: modal[1] }
  const short = /v\.douyin\.com\/([A-Za-z0-9]+)/.exec(url)
  if (short !== null) return { url, id: short[1] }
  return undefined
}

export const id = 'douyin'
export const label = '抖音'
export const homepage = 'https://www.douyin.com'
export const referer = 'https://www.douyin.com/'
export const captions = false

const adapter = buildUnsupportedAdapter({
  id,
  label,
  homepage,
  referer,
  hostPattern: '(^|\\.)(douyin|iesdouyin)\\.com$',
  parseId,
  limitation,
})

export const match = adapter.match
export const parse = adapter.parse
export const info = adapter.info
export const tracks = adapter.tracks
export const download = adapter.download
export const fetchPageHtml = adapter.fetchPageHtml
