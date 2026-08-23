/** 渲染进程与主进程共享的类型定义 */

export interface VideoStreamInfo {
  index: number
  codec: string
  width: number
  height: number
  /** r_frame_rate 换算出的标称帧率 */
  fps: number
  /** avg_frame_rate 换算出的平均帧率，与 fps 偏差过大视为 VFR */
  avgFps: number
  pixFmt: string
  profile: string | null
  /** ffprobe 数值，如 40 表示 level 4.0 */
  level: number | null
  /** 采样宽高比，如 "1:1" */
  sar: string
  hasBFrames: boolean
  bitrate: number
}

export interface AudioStreamInfo {
  index: number
  codec: string
  sampleRate: number
  channels: number
  bitrate: number
}

export interface MediaInfo {
  path: string
  fileName: string
  fileSize: number
  durationSec: number
  container: string
  video: VideoStreamInfo | null
  audio: AudioStreamInfo[]
  isVfr: boolean
}

export type CutMode = 'keyframe-snap' | 'smart'

/** 轨道模式：全部 / 仅音频（音频分离-提取）/ 仅视频（音频分离-去音轨） */
export type TrackMode = 'all' | 'audio-only' | 'video-only'

export interface CutRequest {
  inputPath: string
  startSec: number
  endSec: number
  mode: CutMode
  container: 'mp4' | 'mkv'
  tracks?: TrackMode
  /** 自定义导出目录（默认视频所在目录） */
  outputDir?: string
  /** 自定义文件名（不含扩展名） */
  outputName?: string
}

/** 多段合并导出：按 ranges 顺序逐段处理后拼接为一个文件 */
/** 轨道片段：可来自不同文件 */
export interface ClipSpec {
  path: string
  startSec: number
  endSec: number
}

export interface MultiCutRequest {
  clips: ClipSpec[]
  mode: CutMode
  container: 'mp4' | 'mkv'
  outputDir?: string
  outputName?: string
}

/** 应用设置（userData/settings.json 持久化） */
export interface AppSettings {
  /** null = 导出到视频所在目录 */
  exportDir: string | null
  container: 'mp4' | 'mkv'
  /** 转码并发数 1-4 */
  transcodeConcurrency: number
}

/** 转码预设 */
export interface TranscodePreset {
  /** copy = 容器互换（流复制秒转），其余为重新编码 */
  videoCodec: 'copy' | 'h264' | 'hevc' | 'vp9' | 'av1'
  quality: 'high' | 'balanced' | 'compact'
  scale: 'source' | '1080p' | '720p'
  audio: 'copy' | 'aac'
  container: 'mp4' | 'mkv' | 'webm' | 'mov'
}

export interface TranscodeItemRequest {
  inputPath: string
  outputDir?: string
  preset: TranscodePreset
}

/** 波形图生成完成事件 */
export interface WaveformResult {
  path: string
  pngPath: string | null
}

export interface Capabilities {
  platform: string
  ffmpegVersion: string
  ffprobeVersion: string
  binaryDir: string
  binariesFound: boolean
  /** smart cut 实际选用的视频编码器 */
  encoder?: { h264: string; hevc: string }
}

export type JobPhase = 'planning' | 'copy' | 'encode' | 'concat' | 'verifying'
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

/** 任务进行中推送的事件 */
export interface JobProgress {
  jobId: string
  state: 'queued' | 'running'
  phase: JobPhase
  /** 0-100 */
  percent: number
  /** ffmpeg 速度，如 "12.3x" */
  speed?: string
}

/** 任务终态事件 */
export interface JobResult {
  jobId: string
  state: 'done' | 'failed' | 'canceled'
  outputPath?: string
  error?: string
  durationMs?: number
  /** 非致命说明，如「源为VFR」「已整段转码兜底」 */
  notice?: string
}

export type JobEvent = JobProgress | JobResult

export interface KeyframeScanProgress {
  path: string
  percent: number
  done: boolean
}

/** 应用更新状态（主进程 → 顶栏提示） */
export interface UpdateState {
  phase: 'available' | 'downloading' | 'ready'
  version: string
  /** 下载进度 0-100 */
  percent: number | null
}

/** planner 产出的段计划，smart cut 用 */
export type Segment =
  | { kind: 'copy'; startSec: number; endSec: number }
  | { kind: 'encode'; startSec: number; endSec: number }
