import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { ACCENT, ACCENT_HOVER } from '@/components/Toolbar'
import { lastKeyframeAtOrBefore, firstKeyframeAtOrAfter } from '@shared/planner'
import { formatShort } from '@/lib/timecode'

/** 主轨道：剪映式片段序列（跨素材），拖拽排序 / 拖边缘修剪 / 点击载入编辑 */
export function TrackTimeline(): ReactNode {
  const clips = useEditor((s) => s.clips)
  const bin = useEditor((s) => s.media.bin)
  const mode = useEditor((s) => s.selection.mode)
  const openExportDialog = useEditor((s) => s.openExportDialog)
  const clearClips = useEditor((s) => s.clearClips)
  const removeClip = useEditor((s) => s.removeClip)
  const moveClip = useEditor((s) => s.moveClip)
  const trimClip = useEditor((s) => s.trimClip)
  const beginClipDrag = useEditor((s) => s.beginClipDrag)
  const loadClipToSelection = useEditor((s) => s.loadClipToSelection)

  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  // 边缘拖拽的换算基准（拖拽期间冻结，避免宽度回流抖动）
  const edgeDrag = useRef<{ id: string; edge: 'start' | 'end'; baseValue: number; pxPerSec: number; blockLeft: number } | null>(null)

  const totalDur = clips.reduce((s, c) => s + (c.end - c.start), 0)

  /** 块内显示源文件波形切片：背景图按比例定位（bgWidth = 源时长/片段时长 倍） */
  const waveStyle = (clip: { path: string; start: number; end: number }): CSSProperties => {
    const entry = bin.find((b) => b.info.path === clip.path)
    if (!entry?.waveformUrl) return {}
    const srcDur = entry.info.durationSec
    const clipDur = clip.end - clip.start
    if (srcDur <= 0 || clipDur >= srcDur) {
      return { backgroundImage: `url(${entry.waveformUrl})`, backgroundSize: '100% 100%', opacity: 0.5 }
    }
    const s = srcDur / clipDur
    const f = clip.start / srcDur
    const p = (f * s) / (s - 1) * 100
    return {
      backgroundImage: `url(${entry.waveformUrl})`,
      backgroundSize: `${s * 100}% 100%`,
      backgroundPosition: `${p}% center`,
      opacity: 0.45
    }
  }

  const onEdgeDown = (e: React.PointerEvent, clipId: string, edge: 'start' | 'end'): void => {
    e.stopPropagation()
    const clip = clips.find((c) => c.id === clipId)
    const track = trackRef.current
    const block = (e.currentTarget as HTMLElement).parentElement
    if (!clip || !track || !block || totalDur <= 0) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    beginClipDrag()
    edgeDrag.current = {
      id: clipId,
      edge,
      baseValue: edge === 'start' ? clip.start : clip.end,
      pxPerSec: track.clientWidth / totalDur,
      blockLeft: block.offsetLeft
    }
  }

  const onEdgeMove = (e: React.PointerEvent): void => {
    const d = edgeDrag.current
    if (!d) return
    const clip = clips.find((c) => c.id === d.id)
    const track = trackRef.current
    if (!clip || !track) return
    const rect = track.getBoundingClientRect()
    const deltaSec = (e.clientX - rect.left - d.blockLeft) / d.pxPerSec
    let value = d.baseValue + deltaSec
    // 吸附：最近关键帧 10px 内磁吸
    if (mode === 'keyframe-snap') {
      const entry = bin.find((b) => b.info.path === clip.path)
      const kfs = entry?.keyframes ?? []
      const snapPx = 10 * (1 / d.pxPerSec)
      if (d.edge === 'start') {
        const kf = firstKeyframeAtOrAfter(kfs, Math.max(0, value - snapPx))
        if (kf != null && Math.abs(kf - value) <= snapPx) value = kf
      } else {
        const kf = lastKeyframeAtOrBefore(kfs, value + snapPx)
        if (kf != null && Math.abs(kf - value) <= snapPx) value = kf
      }
    }
    trimClip(d.id, d.edge, value)
  }

  const onEdgeUp = (e: React.PointerEvent): void => {
    if (edgeDrag.current) {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      edgeDrag.current = null
    }
  }

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-[#141416] px-3 pb-2 pt-1.5">
      {/* 头部：统计 + 操作 */}
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className="font-semibold text-zinc-500">
          主轨道{clips.length > 0 && ` · ${clips.length} 段 · 共 ${formatShort(totalDur)}`}
        </span>
        <span className="flex-1" />
        {clips.length > 0 && (
          <>
            <button className="text-zinc-500 transition-colors hover:text-zinc-300" onClick={clearClips}>
              清空
            </button>
            <button
              onClick={() => openExportDialog('merge')}
              className="rounded-full px-3.5 py-1 text-[11px] font-semibold text-white shadow"
              style={{ background: ACCENT }}
              onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_HOVER)}
              onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}
            >
              合并导出 {clips.length} 段
            </button>
          </>
        )}
      </div>

      {/* 轨道块 */}
      {clips.length === 0 ? (
        <div className="flex h-16 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-600">
          在上方时间轴设好入出点后点「＋加入轨道」，可从多个素材依次截取，拖拽调整顺序
        </div>
      ) : (
        <div ref={trackRef} className="flex h-16 items-stretch gap-1 overflow-x-auto pb-1">
          {clips.map((c, i) => {
            const dur = c.end - c.start
            const style = waveStyle(c)
            const isDragTarget = dragOverIdx === i && dragFrom != null && dragFrom !== i
            return (
              <div
                key={c.id}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDragOverIdx(null)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOverIdx(i)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragFrom != null && dragFrom !== i) moveClip(dragFrom, i)
                  setDragFrom(null)
                  setDragOverIdx(null)
                }}
                onMouseEnter={() => setHoverId(c.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={() => loadClipToSelection(c.id)}
                className={`group relative shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-[#1F1F23] transition-colors ${
                  isDragTarget ? 'border-zinc-400' : 'border-zinc-700 hover:border-zinc-500'
                }`}
                style={{ width: `${Math.max(56, (dur / (totalDur || 1)) * 100)}%`, minWidth: 56 }}
                title={`${c.fileName} · ${formatShort(dur)}（点击载入编辑，拖动边缘微调，拖拽排序）`}
              >
                {/* 波形底图 */}
                <div className="pointer-events-none absolute inset-0" style={style} />
                {/* 序号 */}
                <span className="pointer-events-none absolute left-1.5 top-1 rounded bg-black/50 px-1 text-[9px] font-medium text-zinc-300">
                  {i + 1}
                </span>
                {/* 删除 */}
                <button
                  className={`absolute right-1 top-1 rounded px-1 text-[11px] leading-4 text-zinc-400 transition-opacity hover:text-red-400 ${
                    hoverId === c.id ? 'opacity-100' : 'opacity-0'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeClip(c.id)
                  }}
                >
                  ×
                </button>
                {/* 文件名 + 时长 */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-1.5 pb-1">
                  <span className="max-w-[70%] truncate text-[10px] text-zinc-300">{c.fileName}</span>
                  <span className="text-[10px] text-zinc-500">{dur.toFixed(1)}s</span>
                </div>
                {/* 左右边缘修剪把手 */}
                <div
                  className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 transition-colors hover:bg-white/20"
                  onPointerDown={(e) => onEdgeDown(e, c.id, 'start')}
                  onPointerMove={onEdgeMove}
                  onPointerUp={onEdgeUp}
                />
                <div
                  className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 transition-colors hover:bg-white/20"
                  onPointerDown={(e) => onEdgeDown(e, c.id, 'end')}
                  onPointerMove={onEdgeMove}
                  onPointerUp={onEdgeUp}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
