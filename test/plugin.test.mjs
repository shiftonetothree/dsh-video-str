/**
 * Tests for the plugin's activation surface: tools register, the announcement
 * is visibility-gated, and teardown releases everything.
 *
 * These are deliberately not network tests; the live behaviour is exercised by
 * `tools/probe-*.mjs` and by the fixture tests in this directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, TOOL_NAMES, Config } from '../index.js'

/**
 * Build a capture-only Cordis context.
 *
 * Records everything the plugin registers so a test can assert on it, and
 * implements only the two injected services. `tools.schemas()` is what the
 * announcement gate reads, so it must reflect live registrations.
 *
 * @param {{withSystemPrompt?: boolean}} [options] Context options.
 * @returns {{ctx: any, tools: any[], sections: any[], listeners: Record<string, Function[]>, effects: number, disposed: number}} Harness.
 */
function harness(options = {}) {
  /** @type {any[]} */
  const tools = []
  /** @type {any[]} */
  const sections = []
  /** @type {Record<string, Function[]>} */
  const listeners = {}
  /** @type {Array<undefined|(() => void)>} */
  const effectCleanups = []
  let effects = 0
  let disposed = 0
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
          disposed += 1
        }
      },
      schemas() {
        return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {
          const index = sections.indexOf(definition)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(listener)
      return () => {
        const list = listeners[event] ?? []
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(callback) {
      effects += 1
      const cleanup = callback()
      effectCleanups.push(cleanup)
      return cleanup
    },
    get() {
      return undefined
    },
  }
  if (options.withSystemPrompt === false) delete ctx.systemPrompt
  // `effects` and `disposed` are exposed as getters: a plain property would
  // snapshot the counter at construction and never show the real value.
  return {
    ctx,
    tools,
    sections,
    listeners,
    effectCleanups,
    get effects() {
      return effects
    },
    get disposed() {
      return disposed
    },
  }
}

test('registers every advertised tool with a complete definition', () => {
  const h = harness()
  apply(h.ctx, Config({}))
  assert.equal(h.tools.length, TOOL_NAMES.length, 'one registration per advertised tool')
  assert.deepEqual(
    h.tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
  )
  for (const tool of h.tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} description`)
    assert.ok(tool.description.length > 40, `${tool.name} description is substantive`)
    assert.equal(tool.parameters?.type, 'object', `${tool.name} takes an object`)
    assert.equal(tool.parameters?.additionalProperties, false, `${tool.name} is closed`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} renders`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} executes`)
    assert.ok(tool.output.schema !== undefined, `${tool.name} declares an output schema`)
    // The registry requires either an explicit output schema or a JSON one; the
    // value must always be lossless JSON, so no schema may be `any`.
    assert.equal(typeof tool.output.schema, 'object')
  }
})

test('announces itself exactly once while its tools are visible', () => {
  const h = harness()
  apply(h.ctx, Config({}))
  assert.equal(h.sections.length, 1)
  const section = h.sections[0]
  assert.equal(section.name, 'plugin:dsh-video-srt')
  assert.equal(typeof section.order, 'number')
  assert.ok(section.order > 2400 && section.order < 5000, 'order sits in the unallocated tool-guidance band')
  assert.match(section.text, /video_subtitle_get/)
  assert.match(section.text, /need_login_subtitle/)
})

test('stays silent when disabled or when the announcement is switched off', () => {
  const off = harness()
  apply(off.ctx, Config({ enabled: false }))
  assert.equal(off.sections.length, 0)
  assert.equal(off.tools.length, 0, 'a disabled plugin registers no tools')

  const quiet = harness()
  apply(quiet.ctx, Config({ announceToAgent: false }))
  assert.equal(quiet.tools.length, TOOL_NAMES.length, 'tools still register')
  assert.equal(quiet.sections.length, 0, 'but nothing is announced')
})

test('tools unregister when the owning effect is torn down', () => {
  const h = harness()
  apply(h.ctx, Config({}))
  assert.equal(h.tools.length, TOOL_NAMES.length)
  assert.equal(h.sections.length, 1)
  assert.equal(h.effects, 1, 'the plugin owns exactly one effect')
  const cleanup = h.effectCleanups[0]
  assert.equal(typeof cleanup, 'function', 'the effect returns a teardown')
  cleanup()
  assert.equal(h.tools.length, 0, 'every tool was disposed')
  assert.equal(h.sections.length, 0, 'the announcement was disposed')
  assert.equal((h.listeners['loader/volatile-update'] ?? []).length, 0, 'the config listener was disposed')
})

test('a delivery without a tool registry fails loudly instead of half-mounting', () => {
  const h = harness()
  delete h.ctx.tools
  assert.throws(() => apply(h.ctx, Config({})), /register|Cannot read/i)
})

test('rejects an unknown-only argument set at the tool boundary', async () => {
  const h = harness()
  apply(h.ctx, Config({}))
  const detect = h.tools.find((tool) => tool.name === 'video_site_detect')
  const value = await detect.execute({ url: 'definitely not a url' }, { signal: new AbortController().signal })
  assert.equal(value.matched, false)
  assert.match(String(value.reason), /已知站点|http/)
})

test('site detection reports the adapter and its caption capability', async () => {
  const h = harness()
  apply(h.ctx, Config({}))
  const detect = h.tools.find((tool) => tool.name === 'video_site_detect')
  const signal = new AbortController().signal

  const bili = await detect.execute({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }, { signal })
  assert.equal(bili.site.id, 'bilibili')
  assert.equal(bili.site.captionsSupported, true)
  assert.equal(bili.identity.bvid, 'BV1GJ411x7h7')

  const youku = await detect.execute({ url: 'https://v.youku.com/v_show/id_XNTk1NTQwNzYwOA==.html' }, { signal })
  assert.equal(youku.site.id, 'youku')
  assert.equal(youku.site.captionsSupported, false)
  assert.match(String(youku.site.limitation), /优酷/)

  const generic = await detect.execute({ url: 'https://example.com/a/b.vtt' }, { signal })
  assert.equal(generic.site.id, 'generic')
})

test('the sites tool lists the roster without touching the network', async () => {
  const h = harness()
  apply(h.ctx, Config({}))
  const sites = h.tools.find((tool) => tool.name === 'video_subtitle_sites')
  const value = await sites.execute({}, { signal: new AbortController().signal })
  const ids = value.sites.map((site) => site.id)
  for (const expected of ['bilibili', 'qq', 'mgtv', 'youku', 'douyin', 'generic']) {
    assert.ok(ids.includes(expected), `roster names ${expected}`)
  }
  assert.equal(value.sites.find((site) => site.id === 'bilibili').captions, true)
  assert.equal(value.sites.find((site) => site.id === 'youku').captions, false)
  assert.equal(ids.includes('iqiyi'), false, 'iqiyi is not an adapter; its URLs go to the generic fallback')
})

test('parsing works entirely offline, including a bilibili caption body', async () => {
  const h = harness()
  apply(h.ctx, Config({}))
  const parse = h.tools.find((tool) => tool.name === 'video_subtitle_parse')
  const signal = new AbortController().signal

  const srt = '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:03,000 --> 00:00:05,000\n第二句\n'
  const fromSrt = await parse.execute({ text: srt }, { signal })
  assert.equal(fromSrt.cueCount, 2)
  assert.equal(fromSrt.format, 'srt')

  const body = JSON.stringify({ body: [{ from: 0.5, to: 2.5, content: 'AI 字幕第一句' }, { from: 2.5, to: 4, content: '第二句' }] })
  const fromJson = await parse.execute({ text: body }, { signal })
  assert.equal(fromJson.format, 'bilibili')
  assert.equal(fromJson.cueCount, 2)

  await assert.rejects(() => parse.execute({}, { signal }), /text、path 或 url/)
})

test('the read tool needs either a cacheKey or a url', async () => {
  const h = harness()
  apply(h.ctx, Config({}))
  const read = h.tools.find((tool) => tool.name === 'video_subtitle_read')
  await assert.rejects(() => read.execute({}, { signal: new AbortController().signal }), /cacheKey|url/)
})
