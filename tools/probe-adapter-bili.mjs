// Live end-to-end probe for the bilibili adapter.
import { createHttpContext } from 'file:///F:/code/video-srt/lib/http.js'
import * as bili from 'file:///F:/code/video-srt/lib/sites/bilibili.js'

const http = createHttpContext({ cookie: () => process.env.DSH_VIDEO_SRT_BILIBILI_COOKIE, timeoutMs: 20000, retries: 1, minIntervalMs: 300 })

const targets = process.argv.slice(2)
if (targets.length === 0) targets.push('BV1GJ411x7h7', 'https://www.bilibili.com/video/BV1bK411W797?p=3', 'https://www.bilibili.com/bangumi/play/ep606591')

for (const target of targets) {
  const url = /^https?:/.test(target) ? target : `https://www.bilibili.com/video/${target}`
  console.log(`\n===== ${url}`)
  const ref = bili.parse(url)
  if (ref === undefined) { console.log('  parse failed'); continue }
  try {
    const info = await bili.info(ref, http)
    console.log('  info:', JSON.stringify({ id: info.id, title: info.title, owner: info.owner, dur: info.durationSeconds, parts: info.parts.length, container: info.container }))
    const result = await bili.tracks(ref, http, undefined, info)
    console.log('  tracks:', result.tracks.length, JSON.stringify(result.tracks))
    console.log('  notes:', JSON.stringify(result.notes))
    if (result.help) console.log('  help:', result.help.slice(0, 80) + '…')
    if (result.tracks[0]?.url !== undefined) {
      const doc = await bili.download(result.tracks[0], ref, http)
      console.log('  captions:', doc.cues.length, 'cues', doc.duration, 's; first:', JSON.stringify(doc.cues[0]?.text))
    }
  } catch (error) {
    console.log(`  ERROR ${error.name}: ${error.message}`)
    if (error.hint) console.log(`    hint: ${error.hint}`)
    if (error.notes) console.log(`    notes: ${JSON.stringify(error.notes)}`)
  }
}
