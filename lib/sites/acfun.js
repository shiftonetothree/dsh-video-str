/**
 * AcFun (acfun.cn) adapter.
 *
 * AcFun's player does carry subtitle tracks for some 番剧, but reaching them
 * needs its own request signing (`__ac_signature`/`_did` cookie family). The
 * generic page scan still runs, because AcFun's page state is server-rendered
 * and occasionally names a caption URL outright.
 *
 * @module dsh-video-srt/lib/sites/acfun
 */

import { buildUnsupportedAdapter } from './unsupported.js'

/** Why AcFun captions are not reliably reachable. */
export const limitation =
  'AcFun 的部分番剧确实带字幕轨，但接口需要它自己的签名与 _did 身份 cookie；' +
  '本插件只做通用页面扫描，扫不到时会明确说明，而不会伪造字幕。'

/**
 * Parse an AcFun URL into a minimal identity.
 *
 * @param {string} url Source URL.
 * @returns {{url: string, id?: string} | undefined} Identity, or undefined.
 */
function parseId(url) {
  const video = /\/v\/(ac\d+)/i.exec(url)
  if (video !== null) return { url, id: video[1] }
  const bangumi = /\/bangumi\/(aa\d+)/i.exec(url)
  if (bangumi !== null) return { url, id: bangumi[1] }
  const query = /[?&]ac=(\d+)/.exec(url)
  if (query !== null) return { url, id: `ac${query[1]}` }
  return undefined
}

export const id = 'acfun'
export const label = 'AcFun'
export const homepage = 'https://www.acfun.cn'
export const referer = 'https://www.acfun.cn/'
export const captions = false

const adapter = buildUnsupportedAdapter({
  id,
  label,
  homepage,
  referer,
  hostPattern: '(^|\\.)acfun\\.cn$',
  parseId,
  limitation,
})

export const match = adapter.match
export const parse = adapter.parse
export const info = adapter.info
export const tracks = adapter.tracks
export const download = adapter.download
export const fetchPageHtml = adapter.fetchPageHtml
