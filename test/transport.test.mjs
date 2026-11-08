/**
 * End-to-end tests over a real local HTTP server.
 *
 * These drive the actual transport, the actual scanners, and the actual tool
 * bodies — only the video site is fake. That is the point: the parts most likely
 * to break are the ones between "here is an HTML page" and "here are the cues",
 * and a stubbed `fetch` would skip exactly those.
 *
 * Site-specific behaviour that needs the live network (bilibili's WBI handshake,
 * a signed Tencent request) is covered by `tools/probe-*.mjs` and by the unit
 * tests on the signing helpers, not here.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, Config } from '../index.js'
import { harness } from './harness.mjs'

/** The VTT body served as a subtitle rendition and as a direct file. */
const VTT = ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', '第一句字幕', '', '00:00:04.000 --> 00:00:06.000', '第二句字幕', ''].join('\n')

/** A caption body in bilibili's JSON shape, used as a direct resource. */
const BILI_JSON = JSON.stringify({
  font_size: 0.4,
  body: [
    { from: 0.5, to: 2, location: 2, content: '开场白' },
    { from: 2, to: 4.5, location: 2, content: '正文第一段' },
    { from: 4.5, to: 7, location: 2, content: '这里提到了关键词：苹果' },
  ],
})

/** An SRT file, used to test format detection over HTTP. */
const SRT = '1\n00:00:00,500 --> 00:00:02,000\nSRT 第一句\n\n2\n00:00:03,000 --> 00:00:04,000\nSRT 第二句\n'

/** The master playlist exposing one subtitle rendition. */
const HLS = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh-CN",DEFAULT=YES,URI="/media/zh.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES="subs"', '/media/video.m3u8', ''].join('\n')

/** The subtitle rendition playlist whose segments are WebVTT. */
const HLS_SUB = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:10.0,', '/media/seg1.vtt', '#EXTINF:10.0,', '/media/seg2.vtt', ''].join('\n')

/** @type {import('node:http').Server} */
let server
/** @type {string} */
let origin

/** A page whose state block names a caption file plus a decoy JSON. */
const PAGE_GOOD = `<!doctype html><html><head><title>示例视频 - 某站</title>
<meta property="og:title" content="示例视频 标题" />
<meta property="og:description" content="这是描述" />
<meta property="og:image" content="/cover.jpg" />
</head><body>
<video controls><track kind="subtitles" src="/media/zh.vtt" srclang="zh-CN" label="中文" default></video>
<script>window.__INITIAL_DATA__ = {"video":{"playInfo":{"subtitleList":[{"url":"/media/zh.vtt","lang":"zh-CN","name":"中文"}],"decoy":"/api/user.json"}}};</script>
<script type="application/json">{"captions":[{"url":"/media/en.vtt","lang":"en","label":"English"}]}</script>
</body></html>`

/** A page with no captions anywhere. */
const PAGE_EMPTY = '<!doctype html><html><head><title>没有字幕的视频</title></head><body><video src="/media/video.mp4"></video></body></html>'

/** A page whose only caption-looking URL is a decoy that is not captions. */
const PAGE_DECOY = `<!doctype html><html><head><title>诱饵页</title></head><body>
<script>window.__INITIAL_DATA__ = {"player":{"subtitles":[{"url":"/api/not-captions.json","lang":"zh"}]}};</script>
</body></html>`

/**
 * Start the fixture server.
 *
 * @returns {Promise<void>} Resolves once the server is listening.
 */
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    switch (route) {
      case '/media/zh.vtt':
        return send(200, 'text/vtt; charset=utf-8', VTT)
      case '/media/en.vtt':
        return send(200, 'text/vtt; charset=utf-8', VTT.replace(/第一句字幕/, 'first line').replace(/第二句字幕/, 'second line'))
      case '/media/captions.srt':
        return send(200, 'application/x-subrip', SRT)
      case '/media/bili.json':
        return send(200, 'application/json', BILI_JSON)
      case '/media/master.m3u8':
        return send(200, 'application/vnd.apple.mpegurl', HLS)
      case '/media/zh.m3u8':
        return send(200, 'application/vnd.apple.mpegurl', HLS_SUB)
      case '/media/seg1.vtt':
        return send(200, 'text/vtt', ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', '分片一', ''].join('\n'))
      case '/media/seg2.vtt':
        return send(200, 'text/vtt', ['WEBVTT', '', '00:00:11.000 --> 00:00:13.000', '分片二', ''].join('\n'))
      case '/api/not-captions.json':
        return send(200, 'application/json', JSON.stringify({ user: { id: 1, name: 'not captions' }, items: [1, 2, 3] }))
      case '/page/good':
        return send(200, 'text/html; charset=utf-8', PAGE_GOOD)
      case '/page/empty':
        return send(200, 'text/html; charset=utf-8', PAGE_EMPTY)
      case '/page/decoy':
        return send(200, 'text/html; charset=utf-8', PAGE_DECOY)
      case '/page/refused':
        return send(403, 'text/html', '<html><body>forbidden</body></html>')
      default:
        return send(404, 'text/plain', 'not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
})

/** Stop the fixture server. */
after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

/**
 * Mount the plugin against a fixture-friendly config.
 *
 * @param {Record<string, unknown>} [overrides] Config overrides.
 * @returns {ReturnType<typeof harness>} Harness.
 */
function mount(overrides = {}) {
  const h = harness()
  apply(h.ctx, Config({ requestRetries: 0, minRequestIntervalMs: 0, ...overrides }))
  return h
}

/**
 * Run one tool.
 *
 * @param {ReturnType<typeof harness>} h Harness.
 * @param {string} name Tool name.
 * @param {Record<string, unknown>} args Tool arguments.
 * @returns {Promise<any>} The canonical value.
 */
async function run(h, name, args) {
  return await h.tool(name).execute(args, { signal: AbortSignal.timeout(10_000) })
}

test('a direct .vtt URL is fetched and parsed through the generic adapter', async () => {
  const h = mount()
  const value = await run(h, 'video_subtitle_get', { url: `${origin}/media/zh.vtt` })
  assert.equal(value.ok, true)
  assert.equal(value.subtitles.cueCount, 2)
  assert.equal(value.track.format, 'vtt')
  assert.equal(value.preview[0].text, '第一句字幕')
  assert.match(value.video.title, /zh/)
  assert.ok(value.cacheKey.startsWith('generic:'))
})

test('a direct .srt URL is detected from its body and content type', async () => {
  const h = mount()
  const value = await run(h, 'video_subtitle_get', { url: `${origin}/media/captions.srt` })
  assert.equal(value.subtitles.cueCount, 2)
  assert.equal(value.preview[0].text, 'SRT 第一句')
})

test('a direct bilibili-shaped JSON caption body parses', async () => {
  const h = mount()
  const value = await run(h, 'video_subtitle_get', { url: `${origin}/media/bili.json` })
  assert.equal(value.track.format, 'bilibili')
  assert.equal(value.subtitles.cueCount, 3)
  assert.equal(value.preview[2].at, '0:04')
})

test('an HTML page is scanned and its caption candidates are verified', async () => {
  const h = mount()
  const info = await run(h, 'video_subtitle_info', { url: `${origin}/page/good` })
  assert.equal(info.site.id, 'generic')
  assert.equal(info.video.title, '示例视频 标题')
  assert.equal(info.video.description, '这是描述')
  assert.ok(info.tracks.length >= 2, `expected the track element and the state entry, got ${info.tracks.length}`)
  const langs = info.tracks.map((track) => track.lang)
  assert.ok(langs.includes('zh-CN'))
  assert.ok(langs.includes('en'))
  assert.ok(
    info.tracks.every((track) => track.note === undefined || !track.note.includes('排除')),
    'no candidate should have been rejected on this page',
  )

  const value = await run(h, 'video_subtitle_get', { url: `${origin}/page/good` })
  assert.equal(value.ok, true)
  assert.ok(value.subtitles.cueCount >= 2)
  // The Chinese track is preferred over the English one.
  assert.equal(value.track.lang, 'zh-CN')
})

test('a decoy JSON next to the player is rejected, not offered as a track', async () => {
  const h = mount()
  const info = await run(h, 'video_subtitle_info', { url: `${origin}/page/decoy` })
  assert.equal(info.tracks.length, 0)
  assert.ok(
    info.notes.some((note) => note.includes('排除')),
    `expected a rejection note, got ${JSON.stringify(info.notes)}`,
  )
  await assert.rejects(() => run(h, 'video_subtitle_get', { url: `${origin}/page/decoy` }), /没有取到可用的字幕/)
})

test('a page without captions reports that plainly', async () => {
  const h = mount()
  const info = await run(h, 'video_subtitle_info', { url: `${origin}/page/empty` })
  assert.equal(info.tracks.length, 0)
  assert.match(info.video.title, /没有字幕/)
  await assert.rejects(() => run(h, 'video_subtitle_get', { url: `${origin}/page/empty` }), /没有取到可用的字幕/)
})

test('a refused page yields an explained empty result instead of a transport error', async () => {
  const h = mount()
  const info = await run(h, 'video_subtitle_info', { url: `${origin}/page/refused` })
  assert.equal(info.tracks.length, 0)
  assert.ok(info.notes.some((note) => note.includes('页面为空') || note.includes('拒绝')))
})

test('an HLS master playlist exposes its subtitle rendition and the segments concatenate', async () => {
  const h = mount()
  const info = await run(h, 'video_subtitle_info', { url: `${origin}/media/master.m3u8` })
  assert.equal(info.tracks.length, 1)
  assert.equal(info.tracks[0].lang, 'zh-CN')
  assert.equal(info.tracks[0].format, 'hls-vtt')

  const value = await run(h, 'video_subtitle_get', { url: `${origin}/media/master.m3u8` })
  assert.equal(value.subtitles.cueCount, 2, 'both segments contributed a cue')
  assert.deepEqual(
    value.preview.map((line) => line.text),
    ['分片一', '分片二'],
  )
})

test('a track selector picks a specific language', async () => {
  const h = mount()
  const zh = await run(h, 'video_subtitle_get', { url: `${origin}/page/good`, track: 'zh-CN' })
  assert.equal(zh.track.lang, 'zh-CN')
  assert.equal(zh.preview[0].text, '第一句字幕')
  const en = await run(h, 'video_subtitle_get', { url: `${origin}/page/good`, track: 'en' })
  assert.equal(en.track.lang, 'en')
  assert.equal(en.preview[0].text, 'first line')
})

test('read windows a cached document by page, by time, and by cue index', async () => {
  const h = mount()
  const got = await run(h, 'video_subtitle_get', { url: `${origin}/media/bili.json` })
  const key = got.cacheKey

  const page1 = await run(h, 'video_subtitle_read', { cacheKey: key, page: 1, pageSize: 2 })
  assert.equal(page1.returned, 2)
  assert.equal(page1.window.pageCount, 2)
  assert.equal(page1.lines[0].text, '开场白')

  const page2 = await run(h, 'video_subtitle_read', { cacheKey: key, page: 2, pageSize: 2 })
  assert.equal(page2.returned, 1)
  assert.equal(page2.lines[0].text, '这里提到了关键词：苹果')

  const timed = await run(h, 'video_subtitle_read', { cacheKey: key, startSeconds: 2 })
  assert.deepEqual(
    timed.lines.map((line) => line.text),
    ['正文第一段', '这里提到了关键词：苹果'],
  )

  const byIndex = await run(h, 'video_subtitle_read', { cacheKey: key, fromCue: 3, toCue: 3 })
  assert.equal(byIndex.returned, 1)
  assert.equal(byIndex.lines[0].index, 3)
})

test('search finds a keyword with context and reports timestamps', async () => {
  const h = mount()
  const got = await run(h, 'video_subtitle_get', { url: `${origin}/media/bili.json`, previewCues: 0 })
  const hits = await run(h, 'video_subtitle_search', { cacheKey: got.cacheKey, query: '苹果' })
  assert.equal(hits.hitCount, 1)
  assert.equal(hits.hits[0].at, '0:04')
  assert.match(hits.hits[0].context, /> \[0:04\] 这里提到了关键词：苹果/)
})

test('text output supports truncation reporting and paragraph merging', async () => {
  const h = mount()
  const got = await run(h, 'video_subtitle_get', { url: `${origin}/media/bili.json` })
  const plain = await run(h, 'video_subtitle_text', { cacheKey: got.cacheKey, timestamps: true })
  assert.match(plain.text, /^\[0:00\] 开场白/)
  assert.equal(plain.truncated, false)

  const merged = await run(h, 'video_subtitle_text', { cacheKey: got.cacheKey, paragraph: true })
  assert.equal(merged.text, '开场白正文第一段这里提到了关键词：苹果')

  const tiny = await run(h, 'video_subtitle_text', { cacheKey: got.cacheKey, maxChars: 500 })
  assert.equal(tiny.truncated, false, 'the body fits inside the smallest allowed ceiling')
})

test('export writes an SRT file whose text parses back', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-srt-export-'))
  try {
    const h = mount()
    const got = await run(h, 'video_subtitle_get', { url: `${origin}/media/zh.vtt` })
    const target = path.join(directory, 'out.srt')
    const written = await run(h, 'video_subtitle_export', { cacheKey: got.cacheKey, format: 'srt', path: target, bom: true })
    assert.equal(written.cueCount, 2)
    assert.equal(written.format, 'srt')
    const body = await readFile(target, 'utf8')
    assert.ok(body.startsWith('\ufeff'), 'the BOM was requested and written')
    assert.match(body, /00:00:01,000 --> 00:00:03,000/)
    assert.match(body, /第一句字幕/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('export refuses to clobber an existing file when overwrite is false', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-srt-export-'))
  try {
    const h = mount()
    const got = await run(h, 'video_subtitle_get', { url: `${origin}/media/zh.vtt` })
    const target = path.join(directory, 'exists.srt')
    await run(h, 'video_subtitle_export', { cacheKey: got.cacheKey, path: target })
    await assert.rejects(() => run(h, 'video_subtitle_export', { cacheKey: got.cacheKey, path: target, overwrite: false }), /已存在/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('parse accepts pasted text, a downloaded URL, and reports garbage honestly', async () => {
  const h = mount()
  const inline = await run(h, 'video_subtitle_parse', { text: SRT })
  assert.equal(inline.cueCount, 2)
  assert.equal(inline.origin, 'inline text')

  const downloaded = await run(h, 'video_subtitle_parse', { url: `${origin}/media/zh.vtt` })
  assert.equal(downloaded.cueCount, 2)
  assert.match(downloaded.origin, /downloaded/)

  const garbage = await run(h, 'video_subtitle_parse', { text: 'this is prose, not captions' })
  assert.equal(garbage.cueCount, 0)
  assert.equal(garbage.format, 'srt')

  await assert.rejects(() => run(h, 'video_subtitle_parse', {}), /text、path 或 url/)
})

test('a rejected request surfaces the HTTP status, and retries are bounded', async () => {
  const h = mount()
  await assert.rejects(() => run(h, 'video_subtitle_get', { url: `${origin}/does-not-exist.vtt` }), /404/)
})

test('the session cache short-circuits a second fetch and force overrides it', async () => {
  const h = mount()
  const first = await run(h, 'video_subtitle_get', { url: `${origin}/media/zh.vtt` })
  const second = await run(h, 'video_subtitle_get', { url: `${origin}/media/zh.vtt` })
  assert.equal(first.cacheKey, second.cacheKey)
  const forced = await run(h, 'video_subtitle_get', { url: `${origin}/media/zh.vtt`, force: true })
  assert.equal(forced.cacheKey, first.cacheKey, 'the key is stable even on a forced refetch')
})
