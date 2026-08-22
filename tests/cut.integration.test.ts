import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { JobEvent, JobResult } from '../shared/types'
import { runFfmpeg } from '../electron/services/ffmpeg-runner'
import { probeMedia } from '../electron/services/probe'
import { scanKeyframes } from '../electron/services/keyframes'
import { CutJobQueue } from '../electron/services/job-queue'

const EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_DIR = join(__dirname, '..', 'resources', 'bin')
const FFMPEG = join(BIN_DIR, `ffmpeg${EXT}`)
const FFPROBE = join(BIN_DIR, `ffprobe${EXT}`)
const hasBinaries = existsSync(FFMPEG) && existsSync(FFPROBE)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasBinaries)('端到端：真实视频吸附剪切', () => {
  const workDir = join(tmpdir(), `aiov-test-${randomUUID().slice(0, 8)}`)
  const fixture = join(workDir, 'fixture.mp4')

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true })
    // testsrc2 生成 6 秒 30fps CFR 视频，强制每 30 帧（1s）一个关键帧
    await runFfmpeg({
      bin: FFMPEG,
      args: [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-c:a', 'aac',
        '-shortest',
        fixture
      ]
    })
  }, 60_000)

  it('探测：媒体信息正确', async () => {
    const info = await probeMedia(FFPROBE, fixture)
    expect(info.video).not.toBeNull()
    expect(info.video!.codec).toBe('h264')
    expect(info.video!.width).toBe(320)
    expect(Math.abs(info.durationSec - 6)).toBeLessThan(0.2)
    expect(info.isVfr).toBe(false)
    expect(info.audio.length).toBe(1)
  })

  it('关键帧扫描：每秒一个关键帧', async () => {
    const { keyframes, fromCache } = await scanKeyframes(FFPROBE, fixture, {
      cacheDir: workDir,
      durationSec: 6
    })
    expect(fromCache).toBe(false)
    expect(keyframes.length).toBeGreaterThanOrEqual(6)
    // 0,1,2,3,4,5 各一个（±20ms）
    for (let s = 0; s < 6; s++) {
      expect(keyframes.some((k) => Math.abs(k - s) < 0.02)).toBe(true)
    }
    // 缓存命中
    const again = await scanKeyframes(FFPROBE, fixture, { cacheDir: workDir })
    expect(again.fromCache).toBe(true)
    expect(again.keyframes).toEqual(keyframes)
  })

  it('完整剪切任务：入点 1.5s 出点 4.2s → 实际从关键帧 1.0s 复制到 4.2s', async () => {
    const events: JobEvent[] = []
    const q = new CutJobQueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      keyframeCacheDir: workDir,
      emit: (e) => events.push(e)
    })
    q.submit({
      inputPath: fixture,
      startSec: 1.5,
      endSec: 4.2,
      mode: 'keyframe-snap',
      container: 'mp4'
    })

    let final: JobResult | undefined
    for (let i = 0; i < 300; i++) {
      await sleep(200)
      final = events
        .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
        .pop()
      if (final) break
    }
    expect(final, `任务未结束，事件: ${JSON.stringify(events.slice(-3))}`).toBeDefined()
    expect(final!.state).toBe('done')
    expect(existsSync(final!.outputPath!)).toBe(true)

    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    // 从 1.0s 复制到 4.2s → 时长约 3.2s
    expect(Math.abs(outInfo.durationSec - 3.2)).toBeLessThan(0.15)
    expect(outInfo.video!.codec).toBe('h264')
    expect(outInfo.audio.length).toBe(1)

    // 输出文件首帧应在关键帧 1.0s
    const outKfs = (await scanKeyframes(FFPROBE, final!.outputPath!, { durationSec: outInfo.durationSec })).keyframes
    expect(outKfs.length).toBeGreaterThan(0)
    expect(Math.abs(outKfs[0])).toBeLessThan(0.05)
  }, 120_000)

  it('取消：runFfmpeg AbortSignal → canceled', async () => {
    const ac = new AbortController()
    const p = runFfmpeg({
      bin: FFMPEG,
      args: [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=60',
        '-t', '20',
        '-c:v', 'libx264', '-preset', 'slow',
        join(workDir, 'cancel.mp4')
      ],
      signal: ac.signal
    })
    await sleep(500)
    ac.abort()
    await expect(p).rejects.toMatchObject({ canceled: true })
  }, 60_000)
})
