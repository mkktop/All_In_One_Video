import { useEffect } from 'react'
import { Toolbar } from '@/components/Toolbar'
import { Player } from '@/components/Player'
import { Timeline } from '@/components/Timeline'
import { InOutPanel } from '@/components/InOutPanel'
import { SegmentPanel } from '@/components/SegmentPanel'
import { TaskPanel } from '@/components/TaskPanel'
import { useEditor } from '@/stores/editor'
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
      if (!s.media.info) return
      const fps = s.media.info.video?.fps ?? 25
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
          s.seek(s.media.info.durationSec)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export default function App() {
  useEffect(() => {
    const un1 = onJobEvent((e) => useEditor.getState().applyJobEvent(e))
    const un2 = onKeyframeProgress((p) => useEditor.getState().setScanProgress(p.percent, p.done))
    const un3 = onAutoOpened((r) => useEditor.getState().applyAutoOpened(r))
    const un4 = onWaveform((r) => useEditor.getState().applyWaveform(r))
    void useEditor.getState().init()
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
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!VIDEO_EXT.test(file.name)) return
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
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Player />
          <Timeline />
        </div>
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-zinc-800 bg-[#181818]">
          <InOutPanel />
          <SegmentPanel />
          <TaskPanel />
        </aside>
      </div>
    </div>
  )
}
