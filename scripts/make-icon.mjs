// 应用图标生成器：靛蓝渐变圆角方块 + 被"剪开"的白色播放三角（含投影与切缝高光）
// 纯 Node 实现：3x 超采样抗锯齿，手写 PNG 编码
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = 512
const SS = 3 // 超采样倍数
const N = SIZE * SS

// ---------- 几何 ----------
const pad = 16 * SS
const radius = 110 * SS

/** 点是否在圆角矩形内 */
function inRoundRect(x, y) {
  const x0 = pad, y0 = pad, x1 = N - pad, y1 = N - pad
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + radius, Math.min(x, x1 - radius))
  const cy = Math.max(y0 + radius, Math.min(y, y1 - radius))
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** 射线法：点是否在多边形内 */
function inPoly(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 点到线段距离 */
function distToSeg(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2))
  const px = x1 + t * dx, py = y1 + t * dy
  return Math.hypot(x - px, y - py)
}

const s = (v) => v * SS
// 左碎片（四边形，斜切缝）
const leftPiece = [[s(175), s(142)], [s(276), s(199)], [s(244), s(320)], [s(175), s(370)]]
// 右碎片（三角）
const rightPiece = [[s(300), s(213)], [s(392), s(262)], [s(282), s(338)]]
const off = s(10)
const shadowL = leftPiece.map(([x, y]) => [x + off, y + off])
const shadowR = rightPiece.map(([x, y]) => [x + off, y + off])
const cutA = [s(268), s(190)]
const cutB = [s(236), s(328)]

// ---------- 颜色 ----------
const lerp = (a, b, t) => a + (b - a) * t
const BG1 = [79, 70, 229] // #4F46E5
const BG2 = [124, 58, 237] // #7C3AED
const SHADOW = [20, 10, 40]
const WHITE = [255, 255, 255]

// ---------- 逐像素绘制（超采样缓冲） ----------
const buf = new Uint8Array(N * N * 4)

function blendAt(idx, [r, g, b], alpha) {
  const dstA = buf[idx + 3] / 255
  const outA = alpha + dstA * (1 - alpha)
  if (outA <= 0) return
  buf[idx] = Math.round((r * alpha + buf[idx] * dstA * (1 - alpha)) / outA)
  buf[idx + 1] = Math.round((g * alpha + buf[idx + 1] * dstA * (1 - alpha)) / outA)
  buf[idx + 2] = Math.round((b * alpha + buf[idx + 2] * dstA * (1 - alpha)) / outA)
  buf[idx + 3] = Math.round(outA * 255)
}

const diagLen = Math.hypot(N, N)
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const idx = (y * N + x) * 4
    if (!inRoundRect(x, y)) continue // 保持透明
    // 45° 对角渐变
    const t = Math.min(1, Math.max(0, (x + y) / diagLen))
    buf[idx] = lerp(BG1[0], BG2[0], t)
    buf[idx + 1] = lerp(BG1[1], BG2[1], t)
    buf[idx + 2] = lerp(BG1[2], BG2[2], t)
    buf[idx + 3] = 255
    // 投影
    if (inPoly(x, y, shadowL) || inPoly(x, y, shadowR)) blendAt(idx, SHADOW, 70 / 255)
    // 白色碎片
    if (inPoly(x, y, leftPiece) || inPoly(x, y, rightPiece)) blendAt(idx, WHITE, 1)
    // 切缝高光
    else if (distToSeg(x, y, cutA, cutB) <= s(2.5)) blendAt(idx, WHITE, 150 / 255)
  }
}

// ---------- 降采样 ----------
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const idx = ((y * SS + sy) * N + (x * SS + sx)) * 4
        const al = buf[idx + 3] / 255
        r += buf[idx] * al
        g += buf[idx + 1] * al
        b += buf[idx + 2] * al
        a += al
      }
    }
    const cnt = SS * SS
    const o = (y * SIZE + x) * 4
    if (a > 0) {
      out[o] = Math.round(r / a)
      out[o + 1] = Math.round(g / a)
      out[o + 2] = Math.round(b / a)
    }
    out[o + 3] = Math.round((a / cnt) * 255)
  }
}

// ---------- PNG 编码 ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// 行前加 filter 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
writeFileSync(new URL('../build/icon.png', import.meta.url), png)
console.log(`icon.png ${SIZE}x${SIZE} (${(png.length / 1024).toFixed(1)} KB)`)
