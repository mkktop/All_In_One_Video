import { create } from 'zustand'
import type {
  AppSettings,
  Capabilities,
  CutMode,
  CutRequest,
  JobEvent,
  JobProgress,
  JobResult,
  MediaInfo,
  MultiCutRequest,
  TrackMode
} from '@shared/types'
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

/** 素材库条目 */
export interface BinEntry {
  info: MediaInfo
  keyframes: number[]
  waveformUrl: string | null
}

/** 主轨道片段（可来自不同素材） */
export interface TimelineClip {
  id: string
  path: string
  fileName: string
  start: number
  end: number
}

export type ExportKind = 'cut' | 'merge' | 'audio' | 'video'

interface ExportDialogState {
  open: boolean
  kind: ExportKind
  defaultName: string
}

interface HistorySnapshot {
  selection: EditorState['selection']
  clips: TimelineClip[]
}

interface EditorState {
  page: 'edit' | 'transcode'
  capabilities: Capabilities | null
  settings: AppSettings
  exportDialog: ExportDialogState
  media: {
    bin: BinEntry[]
    activePath: string | null
    scanning: boolean
    scanPercent: number
  }
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
  clips: TimelineClip[]
  past: HistorySnapshot[]
  future: HistorySnapshot[]
  jobs: Record<string, JobEntry>
  jobOrder: string[]

  init: () => Promise<void>
  setPage: (page: 'edit' | 'transcode') => void
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  openExportDialog: (kind: ExportKind) => void
  closeExportDialog: () => void
  confirmExport: (name: string) => Promise<void>
  openMedia: () => Promise<void>
  openMediaPath: (path: string) => Promise<void>
  applyAutoOpened: (r: { info: MediaInfo; keyframes: number[] }) => void
  setActivePath: (path: string) => void
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

  addClipFromSelection: () => void
  removeClip: (id: string) => void
  moveClip: (fromIdx: number, toIdx: number) => void
  trimClip: (id: string, edge: 'start' | 'end', value: number) => void
  beginClipDrag: () => void
  clearClips: () => void
  loadClipToSelection: (id: string) => void
  undo: () => void
  redo: () => void
  exportCut: (tracks?: TrackMode, outputName?: string) => Promise<void>
  exportMerge: (outputName?: string) => Promise<void>
  retryJob: (jobId: string) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  applyJobEvent: (e: JobEvent) => void
}

const frameDurOf = (s: EditorState): number => {
  const active = s.media.bin.find((b) => b.info.path === s.media.activePath)
  return 1 / (active?.info.video?.fps || 25)
}

let seq = 0
function newId(): string {
  seq += 1
  return `clip-${Date.now().toString(36)}-${seq}`
}

export const useEditor = create<EditorState>((set, get) => {
  /** 可撤销的 selection/clips 变更：先快照再应用 */
  const commit = (mutate: (s: EditorState) => Partial<EditorState>): void => {
    set((s) => {
      const snap: HistorySnapshot = { selection: s.selection, clips: s.clips }
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

  /** 打开视频 → 加入素材库并激活（轨道保留） */
  const loadIntoBin = (r: { info: MediaInfo; keyframes: number[] }): void => {
    set((s) => {
      const bin = [
        ...s.media.bin.filter((b) => b.info.path !== r.info.path),
        { info: r.info, keyframes: r.keyframes, waveformUrl: null }
      ].slice(-10)
      return {
        media: { ...s.media, bin, activePath: r.info.path, scanning: false, scanPercent: 100 },
        playback: { ...s.playback, currentTime: 0, playing: false },
        selection: { inPoint: null, outPoint: null, mode: s.selection.mode }
      }
    })
  }

  return {
    page: 'edit',
    capabilities: null,
    settings: { exportDir: null, container: 'mp4', transcodeConcurrency: 2 },
    exportDialog: { open: false, kind: 'cut', defaultName: '' },
    media: { bin: [], activePath: null, scanning: false, scanPercent: 0 },
    playback: { currentTime: 0, playing: false, rate: 1, volume: 1, muted: false },
    selection: { inPoint: null, outPoint: null, mode: 'keyframe-snap' },
    clips: [],
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

    setPage: (page) => {
      // 离开剪辑页时暂停播放
      if (page !== 'edit') videoEl.current?.pause()
      set({ page })
    },

    loadSettings: async () => {
      try {
        set({ settings: await window.aiov.getSettings() })
      } catch {
        // 设置读取失败用默认值
      }
    },

    saveSettings: async (patch) => {
      try {
        set({ settings: await window.aiov.setSettings(patch) })
      } catch {
        // 保存失败仅影响持久化
      }
    },

    openExportDialog: (kind) => {
      const s = get()
      const active = s.media.bin.find((b) => b.info.path === s.media.activePath)
      if (!active && kind !== 'merge') return
      if (kind === 'merge' && s.clips.length === 0) return
      const base = (active?.info.fileName ?? s.clips[0]?.fileName ?? '视频').replace(/\.[^.]+$/, '')
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      const defaultName =
        kind === 'audio'
          ? `${base}_音频_${ts}`
          : kind === 'video'
            ? `${base}_无音轨_${ts}`
            : kind === 'merge'
              ? `${base}_合并${s.clips.length}段_${ts}`
              : `${base}_剪辑_${ts}`
      set({ exportDialog: { open: true, kind, defaultName } })
    },

    closeExportDialog: () => {
      set((s) => ({ exportDialog: { ...s.exportDialog, open: false } }))
    },

    confirmExport: async (name) => {
      const { exportDialog } = get()
      if (!exportDialog.open) return
      get().closeExportDialog()
      const n = name.trim() || undefined
      if (exportDialog.kind === 'merge') await get().exportMerge(n)
      else if (exportDialog.kind === 'audio') await get().exportCut('audio-only', n)
      else if (exportDialog.kind === 'video') await get().exportCut('video-only', n)
      else await get().exportCut('all', n)
    },

    openMedia: async () => {
      set((s) => ({ media: { ...s.media, scanning: true, scanPercent: 0 } }))
      const r = await window.aiov.openMedia()
      if (!r) {
        set((s) => ({ media: { ...s.media, scanning: false } }))
        return
      }
      loadIntoBin(r)
    },

    openMediaPath: async (path) => {
      // 素材已在库中 → 直接激活
      const existed = get().media.bin.find((b) => b.info.path === path)
      if (existed) {
        set((s) => ({
          media: { ...s.media, activePath: path },
          selection: { inPoint: null, outPoint: null, mode: s.selection.mode },
          playback: { ...s.playback, currentTime: 0, playing: false }
        }))
        videoEl.current?.pause()
        return
      }
      set((s) => ({ media: { ...s.media, scanning: true, scanPercent: 0 } }))
      try {
        const r = await window.aiov.openMediaPath(path)
        loadIntoBin(r)
      } catch (err) {
        console.info(`[aiov:media] 打开失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
        set((s) => ({ media: { ...s.media, scanning: false, scanPercent: 0 } }))
      }
    },

    applyAutoOpened: (r) => loadIntoBin(r),

    setActivePath: (path) => {
      if (get().media.activePath === path) return
      set((s) => ({
        media: { ...s.media, activePath: path },
        selection: { inPoint: null, outPoint: null, mode: s.selection.mode },
        playback: { ...s.playback, currentTime: 0, playing: false }
      }))
      videoEl.current?.pause()
    },

    applyWaveform: (r) => {
      set((s) => ({
        media: {
          ...s.media,
          bin: s.media.bin.map((b) =>
            b.info.path === r.path
              ? { ...b, waveformUrl: r.pngPath ? 'file:///' + encodeURI(r.pngPath.replace(/\\/g, '/')) : null }
              : b
          )
        }
      }))
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
      const s = get()
      const active = s.media.bin.find((b) => b.info.path === s.media.activePath)
      const dur = active?.info.durationSec ?? 0
      const nt = Math.min(Math.max(t, 0), dur)
      const v = videoEl.current
      if (v) v.currentTime = nt
      set({ playback: { ...s.playback, currentTime: nt } })
    },

    stepFrames: (n) => {
      const fd = frameDurOf(get())
      const target = (Math.round(get().playback.currentTime / fd) + n) * fd
      get().seek(target)
    },

    setIn: (t) => {
      const s = get()
      const dur = s.media.bin.find((b) => b.info.path === s.media.activePath)?.info.durationSec ?? 0
      let v = Math.min(Math.max(t ?? s.playback.currentTime, 0), dur)
      const out = s.selection.outPoint
      if (out != null && v >= out) v = Math.max(0, out - frameDurOf(s))
      commit((cur) => ({ selection: { ...cur.selection, inPoint: v } }))
    },

    setOut: (t) => {
      const s = get()
      const dur = s.media.bin.find((b) => b.info.path === s.media.activePath)?.info.durationSec ?? 0
      let v = Math.min(Math.max(t ?? s.playback.currentTime, 0), dur)
      const inn = s.selection.inPoint
      if (inn != null && v <= inn) v = Math.min(dur, inn + frameDurOf(s))
      commit((cur) => ({ selection: { ...cur.selection, outPoint: v } }))
    },

    // 时间轴拖拽的实时路径：不进撤销栈（避免拖动刷爆历史）
    setInDirect: (t) => {
      const s = get()
      const dur = s.media.bin.find((b) => b.info.path === s.media.activePath)?.info.durationSec ?? 0
      let v = Math.min(Math.max(t, 0), dur)
      const out = s.selection.outPoint
      if (out != null && v >= out) v = Math.max(0, out - 0.001)
      set({ selection: { ...s.selection, inPoint: v } })
    },

    setOutDirect: (t) => {
      const s = get()
      const dur = s.media.bin.find((b) => b.info.path === s.media.activePath)?.info.durationSec ?? 0
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

    addClipFromSelection: () => {
      const s = get()
      const active = s.media.bin.find((b) => b.info.path === s.media.activePath)
      if (!active) return
      const { inPoint, outPoint } = s.selection
      if (inPoint == null || outPoint == null || outPoint <= inPoint) return
      const clip: TimelineClip = {
        id: newId(),
        path: active.info.path,
        fileName: active.info.fileName,
        start: inPoint,
        end: outPoint
      }
      commit((cur) => ({
        clips: [...cur.clips, clip],
        selection: { ...cur.selection, inPoint: null, outPoint: null }
      }))
      get().seek(clip.end)
    },

    removeClip: (id) => {
      commit((cur) => ({ clips: cur.clips.filter((c) => c.id !== id) }))
    },

    moveClip: (fromIdx, toIdx) => {
      commit((cur) => {
        if (fromIdx === toIdx || fromIdx < 0 || fromIdx >= cur.clips.length) return {}
        const clips = [...cur.clips]
        const [moved] = clips.splice(fromIdx, 1)
        clips.splice(Math.max(0, Math.min(clips.length, toIdx)), 0, moved)
        return { clips }
      })
    },

    /** 拖动边缘修剪：直接改值不进历史（beginClipDrag 已在拖前快照） */
    trimClip: (id, edge, value) => {
      set((s) => ({
        clips: s.clips.map((c) => {
          if (c.id !== id) return c
          const dur = s.media.bin.find((b) => b.info.path === c.path)?.info.durationSec ?? value
          if (edge === 'start') {
            const v = Math.min(Math.max(value, 0), c.end - 0.05)
            return { ...c, start: Math.min(v, dur) }
          }
          const v = Math.max(Math.min(value, dur), c.start + 0.05)
          return { ...c, end: v }
        })
      }))
    },

    beginClipDrag: () => {
      set((s) => ({
        past: [...s.past.slice(-59), { selection: s.selection, clips: s.clips }],
        future: []
      }))
    },

    clearClips: () => {
      commit(() => ({ clips: [] }))
    },

    loadClipToSelection: (id) => {
      const s = get()
      const clip = s.clips.find((c) => c.id === id)
      if (!clip) return
      const source = s.media.bin.find((b) => b.info.path === clip.path)
      if (!source) return
      set((cur) => ({
        media: cur.media.activePath === clip.path ? cur.media : { ...cur.media, activePath: clip.path },
        selection: { ...cur.selection, inPoint: clip.start, outPoint: clip.end }
      }))
      videoEl.current?.pause()
      get().seek(clip.start)
    },

    undo: () => {
      const s = get()
      const prev = s.past[s.past.length - 1]
      if (!prev) return
      set({
        past: s.past.slice(0, -1),
        future: [{ selection: s.selection, clips: s.clips }, ...s.future].slice(0, 60),
        selection: prev.selection,
        clips: prev.clips
      })
    },

    redo: () => {
      const s = get()
      const next = s.future[0]
      if (!next) return
      set({
        past: [...s.past, { selection: s.selection, clips: s.clips }],
        future: s.future.slice(1),
        selection: next.selection,
        clips: next.clips
      })
    },

    exportCut: async (tracks: TrackMode = 'all', outputName?: string) => {
      const s = get()
      const active = s.media.bin.find((b) => b.info.path === s.media.activePath)
      if (!active) return
      // 未设入出点时作用于全片
      const startSec = s.selection.inPoint ?? 0
      const endSec = s.selection.outPoint ?? active.info.durationSec
      if (endSec <= startSec) return
      const labelSuffix =
        tracks === 'audio-only' ? '（提取音频）' : tracks === 'video-only' ? '（仅视频）' : ''
      await submitJob(
        {
          inputPath: active.info.path,
          startSec,
          endSec,
          mode: s.selection.mode,
          container: s.settings.container,
          tracks,
          outputDir: s.settings.exportDir ?? undefined,
          outputName
        },
        active.info.fileName + labelSuffix
      )
    },

    exportMerge: async (outputName?: string) => {
      const s = get()
      if (s.clips.length === 0) return
      await submitJob(
        {
          clips: s.clips.map((c) => ({ path: c.path, startSec: c.start, endSec: c.end })),
          mode: s.selection.mode,
          container: s.settings.container,
          outputDir: s.settings.exportDir ?? undefined,
          outputName
        },
        `合并 ${s.clips.length} 段`
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
