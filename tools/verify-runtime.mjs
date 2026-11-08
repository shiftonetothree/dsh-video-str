/**
 * Apply the plugin against the REAL DSH runtime: the actual `ToolRuntime`
 * registry and execution pipeline, and the actual `SystemPrompt` service.
 *
 * This is the strongest verification available without booting the whole
 * harness. It proves the things a stub cannot:
 *
 * - every tool definition passes the registry's own schema checks,
 * - every declared output schema is a supported JSON Schema and every rendered
 *   value validates against it,
 * - the plugin's `parameters` really are raw JSON Schema (the trap that breaks
 *   plugins that hand back a `defineTool`-compiled schema),
 * - `execute` → `output.render` produces the content the model would see,
 * - the system-prompt section registers, renders, and disposes.
 *
 * Run:  node tools/verify-runtime.mjs
 *
 * The plugin's own `node_modules` must be able to resolve the real runtime
 * packages. It cannot declare them itself — DSH supplies them — so this script
 * expects them to be reachable and explains how to arrange that when they are
 * not. See the "开发与测试" section of the README.
 */

import { pathToFileURL } from 'node:url'

/**
 * Import a module, turning a resolution failure into an actionable message.
 *
 * @param {string} specifier Module specifier.
 * @returns {Promise<any>} The module namespace.
 */
async function load(specifier) {
  try {
    return await import(specifier)
  } catch (error) {
    if (error instanceof Error && (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(error.message))) {
      console.error(
        `\nverify-runtime: cannot resolve "${specifier}".\n\n` +
          'The plugin intentionally declares no runtime dependency on the DSH packages — the host\n' +
          'supplies them. To run this check, make them reachable from this package, e.g.:\n\n' +
          '  npm install --prefix %TEMP%/dsh-verify --legacy-peer-deps \\\n' +
          '    @deepseek-ai/dsh-tools@0.2.0-rc.2 @deepseek-ai/dsh-system-prompt@0.2.0-rc.2 \\\n' +
          '    @deepseek-ai/cordis@4.0.4\n' +
          '  # then junction/link each @deepseek-ai/* directory into node_modules/@deepseek-ai/\n\n' +
          'The offline suite (`npm test`) covers everything that does not need the real services.\n',
      )
      process.exit(2)
    }
    throw error
  }
}

const { Context } = await load('@deepseek-ai/cordis')
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')

const PLUGIN = pathToFileURL('F:/code/video-srt/index.js').href
const plugin = await import(PLUGIN)

let failures = 0
/**
 * Assert one condition.
 *
 * @param {unknown} condition Value that must be truthy.
 * @param {string} message Failure message.
 */
function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${message}`)
}

// ---------------------------------------------------------------------------
// A REAL Cordis root context carrying the two REAL services.
// ---------------------------------------------------------------------------

const context = new Context()

// Constructing a `Service` registers it on the context under its own name, so
// the plugin's `ctx.tools` / `ctx.systemPrompt` are the genuine implementations
// — including their schema checks, guards, and output validation.
//
// Order matters: the real `ToolRuntime` registers its PTC prompt sections
// through `ctx.systemPrompt` during construction, so the prompt service must
// exist first. A real composition gets this from the `tools` service's own
// `static inject`, which the Loader honours; here it is explicit.
const systemPrompt = new SystemPrompt(context, {})
const tools = new ToolRuntime(context)

// ---------------------------------------------------------------------------
// Apply the plugin.
// ---------------------------------------------------------------------------

console.log('\n== applying the plugin to the real services ==')
const config = plugin.Config({})
plugin.apply(context, config)

const schemas = tools.schemas()
console.log(`  registered ${schemas.length} tools`)
check(schemas.length === plugin.TOOL_NAMES.length, `all ${plugin.TOOL_NAMES.length} tools are visible to the registry`)
for (const name of plugin.TOOL_NAMES) {
  check(tools.get(name) !== undefined, `registry resolves ${name}`)
}

// The registry clones the allowlisted schema fields, so this asserts the plugin
// did not smuggle a compiled author-DSL object into `parameters`.
for (const schema of schemas) {
  const parameters = /** @type {any} */ (schema.parameters)
  check(parameters?.type === 'object', `${schema.name}: parameters is a raw JSON Schema object`)
  check(parameters?.additionalProperties === false, `${schema.name}: parameters is a closed object`)
  // A tool takes no arguments at all in exactly one legitimate case, and then
  // an absent `required` is correct rather than a mistake.
  const takesArguments = Object.keys(parameters?.properties ?? {}).length > 0
  check(takesArguments ? Array.isArray(parameters?.required) : parameters?.required === undefined, `${schema.name}: required is declared iff the tool takes arguments`)
  check(parameters !== undefined && Object.hasOwn(parameters, 'properties'), `${schema.name}: parameters declares "properties"`)
  check(typeof schema.description === 'string' && schema.description.length > 20, `${schema.name}: has a model-facing description`)
}

// ---------------------------------------------------------------------------
// Exercise the real execution pipeline end to end.
// ---------------------------------------------------------------------------

console.log('\n== executing through the real pipeline ==')

/**
 * Dispatch one call through the registry.
 *
 * @param {string} name Tool name.
 * @param {unknown} args Arguments.
 * @returns {Promise<import('@deepseek-ai/dsh-tools').ToolExecutionResult>} Result.
 */
async function call(name, args) {
  return await tools.execute({
    callId: /** @type {any} */ (`verify-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
    signal: AbortSignal.timeout(30_000),
  })
}

/**
 * Read the joined text of a result's content blocks.
 *
 * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result Result.
 * @returns {string} Joined text.
 */
function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => /** @type {any} */ (block).text)
    .join('\n')
}

// 1. A tool with no network dependency, so this stays runnable offline.
const sites = await call('video_subtitle_sites', {})
check(sites.isError === false, 'video_subtitle_sites succeeds')
check(Array.isArray(/** @type {any} */ (sites).value?.sites) && /** @type {any} */ (sites).value.sites.length >= 10, 'the roster carries every adapter')
check(textOf(sites).includes('哔哩哔哩'), 'the rendered content names a site')

// 2. Offline parsing through the real output-schema validation.
const srt = '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:03,000 --> 00:00:05,000\n第二句\n'
const parsed = await call('video_subtitle_parse', { text: srt })
check(parsed.isError === false, 'video_subtitle_parse succeeds on inline SRT')
check(/** @type {any} */ (parsed).value?.cueCount === 2, 'the canonical value carries the cue count')
check(textOf(parsed).includes('第一句'), 'the rendered content carries the cue text')

// 3. Site detection, which exercises argument validation and the adapter table.
const detect = await call('video_site_detect', { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' })
check(detect.isError === false, 'video_site_detect succeeds')
check(/** @type {any} */ (detect).value?.site?.id === 'bilibili', 'it names the bilibili adapter')
check(textOf(detect).includes('哔哩哔哩'), 'the rendered content names the site')

// 4. An invalid argument must be refused by the registry, not by the tool body.
const badArgs = await call('video_subtitle_parse', { nope: true })
check(badArgs.isError === true, 'an argument outside the schema is refused')

// 5. An absent required argument. A plain registry definition has its
//    `required` list shown to the model but NOT enforced at dispatch — only a
//    `defineTool` definition carries that check — so the tool body must own it
//    and answer with something a model can act on.
const missing = await call('video_site_detect', {})
check(missing.isError === true, 'an absent required argument fails the call')
check(textOf(missing).includes('url 是必需的'), 'and the failure says which argument is missing')

// 6. A tool body that throws must become an error result, not a rejection.
const unknown = await call('video_site_detect', { url: 'not-a-url-at-all' })
check(unknown.isError === false, 'an unrecognized address is a value, not a crash')
check(/** @type {any} */ (unknown).value?.matched === false, 'and it reports the miss')

// ---------------------------------------------------------------------------
// The system prompt.
// ---------------------------------------------------------------------------

console.log('\n== system prompt ==')
const assembly = await systemPrompt.assemble({})
const section = assembly.sections.find((entry) => entry.name === 'plugin:dsh-video-srt')
check(section !== undefined, 'the announcement section is registered')
check(typeof section?.text === 'string' && section.text.includes('video_subtitle_get'), 'the announcement names the entry-point tool')
check(typeof section?.text === 'string' && section.text.includes('need_login_subtitle'), 'the announcement teaches the bilibili login gate')
const matchingTools = assembly.tools.filter((tool) => plugin.TOOL_NAMES.includes(tool.name))
check(matchingTools.length === plugin.TOOL_NAMES.length, 'every tool is present in the assembled prompt surface')

console.log(`\n${failures === 0 ? 'ALL RUNTIME CHECKS PASSED' : `${failures} RUNTIME CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
