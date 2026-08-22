import { useEffect } from 'react'
import { Toolbar } from '@/components/Toolbar'
import { Player } from '@/components/Player'
import { Timeline } from '@/components/Timeline'
import { InOutPanel } from '@/components/InOutPanel'
import { MediaBin } from '@/components/MediaBin'
import { TrackTimeline } from '@/components/TrackTimeline'
import { TaskPanel } from '@/components/TaskPanel'
import { ExportDialog } from '@/components/ExportDialog'
import { TranscodePage } from '@/components/TranscodePage'
import { useEditor } from '@/stores/editor'
import { useTranscode } from '@/stores/transcode'
import { onAutoOpened, onJobEvent, onKeyframeProgress, onWaveform } from '@/ipc'

const VIDEO_EXT = /\.(mp4|mkv|mov|webm|avi|ts|flv|m4v|wmv)$/i

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, select, textarea, [contenteditable="true"]')) return
      const s = useEditor.getState()
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        s.redo()
        return
      }
      const active = s.media.bin.find((b) => b.info.path === s.media.activePath)
      if (!active) return
      const fps = active.info.video?.fps ?? 25
      switch (e.key) {
        case ' ':
          e.preventDefault()
          s.togglePlay()
          break
        case 'ArrowRight':
          e.preventDefault()
          s.stepFrames(e.shiftKey ? Math.round(fps) : 1)
          break
        case 'ArrowLeft':
          e.preventDefault()
          s.stepFrames(e.shiftKey ? -Math.round(fps) : -1)
          break
        case 'i':
        case 'I':
          s.setIn()
          break
        case 'o':
        case 'O':
          s.setOut()
          break
        case 'Home':
          e.preventDefault()
          s.seek(0)
          break
        case 'End':
          e.preventDefault()
          s.seek(active.info.durationSec)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export default function App() {
  const page = useEditor((s) => s.page)

  useEffect(() => {
    const un1 = onJobEvent((e) => {
      // 两个队列共用事件通道，各自按 jobId 过滤
      useEditor.getState().applyJobEvent(e)
      useTranscode.getState().applyJobEvent(e)
    })
    const un2 = onKeyframeProgress((p) => useEditor.getState().setScanProgress(p.percent, p.done))
    const un3 = onAutoOpened((r) => useEditor.getState().applyAutoOpened(r))
    const un4 = onWaveform((r) => useEditor.getState().applyWaveform(r))
    void useEditor.getState().init()
    void useEditor.getState().loadSettings()
    return () => {
      un1()
      un2()
      un3()
      un4()
    }
  }, [])

  useShortcuts()

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    if (useEditor.getState().page === 'transcode') {
      const paths: string[] = []
      for (const f of files) {
        try {
          paths.push(window.aiov.getPathForFile(f))
        } catch {
          // 忽略无法解析的项
        }
      }
      useTranscode.getState().addFiles(paths)
      return
    }
    const file = files[0]
    if (!file || !VIDEO_EXT.test(file.name)) return
    try {
      const path = window.aiov.getPathForFile(file)
      void useEditor.getState().openMediaPath(path)
    } catch {
      console.info('[aiov:drop] 无法解析拖入文件路径')
    }
  }

  return (
    <div
      className="flex h-screen select-none flex-col overflow-hidden bg-[#141414] text-zinc-200"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <Toolbar />
      {/* 剪辑页保持挂载（隐藏），切回时保留播放位置 */}
      <div className={page === 'edit' ? 'flex min-h-0 flex-1' : 'hidden'}>
        <div className="flex min-w-0 flex-1 flex-col">
          <Player />
          <MediaBin />
          <TrackTimeline />
          <Timeline />
        </div>
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-zinc-800 bg-[#181818]">
          <InOutPanel />
          <TaskPanel />
        </aside>
      </div>
      {page === 'transcode' && <TranscodePage />}
      <ExportDialog />
    </div>
  )
}
