import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename } from 'path'
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from '../../shared/types'

const execFileP = promisify(execFile)

interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  pix_fmt?: string
  profile?: string
  level?: number
  sample_aspect_ratio?: string
  has_b_frames?: number
  bit_rate?: string
  sample_rate?: string
  channels?: number
  disposition?: Record<string, number>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: {
    duration?: string
    size?: string
    format_name?: string
  }
}

function evalFraction(s: string | undefined): number {
  if (!s) return 0
  const [num, den] = s.split('/')
  const n = Number(num)
  const d = den === undefined ? 1 : Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return n / d
}

export async function probeMedia(ffprobeBin: string, filePath: string): Promise<MediaInfo> {
  const { stdout } = await execFileP(
    ffprobeBin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  )
  const j: FfprobeOutput = JSON.parse(stdout)

  const streams = j.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const audios = streams.filter((s) => s.codec_type === 'audio')

  const durationSec = Number(j.format?.duration ?? 0) || 0

  let video: VideoStreamInfo | null = null
  let isVfr = false
  if (v) {
    const fps = evalFraction(v.r_frame_rate)
    const avgFps = evalFraction(v.avg_frame_rate)
    isVfr = fps > 0 && avgFps > 0 && Math.abs(fps - avgFps) / fps > 0.02
    video = {
      index: v.index,
      codec: v.codec_name ?? 'unknown',
      width: v.width ?? 0,
      height: v.height ?? 0,
      fps: fps || avgFps || 25,
      avgFps,
      pixFmt: v.pix_fmt ?? 'unknown',
      profile: v.profile ?? null,
      level: typeof v.level === 'number' && v.level > 0 ? v.level : null,
      sar: v.sample_aspect_ratio ?? '1:1',
      hasBFrames: (v.has_b_frames ?? 0) !== 0,
      bitrate: Number(v.bit_rate ?? 0) || 0
    }
  }

  const audio: AudioStreamInfo[] = audios.map((a) => ({
    index: a.index,
    codec: a.codec_name ?? 'unknown',
    sampleRate: Number(a.sample_rate ?? 0) || 0,
    channels: a.channels ?? 0,
    bitrate: Number(a.bit_rate ?? 0) || 0
  }))

  return {
    path: filePath,
    fileName: basename(filePath),
    fileSize: Number(j.format?.size ?? 0) || 0,
    durationSec,
    container: (j.format?.format_name ?? '').split(',')[0],
    video,
    audio,
    isVfr
  }
}
