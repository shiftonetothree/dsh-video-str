/**
 * QR rendering for the login flow.
 *
 * The encoder is `qrcode-generator` — a single dependency-free CommonJS module
 * that produces the module matrix and nothing else. Everything visual is built
 * here: a grayscale PNG written by hand on top of `node:zlib`, plus an SVG
 * string. Writing the PNG directly avoids pulling in `pngjs` (and, through the
 * more common `qrcode` package, `yargs` and its whole tree) for what amounts to
 * one deflate stream.
 *
 * The dependency is loaded with a dynamic `import` on first use rather than at
 * module scope: a missing package must break the login tool with a clear
 * message, not stop the entire plugin from loading.
 *
 * @module dsh-video-srt/lib/qr
 */

import { deflateSync } from 'node:zlib'

/** Cached module namespace, so the first-use import happens once. */
let encoderPromise

/**
 * Load the encoder, with an actionable failure message.
 *
 * @returns {Promise<(text: string, ecc: string) => any>} A `qrcode(typeNumber, ecc)` factory.
 */
async function loadEncoder() {
  if (encoderPromise === undefined) {
    encoderPromise = import('qrcode-generator').then(
      (module) => /** @type {any} */ (module).default ?? /** @type {any} */ (module),
    )
  }
  try {
    return await encoderPromise
  } catch (error) {
    encoderPromise = undefined
    throw new Error(
      `二维码编码模块 qrcode-generator 未安装，无法生成登录二维码（${error instanceof Error ? error.message : String(error)}）。` +
        '请在插件目录执行 npm install，或改用配置 cookies.bilibili 手动登录。',
    )
  }
}

/**
 * Build the module matrix for a string.
 *
 * @param {string} text Content to encode (a URL, for this plugin).
 * @param {string} [ecc] Error-correction level: `L`, `M`, `Q` or `H`.
 * @returns {Promise<{count: number, isDark: (row: number, col: number) => boolean}>} The matrix.
 */
export async function qrMatrix(text, ecc = 'M') {
  const factory = await loadEncoder()
  const payload = String(text ?? '')
  if (payload === '') throw new Error('二维码内容为空')
  // Type 0 lets the encoder pick the smallest version that fits.
  const qr = factory(0, ecc)
  // The default byte encoder is single-byte; QR payloads here are URLs (ASCII),
  // but UTF-8 is the correct choice if that ever changes.
  try {
    const utf8 = /** @type {any} */ (factory).stringToBytesFuncs?.['UTF-8']
    if (typeof utf8 === 'function') factory.stringToBytes = utf8
  } catch {
    // Older builds expose no such table; the default encoder is fine for ASCII.
  }
  qr.addData(payload)
  qr.make()
  return { count: qr.getModuleCount(), isDark: (row, col) => qr.isDark(row, col) }
}

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/**
 * CRC-32 of a buffer, as PNG requires.
 *
 * @param {Buffer} buffer Input.
 * @returns {number} Unsigned CRC.
 */
function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Encode one PNG chunk: length, type, payload, CRC.
 *
 * @param {string} type Four-character chunk type.
 * @param {Buffer} data Chunk payload.
 * @returns {Buffer} The complete chunk.
 */
function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/**
 * Render a string as a grayscale PNG.
 *
 * @param {string} text Content to encode.
 * @param {{scale?: number, margin?: number, ecc?: string}} [options] Module size in pixels, quiet zone in modules, ECC level.
 * @returns {Promise<Buffer>} PNG bytes.
 */
export async function qrPng(text, options = {}) {
  const scale = Math.max(1, Math.min(32, Math.trunc(options.scale ?? 8)))
  const margin = Math.max(0, Math.min(16, Math.trunc(options.margin ?? 4)))
  const { count, isDark } = await qrMatrix(text, options.ecc ?? 'M')

  const size = (count + margin * 2) * scale
  // One filter byte per scanline; filter 0 (None) keeps this a straight copy.
  const stride = size + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) raw.fill(255, y * stride + 1, y * stride + 1 + size)

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!isDark(row, col)) continue
      const x0 = (col + margin) * scale
      const y0 = (row + margin) * scale
      for (let dy = 0; dy < scale; dy += 1) {
        const start = (y0 + dy) * stride + 1 + x0
        raw.fill(0, start, start + scale)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type 0: grayscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Render a string as an SVG QR code, for surfaces that prefer vector.
 *
 * @param {string} text Content to encode.
 * @param {{scale?: number, margin?: number, ecc?: string}} [options] Module size, quiet zone in modules, ECC level.
 * @returns {Promise<string>} SVG document.
 */
export async function qrSvg(text, options = {}) {
  const scale = Math.max(1, Math.min(32, Math.trunc(options.scale ?? 8)))
  const margin = Math.max(0, Math.min(16, Math.trunc(options.margin ?? 4)))
  const { count, isDark } = await qrMatrix(text, options.ecc ?? 'M')
  const size = (count + margin * 2) * scale
  const parts = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!isDark(row, col)) continue
      parts.push(`<rect x="${(col + margin) * scale}" y="${(row + margin) * scale}" width="${scale}" height="${scale}"/>`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g fill="#000000">${parts.join('')}</g>` +
    '</svg>'
  )
}
