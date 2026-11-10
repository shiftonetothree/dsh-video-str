/**
 * Waking the agent after a scan.
 *
 * The wake is what makes the scan hands-free, so the two failure modes matter
 * as much as the happy path: there is no agent to wake (a script, a test), and
 * the host refuses the message. Neither may throw into the login flow.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { notifyAgent } from '../lib/wake.js'

test('no agent attached is reported, not thrown', async () => {
  assert.deepEqual(await notifyAgent(undefined, 'hello'), { ok: false, error: 'no agent attached' })
  assert.deepEqual(await notifyAgent({}, 'hello'), { ok: false, error: 'no agent attached' })
})

test('a wake reaches the agent as one user message', async () => {
  const seen = []
  const agent = { followup: (message) => seen.push(message) }

  assert.deepEqual(await notifyAgent(agent, '✅ 登录成功'), { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].role, 'user')
  assert.equal(typeof seen[0].id, 'string')
  assert.deepEqual(seen[0].content, [{ type: 'text', text: '✅ 登录成功' }])
  assert.deepEqual(seen[0].source, { kind: 'user' })
})

test('a refused wake is reported, not thrown', async () => {
  const agent = {
    followup: () => {
      throw new Error('turn is closed')
    },
  }

  assert.deepEqual(await notifyAgent(agent, 'hello'), { ok: false, error: 'turn is closed' })
})
