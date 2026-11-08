/**
 * Tests for the site adapters, their request signing, and their error mapping.
 *
 * Everything here is offline: the signing helpers are pure functions with
 * published test vectors, and the adapters' diagnostic paths are driven through
 * a fixture server. The live request chains are exercised separately by
 * `tools/probe-adapter-*.mjs`, because a unit test that needed the real network
 * would be a test that fails on a train.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHttpContext, cookieEnvName, mergeCookies, normalizeCookie, readCookie, toHttps } from '../lib/http.js'
import * as bilibili from '../lib/sites/bilibili.js'
import * as qq from '../lib/sites/qq.js'
import * as mgtv from '../lib/sites/mgtv.js'
import * as youku from '../lib/sites/youku.js'
import * as generic from '../lib/sites/generic.js'
import { readPageMeta } from '../lib/sites/base.js'
import { looksLikeCaptions } from '../lib/page-scan.js'
import { resolve, roster, supports } from '../lib/sites.js'

/** @type {import('node:http').Server} */
let server
/** @type {string} */
let origin

before(async () => {
  server = createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname
    if (route === '/b23') {
      res.writeHead(302, { location: 'https://www.bilibili.com/video/BV1GJ411x7h7' })
      res.end()
      return
    }
    if (route === '/short-offsite') {
      // A short link whose hop leaves the site entirely.
      res.writeHead(302, { location: 'https://example.com/not-a-video' })
      res.end()
      return
    }
    if (route === '/short-bad-target') {
      res.writeHead(302, { location: 'https://www.bilibili.com/ranking' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
})

after(async () => {
  await new Promise((resolve_) => server.close(resolve_))
})

/** A transport with no cookies and no retries, for fixture probes. */
const http = createHttpContext({ cookie: () => undefined, timeoutMs: 8000, retries: 0, minIntervalMs: 0 })

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

test('bilibili parses every URL shape it claims', () => {
  const cases = [
    ['https://www.bilibili.com/video/BV1GJ411x7h7', { bvid: 'BV1GJ411x7h7', page: 1, pgc: false }],
    ['https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333', { bvid: 'BV1GJ411x7h7' }],
    ['https://www.bilibili.com/video/BV1bK411W797?p=3', { bvid: 'BV1bK411W797', page: 3 }],
    ['https://m.bilibili.com/video/BV1GJ411x7h7', { bvid: 'BV1GJ411x7h7' }],
    ['https://www.bilibili.com/video/av80433022', { aid: 80433022 }],
    ['https://www.bilibili.com/video/av80433022?p=2', { aid: 80433022, page: 2 }],
    ['https://www.bilibili.com/bangumi/play/ep606591', { epId: 606591, pgc: true }],
    ['https://www.bilibili.com/bangumi/play/ss28747', { seasonId: 28747, pgc: true }],
    ['https://www.bilibili.com/bangumi/play/ep606591?from=search', { epId: 606591, pgc: true }],
    ['https://www.bilibili.com/cheese/play/ep12345', { epId: 12345, pgc: true }],
    ['https://www.bilibili.com/video/BV1GJ411x7h7?bvid=BV1GJ411x7h7&p=2', { bvid: 'BV1GJ411x7h7', page: 2 }],
  ]
  for (const [url, expected] of cases) {
    const ref = bilibili.parse(url)
    assert.ok(ref !== undefined, `parsed ${url}`)
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(ref[key], value, `${url} -> ${key}`)
    }
  }
})

test('bilibili recognizes a short link and defers its expansion', () => {
  const ref = bilibili.parse('https://b23.tv/abc123')
  assert.equal(ref.shortUrl, 'https://b23.tv/abc123')
  assert.equal(ref.bvid, undefined)
})

test('bilibili declines hosts it does not own', () => {
  assert.equal(bilibili.match('https://www.youtube.com/watch?v=x'), false)
  assert.equal(bilibili.parse('https://notbilibili.com/video/BV1GJ411x7h7'), undefined)
  // A lookalike host must not be claimed by a suffix check.
  assert.equal(bilibili.match('https://evilbilibili.com/video/BV1'), false)
  assert.equal(bilibili.match('https://bilibili.com.evil.test/x'), false)
})

test('Tencent Video parses cover, page and bare-id forms', () => {
  assert.deepEqual(
    { ...qq.parse('https://v.qq.com/x/cover/mzc002001bk7moh/z41023tinp7.html') },
    { site: 'qq', url: 'https://v.qq.com/x/cover/mzc002001bk7moh/z41023tinp7.html', cid: 'mzc002001bk7moh', vid: 'z41023tinp7', sourceUrl: 'https://v.qq.com/x/cover/mzc002001bk7moh/z41023tinp7.html' },
  )
  assert.equal(qq.parse('https://v.qq.com/x/page/q326831cny0.html').vid, 'q326831cny0')
  assert.equal(qq.parse('q326831cny0').vid, 'q326831cny0')
  assert.equal(qq.match('https://v.qq.com/x/cover/a/b.html'), true)
  assert.equal(qq.match('https://www.qq.com/'), false)
})

test('MangoTV parses show, play and bare-id forms', () => {
  const show = mgtv.parse('https://www.mgtv.com/b/336727/5484561.html')
  assert.equal(show.collectionId, '336727')
  assert.equal(show.videoId, '5484561')
  assert.equal(mgtv.parse('https://www.mgtv.com/play/15588271.html').videoId, '15588271')
  assert.equal(mgtv.parse('15588271').videoId, '15588271')
  assert.equal(mgtv.match('https://www.mgtv.com/b/1/2.html'), true)
  assert.equal(mgtv.match('https://mgtv.com.evil.test/b/1/2.html'), false)
})

test('Youku needs a video id and declines a bare channel page', () => {
  assert.equal(youku.parse('https://v.youku.com/v_show/id_XNTk1NTQwNzYwOA==.html').id, 'XNTk1NTQwNzYwOA==')
  assert.equal(youku.parse('https://www.youku.com/channel/webtv'), undefined)
})

test('the generic adapter takes any http URL and classifies it', () => {
  assert.equal(generic.parse('https://x.test/a.vtt').kind, 'caption-file')
  assert.equal(generic.parse('https://x.test/a.srt').kind, 'caption-file')
  assert.equal(generic.parse('https://x.test/a.ass').kind, 'caption-file')
  assert.equal(generic.parse('https://x.test/master.m3u8').kind, 'hls')
  assert.equal(generic.parse('https://x.test/manifest.mpd').kind, 'dash')
  assert.equal(generic.parse('https://x.test/captions.json').kind, 'json')
  assert.equal(generic.parse('https://x.test/watch/1').kind, 'page')
  assert.equal(generic.parse('ftp://x.test/a.vtt'), undefined)
  assert.equal(generic.match('not a url'), false)
  // A query string must not defeat extension detection.
  assert.equal(generic.parse('https://x.test/a.vtt?token=1').kind, 'caption-file')
})

test('adapter resolution prefers a site adapter over the generic fallback', () => {
  assert.equal(resolve('https://www.bilibili.com/video/BV1GJ411x7h7').adapter.id, 'bilibili')
  assert.equal(resolve('https://v.qq.com/x/cover/a/b.html').adapter.id, 'qq')
  assert.equal(resolve('https://www.mgtv.com/b/1/2.html').adapter.id, 'mgtv')
  assert.equal(resolve('https://v.youku.com/v_show/id_X1==.html').adapter.id, 'youku')
  assert.equal(resolve('https://example.com/anything').adapter.id, 'generic')
  assert.equal(resolve('nonsense'), undefined)
  assert.equal(supports('https://example.com/anything'), true)
  assert.equal(supports('nonsense'), false)
})

test('the roster marks which adapters really serve captions', () => {
  const byId = Object.fromEntries(roster().map((entry) => [entry.id, entry]))
  // Only two things were ever observed to hand back real caption text: bilibili
  // (with a session) and the generic fallback (a direct file / HLS / DASH URL).
  assert.equal(byId.bilibili.captions, true)
  assert.equal(byId.generic.captions, true)
  // These carry a working metadata path but produced zero usable caption tracks
  // across every real sample in the audit, so they must not claim captions.
  for (const id of ['qq', 'mgtv', 'youku', 'douyin', 'ixigua', 'kuaishou', 'weibo', 'acfun']) {
    assert.equal(byId[id].captions, false, `${id} must not claim caption support`)
    assert.ok(byId[id].limitation.length > 20, `${id} must explain the limitation`)
  }
  // iqiyi is deliberately absent: server-side it yields neither captions nor
  // metadata (a pure client-rendered shell), so claiming it as a site was a lie.
  // Its URLs now fall through to the generic scan, which reports honestly.
  assert.equal(byId.iqiyi, undefined)
})

// ---------------------------------------------------------------------------
// Bilibili signing
// ---------------------------------------------------------------------------

test('MD5 matches the published vectors', () => {
  assert.equal(bilibili.md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(bilibili.md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(bilibili.md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6')
  // The pure implementation must agree with node:crypto on multi-byte input.
  assert.equal(bilibili.md5Pure('中文测试'), bilibili.md5Hex('中文测试'))
  assert.equal(bilibili.md5Pure('a'.repeat(1000)), bilibili.md5Hex('a'.repeat(1000)))
})

test('the WBI mixin table is a permutation of 0..63', () => {
  assert.equal(bilibili.MIXIN_KEY_ENC_TAB.length, 64)
  assert.equal(new Set(bilibili.MIXIN_KEY_ENC_TAB).size, 64)
  for (const index of bilibili.MIXIN_KEY_ENC_TAB) assert.ok(index >= 0 && index < 64)
})

test('WBI signing reproduces the documented test vector', () => {
  const mixin = bilibili.mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  assert.equal(mixin, 'ea1db124af3c7062474693fa704f4ff8')
  const params = new URLSearchParams({ foo: '114', bar: '514', zab: '1919810' })
  bilibili.signWbi(params, mixin, 1702204169)
  assert.equal(params.get('wts'), '1702204169')
  assert.equal(params.get('w_rid'), '8f6f2b5b3d485fe1886cec6a0be8c5d4')
})

test('WBI value encoding matches the reference urlencode, not encodeURIComponent', () => {
  // `encodeURIComponent` leaves `!'()*` alone; the reference filters them out.
  assert.equal(bilibili.wbiEncode("a!'()*b"), 'ab')
  assert.equal(bilibili.wbiEncode('a b'), 'a%20b')
  assert.equal(bilibili.wbiEncode('中'), '%E4%B8%AD')
})

test('WBI keys are read from a nav payload, and absent when the payload is shaped differently', () => {
  const nav = { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } }
  assert.equal(bilibili.mixinKeyFromNav(nav), 'ea1db124af3c7062474693fa704f4ff8')
  assert.equal(bilibili.mixinKeyFromNav({ code: -101 }), undefined)
  assert.equal(bilibili.mixinKeyFromNav(null), undefined)
})

// ---------------------------------------------------------------------------
// Tencent signing
// ---------------------------------------------------------------------------

test('the Tencent cKey is reproducible and stable for fixed inputs', () => {
  const input = { vid: 'q326831cny0', pageUrl: 'https://v.qq.com/x/cover/abc/q326831cny0.html', userAgent: qq.signingConstants.DESKTOP_UA, timestamp: 1702204169, guid: 'abcdefghijklmnop' }
  const first = qq.buildCkey(input)
  const second = qq.buildCkey(input)
  assert.equal(first, second, 'signing is deterministic')
  assert.match(first, /^[0-9A-F]+$/, 'uppercase hex')
  assert.equal(first.length % 32, 0, 'whole AES blocks')
  // A different vid must change the signature, or the checksum is not wired in.
  assert.notEqual(first, qq.buildCkey({ ...input, vid: 'q326831cny1' }))
  // The timestamp participates too.
  assert.notEqual(first, qq.buildCkey({ ...input, timestamp: 1702204170 }))
})

test('the QZOutputJson envelope is parsed, including a trailing semicolon', () => {
  assert.deepEqual(qq.parseQzOutput('QZOutputJson={"s":"o","em":0};', 'test'), { s: 'o', em: 0 })
  assert.deepEqual(qq.parseQzOutput('prefix QZOutputJson={"a":1}', 'test'), { a: 1 })
  assert.throws(() => qq.parseQzOutput('<html>not json</html>', 'test'), /QZOutputJson/)
  assert.throws(() => qq.parseQzOutput('QZOutputJson={broken', 'test'), /无法解析/)
})

test('Tencent subtitle file entries are read from sfl.fi, and an empty container yields none', () => {
  const populated = { sfl: { cnt: 1, fi: [{ lang: 'zh', url: 'https://x.test/a.srt', captionType: 0 }] } }
  assert.equal(qq.subtitleFileEntries(populated).length, 1)
  assert.deepEqual(qq.subtitleFileEntries({ sfl: { cnt: 0 } }), [])
  assert.deepEqual(qq.subtitleFileEntries({}), [])
  // An entry without a URL is not a track.
  assert.deepEqual(qq.subtitleFileEntries({ sfl: { fi: [{ lang: 'zh' }] } }), [])
})

test('the Tencent vid is recoverable from page markup', () => {
  assert.equal(qq.vidFromHtml('<script>window.x={"vid":"z41023tinp7"}</script>'), 'z41023tinp7')
  assert.equal(qq.vidFromHtml('<meta property="og:url" content="https://v.qq.com/x/cover/abc/q326831cny0.html">'), 'q326831cny0')
  assert.equal(qq.vidFromHtml('<html><body>nothing</body></html>'), undefined)
})

// ---------------------------------------------------------------------------
// MangoTV signing
// ---------------------------------------------------------------------------

test('the MangoTV tk2 is base64url of the documented payload, reversed', () => {
  const token = mgtv.buildTk2(1702204169, '00000000-0000-4000-8000-000000000000')
  const decoded = Buffer.from([...token].reverse().join(''), 'base64url').toString('utf8')
  assert.equal(decoded, 'did=00000000-0000-4000-8000-000000000000|pno=1030|ver=0.3.0301|clit=1702204169')
  // The reversal is the whole obfuscation, so a generated token must not be its
  // own reverse unless it is a palindrome (it never is in practice).
  const generated = mgtv.buildTk2()
  assert.notEqual(generated, [...generated].reverse().join(''))
  assert.ok(generated.length > 40)
})

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

test('cookie headers are normalized, merged and read', () => {
  assert.equal(normalizeCookie(undefined), undefined)
  assert.equal(normalizeCookie('   '), undefined)
  assert.equal(normalizeCookie('a=1'), 'a=1')
  assert.equal(normalizeCookie([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2')
  assert.equal(normalizeCookie([{ name: 'a', value: '1' }, { nope: true }]), 'a=1')
  assert.equal(mergeCookies(undefined, 'a=1'), 'a=1')
  assert.equal(mergeCookies('a=1', undefined), 'a=1')
  // The later header wins per name, with the rest preserved.
  assert.equal(mergeCookies('a=1; b=2', 'b=9; c=3'), 'a=1; b=9; c=3')
  assert.equal(readCookie('SESSDATA=abc; bili_jct=xyz', 'SESSDATA'), 'abc')
  assert.equal(readCookie('SESSDATA=abc', 'nope'), undefined)
  assert.equal(readCookie(undefined, 'SESSDATA'), undefined)
})

test('a bare SESSDATA pasted into the cookie field acquires its name', () => {
  // Users paste the value, not the pair; the site needs the pair. The plugin
  // does not rewrite it (that would be guessing), but it must at least pass the
  // text through untouched so a full header keeps working.
  assert.equal(normalizeCookie('SESSDATA=abc'), 'SESSDATA=abc')
})

test('cookie environment variable names are derived per site', () => {
  assert.equal(cookieEnvName('bilibili'), 'DSH_VIDEO_SRT_BILIBILI_COOKIE')
  assert.equal(cookieEnvName('mgtv'), 'DSH_VIDEO_SRT_MGTV_COOKIE')
  assert.equal(cookieEnvName('some-site'), 'DSH_VIDEO_SRT_SOME_SITE_COOKIE')
})

test('protocol-relative and schemeless caption URLs are upgraded', () => {
  assert.equal(toHttps('//i0.hdslb.com/x.json'), 'https://i0.hdslb.com/x.json')
  assert.equal(toHttps('https://x.test/a.vtt'), 'https://x.test/a.vtt')
  assert.equal(toHttps('http://x.test/a.vtt'), 'http://x.test/a.vtt')
  assert.equal(toHttps('x.test/a.vtt'), 'https://x.test/a.vtt')
  // A relative path has no host to upgrade and must survive unchanged.
  assert.equal(toHttps('/media/a.vtt'), '/media/a.vtt')
  assert.equal(toHttps(''), '')
})

// ---------------------------------------------------------------------------
// Adapter diagnostics over the fixture server
// ---------------------------------------------------------------------------

test('a refused page becomes an empty page, not a thrown transport error', async () => {
  const html = await bilibili.fetchPageHtml({ url: `${origin}/does-not-exist` }, http)
  assert.equal(html, '')
})

test('a short link that lands somewhere unrecognizable fails with an explained error', async () => {
  const html = await bilibili.fetchPageHtml({ url: `${origin}/nope` }, http)
  assert.equal(html, '', 'a refused page reads as empty rather than throwing')
  // A hop that leaves the site must not silently become a bilibili identity.
  await assert.rejects(() => bilibili.expandShortLink(`${origin}/short-bad-target`, http), /不是可识别的 B 站视频地址/)
  // A transport failure surfaces as the HTTP error it is.
  await assert.rejects(() => bilibili.expandShortLink(`${origin}/nope`, http), /404/)
})

// ---------------------------------------------------------------------------
// Page metadata and client-rendered shells
// ---------------------------------------------------------------------------
//
// A client-rendered page (爱奇艺, 抖音, 西瓜 …) answers 200 with a full-size
// document whose only title is the *site's* boilerplate and whose markup does not
// contain the video id at all. Reporting that title as the video's is worse than
// reporting nothing: it reads as a successful read of the wrong video.

/** A page carrying real Open Graph metadata. */
const PAGE_WITH_OG =
  '<html><head><title>站点名</title>' +
  '<meta property="og:title" content="真正的视频标题">' +
  '<meta property="og:image" content="https://cdn.example.com/cover.jpg">' +
  '<meta property="og:video:duration" content="754">' +
  '</head><body></body></html>'

/** A client-rendered shell: boilerplate title, no Open Graph, no video id. */
const PAGE_SHELL = '<html><head><title>爱奇艺-在线视频网站-海量正版高清视频在线观看</title></head><body><div id="app"></div></body></html>'

test('Open Graph metadata wins and supplies the duration', () => {
  const meta = readPageMeta(PAGE_WITH_OG, undefined, 'abcdef123')
  assert.equal(meta.title, '真正的视频标题')
  assert.equal(meta.durationSeconds, 754)
  assert.equal(meta.cover, 'https://cdn.example.com/cover.jpg')
  assert.equal(meta.shell, undefined)
})

test('a shell page reports no title instead of the site boilerplate', () => {
  const meta = readPageMeta(PAGE_SHELL, undefined, '1lg5qzzbjq8')
  assert.equal(meta.title, '')
  assert.equal(meta.durationSeconds, undefined)
  assert.equal(meta.shell, true)
})

test('a page that mentions the video id is not a shell', () => {
  // The id appearing anywhere in the markup is evidence the page really is
  // about that video, so the <title> fallback is trustworthy even without OG.
  const html = PAGE_SHELL.replace('<div id="app"></div>', '<div data-vid="1lg5qzzbjq8"></div>')
  const meta = readPageMeta(html, undefined, '1lg5qzzbjq8')
  assert.equal(meta.shell, undefined)
  assert.notEqual(meta.title, '')
})

test('without a video id the shell heuristic never fires', () => {
  // Callers that have no id (the generic fallback) keep the old behaviour.
  const meta = readPageMeta(PAGE_SHELL)
  assert.equal(meta.shell, undefined)
  assert.match(meta.title, /爱奇艺/)
})

// ---------------------------------------------------------------------------
// Caption-vs-HTML discrimination
// ---------------------------------------------------------------------------
//
// The probe that decides "is this body a caption file?" used to match a bare
// `-->`. HTML comments end with `-->`, so a ordinary web page passed, and a
// Youku page produced a "subtitle track" whose only cue was `html { min-width:
// 1239px;`. These cases pin the fix.

test('an HTML page is never mistaken for captions, even with a comment', () => {
  const page =
    '<!doctype html><html><head><style>html { min-width: 1239px; }</style></head>' +
    '<body><!-- navigation start --><div id="app"></div></body></html>'
  assert.equal(looksLikeCaptions(page, 'text/html; charset=utf-8'), false)
  assert.equal(looksLikeCaptions(page, ''), false, 'the doctype alone disqualifies it')
})

test('a fragment of HTML without a doctype is still not captions', () => {
  assert.equal(looksLikeCaptions('<html><body><!-- x --></body></html>', ''), false)
  assert.equal(looksLikeCaptions('<script>var a = 1 --> 2</script>', ''), false)
})

test('real caption bodies are still recognized', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n第一句\n\n00:00:04.000 --> 00:00:06.000\n第二句\n'
  assert.equal(looksLikeCaptions(vtt, 'text/vtt'), true)
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,000 --> 00:00:06,000\n第二句\n'
  assert.equal(looksLikeCaptions(srt, ''), true, 'SRT without a content type must still pass')
  const json = '{"body":[{"from":1,"to":2,"content":"x"},{"from":3,"to":4,"content":"y"}]}'
  assert.equal(looksLikeCaptions(json, 'application/json'), true)
  const ass = '[Script Info]\nTitle: x\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,你好\n'
  assert.equal(looksLikeCaptions(ass, ''), true)
})

test('ordinary page text and navigation JSON are not captions', () => {
  assert.equal(looksLikeCaptions('{"pageTabs":[{"title":"视频","url":"detail"}]}', 'application/json'), false)
  assert.equal(looksLikeCaptions('Just some prose about the video, no timings at all.', 'text/plain'), false)
})
