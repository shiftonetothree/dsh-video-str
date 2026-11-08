/**
 * A capture-only Cordis context for tests.
 *
 * Implements exactly the two services the plugin injects, records every
 * registration, and exposes the effect teardown so a test can assert on both
 * mount and unload. Deliberately not a mock of the real `ToolRuntime`: the
 * registry's own pipeline is exercised by the DSH host, and re-implementing it
 * here would only test the re-implementation.
 */

/**
 * Build the harness.
 *
 * @returns {{
 *   ctx: any,
 *   tools: any[],
 *   sections: any[],
 *   listeners: Record<string, Function[]>,
 *   effectCleanups: Array<undefined|(() => void)>,
 *   readonly effects: number,
 *   readonly disposed: number,
 *   tool(name: string): any,
 * }} Harness.
 */
export function harness() {
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
    /**
     * Find one registered tool by name.
     *
     * @param {string} name Tool name.
     * @returns {any} The tool definition.
     */
    tool(name) {
      const found = tools.find((entry) => entry.name === name)
      if (found === undefined) throw new Error(`tool ${name} is not registered; have: ${tools.map((entry) => entry.name).join(', ')}`)
      return found
    },
  }
}
