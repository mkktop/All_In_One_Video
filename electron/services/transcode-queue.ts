import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { rename, rm } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { JobEvent, JobState, TranscodeItemRequest, TranscodePreset } from '../../shared/types'
import { FfmpegError, runFfmpeg } from './ffmpeg-runner'
import { probeMedia } from './probe'
import { pickEncoder, type EncoderChoice } from './encoders'

type Container = TranscodePreset['container']
type Quality = TranscodePreset['quality']

export interface TranscodeJobContext {
  ffmpegBin: string
  ffprobeBin: string
  emit: (e: JobEvent) => void
  /** 测试用：强制软件编码器 */
  forceSoftware?: boolean
}

class CanceledError extends Error {
  constructor() {
    super('已取消')
  }
}

const MUXER: Record<Container, string[]> = {
  mp4: ['-f', 'mp4', '-movflags', '+faststart'],
  mov: ['-f', 'mov'],
  mkv: ['-f', 'matroska'],
  webm: ['-f', 'webm']
}

const CONTAINER_EXT: Record<Container, string> = { mp4: 'mp4', mov: 'mov', mkv: 'mkv', webm: 'webm' }

const QUALITY_VALUE: Record<'h264' | 'hevc' | 'vp9' | 'av1', Record<Quality, number>> = {
  h264: { high: 18, balanced: 21, compact: 24 },
  hevc: { high: 19, balanced: 22, compact: 25 },
  vp9: { high: 27, balanced: 32, compact: 36 },
  av1: { high: 24, balanced: 30, compact: 34 }
}

function videoArgs(codec: 'h264' | 'hevc' | 'vp9' | 'av1', quality: Quality, encName: string): string[] {
  const v = QUALITY_VALUE[codec][quality]
  if (codec === 'vp9') {
    return ['-crf', String(v), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']
  }
  if (codec === 'av1') {
    return ['-preset', quality === 'high' ? '6' : '8', '-crf', String(v)]
  }
  if (encName.includes('videotoolbox')) return ['-allow_sw', '1', '-q:v', String(v + 10)]
  if (encName.includes('nvenc')) return ['-preset', 'p4', '-cq', String(v)]
  if (encName.includes('qsv')) return ['-preset', 'veryfast', '-global_quality', String(v)]
  if (encName.includes('amf')) return ['-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', `${v < 20 ? 12 : v < 24 ? 8 : 5}M`]
  // libx264 / libx265
  return ['-preset', 'veryfast', '-crf', String(v)]
}

function scaleFilter(scale: TranscodePreset['scale']): string | null {
  if (scale === '1080p') return "scale=-2:'min(1080,ih)'"
  if (scale === '720p') return "scale=-2:'min(720,ih)'"
  return null
}

function buildOutput(inputPath: string, preset: TranscodePreset, outputDir?: string): string {
  const dir = outputDir && outputDir.trim().length > 0 ? outputDir : dirname(inputPath)
  const base = basename(inputPath).replace(/\.[^.]+$/, '')
  const suffix =
    preset.videoCodec === 'copy'
      ? ''
      : `_${preset.videoCodec}${preset.scale !== 'source' ? `_${preset.scale}` : ''}`
  const ext = CONTAINER_EXT[preset.container]
  let out = join(dir, `${base}${suffix}.${ext}`)
  let i = 1
  while (existsSync(out)) {
    out = join(dir, `${base}${suffix}-${i++}.${ext}`)
  }
  return out
}

/**
 * 并行转码队列（并发可调，默认 2）。
 * 预设：copy = 容器互换流复制；h264/hevc 优先硬件编码器；vp9/av1 软件编码。
 */
export class TranscodeQueue {
  private pending: Array<() => Promise<void>> = []
  private active = 0
  private concurrency = 2
  private controllers = new Map<string, AbortController>()
  private canceledWhileQueued = new Set<string>()
  private states = new Map<string, JobState>()

  constructor(private ctx: TranscodeJobContext) {}

  setConcurrency(n: number): void {
    this.concurrency = Math.min(4, Math.max(1, Math.floor(n) || 2))
    void this.drain()
  }

  submit(item: TranscodeItemRequest): string {
    const jobId = randomUUID()
    this.controllers.set(jobId, new AbortController())
    this.ctx.emit({ jobId, state: 'queued', phase: 'encode', percent: 0 })
    this.pending.push(() => this.run(jobId, item))
    void this.drain()
    return jobId
  }

  cancel(jobId: string): void {
    this.canceledWhileQueued.add(jobId)
    this.controllers.get(jobId)?.abort()
  }

  state(jobId: string): JobState | undefined {
    return this.states.get(jobId)
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0 && this.active < this.concurrency) {
      const job = this.pending.shift()!
      this.active++
      void job().finally(() => {
        this.active--
        void this.drain()
      })
    }
  }

  private async run(jobId: string, item: TranscodeItemRequest): Promise<void> {
    const ac = this.controllers.get(jobId)!
    const started = Date.now()
    let tmpOut: string | null = null
    try {
      if (this.canceledWhileQueued.has(jobId)) throw new CanceledError()
      this.states.set(jobId, 'running')

      const p = item.preset
      const info = await probeMedia(this.ctx.ffprobeBin, item.inputPath)
      if (!info.video) throw new Error('该文件没有视频轨')

      // 音频参数（webm 仅支持 opus/vorbis，不满足时自动转 opus）
      let audioArgs: string[]
      if (info.audio.length === 0) {
        audioArgs = []
      } else if (p.container === 'webm') {
        const a = info.audio[0].codec
        audioArgs =
          p.audio === 'copy' && (a === 'opus' || a === 'vorbis') ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '160k']
      } else {
        audioArgs = p.audio === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
      }

      // 视频参数
      let videoEncodeArgs: string[] | null = null
      if (p.videoCodec === 'copy') {
        if (p.container === 'webm' && !['vp9', 'vp8', 'av1'].includes(info.video.codec)) {
          throw new Error(`WebM 仅支持 VP9/AV1 视频流，源为 ${info.video.codec.toUpperCase()}，请选择转码（如 VP9）`)
        }
        if (p.scale !== 'source') {
          throw new Error('分辨率缩放需要重新编码，请把编码格式从「直接复制」改为具体编码')
        }
      } else {
        let enc: EncoderChoice
        if (p.videoCodec === 'h264' || p.videoCodec === 'hevc') {
          enc = this.ctx.forceSoftware
            ? { name: p.videoCodec === 'h264' ? 'libx264' : 'libx265', isHardware: false, args: [] }
            : await pickEncoder(this.ctx.ffmpegBin, p.videoCodec)
        } else if (p.videoCodec === 'vp9') {
          enc = { name: 'libvpx-vp9', isHardware: false, args: [] }
        } else {
          enc = { name: 'libsvtav1', isHardware: false, args: [] }
        }
        videoEncodeArgs = ['-c:v', enc.name, ...videoArgs(p.videoCodec, p.quality, enc.name)]
      }

      const outputPath = buildOutput(item.inputPath, p, item.outputDir)
      tmpOut = `${outputPath}.aiov-tmp-${jobId.slice(0, 6)}.part`

      const args = [
        '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
        '-i', item.inputPath,
        '-map', '0:v:0'
      ]
      if (info.audio.length > 0) args.push('-map', '0:a?')
      if (videoEncodeArgs) {
        args.push(...videoEncodeArgs)
        const vf = scaleFilter(p.scale)
        if (vf) args.push('-vf', vf)
        args.push('-pix_fmt', 'yuv420p')
      } else {
        args.push('-c', 'copy')
      }
      args.push(...audioArgs, ...MUXER[p.container], tmpOut)

      let lastTick = 0
      await runFfmpeg({
        bin: this.ctx.ffmpegBin,
        args,
        signal: ac.signal,
        onProgress: (pr) => {
          const now = Date.now()
          if (now - lastTick < 150) return
          lastTick = now
          const frac = info.durationSec > 0 ? Math.min(1, pr.outTimeSec / info.durationSec) : 1
          this.ctx.emit({
            jobId,
            state: 'running',
            phase: 'encode',
            percent: 4 + 92 * frac,
            speed: pr.speed != null ? `${pr.speed.toFixed(1)}x` : undefined
          })
        }
      })

      // 校验
      this.ctx.emit({ jobId, state: 'running', phase: 'verifying', percent: 97 })
      const outInfo = await probeMedia(this.ctx.ffprobeBin, tmpOut)
      if (!outInfo.video) throw new Error('输出没有视频轨')
      const tol = p.videoCodec === 'copy' ? 0.15 : Math.max(0.5, info.durationSec * 0.02)
      if (Math.abs(outInfo.durationSec - info.durationSec) > tol) {
        throw new Error(`输出时长校验失败：期望 ${info.durationSec.toFixed(2)}s，实际 ${outInfo.durationSec.toFixed(2)}s`)
      }

      await rename(tmpOut, outputPath)
      this.states.set(jobId, 'done')
      this.ctx.emit({ jobId, state: 'done', outputPath, durationMs: Date.now() - started })
    } catch (err) {
      const canceled =
        this.canceledWhileQueued.has(jobId) ||
        ac.signal.aborted ||
        err instanceof CanceledError ||
        (err instanceof FfmpegError && err.canceled)
      if (canceled) {
        this.states.set(jobId, 'canceled')
        this.ctx.emit({ jobId, state: 'canceled', durationMs: Date.now() - started })
      } else {
        this.states.set(jobId, 'failed')
        this.ctx.emit({
          jobId,
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started
        })
      }
    } finally {
      this.canceledWhileQueued.delete(jobId)
      this.controllers.delete(jobId)
      if (tmpOut && this.states.get(jobId) !== 'done') {
        await rm(tmpOut, { force: true }).catch(() => {})
      }
    }
  }
}
