import type { ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { lastKeyframeAtOrBefore } from '@shared/planner'
import { formatTimecode, frameNumber } from '@/lib/timecode'

function MiniBtn({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }): ReactNode {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function InOutPanel(): ReactNode {
  const info = useEditor((s) => s.media.info)
  const keyframes = useEditor((s) => s.media.keyframes)
  const inPoint = useEditor((s) => s.selection.inPoint)
  const outPoint = useEditor((s) => s.selection.outPoint)
  const mode = useEditor((s) => s.selection.mode)
  const setMode = useEditor((s) => s.setMode)
  const capabilities = useEditor((s) => s.capabilities)
  const setIn = useEditor((s) => s.setIn)
  const setOut = useEditor((s) => s.setOut)
  const clearSelection = useEditor((s) => s.clearSelection)
  const exportCut = useEditor((s) => s.exportCut)

  const fps = info?.video?.fps ?? 25
  const ready = info != null && inPoint != null && outPoint != null && outPoint > inPoint
  const selDur = inPoint != null && outPoint != null && outPoint > inPoint ? outPoint - inPoint : null

  // 吸附模式下，用快捷键 I 设的入点可能不在关键帧上，导出时会被迫提前——给出提示
  const snapOffset =
    ready && mode === 'keyframe-snap' && inPoint != null
      ? inPoint - (lastKeyframeAtOrBefore(keyframes, inPoint) ?? 0)
      : 0

  const smartEncoderName =
    capabilities?.encoder && info?.video
      ? info.video.codec === 'hevc'
        ? capabilities.encoder.hevc
        : capabilities.encoder.h264
      : null

  return (
    <section className="shrink-0 border-b border-zinc-800 p-3 text-xs">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">剪辑</h2>
        <div className="flex rounded-md bg-zinc-800 p-0.5">
          <button
            onClick={() => setMode('keyframe-snap')}
            className={`rounded px-2 py-0.5 transition-colors ${mode === 'keyframe-snap' ? 'bg-sky-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            吸附 · 秒切
          </button>
          <button
            onClick={() => setMode('smart')}
            className={`rounded px-2 py-0.5 transition-colors ${mode === 'smart' ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            精确 · Smart
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-zinc-500">入点</span>
          <span className="flex-1 truncate font-mono tabular-nums text-zinc-300">
            {inPoint != null ? `${formatTimecode(inPoint, fps)} · 帧 ${frameNumber(inPoint, fps)}` : '—'}
          </span>
          <MiniBtn title="设为当前帧（I）" disabled={!info} onClick={() => setIn()}>I</MiniBtn>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-zinc-500">出点</span>
          <span className="flex-1 truncate font-mono tabular-nums text-zinc-300">
            {outPoint != null ? `${formatTimecode(outPoint, fps)} · 帧 ${frameNumber(outPoint, fps)}` : '—'}
          </span>
          <MiniBtn title="设为当前帧（O）" disabled={!info} onClick={() => setOut()}>O</MiniBtn>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-zinc-500">时长</span>
          <span className="flex-1 font-mono tabular-nums text-zinc-300">{selDur != null ? formatTimecode(selDur, fps) : '—'}</span>
          <MiniBtn title="清除入出点" disabled={!info || (inPoint == null && outPoint == null)} onClick={clearSelection}>
            清除
          </MiniBtn>
        </div>
      </div>

      {mode === 'keyframe-snap' ? (
        snapOffset > 0.01 && (
          <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-4 text-amber-400">
            实际起点将提前 {snapOffset.toFixed(2)} 秒（吸附到关键帧，画面无损、导出秒级完成）
          </p>
        )
      ) : (
        <p className="mt-2 rounded bg-violet-500/10 px-2 py-1.5 text-[11px] leading-4 text-violet-300">
          帧级精确：入点到下一关键帧的小段
          {smartEncoderName ? `由 ${smartEncoderName} ` : ''}
          转码，其余全部流复制，速度与画质兼得
        </p>
      )}
      {mode === 'smart' && info?.isVfr && (
        <p className="mt-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-4 text-amber-400">
          该视频为可变帧率（VFR），精确模式按原始时间戳处理；如输出异常请改用吸附模式
        </p>
      )}

      <button
        disabled={!ready}
        onClick={() => void exportCut()}
        className={`mt-3 w-full rounded-md py-2 text-xs font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500 ${
          mode === 'smart' ? 'bg-violet-600 hover:bg-violet-500' : 'bg-sky-600 hover:bg-sky-500'
        }`}
      >
        {mode === 'smart' ? '导出选段（帧级精确 · Smart）' : '导出选段（流复制 · 无损秒切）'}
      </button>
    </section>
  )
}
