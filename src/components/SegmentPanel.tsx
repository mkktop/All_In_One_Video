import { useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { formatShort } from '@/lib/timecode'

export function SegmentPanel(): ReactNode {
  const info = useEditor((s) => s.media.info)
  const segments = useEditor((s) => s.segments)
  const inPoint = useEditor((s) => s.selection.inPoint)
  const outPoint = useEditor((s) => s.selection.outPoint)
  const addSegment = useEditor((s) => s.addSegment)
  const removeSegment = useEditor((s) => s.removeSegment)
  const loadSegment = useEditor((s) => s.loadSegment)
  const clearSegments = useEditor((s) => s.clearSegments)
  const exportMerge = useEditor((s) => s.exportMerge)
  const [hover, setHover] = useState<string | null>(null)

  const canAdd = info != null && inPoint != null && outPoint != null && outPoint > inPoint
  const totalDur = segments.reduce((s, sg) => s + (sg.end - sg.start), 0)

  return (
    <section className="flex min-h-0 shrink-0 flex-col border-b border-zinc-800 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">
          片段 <span className="text-zinc-500">{segments.length > 0 && `(${segments.length})`}</span>
        </h2>
        {segments.length > 0 && (
          <button className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300" onClick={clearSegments}>
            清空
          </button>
        )}
      </div>

      <div className="max-h-44 min-h-0 space-y-1 overflow-y-auto pr-0.5">
        {segments.length === 0 && (
          <p className="leading-5 text-zinc-600">设置入出点后点「＋ 添加片段」，多段可合并导出为一个视频</p>
        )}
        {segments.map((sg, i) => (
          <div
            key={sg.id}
            className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 transition-colors ${
              hover === sg.id ? 'border-sky-600/60 bg-sky-600/10' : 'border-zinc-800 bg-[#1c1c1f]'
            }`}
            onMouseEnter={() => setHover(sg.id)}
            onMouseLeave={() => setHover(null)}
            onClick={() => loadSegment(sg.id)}
            title="点击载入到入出点进行微调"
          >
            <span className="w-5 shrink-0 text-center font-mono text-zinc-500">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-mono tabular-nums text-zinc-300">
              {formatShort(sg.start)} → {formatShort(sg.end)}
            </span>
            <span className="shrink-0 text-zinc-500">{(sg.end - sg.start).toFixed(1)}s</span>
            <button
              className="shrink-0 px-1 text-zinc-500 transition-colors hover:text-red-400"
              title="删除片段"
              onClick={(e) => {
                e.stopPropagation()
                removeSegment(sg.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <button
          disabled={!canAdd}
          onClick={addSegment}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 py-1.5 font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋ 添加片段
        </button>
        <button
          disabled={segments.length === 0 || !info}
          onClick={() => void exportMerge()}
          className="flex-1 rounded-md bg-emerald-600 py-1.5 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          title={`按时间顺序合并 ${segments.length} 段为一个视频`}
        >
          合并导出{segments.length > 0 ? ` ${segments.length} 段` : ''}
        </button>
      </div>
      {segments.length > 1 && (
        <p className="mt-1.5 text-center text-[10px] text-zinc-600">合计 {totalDur.toFixed(1)}s，段间无缝拼接</p>
      )}
    </section>
  )
}
