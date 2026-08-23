import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  Capabilities,
  CutRequest,
  JobEvent,
  KeyframeScanProgress,
  MediaInfo,
  MultiCutRequest,
  TranscodeItemRequest,
  UpdateState,
  WaveformResult
} from '../shared/types'

export interface OpenMediaResult {
  info: MediaInfo
  keyframes: number[]
}

const EVENT_CHANNELS = ['job:event', 'media:keyframeProgress', 'media:auto-opened', 'media:waveform', 'win:maximizedChanged', 'app:updateState'] as const
export type EventChannel = (typeof EVENT_CHANNELS)[number]

type EventPayload = JobEvent | KeyframeScanProgress | OpenMediaResult | WaveformResult | boolean | UpdateState

const api = {
  capabilities: (): Promise<Capabilities> => ipcRenderer.invoke('app:capabilities'),

  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  openMedia: (): Promise<OpenMediaResult | null> => ipcRenderer.invoke('media:open'),

  openMediaPath: (path: string): Promise<OpenMediaResult> => ipcRenderer.invoke('media:openPath', path),

  recentFiles: (): Promise<string[]> => ipcRenderer.invoke('app:recentFiles'),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),

  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),

  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),

  submitCut: (req: CutRequest | MultiCutRequest): Promise<{ jobId: string }> => ipcRenderer.invoke('cut:submit', req),

  cancelJob: (jobId: string): Promise<void> => ipcRenderer.invoke('job:cancel', jobId),

  /** 拖拽的 File 对象 → 本地路径（File.path 已移除，官方迁移方式） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('win:minimize'),

  toggleMaximize: (): Promise<void> => ipcRenderer.invoke('win:toggleMaximize'),

  closeWindow: (): Promise<void> => ipcRenderer.invoke('win:close'),

  submitTranscode: (items: TranscodeItemRequest[]): Promise<{ jobIds: string[] }> =>
    ipcRenderer.invoke('transcode:submit', items),

  cancelTranscode: (jobId: string): Promise<void> => ipcRenderer.invoke('transcode:cancel', jobId),

  pickVideoFiles: (): Promise<string[]> => ipcRenderer.invoke('transcode:pickFiles'),

  pickVideoFolder: (): Promise<string[]> => ipcRenderer.invoke('transcode:pickFolder'),

  setTranscodeConcurrency: (n: number): Promise<number> => ipcRenderer.invoke('transcode:setConcurrency', n),

  /** 手动检查更新（结果通过 app:updateState 事件返回） */
  checkUpdate: (): Promise<void> => ipcRenderer.invoke('update:check'),

  /** 开始下载已检测到的新版本 */
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download').then(() => undefined),

  /** 退出并安装已下载的更新（静默安装 + 重启） */
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),

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
