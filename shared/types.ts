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

export interface CutRequest {
  inputPath: string
  startSec: number
  endSec: number
  mode: CutMode
  container: 'mp4' | 'mkv'
}

/** 多段合并导出：按 ranges 顺序逐段处理后拼接为一个文件 */
export interface SegmentRange {
  startSec: number
  endSec: number
}

export interface MultiCutRequest {
  inputPath: string
  container: 'mp4' | 'mkv'
  mode: CutMode
  ranges: SegmentRange[]
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

/** planner 产出的段计划，smart cut 用 */
export type Segment =
  | { kind: 'copy'; startSec: number; endSec: number }
  | { kind: 'encode'; startSec: number; endSec: number }
