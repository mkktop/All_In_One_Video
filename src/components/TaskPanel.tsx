import type { ReactNode } from 'react'
import { useEditor, type JobEntry } from '@/stores/editor'

const PHASE_LABEL: Record<JobEntry['phase'], string> = {
  planning: '规划中',
  copy: '流复制',
  encode: '转码',
  concat: '拼接',
  verifying: '校验中'
}

const STATE_LABEL: Record<JobEntry['state'], string> = {
  queued: '排队中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  canceled: '已取消'
}

function StateBadge({ state }: { state: JobEntry['state'] }): ReactNode {
  const cls: Record<string, string> = {
    queued: 'bg-zinc-700 text-zinc-300',
    running: 'bg-sky-600/20 text-sky-400',
    done: 'bg-emerald-600/20 text-emerald-400',
    failed: 'bg-red-600/20 text-red-400',
    canceled: 'bg-zinc-700 text-zinc-400'
  }
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${cls[state]}`}>{STATE_LABEL[state]}</span>
}

/** 渲染进程没有 node:path，用字符串操作取目录 */
function fileDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

export function TaskPanel(): ReactNode {
  const jobs = useEditor((s) => s.jobs)
  const jobOrder = useEditor((s) => s.jobOrder)
  const capabilities = useEditor((s) => s.capabilities)
  const list = jobOrder.map((id) => jobs[id]).filter((j): j is JobEntry => j != null)

  return (
    <section className="flex min-h-0 flex-1 flex-col p-3 text-xs">
      <h2 className="mb-2 shrink-0 text-sm font-semibold text-zinc-200">导出任务</h2>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
        {list.length === 0 && <p className="text-zinc-600">暂无任务</p>}
        {list.map((j) => (
          <div key={j.jobId} className="rounded-md border border-zinc-800 bg-[#1c1c1f] p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-zinc-300" title={j.label}>
                {j.label}
              </span>
              <StateBadge state={j.state} />
            </div>
            {(j.state === 'running' || j.state === 'queued') && (
              <>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-sky-500 transition-[width] duration-150" style={{ width: `${j.percent}%` }} />
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                  <span>
                    {PHASE_LABEL[j.phase]} · {j.percent.toFixed(0)}%
                  </span>
                  <div className="flex items-center gap-2">
                    {j.speed && <span>{j.speed}</span>}
                    <button className="text-red-400 transition-colors hover:text-red-300" onClick={() => void useEditor.getState().cancelJob(j.jobId)}>
                      取消
                    </button>
                  </div>
                </div>
              </>
            )}
            {j.state === 'done' && j.result?.outputPath && (
              <>
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <button
                    className="text-sky-400 transition-colors hover:text-sky-300"
                    onClick={() => void window.aiov.openPath(fileDir(j.result!.outputPath!))}
                  >
                    打开所在文件夹
                  </button>
                  <span className="text-zinc-600">{((j.result.durationMs ?? 0) / 1000).toFixed(1)}s 完成</span>
                </div>
                {j.result.notice && (
                  <p className="mt-1 rounded bg-amber-500/10 px-1.5 py-1 text-[11px] leading-4 text-amber-400">{j.result.notice}</p>
                )}
              </>
            )}
            {(j.state === 'failed' || j.state === 'canceled') && (
              <div className="mt-1 space-y-1 text-[11px]">
                {j.result?.error && <p className="break-all leading-4 text-zinc-500">{j.result.error}</p>}
                {j.request && (
                  <button
                    className="text-sky-400 transition-colors hover:text-sky-300"
                    onClick={() => void useEditor.getState().retryJob(j.jobId)}
                  >
                    重新导出
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <footer className="mt-2 shrink-0 border-t border-zinc-800 pt-2 text-[10px] leading-4 text-zinc-600">
        {capabilities ? (
          <span>
            ffmpeg {capabilities.ffmpegVersion}
            {!capabilities.binariesFound && <span className="text-red-400">（未找到二进制）</span>}
          </span>
        ) : (
          <span>正在探测 ffmpeg…</span>
        )}
        <br />
        空格 播放/暂停 · ←/→ 逐帧 · Shift+←/→ 跳 1 秒 · I/O 入出点
      </footer>
    </section>
  )
}
