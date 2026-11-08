// Live probe: the whole B站 QR login loop, then a real caption fetch.
//
// This is the one path `npm test` cannot cover — the "confirmed" branch needs a
// human to actually scan the code — so run it by hand:
//
//   node tools/probe-login.mjs
//   node tools/probe-login.mjs https://www.bilibili.com/video/BV1GJ411x7h7
//
// It writes the QR to ./bilibili-login-qr.png, prints every poll transition, and
// finally re-reads the caption track list to prove the stored session is used.
import { writeFileSync } from 'node:fs'

import { createHttpContext } from '../lib/http.js'
import { pollQrLogin, startQrLogin } from '../lib/login.js'
import { qrPng } from '../lib/qr.js'
import { describeCookie, readSession, writeSession } from '../lib/session.js'
import * as bilibili from '../lib/sites/bilibili.js'

const target = process.argv[2] ?? 'https://www.bilibili.com/video/BV1GJ411x7h7'

/** The stored session, if this run or an earlier one left one behind. */
const preexisting = readSession('bilibili')
console.log('已有的 session:', preexisting === undefined ? '（无）' : describeCookie(preexisting.cookie))

// Anonymous transport for the challenge; then a cookie-aware one for captions.
const anonymous = createHttpContext({ cookie: () => undefined, timeoutMs: 15000, retries: 1, minIntervalMs: 200 })

console.log('\n[1/3] 申请二维码…')
const challenge = await startQrLogin(anonymous)
console.log('  qrKey :', challenge.key)
console.log('  qrUrl :', challenge.url)
writeFileSync('bilibili-login-qr.png', await qrPng(challenge.url, { scale: 8, margin: 4 }))
console.log('  二维码已写入 bilibili-login-qr.png —— 用 B 站手机客户端扫码并确认')

console.log('\n[2/3] 轮询（最多 180 秒）…')
let lastState = ''
let session
for (let attempt = 1; attempt <= 90; attempt += 1) {
  const result = await pollQrLogin(challenge.key, anonymous)
  if (result.state !== lastState) {
    console.log(`  ${new Date().toLocaleTimeString()} 状态 -> ${result.state}${result.message ? `（${result.message}）` : ''}`)
    lastState = result.state
  }
  if (result.state === 'confirmed') {
    if (result.cookie === undefined) {
      console.log('  扫码已确认，但没抓到 SESSDATA，停止')
      process.exit(1)
    }
    session = writeSession('bilibili', {
      cookie: result.cookie,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
      ...(result.mid === undefined ? {} : { mid: result.mid }),
    })
    console.log('  已保存:', describeCookie(session.cookie), '->', session.path)
    break
  }
  if (result.state === 'expired' || result.state === 'unknown') {
    console.log('  无法继续:', result.message)
    process.exit(1)
  }
  await new Promise((done) => setTimeout(done, 2000))
}
if (session === undefined) {
  console.log('  超时，二维码已失效')
  process.exit(1)
}

console.log('\n[3/3] 用刚保存的 session 读字幕轨…')
const authed = createHttpContext({
  cookie: (site) => (site === 'bilibili' ? session.cookie : undefined),
  timeoutMs: 20000,
  retries: 1,
  minIntervalMs: 300,
})
const ref = bilibili.parse(target)
if (ref === undefined) {
  console.log('  无法解析地址:', target)
  process.exit(1)
}
const info = await bilibili.info(ref, authed)
console.log('  视频:', info.title)
const listing = await bilibili.tracks(ref, authed, undefined, info)
console.log('  字幕轨:', listing.tracks.length)
for (const track of listing.tracks) {
  console.log(`    - ${track.label ?? track.lang ?? track.id} (${track.lang ?? '?'}) auto=${track.auto === true}`)
}
if (listing.tracks.length === 0) {
  console.log('  注意：0 条可能代表「这个视频本来就没字幕」，也可能代表登录态没生效。')
  console.log('  说明:', listing.notes.join(' | '))
  process.exit(listing.help === undefined ? 0 : 2)
}

const document = await bilibili.download(listing.tracks[0], ref, authed)
console.log(`  取到 ${document.cues.length} 条字幕，第一条：${document.cues[0]?.text ?? ''}`)
console.log('\n登录链路验证通过。')
