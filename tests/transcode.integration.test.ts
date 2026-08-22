import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { JobEvent, JobResult } from '../shared/types'
import { runFfmpeg } from '../electron/services/ffmpeg-runner'
import { probeMedia } from '../electron/services/probe'
import { TranscodeQueue } from '../electron/services/transcode-queue'

const EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_DIR = join(__dirname, '..', 'resources', 'bin')
const FFMPEG = join(BIN_DIR, `ffmpeg${EXT}`)
const FFPROBE = join(BIN_DIR, `ffprobe${EXT}`)
const hasBinaries = existsSync(FFMPEG) && existsSync(FFPROBE)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasBinaries)('端到端：批量转码 / 格式转换', () => {
  const workDir = join(tmpdir(), `aiov-tc-${randomUUID().slice(0, 8)}`)
  const src1 = join(workDir, 'a.mp4')
  const src2 = join(workDir, 'b.mp4')

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true })
    for (const [f, freq] of [
      [src1, 440],
      [src2, 880]
    ] as const) {
      await runFfmpeg({
        bin: FFMPEG,
        args: [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
          '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100`,
          '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-sc_threshold', '0',
          '-c:a', 'aac', '-shortest', f
        ]
      })
    }
  }, 60_000)

  function makeQueue(events: JobEvent[]): TranscodeQueue {
    return new TranscodeQueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      forceSoftware: true,
      emit: (e) => events.push(e)
    })
  }

  async function waitJob(events: JobEvent[], jobId: string): Promise<JobResult | undefined> {
    for (let i = 0; i < 600; i++) {
      await sleep(150)
      const final = events
        .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
        .findLast((e) => e.jobId === jobId)
      if (final) return final
    }
    return undefined
  }

  it('批量转 H.264（并发 2）：两个文件全部完成，编码正确', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    q.setConcurrency(2)
    const ids = [src1, src2].map((p) =>
      q.submit({ inputPath: p, outputDir: workDir, preset: { videoCodec: 'h264', quality: 'balanced', scale: 'source', audio: 'copy', container: 'mp4' } })
    )
    const results: Array<JobResult | undefined> = []
    for (const id of ids) results.push(await waitJob(events, id))
    for (const r of results) {
      expect(r, JSON.stringify(events.slice(-3))).toBeDefined()
      expect(r!.state).toBe('done')
      const info = await probeMedia(FFPROBE, r!.outputPath!)
      expect(info.video!.codec).toBe('h264')
      expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.3)
    }
    // 输出文件名带 _h264 后缀
    expect(results[0]!.outputPath!.includes('_h264')).toBe(true)
  }, 180_000)

  it('容器互换 mp4→mkv 流复制：秒转且流参数不变', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    const id = q.submit({
      inputPath: src1,
      outputDir: workDir,
      preset: { videoCodec: 'copy', quality: 'balanced', scale: 'source', audio: 'copy', container: 'mkv' }
    })
    const r = await waitJob(events, id)
    expect(r).toBeDefined()
    expect(r!.state).toBe('done')
    expect(r!.outputPath!.endsWith('.mkv')).toBe(true)
    const info = await probeMedia(FFPROBE, r!.outputPath!)
    expect(info.video!.codec).toBe('h264')
    expect(info.audio[0].codec).toBe('aac')
    expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.15)
    expect(r!.durationMs!).toBeLessThan(5000)
  }, 120_000)

  it('WebM 规则：h264 流复制被拒绝并给出明确提示；VP9 转码成功且音频自动转 Opus', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    // h264 → webm copy 应快速失败
    const idFail = q.submit({
      inputPath: src1,
      outputDir: workDir,
      preset: { videoCodec: 'copy', quality: 'balanced', scale: 'source', audio: 'copy', container: 'webm' }
    })
    const rf = await waitJob(events, idFail)
    expect(rf).toBeDefined()
    expect(rf!.state).toBe('failed')
    expect(rf!.error).toContain('WebM')

    // vp9 → webm 转码成功
    const idOk = q.submit({
      inputPath: src1,
      outputDir: workDir,
      preset: { videoCodec: 'vp9', quality: 'balanced', scale: 'source', audio: 'copy', container: 'webm' }
    })
    const rok = await waitJob(events, idOk)
    expect(rok).toBeDefined()
    expect(rok!.state).toBe('done')
    const info = await probeMedia(FFPROBE, rok!.outputPath!)
    expect(info.video!.codec).toBe('vp9')
    // 源音频 aac 不兼容 webm → 自动转 opus
    expect(info.audio[0].codec).toBe('opus')
  }, 180_000)

  it('分辨率缩放：720p 上限生效', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    const id = q.submit({
      inputPath: src1,
      outputDir: workDir,
      preset: { videoCodec: 'h264', quality: 'compact', scale: '720p', audio: 'aac', container: 'mp4' }
    })
    const r = await waitJob(events, id)
    expect(r).toBeDefined()
    expect(r!.state).toBe('done')
    const info = await probeMedia(FFPROBE, r!.outputPath!)
    expect(info.video!.height).toBe(240) // 源 240p < 720p → 不放大
  }, 120_000)
})
