/**
 * 快手 (kuaishou.com) adapter.
 *
 * **Captions are not reachable server-side, and for this site there is an extra
 * caveat worth stating plainly: its canonical video-detail GraphQL query exposes
 * no subtitle field at all.** The transport is open (`{"result":2}` succeeds)
 * but needs an `__NS_sig3` signature, and `photo.caption` — the one
 * caption-looking field — is the post's *description text*, not a subtitle
 * track. So this is not merely a signing problem.
 *
 * @module dsh-video-srt/lib/sites/kuaishou
 */

import { buildUnsupportedAdapter } from './unsupported.js'

/** The researched, specific reason Kuaishou captions are out of reach. */
export const limitation =
  '快手的接口需要 __NS_sig3 签名，而且它的视频详情 GraphQL 查询里根本没有字幕字段' +
  '（唯一的 caption 字段是作品文案，不是字幕轨道）。也就是说快手在网页端并不暴露字幕，本插件取不到。'

/**
 * Parse a Kuaishou URL into a minimal identity.
 *
 * @param {string} url Source URL.
 * @returns {{url: string, id?: string} | undefined} Identity, or undefined.
 */
function parseId(url) {
  const short = /\/short-video\/([A-Za-z0-9_-]+)/.exec(url)
  if (short !== null) return { url, id: short[1] }
  const fw = /\/fw\/photo\/([A-Za-z0-9_-]+)/.exec(url)
  if (fw !== null) return { url, id: fw[1] }
  const photo = /\/photo\/([A-Za-z0-9_-]+)/.exec(url)
  if (photo !== null) return { url, id: photo[1] }
  return undefined
}

export const id = 'kuaishou'
export const label = '快手'
export const homepage = 'https://www.kuaishou.com'
export const referer = 'https://www.kuaishou.com/'
export const captions = false

const adapter = buildUnsupportedAdapter({
  id,
  label,
  homepage,
  referer,
  hostPattern: '(^|\\.)(kuaishou|gifshow)\\.com$',
  parseId,
  limitation,
})

export const match = adapter.match
export const parse = adapter.parse
export const info = adapter.info
export const tracks = adapter.tracks
export const download = adapter.download
export const fetchPageHtml = adapter.fetchPageHtml
