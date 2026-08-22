/** 秒 → "HH:MM:SS.mmm" */
export function formatTimecode(sec: number, _fps = 30): string {
  const clamped = Math.max(0, sec)
  const whole = Math.floor(clamped)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const ms = Math.round((clamped - whole) * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`
}

/** 秒 → "1:23.4"（简短显示） */
export function formatShort(sec: number): string {
  const clamped = Math.max(0, sec)
  const m = Math.floor(clamped / 60)
  const s = clamped % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** 时间 → 帧号 */
export function frameNumber(sec: number, fps: number): number {
  return Math.max(0, Math.round(sec * fps))
}
