/**
 * 优酷 (youku.com) adapter.
 *
 * **Captions are not reachable server-side, and this adapter does not pretend
 * otherwise.** `ups.youku.com/ups/get.json` works anonymously and returns rich
 * metadata, but its payload contains no subtitle or caption field at all — and
 * neither does any other public Youku API. Youku's own engineering writing
 * describes subtitles as external `.ass` files fetched by the player's subtitle
 * "sourcer" over a private command channel whose endpoint is not published.
 *
 * The generic page scan still runs, because a Youku page's `__INITIAL_DATA__`
 * occasionally carries a subtitle URL; when it does not, the result says why.
 *
 * @module dsh-video-srt/lib/sites/youku
 */

import { buildUnsupportedAdapter } from './unsupported.js'

/** The researched, specific reason Youku captions are out of reach. */
export const limitation =
  '优酷不通过公开接口返回字幕：它的字幕是播放器用私有的「设置 subtitle url」命令拉取的外挂 .ass 文件，' +
  '该命令的接口没有公开，ups/get.json 的响应里也完全没有字幕字段。因此本插件无法在服务端直接取到优酷字幕。'

/**
 * Parse a Youku URL into a minimal identity.
 *
 * @param {string} url Source URL.
 * @returns {{url: string, id?: string} | undefined} Identity, or undefined.
 */
function parseId(url) {
  const match = /\/v_show\/id_([A-Za-z0-9=_-]+)\.html/.exec(url)
  if (match !== null) return { url, id: match[1] }
  const query = /[?&]vid=([A-Za-z0-9=_-]+)/.exec(url)
  if (query !== null) return { url, id: query[1] }
  return undefined
}

export const id = 'youku'
export const label = '优酷'
export const homepage = 'https://www.youku.com'
export const referer = 'https://www.youku.com/'
export const captions = false

const adapter = buildUnsupportedAdapter({
  id,
  label,
  homepage,
  referer,
  hostPattern: '(^|\\.)youku\\.com$',
  parseId,
  limitation,
})

export const match = adapter.match
export const parse = adapter.parse
export const info = adapter.info
export const tracks = adapter.tracks
export const download = adapter.download
export const fetchPageHtml = adapter.fetchPageHtml
