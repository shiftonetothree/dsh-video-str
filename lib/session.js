/**
 * Persisted login sessions.
 *
 * A site cookie obtained through `video_subtitle_login` outlives one DSH process,
 * so it cannot live in the volatile plugin config: a config edit is a settings
 * write the user has to make, and re-scanning a QR code on every restart would
 * defeat the point of the login tool. The session therefore lands in a small
 * JSON file next to the rest of this machine's DSH state:
 *
 * ```
 * $DSH_VIDEO_SRT_HOME                        when set (tests, unusual layouts)
 * $DSH_HOME/video-srt/session.json           when DSH_HOME is set
 * ~/.dsh/video-srt/session.json              otherwise
 * ```
 *
 * `DSH_HOME` is honoured because it is the same variable the host itself uses,
 * so a profile kept outside the home directory keeps its sessions next to it.
 *
 * **The file holds a credential.** It is created `0600` — owner read/write only —
 * and every read tolerates damage: a half-written or hand-edited file degrades to
 * "no session" rather than making the whole plugin fail to load.
 *
 * @module dsh-video-srt/lib/session
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory holding this plugin's state, honouring the host's own layout. */
export function sessionDir() {
  const override = String(process.env.DSH_VIDEO_SRT_HOME ?? '').trim()
  if (override !== '') return override
  const dshHome = String(process.env.DSH_HOME ?? '').trim()
  const base = dshHome !== '' ? dshHome : join(homedir(), '.dsh')
  return join(base, 'video-srt')
}

/** Absolute path of the session file. */
export function sessionPath() {
  return join(sessionDir(), 'session.json')
}

/**
 * Read the whole session store.
 *
 * @param {string} [path] Session file path, for tests.
 * @returns {Record<string, any>} Site id to record; empty when absent or damaged.
 */
export function readStore(path = sessionPath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    /** @type {Record<string, any>} */
    const store = {}
    for (const [site, record] of Object.entries(parsed)) {
      if (record === null || typeof record !== 'object') continue
      if (typeof (/** @type {any} */ (record).cookie) !== 'string') continue
      store[site] = record
    }
    return store
  } catch {
    return {}
  }
}

/**
 * Read one site's session record.
 *
 * An expired record is reported as expired rather than hidden, so a caller can
 * say "登录态过期了，重新扫一次" instead of silently degrading to anonymous.
 *
 * @param {string} site Site id, e.g. `bilibili`.
 * @param {string} [path] Session file path, for tests.
 * @returns {{cookie: string, savedAt: number, expiresAt?: number, mid?: string, name?: string, expired: boolean}|undefined}
 *   The record, with an `expired` verdict added.
 */
export function readSession(site, path = sessionPath()) {
  const record = readStore(path)[site]
  if (record === undefined) return undefined
  const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : undefined
  return {
    ...record,
    expiresAt,
    expired: expiresAt !== undefined && expiresAt * 1000 <= Date.now(),
  }
}

/**
 * Persist one site's session.
 *
 * @param {string} site Site id.
 * @param {{cookie: string, expiresAt?: number, mid?: string, name?: string}} record What to store.
 * @param {string} [path] Session file path, for tests.
 * @returns {{cookie: string, savedAt: number, expiresAt?: number, path: string}} The stored record.
 */
export function writeSession(site, record, path = sessionPath()) {
  const cookie = String(record.cookie ?? '').trim()
  if (cookie === '') throw new Error('writeSession 需要非空的 cookie')
  const stored = {
    cookie,
    savedAt: Date.now(),
    ...(typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? { expiresAt: record.expiresAt } : {}),
    ...(record.mid === undefined ? {} : { mid: String(record.mid) }),
    ...(record.name === undefined ? {} : { name: String(record.name) }),
  }
  const store = readStore(path)
  store[site] = stored
  mkdirSync(sessionDirOf(path), { recursive: true })
  // `mode` only applies when the file is created; an existing file keeps its mode,
  // so chmod unconditionally to keep a previously loosened file tightening again.
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // A filesystem without POSIX modes (or a Windows ACL it cannot map) is not a
    // reason to lose the session; the write itself succeeded.
  }
  return { ...stored, path }
}

/**
 * Remove one site's session.
 *
 * @param {string} site Site id.
 * @param {string} [path] Session file path, for tests.
 * @returns {boolean} Whether a record was removed.
 */
export function clearSession(site, path = sessionPath()) {
  const store = readStore(path)
  if (store[site] === undefined) return false
  delete store[site]
  rmSync(path, { force: true })
  if (Object.keys(store).length > 0) {
    mkdirSync(sessionDirOf(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  }
  return true
}

/**
 * Directory part of a session path.
 *
 * @param {string} path Session file path.
 * @returns {string} Its directory.
 */
function sessionDirOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? '.' : path.slice(0, index)
}

/**
 * Describe a secret without revealing it.
 *
 * Tool results and logs both end up in places a credential must not, so every
 * description of a stored cookie goes through here. The tail is kept because it
 * is what lets a user recognise *which* login is stored.
 *
 * @param {string|undefined} cookie Cookie header.
 * @returns {string} A masked description.
 */
export function describeCookie(cookie) {
  if (cookie === undefined || cookie === '') return '（未登录）'
  const match = /SESSDATA=([^;]+)/.exec(cookie)
  const value = match?.[1] ?? cookie
  const tail = value.slice(-4)
  return `SESSDATA=…${tail}（共 ${value.length} 字符）`
}
