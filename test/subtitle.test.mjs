/**
 * Tests for the subtitle format layer.
 *
 * Every parser is fed the awkward shape it is most likely to meet in the wild,
 * because that is where a caption reader actually breaks: a rolling caption
 * whose cue ends where it starts, an ASS line whose text contains commas, a
 * bilingual bilibili cue containing a newline, a WebVTT cue with markup, a
 * protocol-relative caption URL.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeEntities,
  detectFormat,
  finalizeDocument,
  formatClock,
  formatTimecode,
  makeCue,
  measureText,
  normalizeCueText,
  parseAss,
  parseLrc,
  parseSubtitles,
  parseTimecode,
  parseVtt,
  searchCues,
  selectCues,
  serialize,
  stripCueMarkup,
  toSrt,
  toText,
  toVtt,
} from '../lib/subtitle.js'

test('parseTimecode accepts every timestamp shape the sites emit', () => {
  assert.equal(parseTimecode('00:00:01,500'), 1.5)
  assert.equal(parseTimecode('00:00:01.500'), 1.5)
  assert.equal(parseTimecode('01:02:03.250'), 3723.25)
  assert.equal(parseTimecode('02:03.500'), 123.5)
  assert.equal(parseTimecode('12.5'), 12.5)
  assert.equal(parseTimecode(2.25), 2.25)
  // ASS timestamps are centiseconds.
  assert.equal(parseTimecode('0:00:01.50', 100), 1.5)
  assert.ok(Number.isNaN(parseTimecode('not a time')))
  assert.ok(Number.isNaN(parseTimecode('')))
})

test('formatTimecode and formatClock round-trip usefully', () => {
  assert.equal(formatTimecode(0, ','), '00:00:00,000')
  assert.equal(formatTimecode(3723.25, ','), '01:02:03,250')
  assert.equal(formatTimecode(1.5, '.'), '00:00:01.500')
  // A negative or non-finite input must not produce a broken timestamp.
  assert.equal(formatTimecode(-5, ','), '00:00:00,000')
  assert.equal(formatTimecode(Number.NaN, ','), '00:00:00,000')
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(65), '1:05')
  assert.equal(formatClock(3725), '1:02:05')
})

test('decodeEntities handles numeric, hex, double-encoded and named entities', () => {
  assert.equal(decodeEntities('&amp;'), '&')
  assert.equal(decodeEntities('&lt;b&gt;'), '<b>')
  assert.equal(decodeEntities('&#39;'), "'")
  assert.equal(decodeEntities('&#x27;'), "'")
  assert.equal(decodeEntities('&nbsp;x'), '\u00a0x')
  // Double-encoded, which real payloads do produce.
  assert.equal(decodeEntities('&amp;#39;'), "'")
  assert.equal(decodeEntities('no entities here'), 'no entities here')
  // An unknown entity survives rather than becoming a replacement character.
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;')
})

test('stripCueMarkup removes markup and keeps the words', () => {
  assert.equal(stripCueMarkup('<v Roger>Hello</v>'), 'Hello')
  assert.equal(stripCueMarkup('<00:00:01.000>Timed'), 'Timed')
  assert.equal(stripCueMarkup('{\\an8}Top line'), 'Top line')
  assert.equal(stripCueMarkup('line\\Nsecond'), 'line\nsecond')
  assert.equal(stripCueMarkup('a\\hb'), 'a b')
  // An ASS drawing command carries coordinates, not text.
  assert.equal(stripCueMarkup('{\\p1}m 0 0 l 100 0{\\p0}real'), 'real')
})

test('parseSrt repairs a cue whose end is not after its start', () => {
  const srt = ['1', '00:00:01,000 --> 00:00:01,000', '零长度', '', '2', '00:00:05,000 --> 00:00:06,000', '下一句', ''].join('\n')
  const document = parseSubtitles(srt, 'srt')
  assert.equal(document.cues.length, 2)
  assert.ok(document.cues[0].end > document.cues[0].start, 'a zero-length cue is extended, not dropped')
})

test('parseSrt keeps multiline cue text and drops blank noise', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n第一行\n第二行\n\n2\n00:00:04,000 --> 00:00:05,000\n下一句\n'
  const document = parseSubtitles(srt, 'srt')
  assert.equal(document.cues[0].text, '第一行\n第二行')
  assert.deepEqual(document.cues[0].lines, ['第一行', '第二行'])
})

test('parseVtt handles a header, NOTE blocks, cue ids and settings', () => {
  const vtt = [
    'WEBVTT - some title',
    'Kind: captions',
    '',
    'NOTE this is a comment',
    'spanning two lines',
    '',
    'STYLE',
    '::cue { color: yellow }',
    '',
    'intro',
    '00:00:01.000 --> 00:00:03.000 align:start position:10%',
    '<v Speaker>Hello there</v>',
    '',
    '00:03.000 --> 00:05.000',
    'second',
    '',
  ].join('\n')
  const { cues, warnings } = parseVtt(vtt)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].text, 'Hello there')
  assert.equal(cues[1].start, 3)
  assert.deepEqual(warnings, [])
})

test('parseVtt reports a missing header rather than throwing', () => {
  const { cues, warnings } = parseVtt('00:00:01.000 --> 00:00:02.000\nno header\n')
  assert.equal(cues.length, 1)
  assert.ok(warnings.some((entry) => entry.includes('WEBVTT header')))
})

test('parseAss keeps text that contains commas', () => {
  const ass = [
    '[Script Info]',
    'Title: demo',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}你好, 世界, 再见',
    'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,plain',
    '',
  ].join('\n')
  const document = parseSubtitles(ass, 'ass')
  assert.equal(document.cues.length, 2)
  assert.equal(document.cues[0].text, '你好, 世界, 再见')
  assert.equal(document.cues[0].start, 1)
  assert.equal(document.cues[0].end, 3.5)
})

test('parseAss tolerates a line with too few fields', () => {
  const ass = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00\n'
  const { cues, warnings } = parseAss(ass)
  assert.equal(cues.length, 0)
  assert.ok(warnings.length > 0)
})

test('parseLrc distributes multiple timestamps on one line', () => {
  const lrc = '[ar:Artist]\n[00:01.50][00:10.00]重复的句子\n[00:05.00]第二句\n'
  const { cues } = parseLrc(lrc)
  assert.equal(cues.length, 3)
  assert.deepEqual(
    cues.map((cue) => cue.start),
    [1.5, 5, 10],
  )
  assert.equal(cues[0].text, '重复的句子')
})

test('bilibili JSON body parses, including a newline inside one cue', () => {
  const body = JSON.stringify({
    font_size: 0.4,
    body: [
      { from: 0.5, to: 2.5, location: 2, content: '中文上行\nEnglish line' },
      { from: 2.5, to: 4, location: 2, content: '第二句' },
    ],
  })
  const document = parseSubtitles(body, 'json')
  assert.equal(document.format, 'bilibili')
  assert.equal(document.cues.length, 2)
  assert.equal(document.cues[0].text, '中文上行\nEnglish line')
  assert.equal(document.cues[0].duration, 2)
})

test('generic JSON envelopes are found through nested keys', () => {
  const cases = [
    JSON.stringify({ cues: [{ start: 1, end: 2, text: 'a' }] }),
    JSON.stringify({ captions: [{ startTime: 1, endTime: 2, text: 'a' }] }),
    JSON.stringify({ data: { subtitles: [{ start: 1, end: 2, content: 'a' }] } }),
    JSON.stringify({ result: { lines: [{ s: 1, e: 2, t: 'a' }] } }),
    JSON.stringify([{ from: 1, to: 2, content: 'a' }]),
    JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'a' }] }] }),
  ]
  for (const payload of cases) {
    const document = parseSubtitles(payload, 'json')
    assert.equal(document.cues.length, 1, `one cue from ${payload.slice(0, 40)}`)
    assert.equal(document.cues[0].text, 'a')
    assert.equal(document.cues[0].start, 1)
  }
})

test('a mislabeled JSON payload still parses', () => {
  // Content-Type said text/vtt but the body is a caption envelope; the SRT
  // reader finds nothing and the JSON reader takes over.
  const document = parseSubtitles(JSON.stringify({ body: [{ from: 1, to: 2, content: 'x' }] }), 'vtt')
  assert.equal(document.cues.length, 1)
  assert.ok(document.warnings.some((entry) => entry.includes('JSON captions')))
})

test('parseSubtitles never throws on garbage and reports why', () => {
  for (const garbage of ['', '   ', 'not captions at all', '{ broken json', '\u0000\u0001\u0002', '<html><body>hi</body></html>']) {
    const document = parseSubtitles(garbage)
    assert.equal(document.cues.length, 0)
    assert.equal(typeof document.duration, 'number')
  }
})

test('detectFormat recognizes each format from text and from a hint', () => {
  assert.equal(detectFormat('WEBVTT\n\n00:00.000 --> 00:01.000\nx'), 'vtt')
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nx'), 'srt')
  assert.equal(detectFormat('[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,D,,0,0,0,,x'), 'ass')
  assert.equal(detectFormat('[00:01.00]x'), 'lrc')
  assert.equal(detectFormat('{"body":[{"from":1,"to":2,"content":"x"}]}'), 'bilibili')
  assert.equal(detectFormat('anything', 'https://x/a.vtt'), 'vtt')
  assert.equal(detectFormat('anything', 'subs.srt'), 'srt')
})

test('serializers produce text the parsers read back identically', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,500 --> 00:00:06,000\nSecond line\n'
  const original = parseSubtitles(srt, 'srt')

  const roundTripSrt = parseSubtitles(toSrt(original), 'srt')
  assert.deepEqual(
    roundTripSrt.cues.map((cue) => [cue.start, cue.end, cue.text]),
    original.cues.map((cue) => [cue.start, cue.end, cue.text]),
  )

  const roundTripVtt = parseSubtitles(toVtt(original), 'vtt')
  assert.deepEqual(
    roundTripVtt.cues.map((cue) => [cue.start, cue.end, cue.text]),
    original.cues.map((cue) => [cue.start, cue.end, cue.text]),
  )
})

test('toSrt can prepend a BOM, which some Chinese players require', () => {
  const document = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nx\n', 'srt')
  assert.ok(toSrt(document, { bom: true }).startsWith('\ufeff'))
  assert.ok(!toSrt(document).startsWith('\ufeff'))
})

test('toText can drop timestamps or merge into one paragraph', () => {
  const document = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n第一句\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句\n', 'srt')
  assert.match(toText(document, { timestamps: false }), /^第一句\n第二句$/)
  assert.match(toText(document, { timestamps: true }), /^\[0:01\] 第一句\n\[0:03\] 第二句$/)
  assert.equal(toText(document, { paragraph: true }), '第一句第二句')
})

test('serialize covers every advertised format', () => {
  const document = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nhello\n', 'srt')
  assert.match(serialize(document, 'srt'), /--> 00:00:02,000/)
  assert.match(serialize(document, 'vtt'), /^WEBVTT/)
  assert.equal(serialize(document, 'txt', { timestamps: false }), 'hello')
  assert.match(serialize(document, 'lrc'), /^\[00:01\.00\]hello$/)
  assert.deepEqual(JSON.parse(serialize(document, 'json')).cues.length, 1)
})

test('selectCues windows by time, by index, and by both', () => {
  const document = parseSubtitles(
    ['1', '00:00:00,000 --> 00:00:02,000', 'a', '', '2', '00:00:05,000 --> 00:00:07,000', 'b', '', '3', '00:00:10,000 --> 00:00:12,000', 'c', ''].join('\n'),
    'srt',
  )
  assert.deepEqual(
    selectCues(document, { start: 4 }).map((cue) => cue.text),
    ['b', 'c'],
  )
  assert.deepEqual(
    selectCues(document, { start: 4, end: 11 }).map((cue) => cue.text),
    ['b', 'c'],
  )
  assert.deepEqual(
    selectCues(document, { fromCue: 2, toCue: 2 }).map((cue) => cue.text),
    ['b'],
  )
  assert.deepEqual(
    selectCues(document, { limit: 2 }).map((cue) => cue.text),
    ['a', 'b'],
  )
})

test('searchCues returns offsets and context, and survives a bad regex', () => {
  const document = parseSubtitles(
    ['1', '00:00:00,000 --> 00:00:02,000', '苹果和香蕉', '', '2', '00:00:05,000 --> 00:00:07,000', '只有苹果', ''].join('\n'),
    'srt',
  )
  const hits = searchCues(document, '苹果')
  assert.equal(hits.length, 2)
  assert.deepEqual(hits[0].matches, [0])
  assert.match(hits[0].context, /> \[0:00\] 苹果和香蕉/)

  assert.equal(searchCues(document, '苹果', { regex: true }).length, 2)
  // An invalid pattern yields no hits instead of throwing.
  assert.deepEqual(searchCues(document, '([', { regex: true }), [])
  assert.deepEqual(searchCues(document, ''), [])
})

test('measureText separates CJK characters from whitespace-delimited words', () => {
  assert.deepEqual(measureText('你好世界'), { cjk: 4, words: 0, characters: 4 })
  assert.deepEqual(measureText('hello world'), { cjk: 0, words: 2, characters: 10 })
  const mixed = measureText('你好 hello')
  assert.equal(mixed.cjk, 2)
  assert.equal(mixed.words, 1)
})

test('makeCue quantizes binary-float timings to milliseconds', () => {
  const cue = makeCue(0.1, 2.1, 'x')
  assert.equal(cue.start, 0.1)
  assert.equal(cue.end, 2.1)
  assert.equal(cue.duration, 2, '2.1 - 0.1 must not leak 1.9999999999999996')
})

test('finalizeDocument orders, indexes and measures', () => {
  const out = finalizeDocument([makeCue(5, 6, 'b'), makeCue(1, 2, 'a')], 'srt', ['w'])
  assert.deepEqual(
    out.cues.map((cue) => cue.index),
    [1, 2],
  )
  assert.deepEqual(
    out.cues.map((cue) => cue.text),
    ['a', 'b'],
  )
  assert.equal(out.duration, 6)
  assert.equal(out.characters, 2)
  assert.deepEqual(out.warnings, ['w'])
})

test('normalizeCueText trims edges but keeps interior blank lines', () => {
  assert.equal(normalizeCueText('\n\n  a  \n\n  b  \n\n'), 'a\n\nb')
  assert.equal(normalizeCueText('   '), '')
})
