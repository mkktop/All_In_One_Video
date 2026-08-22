import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { ACCENT, ACCENT_HOVER } from '@/components/Toolbar'

const KIND_TITLE: Record<string, string> = {
  cut: '导出视频',
  merge: '合并导出',
  audio: '提取音频',
  video: '仅视频（去音轨）'
}

/** 导出确认弹窗：命名 + 目标目录展示/更改 */
export function ExportDialog(): ReactNode {
  const dialog = useEditor((s) => s.exportDialog)
  const info = useEditor((s) => s.media.bin.find((b) => b.info.path === s.media.activePath)?.info ?? null)
  const settings = useEditor((s) => s.settings)
  const clips = useEditor((s) => s.clips)
  const saveSettings = useEditor((s) => s.saveSettings)
  const confirmExport = useEditor((s) => s.confirmExport)
  const closeExportDialog = useEditor((s) => s.closeExportDialog)
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog.open) {
      setName(dialog.defaultName)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 30)
    }
  }, [dialog.open, dialog.defaultName])

  if (!dialog.open || !info) return null

  const dir = settings.exportDir ?? info.path.replace(/[\\/][^\\/]+$/, '')
  const isAac = info.audio[0]?.codec === 'aac'
  const ext = dialog.kind === 'audio' ? (isAac ? 'm4a' : 'mka') : settings.container

  const submit = (): void => {
    void confirmExport(name)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeExportDialog()
      }}
    >
      <div
        className="w-[26rem] rounded-xl border border-zinc-700 bg-[#1F1F21] p-5 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') closeExportDialog()
        }}
      >
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">{KIND_TITLE[dialog.kind] ?? '导出'}</h3>

        <label className="mb-1.5 block text-xs text-zinc-400">文件名（不含扩展名）</label>
        <div className="mb-3 flex items-center gap-2">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-800 px-2.5 py-2 text-xs text-zinc-100 outline-none focus:border-zinc-400"
          />
          <span className="shrink-0 text-xs text-zinc-500">.{ext}</span>
        </div>

        <label className="mb-1.5 block text-xs text-zinc-400">保存位置</label>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-md bg-zinc-800 px-2.5 py-2 text-xs text-zinc-300" title={dir}>
            {dir}
          </span>
          <button
            className="shrink-0 rounded-md border border-zinc-600 px-2.5 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
            onClick={async () => {
              const d = await window.aiov.pickDirectory()
              if (d) void saveSettings({ exportDir: d })
            }}
          >
            更改…
          </button>
        </div>
        <p className="mb-4 text-[11px] text-zinc-600">
          {dialog.kind === 'merge'
            ? `将按顺序合并 ${clips.length} 个片段为一个文件`
            : dialog.kind === 'audio'
              ? '音频流无损复制，速度极快'
              : dialog.kind === 'video'
                ? '去除音轨，画面无损'
                : '未设入出点时导出全片'}
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={closeExportDialog}
            className="rounded-full px-4 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
          >
            取消
          </button>
          <button
            onClick={submit}
            className="rounded-full px-5 py-1.5 text-xs font-semibold text-white shadow transition-colors"
            style={{ background: ACCENT }}
            onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_HOVER)}
            onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT)}
          >
            开始导出
          </button>
        </div>
      </div>
    </div>
  )
}
