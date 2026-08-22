import { create } from 'zustand'
import type { JobEvent, TranscodePreset } from '@shared/types'

export interface TranscodeJobEntry {
  jobId: string
  inputPath: string
  label: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  phase: 'encode' | 'concat' | 'copy' | 'planning' | 'verifying'
  percent: number
  speed?: string
  error?: string
  outputPath?: string
  durationMs?: number
  preset: TranscodePreset
}

interface TranscodeState {
  preset: TranscodePreset
  concurrency: number
  pending: string[]
  jobs: Record<string, TranscodeJobEntry>
  order: string[]

  setPreset: (patch: Partial<TranscodePreset>) => void
  setConcurrency: (n: number) => Promise<void>
  addFiles: (paths: string[]) => void
  removePending: (path: string) => void
  clearFinished: () => void
  submitAll: (outputDir?: string) => Promise<void>
  retry: (jobId: string) => Promise<void>
  cancel: (jobId: string) => Promise<void>
  applyJobEvent: (e: JobEvent) => void
}

const VIDEO_RE = /\.(mp4|mkv|mov|webm|avi|ts|flv|m4v|wmv|mpg|mpeg|3gp)$/i

export const useTranscode = create<TranscodeState>((set, get) => ({
  preset: { videoCodec: 'h264', quality: 'balanced', scale: 'source', audio: 'copy', container: 'mp4' },
  concurrency: 2,
  pending: [],
  jobs: {},
  order: [],

  setPreset: (patch) => {
    set((s) => ({ preset: { ...s.preset, ...patch } }))
  },

  setConcurrency: async (n) => {
    try {
      const clamped = await window.aiov.setTranscodeConcurrency(n)
      set({ concurrency: clamped })
    } catch {
      // 忽略
    }
  },

  addFiles: (paths) => {
    set((s) => {
      const existing = new Set([...s.pending, ...Object.values(s.jobs).map((j) => j.inputPath)])
      const add = paths.filter((p) => VIDEO_RE.test(p) && !existing.has(p))
      return { pending: [...s.pending, ...add] }
    })
  },

  removePending: (path) => {
    set((s) => ({ pending: s.pending.filter((p) => p !== path) }))
  },

  clearFinished: () => {
    set((s) => {
      const jobs: Record<string, TranscodeJobEntry> = {}
      const order: string[] = []
      for (const id of s.order) {
        const j = s.jobs[id]
        if (j && (j.state === 'running' || j.state === 'queued')) {
          jobs[id] = j
          order.push(id)
        }
      }
      return { jobs, order }
    })
  },

  submitAll: async (outputDir) => {
    const { pending, preset } = get()
    if (pending.length === 0) return
    const items = pending.map((p) => ({ inputPath: p, outputDir, preset }))
    try {
      const res = await window.aiov.submitTranscode(items)
      set((s) => {
        const jobs = { ...s.jobs }
        const order = [...s.order]
        res.jobIds.forEach((jobId, i) => {
          const inputPath = items[i].inputPath
          jobs[jobId] = {
            jobId,
            inputPath,
            label: inputPath.replace(/^.*[\\/]/, ''),
            state: 'queued',
            phase: 'encode',
            percent: 0,
            preset: { ...preset }
          }
          order.push(jobId)
        })
        return { jobs, order, pending: [] }
      })
    } catch {
      // 提交失败保持 pending
    }
  },

  retry: async (jobId) => {
    const s = get()
    const job = s.jobs[jobId]
    if (!job) return
    try {
      const res = await window.aiov.submitTranscode([{ inputPath: job.inputPath, preset: job.preset }])
      const newId = res.jobIds[0]
      set((cur) => ({
        jobs: {
          ...cur.jobs,
          [newId]: {
            jobId: newId,
            inputPath: job.inputPath,
            label: job.label,
            state: 'queued',
            phase: 'encode',
            percent: 0,
            preset: job.preset
          }
        },
        order: [...cur.order, newId]
      }))
    } catch {
      // 忽略
    }
  },

  cancel: async (jobId) => {
    await window.aiov.cancelTranscode(jobId)
  },

  applyJobEvent: (e) => {
    const prev = get().jobs[e.jobId]
    if (!prev) return
    if ('phase' in e) {
      set((s) => ({
        jobs: { ...s.jobs, [e.jobId]: { ...prev, state: e.state, phase: e.phase, percent: e.percent, speed: e.speed } }
      }))
    } else {
      set((s) => ({
        jobs: {
          ...s.jobs,
          [e.jobId]: {
            ...prev,
            state: e.state,
            percent: e.state === 'done' ? 100 : prev.percent,
            error: e.error,
            outputPath: e.outputPath,
            durationMs: e.durationMs
          }
        }
      }))
    }
  }
}))
