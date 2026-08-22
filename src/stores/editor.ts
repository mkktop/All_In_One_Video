import { create } from 'zustand'
import type { Capabilities, CutMode, CutRequest, JobEvent, JobProgress, JobResult, MediaInfo, MultiCutRequest } from '@shared/types'
import { videoEl } from '@/lib/playerRef'

export interface JobEntry {
  jobId: string
  label: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  phase: JobProgress['phase']
  percent: number
  speed?: string
  result?: JobResult
  /** 重试用：提交时的请求 */
  request?: CutRequest | MultiCutRequest
}

export interface ClipSegment {
  id: string
  start: number
  end: number
}

interface HistorySnapshot {
  selection: EditorState['selection']
  segments: ClipSegment[]
}

interface EditorState {
  capabilities: Capabilities | null
  media: {
    info: MediaInfo | null
    keyframes: number[]
    scanning: boolean
    scanPercent: number
  }
  waveform: { forPath: string | null; url: string | null }
  playback: {
    currentTime: number
    playing: boolean
    rate: number
    volume: number
    muted: boolean
  }
  selection: {
    inPoint: number | null
    outPoint: number | null
    mode: CutMode
  }
  segments: ClipSegment[]
  past: HistorySnapshot[]
  future: HistorySnapshot[]
  jobs: Record<string, JobEntry>
  jobOrder: string[]

  init: () => Promise<void>
  openMedia: () => Promise<void>
  openMediaPath: (path: string) => Promise<void>
  applyAutoOpened: (r: { info: MediaInfo; keyframes: number[] }) => void
  applyWaveform: (r: { path: string; pngPath: string | null }) => void
  setScanProgress: (percent: number, done: boolean) => void
  setCurrentTime: (t: number) => void
  setPlaying: (playing: boolean) => void
  setRate: (rate: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  togglePlay: () => void
  seek: (t: number) => void
  stepFrames: (n: number) => void
  setIn: (t?: number) => void
  setOut: (t?: number) => void
  setInDirect: (t: number) => void
  setOutDirect: (t: number) => void
  clearSelection: () => void
  setMode: (mode: CutMode) => void
  addSegment: () => void
  removeSegment: (id: string) => void
  loadSegment: (id: string) => void
  clearSegments: () => void
  undo: () => void
  redo: () => void
  exportCut: () => Promise<void>
  exportMerge: () => Promise<void>
  retryJob: (jobId: string) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  applyJobEvent: (e: JobEvent) => void
}

const frameDur = (s: EditorState): number => 1 / (s.media.info?.video?.fps || 25)

let segSeq = 0
function newSegId(): string {
  segSeq += 1
  return `seg-${Date.now().toString(36)}-${segSeq}`
}

export const useEditor = create<EditorState>((set, get) => {
  /** 可撤销的 selection/segments 变更：先快照再应用 */
  const commit = (mutate: (s: EditorState) => Partial<EditorState>): void => {
    set((s) => {
      const snap: HistorySnapshot = { selection: s.selection, segments: s.segments }
      const patch = mutate(s)
      return { ...patch, past: [...s.past.slice(-59), snap], future: [] }
    })
  }

  const submitJob = async (request: CutRequest | MultiCutRequest, label: string): Promise<void> => {
    const res = await window.aiov.submitCut(request)
    set((s) => ({
      jobs: { ...s.jobs, [res.jobId]: { jobId: res.jobId, label, state: 'queued', phase: 'planning', percent: 0, request } },
      jobOrder: [res.jobId, ...s.jobOrder]
    }))
  }

  const loadMediaResult = (r: { info: MediaInfo; keyframes: number[] }): void => {
    set((s) => ({
      media: { info: r.info, keyframes: r.keyframes, scanning: false, scanPercent: 100 },
      waveform: { forPath: r.info.path, url: null },
      playback: { ...s.playback, currentTime: 0, playing: false },
      // 换文件是历史边界：清空选择、片段与撤销栈
      selection: { inPoint: null, outPoint: null, mode: s.selection.mode },
      segments: [],
      past: [],
      future: []
    }))
  }

  return {
    capabilities: null,
    media: { info: null, keyframes: [], scanning: false, scanPercent: 0 },
    waveform: { forPath: null, url: null },
    playback: { currentTime: 0, playing: false, rate: 1, volume: 1, muted: false },
    selection: { inPoint: null, outPoint: null, mode: 'keyframe-snap' },
    segments: [],
    past: [],
    future: [],
    jobs: {},
    jobOrder: [],

    init: async () => {
      if (get().capabilities) return
      try {
        set({ capabilities: await window.aiov.capabilities() })
      } catch {
        // 探测失败不阻塞 UI，任务面板会显示未知状态
      }
    },

    openMedia: async () => {
      set((s) => ({
        media: { info: null, keyframes: [], scanning: true, scanPercent: 0 },
        waveform: { forPath: null, url: null },
        selection: { inPoint: null, outPoint: null, mode: s.selection.mode },
        segments: [],
        past: [],
        future: [],
        playback: { ...s.playback, currentTime: 0, playing: false }
      }))
      const r = await window.aiov.openMedia()
      if (!r) {
        set((s) => ({ media: { ...s.media, scanning: false } }))
        return
      }
      loadMediaResult(r)
    },

    openMediaPath: async (path) => {
      set((s) => ({
        media: { info: null, keyframes: [], scanning: true, scanPercent: 0 },
        waveform: { forPath: null, url: null },
        selection: { inPoint: null, outPoint: null, mode: s.selection.mode },
        segments: [],
        past: [],
        future: [],
        playback: { ...s.playback, currentTime: 0, playing: false }
      }))
      try {
        const r = await window.aiov.openMediaPath(path)
        loadMediaResult(r)
      } catch (err) {
        console.info(`[aiov:media] 打开失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
        set({ media: { info: null, keyframes: [], scanning: false, scanPercent: 0 } })
      }
    },

    applyAutoOpened: (r) => loadMediaResult(r),

    applyWaveform: (r) => {
      const cur = get().media.info?.path
      if (cur !== r.path) return
      set({
        waveform: {
          forPath: r.path,
          url: r.pngPath ? 'file:///' + encodeURI(r.pngPath.replace(/\\/g, '/')) : null
        }
      })
    },

    setScanProgress: (percent, done) => {
      set((s) => ({ media: { ...s.media, scanning: !done, scanPercent: percent } }))
    },

    setCurrentTime: (t) => {
      set((s) => ({ playback: { ...s.playback, currentTime: t } }))
    },

    setPlaying: (playing) => {
      set((s) => ({ playback: { ...s.playback, playing } }))
    },

    setRate: (rate) => {
      set((s) => ({ playback: { ...s.playback, rate } }))
    },

    setVolume: (volume) => {
      set((s) => ({ playback: { ...s.playback, volume, muted: false } }))
    },

    toggleMute: () => {
      set((s) => ({ playback: { ...s.playback, muted: !s.playback.muted } }))
    },

    togglePlay: () => {
      const v = videoEl.current
      if (!v) return
      if (v.paused) void v.play().catch(() => {})
      else v.pause()
    },

    seek: (t) => {
      const dur = get().media.info?.durationSec ?? 0
      const nt = Math.min(Math.max(t, 0), dur)
      const v = videoEl.current
      if (v) v.currentTime = nt
      set((s) => ({ playback: { ...s.playback, currentTime: nt } }))
    },

    stepFrames: (n) => {
      const fd = frameDur(get())
      const target = (Math.round(get().playback.currentTime / fd) + n) * fd
      get().seek(target)
    },

    setIn: (t) => {
      const s = get()
      const dur = s.media.info?.durationSec ?? 0
      let v = Math.min(Math.max(t ?? s.playback.currentTime, 0), dur)
      const out = s.selection.outPoint
      if (out != null && v >= out) v = Math.max(0, out - frameDur(s))
      commit((cur) => ({ selection: { ...cur.selection, inPoint: v } }))
    },

    setOut: (t) => {
      const s = get()
      const dur = s.media.info?.durationSec ?? 0
      let v = Math.min(Math.max(t ?? s.playback.currentTime, 0), dur)
      const inn = s.selection.inPoint
      if (inn != null && v <= inn) v = Math.min(dur, inn + frameDur(s))
      commit((cur) => ({ selection: { ...cur.selection, outPoint: v } }))
    },

    // 时间轴拖拽的实时路径：不进撤销栈（避免拖动刷爆历史）
    setInDirect: (t) => {
      const s = get()
      const dur = s.media.info?.durationSec ?? 0
      let v = Math.min(Math.max(t, 0), dur)
      const out = s.selection.outPoint
      if (out != null && v >= out) v = Math.max(0, out - 0.001)
      set({ selection: { ...s.selection, inPoint: v } })
    },

    setOutDirect: (t) => {
      const s = get()
      const dur = s.media.info?.durationSec ?? 0
      let v = Math.min(Math.max(t, 0), dur)
      const inn = s.selection.inPoint
      if (inn != null && v <= inn) v = Math.min(dur, inn + 0.001)
      set({ selection: { ...s.selection, outPoint: v } })
    },

    clearSelection: () => {
      commit((cur) => ({ selection: { ...cur.selection, inPoint: null, outPoint: null } }))
    },

    setMode: (mode) => {
      set((s) => ({ selection: { ...s.selection, mode } }))
    },

    addSegment: () => {
      const s = get()
      const { inPoint, outPoint } = s.selection
      if (inPoint == null || outPoint == null || outPoint <= inPoint) return
      const seg: ClipSegment = { id: newSegId(), start: inPoint, end: outPoint }
      commit((cur) => ({
        segments: [...cur.segments, seg],
        selection: { ...cur.selection, inPoint: null, outPoint: null }
      }))
      get().seek(seg.end)
    },

    removeSegment: (id) => {
      commit((cur) => ({ segments: cur.segments.filter((sg) => sg.id !== id) }))
    },

    loadSegment: (id) => {
      const s = get()
      const seg = s.segments.find((sg) => sg.id === id)
      if (!seg) return
      commit((cur) => ({ selection: { ...cur.selection, inPoint: seg.start, outPoint: seg.end } }))
      get().seek(seg.start)
    },

    clearSegments: () => {
      commit(() => ({ segments: [] }))
    },

    undo: () => {
      const s = get()
      const prev = s.past[s.past.length - 1]
      if (!prev) return
      set({
        past: s.past.slice(0, -1),
        future: [{ selection: s.selection, segments: s.segments }, ...s.future].slice(0, 60),
        selection: prev.selection,
        segments: prev.segments
      })
    },

    redo: () => {
      const s = get()
      const next = s.future[0]
      if (!next) return
      set({
        past: [...s.past, { selection: s.selection, segments: s.segments }],
        future: s.future.slice(1),
        selection: next.selection,
        segments: next.segments
      })
    },

    exportCut: async () => {
      const { media, selection } = get()
      if (!media.info || selection.inPoint == null || selection.outPoint == null) return
      if (selection.outPoint <= selection.inPoint) return
      await submitJob(
        {
          inputPath: media.info.path,
          startSec: selection.inPoint,
          endSec: selection.outPoint,
          mode: selection.mode,
          container: 'mp4'
        },
        media.info.fileName
      )
    },

    exportMerge: async () => {
      const { media, selection, segments } = get()
      if (!media.info || segments.length === 0) return
      const sorted = [...segments].sort((a, b) => a.start - b.start)
      await submitJob(
        {
          inputPath: media.info.path,
          container: 'mp4',
          mode: selection.mode,
          ranges: sorted.map((sg) => ({ startSec: sg.start, endSec: sg.end }))
        },
        `${media.info.fileName}（${sorted.length} 段合并）`
      )
    },

    retryJob: async (jobId) => {
      const s = get()
      const job = s.jobs[jobId]
      if (!job?.request) return
      await submitJob(job.request, job.label)
    },

    cancelJob: async (jobId) => {
      await window.aiov.cancelJob(jobId)
    },

    applyJobEvent: (e) => {
      const prev = get().jobs[e.jobId]
      if (!prev) return
      if ('phase' in e) {
        set((s) => ({
          jobs: {
            ...s.jobs,
            [e.jobId]: { ...prev, state: e.state, phase: e.phase, percent: e.percent, speed: e.speed }
          }
        }))
      } else {
        set((s) => ({
          jobs: {
            ...s.jobs,
            [e.jobId]: {
              ...prev,
              state: e.state,
              percent: e.state === 'done' ? 100 : prev.percent,
              result: e
            }
          }
        }))
      }
    }
  }
})
