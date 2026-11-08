// Live audit: does each claimed site actually work, end to end?
//
// For every adapter this prints three verdicts, because "supported" has been
// doing too much work in the README:
//
//   INFO   — did info() return a real title, or only a site boilerplate / none?
//   TRACKS — did tracks() list any caption track?
//   DOWN   — if it listed one, did it actually download and parse?
//
// Discovery is deliberately loose: each site's homepage is scraped for one or two
// real content URLs, so the audit tests today's pages rather than ids frozen in
// this file. When discovery finds nothing the script says so instead of guessing.
//
//   node tools/audit-sites.mjs            # every site
//   node tools/audit-sites.mjs qq mgtv    # only the named ones
import { createHttpContext, DESKTOP_UA } from '../lib/http.js'
import * as bilibili from '../lib/sites/bilibili.js'
import * as qq from '../lib/sites/qq.js'
import * as mgtv from '../lib/sites/mgtv.js'
import * as youku from '../lib/sites/youku.js'
import * as douyin from '../lib/sites/douyin.js'
import * as ixigua from '../lib/sites/ixigua.js'
import * as kuaishou from '../lib/sites/kuaishou.js'
import * as weibo from '../lib/sites/weibo.js'
import * as acfun from '../lib/sites/acfun.js'

const http = createHttpContext({ cookie: () => undefined, timeoutMs: 15000, retries: 0, minIntervalMs: 250 })

/**
 * Fetch a page as plain text, never throwing.
 *
 * @param {string} url Page URL.
 * @param {string} [referer] Referer to send.
 * @returns {Promise<string>} Body, or an empty string.
 */
async function page(url, referer) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml', ...(referer ? { referer } : {}) },
      signal: AbortSignal.timeout(15000),
    })
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * Pull up to `limit` unique matches of one pattern out of a page.
 *
 * @param {string} url Page URL.
 * @param {RegExp} pattern Pattern with the URL in match 0.
 * @param {(path: string) => string} absolute Prefix a matched path.
 * @param {number} [limit] How many to keep.
 * @returns {Promise<string[]>} Candidate URLs.
 */
async function discover(url, pattern, absolute, limit = 2) {
  const html = await page(url)
  const found = new Set()
  for (const match of html.matchAll(pattern)) {
    found.add(absolute(match[0]))
    if (found.size >= limit) break
  }
  return [...found]
}

/** Per-site candidate discovery. */
const SITES = {
  bilibili: {
    label: '哔哩哔哩',
    adapter: bilibili,
    candidates: async () => [
      'https://www.bilibili.com/video/BV1MU411S7iJ',
      'https://www.bilibili.com/video/BV1GJ411x7h7',
    ],
  },
  qq: {
    label: '腾讯视频',
    adapter: qq,
    candidates: async () => {
      const out = []
      for (const channel of ['https://v.qq.com/channel/tv', 'https://v.qq.com/channel/movie', 'https://v.qq.com/channel/variety']) {
        out.push(...(await discover(channel, /\/x\/cover\/[a-z0-9]+\/[a-z0-9]{11}\.html/g, (m) => `https://v.qq.com${m}`, 3)))
        if (out.length >= 6) break
      }
      return out.slice(0, 6)
    },
  },
  mgtv: {
    label: '芒果TV',
    adapter: mgtv,
    candidates: async () => discover('https://www.mgtv.com/', /\/b\/\d+\.html/g, (m) => `https://www.mgtv.com${m}`, 3),
  },
  youku: {
    label: '优酷',
    adapter: youku,
    candidates: async () =>
      discover('https://www.youku.com/', /\/v_show\/id_[A-Za-z0-9=]+\.html/g, (m) => `https://v.youku.com${m}`, 2),
  },
  douyin: {
    label: '抖音',
    adapter: douyin,
    candidates: async () => discover('https://www.douyin.com/', /\/video\/\d{15,25}/g, (m) => `https://www.douyin.com${m}`, 2),
  },
  ixigua: {
    label: '西瓜视频',
    adapter: ixigua,
    candidates: async () => discover('https://www.ixigua.com/', /\/\d{19}/g, (m) => `https://www.ixigua.com${m}`, 2),
  },
  kuaishou: {
    label: '快手',
    adapter: kuaishou,
    candidates: async () =>
      discover('https://www.kuaishou.com/', /\/short-video\/[A-Za-z0-9_-]+/g, (m) => `https://www.kuaishou.com${m}`, 2),
  },
  weibo: {
    label: '微博视频',
    adapter: weibo,
    candidates: async () =>
      discover('https://weibo.com/tv', /\/tv\/show\/\d+:[A-Za-z0-9]+/g, (m) => `https://weibo.com${m}`, 2),
  },
  acfun: {
    label: 'AcFun',
    adapter: acfun,
    candidates: async () => discover('https://www.acfun.cn/', /\/v\/ac\d+/g, (m) => `https://www.acfun.cn${m}`, 2),
  },
}

/**
 * Audit one URL through one adapter.
 *
 * @param {string} siteId Adapter id.
 * @param {any} adapter Adapter module.
 * @param {string} url Candidate URL.
 * @returns {Promise<Record<string, unknown>>} Verdict.
 */
async function auditUrl(siteId, adapter, url) {
  const ref = adapter.parse(url)
  if (ref === undefined) return { url, verdict: 'PARSE-REJECTED' }
  const out = { url }

  try {
    const info = await adapter.info(ref, http)
    out.title = info.title
    out.duration = info.durationSeconds
    out.notes = info.notes
    out.info = info.title === '' || info.title === undefined ? 'EMPTY' : 'OK'
  } catch (error) {
    out.info = `THREW: ${error.message.slice(0, 110)}`
    return { ...out, verdict: 'INFO-FAILED' }
  }

  try {
    const listing = await adapter.tracks(ref, http, undefined, await adapter.info(ref, http))
    out.trackCount = listing.tracks.length
    out.help = listing.help
    out.trackNotes = listing.notes
    if (listing.tracks.length === 0) return out
  } catch (error) {
    out.tracks = `THREW: ${error.message.slice(0, 110)}`
    return out
  }

  try {
    const document = await adapter.download((await adapter.tracks(ref, http, undefined, await adapter.info(ref, http))).tracks[0], ref, http)
    out.download = document.cues.length > 0 ? `OK ${document.cues.length} cues` : 'EMPTY'
    out.firstCue = document.cues[0]?.text?.slice(0, 60)
    void siteId
  } catch (error) {
    out.download = `THREW: ${error.message.slice(0, 110)}`
  }
  return out
}

const wanted = process.argv.slice(2)
// `site=url` overrides discovery, for sites whose homepage is JS-rendered and
// therefore yields no scrapeable content links.
/** @type {Map<string, string[]>} */
const overrides = new Map()
const siteArgs = []
for (const arg of wanted) {
  const eq = arg.indexOf('=')
  if (eq > 0) {
    const site = arg.slice(0, eq)
    const list = overrides.get(site) ?? []
    list.push(arg.slice(eq + 1))
    overrides.set(site, list)
  } else {
    siteArgs.push(arg)
  }
}
const ids = [...new Set([...siteArgs, ...overrides.keys()])].filter((id) => SITES[id] !== undefined)

console.log(`审计开始：${ids.join(', ')}\n`)

/** @type {Array<Record<string, unknown>>} */
const report = []
for (const siteId of ids) {
  const site = SITES[siteId]
  if (site === undefined) {
    console.log(`!! 未知站点 ${siteId}`)
    continue
  }
  console.log(`===== ${site.label} (${siteId}) =====`)
  let candidates = overrides.get(siteId) ?? []
  if (candidates.length === 0) {
    try {
      candidates = await site.candidates()
    } catch (error) {
      console.log(`  发现候选失败: ${error.message}`)
    }
  }
  if (candidates.length === 0) {
    console.log('  没找到任何候选地址（首页抓不到内容链接）')
    report.push({ site: siteId, label: site.label, discovered: 0 })
    continue
  }
  console.log(`  候选 ${candidates.length} 个`)
  for (const url of candidates) {
    const verdict = await auditUrl(siteId, site.adapter, url)
    console.log(`  - ${url}`)
    console.log(`      info=${verdict.info}  title=${JSON.stringify(verdict.title ?? '')}  duration=${verdict.duration ?? 'undefined'}`)
    if (verdict.trackCount !== undefined) console.log(`      tracks=${verdict.trackCount}`)
    if (verdict.download !== undefined) console.log(`      download=${verdict.download}`)
    if (verdict.info === 'EMPTY' && Array.isArray(verdict.notes)) {
      console.log(`      note[0]=${String(verdict.notes[0]).slice(0, 100)}`)
    }
    report.push({ site: siteId, label: site.label, ...verdict })
  }
  console.log('')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('===== 汇总 =====')
const bySite = new Map()
for (const row of report) {
  const list = bySite.get(row.site) ?? []
  list.push(row)
  bySite.set(row.site, list)
}
for (const [site, rows] of bySite) {
  const label = rows[0].label
  const infoOk = rows.filter((r) => r.info === 'OK').length
  const trackRows = rows.filter((r) => typeof r.trackCount === 'number' && r.trackCount > 0)
  const dlOk = rows.filter((r) => typeof r.download === 'string' && r.download.startsWith('OK')).length
  const best = trackRows.length > 0 ? `字幕轨 ${Math.max(...trackRows.map((r) => r.trackCount))} 条` : '无字幕轨'
  console.log(
    `${String(label).padEnd(8)} 候选=${String(rows.length).padEnd(2)} 元信息OK=${infoOk}  ${best.padEnd(12)} 可下载=${dlOk}`,
  )
}
