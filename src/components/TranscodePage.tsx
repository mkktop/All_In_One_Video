import { useEffect, useState, type ReactNode } from 'react'
import { useTranscode } from '@/stores/transcode'
import { useEditor } from '@/stores/editor'
import { ACCENT } from '@/components/Toolbar'
import { formatShort } from '@/lib/timecode'

const STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '转码中',
  done: '完成',
  failed: '失败',
  canceled: '已取消'
}

function presetSummary(p: { videoCodec: string; quality: string; scale: string; container: string }): string {
  if (p.videoCodec === 'copy') return `流复制 → ${p.container.toUpperCase()}`
  const codecName = { h264: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1' }[p.videoCodec] ?? p.videoCodec
  const q = { high: '高质量', balanced: '均衡', compact: '小体积' }[p.quality] ?? ''
  const s = p.scale === 'source' ? '' : ` ${p.scale}`
  return `${codecName} ${q}${s} → ${p.container.toUpperCase()}`
}

function Select<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; disabled?: boolean }): ReactNode {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none transition-colors focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function TranscodePage(): ReactNode {
  const preset = useTranscode((s) => s.preset)
  const setPreset = useTranscode((s) => s.setPreset)
  const concurrency = useTranscode((s) => s.concurrency)
  const setConcurrency = useTranscode((s) => s.setConcurrency)
  const pending = useTranscode((s) => s.pending)
  const jobs = useTranscode((s) => s.jobs)
  const order = useTranscode((s) => s.order)
  const addFiles = useTranscode((s) => s.addFiles)
  const removePending = useTranscode((s) => s.removePending)
  const clearFinished = useTranscode((s) => s.clearFinished)
  const submitAll = useTranscode((s) => s.submitAll)
  const retry = useTranscode((s) => s.retry)
  const cancel = useTranscode((s) => s.cancel)
  const exportDir = useEditor((s) => s.settings.exportDir)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void useTranscode.getState().setConcurrency(concurrency)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isCopy = preset.videoCodec === 'copy'
  const jobList = order.map((id) => jobs[id]).filter((j): j is NonNullable<typeof j> => j != null)
  const activeCount = jobList.filter((j) => j.state === 'running' || j.state === 'queued').length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {/* 预设面板 */}
      <section className="rounded-xl border border-zinc-800 bg-[#1A1A1C] p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-100">转码预设</h2>
        <div className="grid grid-cols-5 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-zinc-500">编码格式</label>
            <Select
              value={preset.videoCodec}
              onChange={(v) => setPreset({ videoCodec: v })}
              options={[
                { value: 'copy', label: '直接复制（秒转）' },
                { value: 'h264', label: 'H.264 兼容性最好' },
                { value: 'hevc', label: 'H.265 省空间' },
                { value: 'vp9', label: 'VP9' },
                { value: 'av1', label: 'AV1' }
              ]}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-zinc-500">质量</label>
            <Select
              value={preset.quality}
              disabled={isCopy}
              onChange={(v) => setPreset({ quality: v })}
              options={[
                { value: 'high', label: '高质量' },
                { value: 'balanced', label: '均衡' },
                { value: 'compact', label: '小体积' }
              ]}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-zinc-500">分辨率</label>
            <Select
              value={preset.scale}
              disabled={isCopy}
              onChange={(v) => setPreset({ scale: v })}
              options={[
                { value: 'source', label: '保持原始' },
                { value: '1080p', label: '最高 1080p' },
                { value: '720p', label: '最高 720p' }
              ]}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-zinc-500">音频</label>
            <Select
              value={preset.audio}
              onChange={(v) => setPreset({ audio: v })}
              options={[
                { value: 'copy', label: '直接复制' },
                { value: 'aac', label: '转 AAC 192k' }
              ]}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-zinc-500">容器</label>
            <Select
              value={preset.container}
              onChange={(v) => setPreset({ container: v })}
              options={[
                { value: 'mp4', label: 'MP4' },
                { value: 'mkv', label: 'MKV' },
                { value: 'webm', label: 'WebM' },
                { value: 'mov', label: 'MOV' }
              ]}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 text-[11px] text-zinc-500">
          <span>输出目录：{exportDir ?? '各视频所在目录'}</span>
          <span className="flex items-center gap-1">
            并发
            <input
              type="number"
              min={1}
              max={4}
              value={concurrency}
              onChange={(e) => void setConcurrency(Number(e.target.value))}
              className="w-12 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-center text-xs text-zinc-200 outline-none"
            />
          </span>
          {isCopy && <span className="text-amber-400">直接复制仅做容器互换，画面音频完全无损、秒级完成；缩放需选择具体编码</span>}
        </div>
      </section>

      {/* 拖放区 */}
      <section
        className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
          dragOver ? 'border-zinc-400 bg-white/5' : 'border-zinc-700 bg-[#1A1A1C]'
        }`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const paths: string[] = []
          for (const f of Array.from(e.dataTransfer.files)) {
            try {
              paths.push(window.aiov.getPathForFile(f))
            } catch {
              // 忽略无法解析的项
            }
          }
          addFiles(paths)
        }}
      >
        <p className="text-xs text-zinc-400">拖入视频文件（可多选），或</p>
        <div className="mt-2 flex justify-center gap-2">
          <button
            onClick={async () => addFiles(await window.aiov.pickVideoFiles())}
            className="rounded-full px-4 py-1.5 text-xs font-medium text-white shadow"
            style={{ background: ACCENT }}
          >
            选择文件
          </button>
          <button
            onClick={async () => addFiles(await window.aiov.pickVideoFolder())}
            className="rounded-full border border-zinc-600 px-4 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10"
          >
            选择文件夹
          </button>
        </div>
      </section>

      {/* 待转列表 */}
      {pending.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-[#1A1A1C] p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-zinc-200">待转码（{pending.length}）</h3>
            <div className="flex gap-2">
              <button
                onClick={async () => await submitAll(exportDir ?? undefined)}
                className="rounded-full px-4 py-1 text-xs font-semibold text-white shadow"
                style={{ background: ACCENT }}
              >
                开始转码
              </button>
            </div>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {pending.map((p) => (
              <div key={p} className="flex items-center gap-2 rounded bg-[#1F1F21] px-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate text-zinc-300" title={p}>
                  {p.replace(/^.*[\\/]/, '')}
                </span>
                <span className="text-zinc-500">{presetSummary(preset)}</span>
                <button className="px-1 text-zinc-500 transition-colors hover:text-red-400" onClick={() => removePending(p)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 任务表格 */}
      <section className="min-h-0 flex-1 rounded-xl border border-zinc-800 bg-[#1A1A1C] p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-200">
            任务（{jobList.length}）{activeCount > 0 && <span className="ml-1 text-zinc-500">{activeCount} 个进行中</span>}
          </h3>
          {jobList.length > 0 && (
            <button onClick={clearFinished} className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
              清除已完成
            </button>
          )}
        </div>
        {jobList.length === 0 && <p className="py-6 text-center text-xs text-zinc-600">暂无任务</p>}
        <div className="space-y-1.5">
          {jobList.map((j) => (
            <div key={j.jobId} className="rounded-lg bg-[#1F1F21] px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-zinc-200" title={j.inputPath}>
                  {j.label}
                </span>
                <span className="shrink-0 text-zinc-500">{presetSummary(j.preset)}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    j.state === 'done'
                      ? 'bg-emerald-600/20 text-emerald-400'
                      : j.state === 'failed'
                        ? 'bg-red-600/20 text-red-400'
                        : j.state === 'running'
                          ? 'bg-sky-600/20 text-sky-400'
                          : 'bg-zinc-700 text-zinc-400'
                  }`}
                >
                  {STATE_LABEL[j.state]}
                </span>
              </div>
              {(j.state === 'running' || j.state === 'queued') && (
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full rounded-full transition-[width] duration-150" style={{ width: `${j.percent}%`, background: ACCENT }} />
                  </div>
                  <span className="w-24 shrink-0 text-right text-[11px] text-zinc-500">
                    {j.percent.toFixed(0)}% {j.speed ?? ''}
                  </span>
                  <button className="shrink-0 text-red-400 transition-colors hover:text-red-300" onClick={() => void cancel(j.jobId)}>
                    取消
                  </button>
                </div>
              )}
              {j.state === 'done' && j.outputPath && (
                <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <button
                    className="text-sky-400 transition-colors hover:text-sky-300"
                    onClick={() => void window.aiov.openPath(j.outputPath!.replace(/[\\/][^\\/]+$/, ''))}
                  >
                    打开所在文件夹
                  </button>
                  <span>{((j.durationMs ?? 0) / 1000).toFixed(1)}s 完成</span>
                </div>
              )}
              {j.state === 'failed' && (
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-zinc-500" title={j.error}>
                    {j.error}
                  </span>
                  <button className="shrink-0 text-sky-400 transition-colors hover:text-sky-300" onClick={() => void retry(j.jobId)}>
                    重试
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {jobList.length > 0 && (
        <p className="pb-1 text-center text-[10px] text-zinc-600">
          已完成 {jobList.filter((j) => j.state === 'done').length} / {jobList.length}
          {jobList.some((j) => j.state === 'done' && j.durationMs != null) &&
            ` · 最快 ${Math.min(...jobList.filter((j) => j.state === 'done' && j.durationMs != null).map((j) => j.durationMs!)) / 1000 < 1 ? '<1s' : formatShort(Math.min(...jobList.filter((j) => j.state === 'done' && j.durationMs != null).map((j) => j.durationMs!)) / 1000)}`}
        </p>
      )}
    </div>
  )
}
