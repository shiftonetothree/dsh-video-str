/**
 * Waking the agent that asked for a scan.
 *
 * Scanning is a three-second action followed by up to three minutes of waiting.
 * If the agent has to be told "扫完了" and poll by hand, the user pays a whole
 * turn for something the plugin can observe itself. `followup()` is the right
 * seam: it queues an ordinary next-turn message and wakes the driver, so the
 * result arrives as if the user had said it.
 *
 * The host package that builds the message (`@deepseek-ai/dsh-llm`) is imported
 * lazily and tolerated as missing: standalone scripts and plain-node tests load
 * this module without a DSH host, and a profile-installed plugin cannot resolve
 * the host's own packages. When the import fails, the same message is built by
 * hand — `createUserMessage` is only `{ ...input, role: 'user' }` plus a fresh
 * id, so the two shapes are interchangeable.
 *
 * @module dsh-video-srt/lib/wake
 */

import { randomUUID } from 'node:crypto'

/**
 * Build the user-role message `Agent.followup()` expects.
 *
 * @param {string} text What the next turn should see.
 * @returns {Promise<{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'user'}}>}
 *   A message the host accepts.
 */
async function userMessage(text) {
  const content = [{ type: 'text', text }]
  const source = { kind: 'user' }
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    return createUserMessage({ content, source })
  } catch {
    return { id: randomUUID(), role: /** @type {'user'} */ ('user'), content, source }
  }
}

/**
 * Wake the agent with a message of our own — this is what makes the scan
 * hands-free: the plugin reports the result, the user does not have to.
 *
 * @param {unknown} agent `exec.agent`; absent in scripts and tests.
 * @param {string} text What the next turn should see.
 * @returns {Promise<{ok: boolean, error?: string}>} Whether the wake reached an agent.
 */
export async function notifyAgent(agent, text) {
  const target = /** @type {{ followup?: (message: unknown) => void } | undefined} */ (agent)
  if (target === undefined || target === null || typeof target.followup !== 'function') {
    return { ok: false, error: 'no agent attached' }
  }
  try {
    target.followup(await userMessage(text))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
