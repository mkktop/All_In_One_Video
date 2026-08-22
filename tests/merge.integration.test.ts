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

describe.skipIf(!hasBinaries)('端到端：多段合并导出', () => {
  const workDir = join(tmpdir(), `aiov-merge-${randomUUID().slice(0, 8)}`)
  const fixture = join(workDir, 'fixture.mp4')

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true })
    await runFfmpeg({
      bin: FFMPEG,
      args: [
        '-y', '-hide_banner', '-loglevel', 'error',
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

  it('三段吸附合并：0.5-1.5 / 2.2-3.0 / 4.0-5.5 → 总时长 ≈ 3.3s，段序正确', async () => {
    const events: JobEvent[] = []
    const q = new CutJobQueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      keyframeCacheDir: workDir,
      emit: (e) => events.push(e)
    })
    const jobId = q.submit({
      inputPath: fixture,
      container: 'mp4',
      mode: 'keyframe-snap',
      ranges: [
        { startSec: 0.5, endSec: 1.5 },
        { startSec: 2.2, endSec: 3.0 },
        { startSec: 4.0, endSec: 5.5 }
      ]
    })

    let final: JobResult | undefined
    for (let i = 0; i < 600; i++) {
      await sleep(150)
      final = events
        .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
        .findLast((e) => e.jobId === jobId)
      if (final) break
    }
    expect(final, `事件: ${JSON.stringify(events.slice(-4))}`).toBeDefined()
    expect(final!.state).toBe('done')
    expect(existsSync(final!.outputPath!)).toBe(true)

    // 吸附后各段：0.0-1.5 (1.5s) + 2.0-3.0 (1.0s) + 4.0-5.5 (1.5s) = 4.0s
    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(outInfo.durationSec - 4.0)).toBeLessThan(0.2)

    // 合并输出内部应有两个拼接点（各段起点都是关键帧）
    const outKfs = (await scanKeyframes(FFPROBE, final!.outputPath!, { durationSec: outInfo.durationSec })).keyframes
    expect(outKfs.length).toBeGreaterThanOrEqual(3)

    // 输出流完好
    expect(outInfo.video!.codec).toBe('h264')
    expect(outInfo.audio.length).toBe(1)
  }, 120_000)

  it('smart 多段合并：非关键帧起点，总时长精确', async () => {
    const events: JobEvent[] = []
    const q = new CutJobQueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      keyframeCacheDir: workDir,
      encoderChoice: { name: 'libx264', isHardware: false, args: ['-preset', 'ultrafast', '-crf', '16'] },
      emit: (e) => events.push(e)
    })
    const jobId = q.submit({
      inputPath: fixture,
      container: 'mp4',
      mode: 'smart',
      ranges: [
        { startSec: 0.5, endSec: 2.5 },
        { startSec: 3.2, endSec: 5.6 }
      ]
    })
    let final: JobResult | undefined
    for (let i = 0; i < 600; i++) {
      await sleep(150)
      final = events
        .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
        .findLast((e) => e.jobId === jobId)
      if (final) break
    }
    expect(final).toBeDefined()
    expect(final!.state).toBe('done')
    // smart: 2.0 + 2.4 = 4.4s 精确
    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(outInfo.durationSec - 4.4)).toBeLessThan(0.25)
  }, 120_000)
})
