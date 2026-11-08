// Live probe: Tencent Video ckey signing + getvinfo subtitle list.
import { createHttpContext } from 'file:///F:/code/video-srt/lib/http.js'
import * as qq from 'file:///F:/code/video-srt/lib/sites/qq.js'
import { parseSubtitles } from 'file:///F:/code/video-srt/lib/subtitle.js'

const http = createHttpContext({ cookie: () => undefined, timeoutMs: 20000, retries: 1, minIntervalMs: 300 })

// 1. Discover a cover URL from the Tencent Video homepage.
const home = await (await fetch('https://v.qq.com/', { headers: { 'User-Agent': qq.signingConstants.DESKTOP_UA } })).text()
const covers = [...new Set([...home.matchAll(/\/x\/cover\/([a-z0-9]+)\/([a-z0-9]{11})\.html/gi)].map((m) => m[0]))]
console.log('covers found:', covers.length, covers.slice(0, 5))

const target = process.argv[2] ?? (covers[0] === undefined ? undefined : `https://v.qq.com${covers[0]}`)
if (target === undefined) {
  console.log('no target')
  process.exit(0)
}
console.log('target:', target)
const ref = qq.parse(target)
console.log('ref:', ref)
if (ref === undefined) process.exit(0)

try {
  const info = await qq.info(ref, http)
  console.log('info:', JSON.stringify({ id: info.id, title: info.title, owner: info.owner, dur: info.durationSeconds }))
  const t = await qq.tracks(ref, http, undefined, info)
  console.log('tracks:', t.tracks.length, JSON.stringify(t.tracks))
  console.log('notes:', JSON.stringify(t.notes))
  if (t.tracks[0]?.url) {
    const res = await fetch(t.tracks[0].url, { headers: { 'User-Agent': qq.signingConstants.DESKTOP_UA, Referer: 'https://v.qq.com/' } })
    const body = await res.text()
    console.log('caption fetch status', res.status, 'len', body.length, JSON.stringify(body.slice(0, 200)))
    const doc = parseSubtitles(body, t.tracks[0].format)
    console.log('cues', doc.cues.length, doc.cues.slice(0, 3).map((c) => c.text))
  }
} catch (e) {
  console.log(`ERROR ${e.name}: ${e.message}`)
  if (e.hint) console.log('hint:', e.hint)
}
