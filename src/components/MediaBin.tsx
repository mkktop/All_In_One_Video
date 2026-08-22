import type { ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { ACCENT } from '@/components/Toolbar'
import { formatShort } from '@/lib/timecode'

/** 素材栏：多个视频的入口，点击切换当前编辑的素材 */
export function MediaBin(): ReactNode {
  const bin = useEditor((s) => s.media.bin)
  const activePath = useEditor((s) => s.media.activePath)
  const setActivePath = useEditor((s) => s.setActivePath)
  const openMedia = useEditor((s) => s.openMedia)

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-t border-zinc-800 bg-[#181818] px-3">
      <span className="shrink-0 text-[11px] font-semibold text-zinc-500">素材</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {bin.length === 0 && <span className="text-xs text-zinc-600">点「＋」或拖入视频添加素材（可多个）</span>}
        {bin.map((b) => {
          const active = b.info.path === activePath
          return (
            <button
              key={b.info.path}
              onClick={() => setActivePath(b.info.path)}
              title={b.info.path}
              className={`flex h-7 shrink-0 max-w-48 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
                active ? 'font-medium text-white' : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
              style={active ? { borderColor: ACCENT, background: 'rgba(99,102,241,0.15)' } : undefined}
            >
              <span className="truncate">{b.info.fileName}</span>
              <span className="shrink-0 text-[10px] opacity-60">{formatShort(b.info.durationSec)}</span>
            </button>
          )
        })}
      </div>
      <button
        onClick={() => void openMedia()}
        title="导入更多视频"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-600 text-sm text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-200"
      >
        ＋
      </button>
    </div>
  )
}
