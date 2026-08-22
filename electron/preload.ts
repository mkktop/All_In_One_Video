import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Capabilities, CutRequest, JobEvent, KeyframeScanProgress, MediaInfo, MultiCutRequest, WaveformResult } from '../shared/types'

export interface OpenMediaResult {
  info: MediaInfo
  keyframes: number[]
}

const EVENT_CHANNELS = ['job:event', 'media:keyframeProgress', 'media:auto-opened', 'media:waveform'] as const
export type EventChannel = (typeof EVENT_CHANNELS)[number]

type EventPayload = JobEvent | KeyframeScanProgress | OpenMediaResult | WaveformResult

const api = {
  capabilities: (): Promise<Capabilities> => ipcRenderer.invoke('app:capabilities'),

  openMedia: (): Promise<OpenMediaResult | null> => ipcRenderer.invoke('media:open'),

  openMediaPath: (path: string): Promise<OpenMediaResult> => ipcRenderer.invoke('media:openPath', path),

  recentFiles: (): Promise<string[]> => ipcRenderer.invoke('app:recentFiles'),

  submitCut: (req: CutRequest | MultiCutRequest): Promise<{ jobId: string }> => ipcRenderer.invoke('cut:submit', req),

  cancelJob: (jobId: string): Promise<void> => ipcRenderer.invoke('job:cancel', jobId),

  /** 拖拽的 File 对象 → 本地路径（File.path 已移除，官方迁移方式） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  openPath: (p: string): Promise<void> => ipcRenderer.invoke('shell:openPath', p),

  showInFolder: (p: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', p),

  on: (channel: EventChannel, listener: (payload: EventPayload) => void): (() => void) => {
    if (!EVENT_CHANNELS.includes(channel)) return () => {}
    const handler = (_e: Electron.IpcRendererEvent, payload: EventPayload): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('aiov', api)

export type AiovApi = typeof api
