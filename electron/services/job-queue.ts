import { randomUUID } from 'crypto'
import { existsSync, writeFileSync } from 'fs'
import { mkdir, rm, rename } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { CutMode, CutRequest, JobEvent, JobState, MediaInfo, MultiCutRequest } from '../../shared/types'
import { planSegments } from '../../shared/planner'
import { FfmpegError, runFfmpeg } from './ffmpeg-runner'
import { probeMedia } from './probe'
import { scanKeyframes } from './keyframes'
import { pickEncoder, type EncoderChoice } from './encoders'

export interface CutJobContext {
  ffmpegBin: string
  ffprobeBin: string
  keyframeCacheDir: string
  /** 测试注入用；默认自动探测（nvenc→qsv→amf→libx*） */
  encoderChoice?: EncoderChoice
  emit: (e: JobEvent) => void
}

export type AnyCutRequest = CutRequest | MultiCutRequest

type EncodeSegment = { kind: 'encode'; startSec: number; endSec: number }
type CopySegment = { kind: 'copy'; startSec: number; endSec: number }

class CanceledError extends Error {
  constructor() {
    super('已取消')
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function buildOutputPath(inputPath: string, container: 'mp4' | 'mkv', suffix: string): string {
  const dir = dirname(inputPath)
  const base = basename(inputPath).replace(/\.[^.]+$/, '')
  let out = join(dir, `${base}_cut_${suffix}_${timestamp()}.${container}`)
  let i = 1
  while (existsSync(out)) {
    out = join(dir, `${base}_cut_${suffix}_${timestamp()}-${i++}.${container}`)
  }
  return out
}

function mapProfile(sourceProfile: string | null, codec: 'h264' | 'hevc'): string | null {
  const p = (sourceProfile ?? '').toLowerCase()
  if (codec === 'h264') {
    if (p.includes('baseline')) return 'baseline'
    if (p.includes('main')) return 'main'
    if (p.includes('high')) return 'high'
  } else {
    if (p.includes('main')) return 'main'
  }
  return null
}

/** 源 SAR 形如 "1:1"；异常值（N/A 等）按 1:1 处理 */
function safeSar(sar: string): string {
  return /^-?\d+:\d+$/.test(sar) ? sar : '1:1'
}

function buildCopyArgs(
  input: string,
  copyStart: number,
  dur: number,
  hasVideo: boolean,
  container: 'mp4' | 'mkv',
  out: string
): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-ss',
    copyStart.toFixed(6),
    '-i',
    input,
    '-t',
    dur.toFixed(6)
  ]
  if (hasVideo) {
    args.push('-map', '0:v:0', '-map', '0:a?')
  } else {
    args.push('-map', '0:a:0')
  }
  args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  if (container === 'mp4') {
    args.push('-movflags', '+faststart', '-f', 'mp4')
  } else {
    args.push('-f', 'matroska')
  }
  args.push(out)
  return args
}

/** 转码段参数：对齐源视频的分辨率/SAR/像素格式/profile，时间戳直通 */
function buildEncodeArgs(
  input: string,
  startSec: number,
  dur: number,
  info: MediaInfo,
  enc: EncoderChoice,
  out: string
): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-ss',
    startSec.toFixed(6),
    '-i',
    input,
    '-t',
    dur.toFixed(6),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    enc.name,
    ...enc.args
  ]
  const v = info.video!
  const codec = v.codec === 'hevc' ? 'hevc' : 'h264'
  const profile = mapProfile(v.profile, codec)
  if (profile) args.push('-profile:v', profile)
  // 8bit 源强制 yuv420p；10bit 源保留原像素格式避免色彩/位深跳变
  if (!v.pixFmt.includes('10')) args.push('-pix_fmt', 'yuv420p')
  args.push('-vf', `setsar=${safeSar(v.sar)}`)
  args.push('-fps_mode', 'passthrough')
  args.push('-c:a', 'aac', '-b:a', '192k')
  args.push('-movflags', '+faststart')
  args.push(out)
  return args
}

function writeConcatList(file: string, parts: string[]): void {
  const body = parts
    .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n')
  writeFileSync(file, body + '\n', 'utf8')
}

/**
 * 串行剪切任务队列。
 * - 单段：吸附纯复制 / smart 两段式（B 复制 → A 转码 → concat），失败整段转码兜底
 * - 多段（MultiCutRequest）：逐段生成后 concat 合并为一个文件
 */
export class CutJobQueue {
  private pending: Array<() => Promise<void>> = []
  private draining = false
  private controllers = new Map<string, AbortController>()
  private canceledWhileQueued = new Set<string>()
  private states = new Map<string, JobState>()

  constructor(private ctx: CutJobContext) {}

  submit(req: AnyCutRequest): string {
    const jobId = randomUUID()
    this.controllers.set(jobId, new AbortController())
    this.ctx.emit({ jobId, state: 'queued', phase: 'planning', percent: 0 })
    this.pending.push(() => this.run(jobId, req))
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
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!
        await job()
      }
    } finally {
      this.draining = false
    }
  }

  private emitProgress(
    jobId: string,
    phase: 'planning' | 'copy' | 'encode' | 'concat' | 'verifying',
    percent: number,
    speed?: string
  ): void {
    this.ctx.emit({ jobId, state: 'running', phase, percent, speed })
  }

  /** 带进度窗口的 ffmpeg 执行：把 outTime/dur 映射到 [fromPct, toPct] */
  private async runWeighted(
    jobId: string,
    phase: 'copy' | 'encode' | 'concat',
    fromPct: number,
    toPct: number,
    durSec: number,
    args: string[],
    ac: AbortSignal
  ): Promise<void> {
    let lastTick = 0
    await runFfmpeg({
      bin: this.ctx.ffmpegBin,
      args,
      signal: ac,
      onProgress: (p) => {
        const now = Date.now()
        if (now - lastTick < 120) return
        lastTick = now
        const frac = durSec > 0 ? Math.min(1, p.outTimeSec / durSec) : 1
        this.emitProgress(jobId, phase, fromPct + (toPct - fromPct) * frac, p.speed != null ? `${p.speed.toFixed(1)}x` : undefined)
      }
    })
    this.emitProgress(jobId, phase, toPct)
  }

  private async encoderFor(codec: string): Promise<EncoderChoice> {
    if (this.ctx.encoderChoice) return this.ctx.encoderChoice
    return pickEncoder(this.ctx.ffmpegBin, codec === 'hevc' ? 'hevc' : 'h264')
  }

  /**
   * 为一个 [startSec, endSec) 区间生成片段文件（吸附复制 / smart 两段式 / 整段转码）。
   * 进度映射到 [fromPct, toPct]。返回期望时长（秒）。
   */
  private async produceRange(
    jobId: string,
    info: MediaInfo,
    keyframes: number[],
    inputPath: string,
    mode: CutMode,
    startSec: number,
    endSec: number,
    container: 'mp4' | 'mkv',
    outPath: string,
    workDir: string,
    fromPct: number,
    toPct: number,
    ac: AbortSignal,
    notices: string[],
    forceWhole: boolean
  ): Promise<number> {
    const frameDur = 1 / (info.video?.fps || 25)
    const hardEnd = Math.min(endSec, info.durationSec)
    const segs = planSegments({
      mode,
      startSec,
      endSec,
      keyframes,
      frameDurSec: frameDur,
      maxSec: info.durationSec
    })
    if (segs.length === 0) throw new Error('无效的剪切区间：入点必须早于出点')
    const encodeSeg = segs.find((s): s is EncodeSegment => s.kind === 'encode')
    const copySeg = segs.find((s): s is CopySegment => s.kind === 'copy')

    const srcCodec = info.video?.codec
    const codecSupported = srcCodec === 'h264' || srcCodec === 'hevc'
    const useSmart = !forceWhole && encodeSeg != null && copySeg != null && codecSupported
    if (encodeSeg != null && !codecSupported && !forceWhole) {
      notices.push(`源编码 ${srcCodec ?? '未知'} 暂不支持无损分段，已整段转码`)
    }

    const span = toPct - fromPct

    const encodeWhole = async (a: number, b: number): Promise<number> => {
      const enc = await this.encoderFor(srcCodec ?? 'h264')
      const dur = hardEnd - startSec
      await this.runWeighted(
        jobId,
        'encode',
        a,
        b,
        dur,
        buildEncodeArgs(inputPath, startSec, dur, info, enc, outPath),
        ac
      )
      return dur
    }

    if (encodeSeg == null) {
      // —— 纯流复制 ——
      const copy = copySeg!
      const dur = copy.endSec - copy.startSec
      await this.runWeighted(
        jobId,
        'copy',
        fromPct,
        toPct,
        dur,
        buildCopyArgs(inputPath, copy.startSec, dur, info.video != null, container, outPath),
        ac
      )
      return dur
    }

    if (useSmart) {
      // —— smart 两段式：B 复制 → 实测校验 → A 转码 → concat ——
      const enc = await this.encoderFor(srcCodec!)
      const segB = join(workDir, `seg_b_${randomUUID().slice(0, 6)}.mp4`)
      const segA = join(workDir, `seg_a_${randomUUID().slice(0, 6)}.mp4`)
      const durB = copySeg!.endSec - copySeg!.startSec
      await this.runWeighted(
        jobId,
        'copy',
        fromPct,
        fromPct + span * 0.6,
        durB,
        buildCopyArgs(inputPath, copySeg!.startSec, durB, true, 'mp4', segB),
        ac
      )
      const bInfo = await probeMedia(this.ctx.ffprobeBin, segB)
      if (Math.abs(bInfo.durationSec - durB) > Math.max(0.1, 2 * frameDur)) {
        notices.push('复制段时长异常，已整段转码兜底')
        return encodeWhole(fromPct + span * 0.6, toPct)
      }
      const durA = encodeSeg.endSec - encodeSeg.startSec
      await this.runWeighted(
        jobId,
        'encode',
        fromPct + span * 0.6,
        fromPct + span * 0.87,
        durA,
        buildEncodeArgs(inputPath, encodeSeg.startSec, durA, info, enc, segA),
        ac
      )
      const listFile = join(workDir, `list_${randomUUID().slice(0, 6)}.txt`)
      writeConcatList(listFile, [segA, segB])
      await this.runWeighted(
        jobId,
        'concat',
        fromPct + span * 0.87,
        toPct,
        endSec - startSec,
        [
          '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
          '-f', 'concat', '-safe', '0', '-i', listFile,
          '-c', 'copy',
          ...(container === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'matroska']),
          outPath
        ],
        ac
      )
      return endSec - startSec
    }

    // —— 整段转码（起点后无关键帧 / 不支持的编码 / 兜底）——
    return encodeWhole(fromPct, toPct)
  }

  private async run(jobId: string, req: AnyCutRequest): Promise<void> {
    const ac = this.controllers.get(jobId)!
    const started = Date.now()
    let tempDir: string | null = null
    const notices: string[] = []
    try {
      if (this.canceledWhileQueued.has(jobId)) throw new CanceledError()
      this.states.set(jobId, 'running')

      this.emitProgress(jobId, 'planning', 2)
      const info = await probeMedia(this.ctx.ffprobeBin, req.inputPath)
      const keyframes = info.video
        ? (
            await scanKeyframes(this.ctx.ffprobeBin, req.inputPath, {
              cacheDir: this.ctx.keyframeCacheDir,
              durationSec: info.durationSec,
              signal: ac.signal
            })
          ).keyframes
        : []
      const frameDur = 1 / (info.video?.fps || 25)
      const tolBase = Math.max(0.15, 2.5 * frameDur)

      const mode: CutMode = req.mode
      const container = req.container
      const isMulti = 'ranges' in req
      const outputPath = buildOutputPath(req.inputPath, container, isMulti ? `${req.ranges.length}段` : 'seg')
      tempDir = join(dirname(outputPath), `.aiov-tmp-${jobId.slice(0, 8)}`)
      await mkdir(tempDir, { recursive: true })
      const tmpOut = join(tempDir, `out.${container}`)

      if (info.isVfr && mode === 'smart') {
        notices.push('源为可变帧率(VFR)，转码段已按原始时间戳直通处理')
      }

      if (!isMulti) {
        // —— 单段导出 ——
        const expectedDur = await this.produceRange(
          jobId, info, keyframes, req.inputPath, mode,
          req.startSec, req.endSec, container, tmpOut, tempDir, 4, 96, ac.signal, notices, false
        )
        this.emitProgress(jobId, 'verifying', 97)
        let outInfo = await probeMedia(this.ctx.ffprobeBin, tmpOut)
        if (Math.abs(outInfo.durationSec - expectedDur) > tolBase) {
          // 拼接异常 → 整段转码重试一次
          notices.push('拼接结果时长校验未通过，已整段转码兜底')
          await this.produceRange(
            jobId, info, keyframes, req.inputPath, mode,
            req.startSec, req.endSec, container, tmpOut, tempDir, 50, 96, ac.signal, notices, true
          )
          this.emitProgress(jobId, 'verifying', 97)
          outInfo = await probeMedia(this.ctx.ffprobeBin, tmpOut)
        }
        if (Math.abs(outInfo.durationSec - expectedDur) > tolBase) {
          throw new Error(`输出时长校验失败：期望 ${expectedDur.toFixed(2)}s，实际 ${outInfo.durationSec.toFixed(2)}s`)
        }
      } else {
        // —— 多段合并导出：逐段生成，最后 concat ——
        const ranges = req.ranges
        if (ranges.length === 0) throw new Error('片段列表为空')
        const rawTotal = ranges.reduce((s, r) => s + (Math.min(r.endSec, info.durationSec) - r.startSec), 0)
        const segFiles: string[] = []
        const expectedDurs: number[] = []
        let cursor = 4
        for (const [i, r] of ranges.entries()) {
          const segOut = join(tempDir, `part_${String(i).padStart(3, '0')}.${container}`)
          const share = (88 * (Math.min(r.endSec, info.durationSec) - r.startSec)) / rawTotal
          const d = await this.produceRange(
            jobId, info, keyframes, req.inputPath, mode,
            r.startSec, r.endSec, container, segOut, tempDir, cursor, cursor + share, ac.signal, notices, false
          )
          expectedDurs.push(d)
          cursor += share
          segFiles.push(segOut)
        }
        // 吸附模式各段实际从关键帧开始，期望总时长 = 各段实际时长之和
        const expectedTotal = expectedDurs.reduce((a, b) => a + b, 0)
        writeConcatList(join(tempDir, 'list.txt'), segFiles)
        await this.runWeighted(
          jobId,
          'concat',
          92,
          96,
          expectedTotal,
          [
            '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
            '-f', 'concat', '-safe', '0', '-i', join(tempDir, 'list.txt'),
            '-c', 'copy',
            ...(container === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'matroska']),
            tmpOut
          ],
          ac.signal
        )
        this.emitProgress(jobId, 'verifying', 97)
        const outInfo = await probeMedia(this.ctx.ffprobeBin, tmpOut)
        const tolMulti = tolBase * ranges.length
        if (Math.abs(outInfo.durationSec - expectedTotal) > tolMulti) {
          throw new Error(`合并时长校验失败：期望 ${expectedTotal.toFixed(2)}s，实际 ${outInfo.durationSec.toFixed(2)}s`)
        }
      }

      await rename(tmpOut, outputPath)
      this.states.set(jobId, 'done')
      this.ctx.emit({
        jobId,
        state: 'done',
        outputPath,
        durationMs: Date.now() - started,
        ...(notices.length > 0 ? { notice: notices.join('；') } : {})
      })
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
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
