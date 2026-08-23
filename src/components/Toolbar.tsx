import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { formatShort } from '@/lib/timecode'
import { onMaximizedChanged, onUpdateState } from '@/ipc'
import type { UpdateState } from '@shared/types'

/** 应用主强调色（靛蓝）及悬停态 */
export const ACCENT = '#6366F1'
export const ACCENT_HOVER = '#5457E0'

/** 窗口控制按钮（frameless 自定义标题栏；macOS 用系统红绿灯，不渲染） */
function CaptionButtons(): ReactNode | null {
  const [maximized, setMaximized] = useState(false)
  const platform = useEditor((s) => s.capabilities?.platform)

  useEffect(() => onMaximizedChanged(setMaximized), [])

  if (platform === 'darwin') return null

  const btn = 'titlebar-no-drag flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100'
  return (
    <div className="-mr-4 flex h-full items-stretch self-stretch">
      <button title="最小化" className={btn} onClick={() => void window.aiov.minimizeWindow()}>
        <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1">
          <path d="M1 6h10" />
        </svg>
      </button>
      <button
        title={maximized ? '还原' : '最大化'}
        className={btn}
        onClick={() => void window.aiov.toggleMaximize()}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="1" y="3.5" width="7" height="7" />
            <path d="M3.5 3.5V1.5H10.5V8.5H8.5" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="1.5" y="1.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        title="关闭"
        className="titlebar-no-drag flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-[#C42B1C] hover:text-white"
        onClick={() => void window.aiov.closeWindow()}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.1">
          <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}

function GearIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  )
}

/** 更新提示：有新版 → 点击下载 → 进度 → 重启安装（无更新/不支持时隐藏） */
function UpdateChip(): ReactNode {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => onUpdateState(setState), [])

  if (!state) return null

  if (state.phase === 'downloading') {
    return (
      <span
        className="rounded-full border px-3 py-1.5 text-xs"
        style={{ borderColor: ACCENT, color: ACCENT }}
      >
        正在下载 {state.percent ?? 0}%
      </span>
    )
  }

  if (state.phase === 'ready') {
    return (
      <button
        title={`v${state.version} 已就绪，重启后生效`}
        onClick={() => void window.aiov.installUpdate()}
        className="rounded-full px-3 py-1.5 text-xs font-medium text-white shadow transition-colors"
        style={{ background: ACCENT }}
        onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_HOVER)}
        onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}
      >
        重启更新
      </button>
    )
  }

  return (
    <button
      title={`下载新版本 v${state.version}`}
      onClick={() => void window.aiov.downloadUpdate()}
      className="rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-white/10"
      style={{ borderColor: ACCENT, color: ACCENT }}
    >
      新版本 v{state.version}
    </button>
  )
}

/** 设置下拉菜单 */
function SettingsMenu({ onClose }: { onClose: () => void }): ReactNode {
  const settings = useEditor((s) => s.settings)
  const saveSettings = useEditor((s) => s.saveSettings)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  return (
    <div ref={ref} className="absolute right-0 top-9 z-50 w-80 rounded-lg border border-zinc-700 bg-[#1F1F21] p-3 text-xs shadow-2xl">
      <h3 className="mb-2.5 text-[13px] font-semibold text-zinc-100">设置</h3>

      <div className="mb-3">
        <p className="mb-1.5 text-zinc-400">导出目录</p>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded bg-zinc-800 px-2 py-1.5 text-zinc-300" title={settings.exportDir ?? '视频所在目录'}>
            {settings.exportDir ?? '视频所在目录（默认）'}
          </span>
          <button
            className="shrink-0 rounded border border-zinc-600 px-2 py-1.5 text-zinc-300 transition-colors hover:bg-zinc-700"
            onClick={async () => {
              const dir = await window.aiov.pickDirectory()
              if (dir) void saveSettings({ exportDir: dir })
            }}
          >
            浏览…
          </button>
          {settings.exportDir && (
            <button
              title="恢复为视频所在目录"
              className="shrink-0 px-1 text-zinc-500 transition-colors hover:text-zinc-300"
              onClick={() => void saveSettings({ exportDir: null })}
            >
              重置
            </button>
          )}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-zinc-400">输出格式</p>
        <div className="flex rounded-md bg-zinc-800 p-0.5">
          {(['mp4', 'mkv'] as const).map((c) => (
            <button
              key={c}
              onClick={() => void saveSettings({ container: c })}
              className={`flex-1 rounded py-1 font-medium uppercase transition-colors ${
                settings.container === c ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              style={settings.container === c ? { background: ACCENT } : undefined}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Toolbar(): ReactNode {
  const info = useEditor((s) => s.media.bin.find((b) => b.info.path === s.media.activePath)?.info ?? null)
  const platform = useEditor((s) => s.capabilities?.platform)
  const scanning = useEditor((s) => s.media.scanning)
  const scanPercent = useEditor((s) => s.media.scanPercent)
  const page = useEditor((s) => s.page)
  const setPage = useEditor((s) => s.setPage)
  const openMedia = useEditor((s) => s.openMedia)
  const openMediaPath = useEditor((s) => s.openMediaPath)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)

  const [recent, setRecent] = useState<string[]>([])
  const [recentOpen, setRecentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
    <header
      className="titlebar-drag flex h-12 shrink-0 items-center gap-4 border-b border-black/50 bg-[#1D1D1F] px-4"
      style={platform === 'darwin' ? { paddingLeft: '5rem' } : undefined}
    >
      {/* Logo */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg shadow"
          style={{ background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)' }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
        <span className="text-sm font-bold tracking-wide text-zinc-100">All In One Video</span>
      </div>

      {/* 导航页签 */}
      <nav className="titlebar-no-drag ml-2 flex h-full shrink-0 items-center gap-1 text-[13px]">
        {(
          [
            { key: 'edit', label: '剪辑' },
            { key: 'transcode', label: '转码' }
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setPage(t.key)}
            className="relative flex h-full items-center px-3 font-medium transition-colors"
            style={page === t.key ? { color: ACCENT, fontWeight: 600 } : { color: '#71717a' }}
          >
            {t.label}
            {page === t.key && (
              <span className="absolute inset-x-3 bottom-0 h-[2.5px] rounded-full" style={{ background: ACCENT }} />
            )}
          </button>
        ))}
      </nav>

      {/* 文件信息（居中，轻量文本） */}
      <div className="mx-auto flex min-w-0 items-center gap-2 text-xs text-zinc-500">
        {info ? (
          <>
            <span className="max-w-52 truncate font-medium text-zinc-300" title={info.path}>
              {info.fileName}
            </span>
            {info.video && <span>{info.video.width}×{info.video.height}</span>}
            {info.video && <span className="uppercase">{info.video.codec}</span>}
            {info.video && <span>{info.video.fps.toFixed(1)}fps</span>}
            {info.isVfr && <span className="text-amber-400">VFR</span>}
            <span>{formatShort(info.durationSec)}</span>
          </>
        ) : (
          <span>未打开文件 · 可直接拖入视频</span>
        )}
        {scanning && (
          <span className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: ACCENT, color: ACCENT }}>
            扫描关键帧 {scanPercent}%
          </span>
        )}
      </div>

      {/* 右侧操作 */}
      <div className="titlebar-no-drag flex shrink-0 items-center gap-1">
        <UpdateChip />
        <button
          title="撤销（Ctrl+Z）"
          disabled={!canUndo}
          onClick={undo}
          className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
        >
          ↶
        </button>
        <button
          title="重做（Ctrl+Y）"
          disabled={!canRedo}
          onClick={redo}
          className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
        >
          ↷
        </button>
        <div className="relative">
          <button
            title="设置"
            onClick={() => setSettingsOpen((v) => !v)}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-white/10 ${settingsOpen ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            <GearIcon />
          </button>
          {settingsOpen && <SettingsMenu onClose={() => setSettingsOpen(false)} />}
        </div>
        <div className="relative" ref={recentRef}>
          <button
            onClick={() => setRecentOpen((v) => !v)}
            className="rounded-full px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10"
          >
            最近
          </button>
          {recentOpen && (
            <div className="absolute right-0 top-9 z-50 w-72 rounded-lg border border-zinc-700 bg-[#1F1F21] p-1 shadow-2xl">
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
                    className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-white/10"
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
          className="rounded-full px-4 py-1.5 text-xs font-medium text-white shadow transition-colors"
          style={{ background: ACCENT }}
          onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_HOVER)}
          onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}
        >
          打开文件
        </button>
      </div>

      {/* 窗口控制：最小化 / 最大化 / 关闭 */}
      <CaptionButtons />
    </header>
  )
}
