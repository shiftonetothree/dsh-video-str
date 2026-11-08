// Live probe: find a Tencent Video with public captions and verify the full chain.
import { createHttpContext } from 'file:///F:/code/video-srt/lib/http.js'
import * as qq from 'file:///F:/code/video-srt/lib/sites/qq.js'

const http = createHttpContext({ cookie: () => undefined, timeoutMs: 20000, retries: 1, minIntervalMs: 250 })
const UA = qq.signingConstants.DESKTOP_UA
const pages = ['https://v.qq.com/', 'https://v.qq.com/channel/tv', 'https://v.qq.com/channel/movie', 'https://v.qq.com/channel/variety', 'https://v.qq.com/channel/doc']
const covers = new Set()
for (const page of pages) {
  try {
    const html = await (await fetch(page, { headers: { 'User-Agent': UA } })).text()
    for (const m of html.matchAll(/\/x\/cover\/([a-z0-9]+)\/([a-z0-9]{11})\.html/gi)) covers.add(m[0])
  } catch (e) {
    console.log('page fail', page, e.message)
  }
}
console.log('candidates:', covers.size)
let hits = 0
for (const cover of covers) {
  const ref = qq.parse(`https://v.qq.com${cover}`)
  if (ref === undefined) continue
  try {
    const info = await qq.info(ref, http)
    const t = await qq.tracks(ref, http, undefined, info)
    if (t.tracks.length > 0) {
      console.log(`HIT ${cover} "${info.title}" ->`, JSON.stringify(t.tracks))
      const doc = await qq.download(t.tracks[0], ref, http)
      console.log('   cues', doc.cues.length, 'first:', JSON.stringify(doc.cues[0]?.text), 'warnings', doc.warnings)
      hits += 1
      if (hits >= 3) break
    }
  } catch (e) {
    console.log(`  ${cover} ERR ${e.message.slice(0, 120)}`)
  }
}
console.log('hits:', hits)
