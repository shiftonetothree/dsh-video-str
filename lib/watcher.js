/**
 * The polling loop behind "scan the code and I'll tell you".
 *
 * A QR lives for three minutes and the user is the one who ends the wait, so
 * the plugin — not the agent — has to keep asking. This is that whole loop,
 * kept out of index.js so it can be driven with a fake `poll` and a fake clock:
 * every interesting case (someone scans, nobody scans, the network hiccups, the
 * plugin unloads mid-wait) is a timing case, and none of them should need a
 * real Bilibili request or a real three-minute wait to test.
 *
 * @module dsh-video-srt/lib/watcher
 */

/**
 * @typedef {{ state: string, cookie?: string, expiresAt?: number, mid?: string }} PollResult
 * @typedef {{ stop: () => void, readonly stopped: boolean }} WatchHandle
 */

/** Poll again quickly once the phone has scanned but not confirmed. */
const SCANNED_DELAY_MS = 2000

/** Poll slowly while nobody has scanned: the QR is good for three minutes. */
const WAITING_DELAY_MS = 2500

/** Back off after a transport error, then keep waiting. */
const ERROR_DELAY_MS = 5000

/** Sleep, without holding the process open just to wait for a scan. */
const defaultDelay = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

/**
 * Poll a QR login key until it is confirmed, expires, or the caller stops it.
 *
 * Exactly one of `onConfirmed` / `onExpired` runs, and only while the handle is
 * live: stopping the watch first (plugin unload, a newer QR, a manual poll that
 * already settled it) means neither fires. Errors are swallowed and retried —
 * a flaky request must not cancel a login the user is still completing.
 *
 * @param {object} options Watch options.
 * @param {string} options.key QR key from `startQrLogin`.
 * @param {number} options.expiresAt Epoch ms when the server-side QR dies.
 * @param {(key: string) => Promise<PollResult>} options.poll One poll request.
 * @param {(result: PollResult) => Promise<void> | void} options.onConfirmed Ran once the cookie exists.
 * @param {(reason: 'expired' | 'timeout') => Promise<void> | void} options.onExpired Ran once the code is dead.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {(ms: number) => Promise<void>} [options.delay] Sleep, injectable for tests.
 * @returns {WatchHandle} Handle whose `stop()` silences the callbacks.
 */
export function watchLogin({ key, expiresAt, poll, onConfirmed, onExpired, now = () => Date.now(), delay = defaultDelay }) {
  let stopped = false
  const handle = {
    stop() {
      stopped = true
    },
    get stopped() {
      return stopped
    },
  }

  const run = async () => {
    while (!stopped) {
      if (now() > expiresAt) {
        stopped = true
        await onExpired('timeout')
        return
      }
      let result
      try {
        result = await poll(key)
      } catch {
        if (stopped) return
        await delay(ERROR_DELAY_MS)
        continue
      }
      if (stopped) return
      if (result?.state === 'confirmed') {
        stopped = true
        await onConfirmed(result)
        return
      }
      if (result?.state === 'expired') {
        stopped = true
        await onExpired('expired')
        return
      }
      await delay(result?.state === 'scanned' ? SCANNED_DELAY_MS : WAITING_DELAY_MS)
    }
  }

  // Start on a microtask, not inline: the caller gets the handle back and may
  // stop it before a single request goes out (plugin unload, replaced QR).
  void (async () => {
    await Promise.resolve()
    await run()
  })()
  return handle
}
