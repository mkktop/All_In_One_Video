import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'

const RULER_H = 22
const BG = '#101012'
const RULER_BG = '#17171a'
const BORDER = '#26262b'
const LABEL = '#71717a'
const KEYFRAME = 'rgba(245, 158, 11, 0.45)'
const IO_FILL = 'rgba(59, 130, 246, 0.16)'
const IO_EDGE = '#3b82f6'
const IO_GRIP = '#60a5fa'
const PLAYHEAD = '#ef4444'

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600]

function clampOffset(offset: number, width: number, pxPerSec: number, duration: number): number {
  const maxOffset = Math.max(0, duration - width / pxPerSec)
  return Math.min(Math.max(offset, 0), maxOffset)
}

function formatRuler(t: number): string {
  if (t >= 3600) {
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    return `${h}:${String(m).padStart(2, '0')}`
  }
  if (t >= 60) {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }
  return `${t.toFixed(t < 10 ? 1 : 0)}s`
}

export function Timeline(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const active = useEditor((s) => s.media.bin.find((b) => b.info.path === s.media.activePath) ?? null)
  const info = active?.info ?? null
  const keyframes = active?.keyframes ?? []
  const waveformUrl = active?.waveformUrl ?? null
  const currentTime = useEditor((s) => s.playback.currentTime)
  const inPoint = useEditor((s) => s.selection.inPoint)
  const outPoint = useEditor((s) => s.selection.outPoint)
  const clips = useEditor((s) => s.clips)
  const activePath = useEditor((s) => s.media.activePath)
  const waveformRef = useRef<HTMLImageElement | null>(null)

  // 波形图加载（file:// 直载，img-src 已放行）
  useEffect(() => {
    waveformRef.current = null
    if (!waveformUrl) {
      setTick((t) => t + 1)
      return
    }
    const img = new Image()
    img.onload = () => {
      waveformRef.current = img
      setTick((t) => t + 1)
    }
    img.src = waveformUrl
  }, [waveformUrl])

  const view = useRef({ pxPerSec: 0, offsetSec: 0, width: 0 })
  const drag = useRef<null | 'playhead' | 'in' | 'out'>(null)
  const [tick, setTick] = useState(0)
  const [snapHint, setSnapHint] = useState<string | null>(null)
  const duration = info?.durationSec ?? 0

  const timeAtX = useCallback((x: number): number => view.current.offsetSec + x / view.current.pxPerSec, [])
  const xOf = useCallback((t: number): number => (t - view.current.offsetSec) * view.current.pxPerSec, [])

  // 尺寸自适应
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      view.current.width = rect.width
      if (duration > 0 && rect.width > 0) {
        const fit = rect.width / duration
        if (view.current.pxPerSec <= 0 || view.current.pxPerSec < fit) {
          view.current.pxPerSec = fit
          view.current.offsetSec = clampOffset(view.current.offsetSec, rect.width, fit, duration)
        }
      }
      setTick((t) => t + 1)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [duration])

  // 换文件重置视图
  useEffect(() => {
    view.current.pxPerSec = 0
    view.current.offsetSec = 0
    setTick((t) => t + 1)
  }, [info?.path])

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const W = view.current.width
    const H = canvas.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, W, H)

    if (duration <= 0 || view.current.pxPerSec <= 0) {
      ctx.fillStyle = LABEL
      ctx.font = '12px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('打开视频后此处显示时间轴', W / 2, H / 2)
      return
    }

    const { pxPerSec, offsetSec } = view.current
    const visible = W / pxPerSec

    // 标尺
    ctx.fillStyle = RULER_BG
    ctx.fillRect(0, 0, W, RULER_H)
    ctx.strokeStyle = BORDER
    ctx.beginPath()
    ctx.moveTo(0, RULER_H + 0.5)
    ctx.lineTo(W, RULER_H + 0.5)
    ctx.stroke()

    const step = STEPS.find((s) => s * pxPerSec >= 72) ?? STEPS[STEPS.length - 1]
    ctx.fillStyle = LABEL
    ctx.font = '10px system-ui, sans-serif'
    ctx.textAlign = 'left'
    const t0 = Math.floor(offsetSec / step) * step
    for (let t = t0; t <= offsetSec + visible + step; t += step) {
      if (t < 0) continue
      const x = Math.round((t - offsetSec) * pxPerSec) + 0.5
      if (x > W) break
      ctx.strokeStyle = 'rgba(113,113,122,0.5)'
      ctx.beginPath()
      ctx.moveTo(x, RULER_H - 6)
      ctx.lineTo(x, RULER_H)
      ctx.stroke()
      for (let i = 1; i < 5; i++) {
        const xm = Math.round((t + (step / 5) * i - offsetSec) * pxPerSec) + 0.5
        ctx.beginPath()
        ctx.moveTo(xm, RULER_H - 3)
        ctx.lineTo(xm, RULER_H)
        ctx.stroke()
      }
      ctx.fillText(formatRuler(t), x + 3, 11)
    }

    // 关键帧刻度（琥珀色竖线）
    if (keyframes.length > 0) {
      ctx.strokeStyle = KEYFRAME
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const kf of keyframes) {
        if (kf < offsetSec - 1 || kf > offsetSec + visible + 1) continue
        const x = Math.round((kf - offsetSec) * pxPerSec) + 0.5
        ctx.moveTo(x, RULER_H + 2)
        ctx.lineTo(x, H)
      }
      ctx.stroke()
    }

    // 波形图（整条音频拉伸铺在轨道底部）
    const wf = waveformRef.current
    if (wf && duration > 0) {
      const dx = (0 - offsetSec) * pxPerSec
      const dw = duration * pxPerSec
      ctx.globalAlpha = 0.5
      ctx.drawImage(wf, dx, RULER_H + 2, dw, H - RULER_H - 2)
      ctx.globalAlpha = 1
    }

    // 当前素材已加入轨道的片段（绿色区块，序号与主轨道一致）
    clips.forEach((sg, gi) => {
      if (sg.path !== activePath) return
      const x1 = xOf(sg.start)
      const x2 = xOf(sg.end)
      if (x2 < -10 || x1 > W + 10) return
      ctx.fillStyle = 'rgba(16, 185, 129, 0.16)'
      ctx.fillRect(x1, RULER_H + 2, x2 - x1, H - RULER_H - 2)
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.75)'
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x1) + 0.5, RULER_H + 2.5, Math.max(1, Math.round(x2 - x1) - 1), H - RULER_H - 3)
      if (x2 - x1 > 26) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.95)'
        ctx.font = '9px system-ui, sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(String(gi + 1), x1 + 3, RULER_H + 12)
      }
    })

    // 入出点选区
    if (inPoint != null && outPoint != null && outPoint > inPoint) {
      const x1 = xOf(inPoint)
      const x2 = xOf(outPoint)
      ctx.fillStyle = IO_FILL
      ctx.fillRect(x1, RULER_H + 2, x2 - x1, H - RULER_H - 2)
      ctx.fillStyle = IO_EDGE
      ctx.fillRect(Math.round(x1), RULER_H + 2, 2, H - RULER_H - 2)
      ctx.fillRect(Math.round(x2) - 2, RULER_H + 2, 2, H - RULER_H - 2)
      ctx.fillStyle = IO_GRIP
      ctx.fillRect(Math.round(x1) - 3, RULER_H - 4, 8, 6)
      ctx.fillRect(Math.round(x2) - 5, RULER_H - 4, 8, 6)
    } else {
      const single = inPoint ?? outPoint
      if (single != null) {
        ctx.fillStyle = IO_EDGE
        ctx.fillRect(Math.round(xOf(single)), RULER_H + 2, 2, H - RULER_H - 2)
      }
    }

    // 播放头
    const px = Math.round(xOf(currentTime)) + 0.5
    ctx.strokeStyle = PLAYHEAD
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px, 2)
    ctx.lineTo(px, H)
    ctx.stroke()
    ctx.fillStyle = PLAYHEAD
    ctx.beginPath()
    ctx.moveTo(px - 5, 2)
    ctx.lineTo(px + 5, 2)
    ctx.lineTo(px + 5, 8)
    ctx.lineTo(px, 13)
    ctx.lineTo(px - 5, 8)
    ctx.closePath()
    ctx.fill()
  }, [currentTime, inPoint, outPoint, keyframes, clips, activePath, duration, tick, timeAtX, xOf, waveformUrl])

  // 滚轮：Ctrl 缩放 / 平移
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || duration <= 0) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const v = view.current
      if (e.ctrlKey || e.metaKey) {
        const tAtCursor = v.offsetSec + x / v.pxPerSec
        const factor = Math.exp(-e.deltaY * 0.0015)
        const fit = rect.width / duration
        const next = Math.min(4000, Math.max(fit, v.pxPerSec * factor))
        v.pxPerSec = next
        v.offsetSec = clampOffset(tAtCursor - x / next, rect.width, next, duration)
      } else {
        v.offsetSec = clampOffset(v.offsetSec + (e.deltaY || e.deltaX) / v.pxPerSec, rect.width, v.pxPerSec, duration)
      }
      setTick((t) => t + 1)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [duration])

  /** 拖拽目标更新：入/出点在吸附模式下磁吸关键帧 */
  const applyDrag = useCallback((rawT: number): void => {
    const st = useEditor.getState()
    const active = st.media.bin.find((b) => b.info.path === st.media.activePath)
    const dur = active?.info.durationSec ?? 0
    const t = Math.min(Math.max(rawT, 0), dur)
    if (drag.current === 'playhead') {
      st.seek(t)
      return
    }
    const snap = st.selection.mode === 'keyframe-snap'
    let value = t
    let hint: string | null = null
    const activeKfs = active?.keyframes ?? []
    if (snap && activeKfs.length > 0 && view.current.pxPerSec > 0) {
      let nearest: number | null = null
      let nearestDist = Infinity
      for (const kf of activeKfs) {
        const d = Math.abs(kf - t)
        if (d < nearestDist) {
          nearestDist = d
          nearest = kf
        }
      }
      if (nearest != null && nearestDist * view.current.pxPerSec < 10) {
        const offset = nearest - t
        hint = `已吸附关键帧（${offset >= 0 ? '延后' : '提前'} ${Math.abs(offset).toFixed(2)}s）`
        value = nearest
      }
    }
    if (drag.current === 'in') {
      const out = st.selection.outPoint
      if (out != null && value >= out) {
        value = Math.max(0, out - 0.001)
        hint = null
      }
      st.setInDirect(value)
      st.seek(value)
    } else {
      const inn = st.selection.inPoint
      if (inn != null && value <= inn) {
        value = Math.min(dur, inn + 0.001)
        hint = null
      }
      st.setOutDirect(value)
      st.seek(value)
    }
    setSnapHint(hint)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (duration <= 0 || view.current.pxPerSec <= 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(e.pointerId)
    const x = e.nativeEvent.offsetX
    const st = useEditor.getState()
    const nearIn = st.selection.inPoint != null && Math.abs(x - xOf(st.selection.inPoint)) < 7
    const nearOut = st.selection.outPoint != null && Math.abs(x - xOf(st.selection.outPoint)) < 7
    drag.current = nearIn ? 'in' : nearOut ? 'out' : 'playhead'
    applyDrag(timeAtX(x))
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (!canvas || duration <= 0 || view.current.pxPerSec <= 0) return
    const x = e.nativeEvent.offsetX
    if (!drag.current) {
      const st = useEditor.getState()
      const nearPlay = Math.abs(x - xOf(st.playback.currentTime)) < 6
      const nearHandle =
        (st.selection.inPoint != null && Math.abs(x - xOf(st.selection.inPoint)) < 7) ||
        (st.selection.outPoint != null && Math.abs(x - xOf(st.selection.outPoint)) < 7) ||
        nearPlay
      canvas.style.cursor = nearHandle ? 'ew-resize' : 'default'
      return
    }
    applyDrag(timeAtX(x))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (drag.current) {
      canvasRef.current?.releasePointerCapture(e.pointerId)
      drag.current = null
    }
  }

  return (
    <div ref={wrapRef} className="relative h-28 shrink-0 border-t border-zinc-800">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {snapHint && (
        <div className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 rounded bg-amber-500/90 px-2 py-0.5 text-[11px] font-medium text-black">
          {snapHint}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-600">
        绿色区块=已加片段 · Ctrl+滚轮缩放 · 滚轮平移 · 拖动入/出点自动吸附关键帧
      </div>
    </div>
  )
}
