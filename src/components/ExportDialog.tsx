import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { ACCENT, ACCENT_HOVER } from '@/components/Toolbar'
import { mergeIncompatibility } from '@shared/compat'

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
  const bin = useEditor((s) => s.media.bin)
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
  // 合并预检：各片段源参数不一致时将统一转码（与主进程 job-queue 的判定保持一致）
  const mergeIncompat =
    dialog.kind === 'merge'
      ? mergeIncompatibility(
          [...new Set(clips.map((c) => c.path))]
            .map((p) => bin.find((b) => b.info.path === p)?.info)
            .filter((x): x is NonNullable<typeof x> => x != null)
        )
      : null

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
        {dialog.kind === 'merge' ? (
          mergeIncompat ? (
            <p className="mb-4 rounded bg-amber-500/10 px-1.5 py-1.5 text-[11px] leading-4 text-amber-400">
              片段素材{mergeIncompat}，将统一转码为首个素材的参数后合并（有重编码损耗）
            </p>
          ) : (
            <p className="mb-4 text-[11px] text-zinc-600">将按顺序合并 {clips.length} 个片段为一个文件</p>
          )
        ) : dialog.kind === 'audio' ? (
          <p className="mb-4 text-[11px] text-zinc-600">音频流无损复制，速度极快</p>
        ) : dialog.kind === 'video' ? (
          <p className="mb-4 text-[11px] text-zinc-600">去除音轨，画面无损</p>
        ) : (
          <p className="mb-4 text-[11px] text-zinc-600">未设入出点时导出全片</p>
        )}

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
