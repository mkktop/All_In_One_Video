import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { formatShort } from '@/lib/timecode'

function Chip({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <span className={`rounded bg-zinc-800 px-1.5 py-0.5 ${className}`}>{children}</span>
}

export function Toolbar(): ReactNode {
  const info = useEditor((s) => s.media.info)
  const scanning = useEditor((s) => s.media.scanning)
  const scanPercent = useEditor((s) => s.media.scanPercent)
  const openMedia = useEditor((s) => s.openMedia)
  const openMediaPath = useEditor((s) => s.openMediaPath)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)

  const [recent, setRecent] = useState<string[]>([])
  const [recentOpen, setRecentOpen] = useState(false)
  const recentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!recentOpen) return
    void window.aiov.recentFiles().then(setRecent)
    const onDown = (e: MouseEvent): void => {
      if (!recentRef.current?.contains(e.target as Node)) setRecentOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [recentOpen])

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-[#181818] px-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-4 w-4 rounded-sm bg-gradient-to-br from-sky-500 to-indigo-500" />
        <span className="text-sm font-semibold tracking-wide">All In One Video</span>
      </div>
      <div className="mx-2 h-5 w-px bg-zinc-700" />
      {info ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
          <span className="max-w-56 truncate font-medium text-zinc-200" title={info.path}>
            {info.fileName}
          </span>
          {info.video && <Chip>{info.video.width}×{info.video.height}</Chip>}
          {info.video && <Chip>{info.video.codec.toUpperCase()}</Chip>}
          {info.video && <Chip>{info.video.fps.toFixed(2)} fps</Chip>}
          {info.isVfr && <Chip className="!text-amber-400">VFR</Chip>}
          <Chip>{formatShort(info.durationSec)}</Chip>
        </div>
      ) : (
        <span className="text-xs text-zinc-500">未打开文件 · 可直接拖入视频</span>
      )}
      {scanning && <Chip className="!text-sky-400">扫描关键帧 {scanPercent}%</Chip>}
      <div className="flex-1" />
      <button
        title="撤销（Ctrl+Z）"
        disabled={!canUndo}
        onClick={undo}
        className="rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
      >
        ↶ 撤销
      </button>
      <button
        title="重做（Ctrl+Y）"
        disabled={!canRedo}
        onClick={redo}
        className="rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
      >
        ↷ 重做
      </button>
      <div className="relative" ref={recentRef}>
        <button
          onClick={() => setRecentOpen((v) => !v)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
        >
          最近
        </button>
        {recentOpen && (
          <div className="absolute right-0 top-9 z-50 w-72 rounded-md border border-zinc-700 bg-[#1c1c1f] p-1 shadow-xl">
            {recent.length === 0 && <p className="px-2 py-2 text-xs text-zinc-600">暂无记录</p>}
            {recent.map((p) => {
              const name = p.replace(/^.*[\\/]/, '')
              return (
                <button
                  key={p}
                  title={p}
                  onClick={() => {
                    setRecentOpen(false)
                    void openMediaPath(p)
                  }}
                  className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
                >
                  {name}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <button
        onClick={() => void openMedia()}
        className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500"
      >
        打开文件
      </button>
    </header>
  )
}
