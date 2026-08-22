import type { JobEvent, KeyframeScanProgress, WaveformResult } from '@shared/types'
import type { OpenMediaResult } from '../electron/preload'

export function onJobEvent(cb: (e: JobEvent) => void): () => void {
  return window.aiov.on('job:event', (p) => cb(p as JobEvent))
}

export function onKeyframeProgress(cb: (p: KeyframeScanProgress) => void): () => void {
  return window.aiov.on('media:keyframeProgress', (p) => cb(p as KeyframeScanProgress))
}

export function onAutoOpened(cb: (r: OpenMediaResult) => void): () => void {
  return window.aiov.on('media:auto-opened', (p) => cb(p as OpenMediaResult))
}

export function onWaveform(cb: (r: WaveformResult) => void): () => void {
  return window.aiov.on('media:waveform', (p) => cb(p as WaveformResult))
}

export function onMaximizedChanged(cb: (maximized: boolean) => void): () => void {
  return window.aiov.on('win:maximizedChanged', (p) => cb(p as boolean))
}

/** 本地视频的 file:// 源地址（webSecurity:false 下 <video> 直接原生加载，Range/索引由 Chromium 处理） */
export function mediaSrc(filePath: string): string {
  return 'file:///' + encodeURI(filePath.replace(/\\/g, '/'))
}
