/**
 * The background scan wait, driven by a fake clock and a fake poll.
 *
 * The whole point of extracting this loop is that its interesting cases are
 * timing cases — nobody scans, someone scans, the network hiccups, the plugin
 * unloads — and none of them should need a real three-minute wait.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { watchLogin } from '../lib/watcher.js'

/** A clock and a sleep that only move when the test says so. */
function fakeClock() {
  let time = 1_000_000
  const sleeps = []
  return {
    now: () => time,
    /** Record the sleep and resolve it immediately — the loop then re-reads the clock. */
    delay: async (ms) => {
      sleeps.push(ms)
      time += ms
    },
    sleeps,
  }
}

/** Poll results fed one per call, so a sequence reads like the QR's real life. */
function sequencePoll(states) {
  const calls = []
  const poll = async (key) => {
    calls.push(key)
    const next = states.shift() ?? { state: 'waiting' }
    if (next instanceof Error) throw next
    return next
  }
  return { poll, calls }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('a confirmed scan reports once, with the cookie', async () => {
  const clock = fakeClock()
  const { poll, calls } = sequencePoll([
    { state: 'waiting' },
    { state: 'scanned' },
    { state: 'confirmed', cookie: 'SESSDATA=x', mid: '42' },
  ])
  const confirmed = []
  const expired = []

  watchLogin({
    key: 'abc',
    expiresAt: 9_999_999,
    poll,
    now: clock.now,
    delay: clock.delay,
    onConfirmed: (result) => confirmed.push(result),
    onExpired: (reason) => expired.push(reason),
  })
  await flush()
  await flush()
  await flush()

  assert.equal(calls.length, 3)
  assert.deepEqual(confirmed, [{ state: 'confirmed', cookie: 'SESSDATA=x', mid: '42' }])
  assert.deepEqual(expired, [])
  // Scanned polls retry faster than idle ones — the user is right there.
  assert.deepEqual(clock.sleeps, [2500, 2000])
})

test('a QR nobody scans times out at the deadline and says why', async () => {
  const clock = fakeClock()
  const { poll } = sequencePoll([])
  const expired = []

  watchLogin({
    key: 'abc',
    expiresAt: clock.now() + 3000,
    poll,
    now: clock.now,
    delay: clock.delay,
    onConfirmed: () => assert.fail('nothing was scanned'),
    onExpired: (reason) => expired.push(reason),
  })
  await flush()
  await flush()

  assert.deepEqual(expired, ['timeout'])
})

test('the server reporting expiry does not wait for the local deadline', async () => {
  const clock = fakeClock()
  const { poll } = sequencePoll([{ state: 'expired' }])
  const expired = []

  watchLogin({
    key: 'abc',
    expiresAt: clock.now() + 10 * 60 * 1000,
    poll,
    now: clock.now,
    delay: clock.delay,
    onConfirmed: () => assert.fail('nothing was scanned'),
    onExpired: (reason) => expired.push(reason),
  })
  await flush()

  assert.deepEqual(expired, ['expired'])
})

test('a failing poll is retried, not treated as a dead login', async () => {
  const clock = fakeClock()
  const { poll, calls } = sequencePoll([new Error('ECONNRESET'), { state: 'confirmed', cookie: 'SESSDATA=y' }])
  const confirmed = []

  watchLogin({
    key: 'abc',
    expiresAt: 9_999_999,
    poll,
    now: clock.now,
    delay: clock.delay,
    onConfirmed: (result) => confirmed.push(result),
    onExpired: () => assert.fail('a network error is not an expiry'),
  })
  await flush()
  await flush()

  assert.equal(calls.length, 2)
  assert.equal(confirmed.length, 1)
  assert.equal(clock.sleeps[0], 5000)
})

test('stopping the watch silences both callbacks', async () => {
  const clock = fakeClock()
  const { poll, calls } = sequencePoll([{ state: 'waiting' }, { state: 'confirmed', cookie: 'SESSDATA=z' }])
  const confirmed = []
  const expired = []

  const handle = watchLogin({
    key: 'abc',
    expiresAt: 9_999_999,
    poll,
    now: clock.now,
    delay: clock.delay,
    onConfirmed: (result) => confirmed.push(result),
    onExpired: (reason) => expired.push(reason),
  })
  handle.stop()
  await flush()
  await flush()

  assert.equal(handle.stopped, true)
  assert.equal(calls.length, 0)
  assert.deepEqual(confirmed, [])
  assert.deepEqual(expired, [])
})
