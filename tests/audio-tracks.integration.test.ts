import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { JobEvent, JobResult } from '../shared/types'
import { runFfmpeg } from '../electron/services/ffmpeg-runner'
import { probeMedia } from '../electron/services/probe'
import { CutJobQueue } from '../electron/services/job-queue'

const EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_DIR = join(__dirname, '..', 'resources', 'bin')
const FFMPEG = join(BIN_DIR, `ffmpeg${EXT}`)
const FFPROBE = join(BIN_DIR, `ffprobe${EXT}`)
const hasBinaries = existsSync(FFMPEG) && existsSync(FFPROBE)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasBinaries)('端到端：音频分离', () => {
  const workDir = join(tmpdir(), `aiov-audio-${randomUUID().slice(0, 8)}`)
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

  function makeQueue(events: JobEvent[]): CutJobQueue {
    return new CutJobQueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      keyframeCacheDir: workDir,
      emit: (e) => events.push(e)
    })
  }

  async function runJob(events: JobEvent[], jobId: string): Promise<JobResult | undefined> {
    for (let i = 0; i < 600; i++) {
      await sleep(150)
      const final = events
        .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
        .findLast((e) => e.jobId === jobId)
      if (final) return final
    }
    return undefined
  }

  it('提取音频：1.5s→4.2s 输出 .m4a，无视频流，时长精确', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    const jobId = q.submit({
      inputPath: fixture,
      startSec: 1.5,
      endSec: 4.2,
      mode: 'smart',
      container: 'mp4',
      tracks: 'audio-only'
    })
    const final = await runJob(events, jobId)
    expect(final, JSON.stringify(events.slice(-3))).toBeDefined()
    expect(final!.state).toBe('done')
    expect(final!.outputPath!.endsWith('.m4a')).toBe(true)

    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(outInfo.video).toBeNull()
    expect(outInfo.audio.length).toBe(1)
    expect(outInfo.audio[0].codec).toBe('aac')
    // 音频包独立可解码 → 从精确入点复制，时长 2.7s
    expect(Math.abs(outInfo.durationSec - 2.7)).toBeLessThan(0.15)
  }, 120_000)

  it('仅视频：吸附 0.5s→2.0s 输出无音轨视频', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    const jobId = q.submit({
      inputPath: fixture,
      startSec: 0.5,
      endSec: 2.0,
      mode: 'keyframe-snap',
      container: 'mp4',
      tracks: 'video-only'
    })
    const final = await runJob(events, jobId)
    expect(final).toBeDefined()
    expect(final!.state).toBe('done')
    expect(final!.outputPath!.endsWith('.mp4')).toBe(true)

    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(outInfo.video).not.toBeNull()
    expect(outInfo.video!.codec).toBe('h264')
    expect(outInfo.audio.length).toBe(0)
    // 吸附到关键帧 0 → 时长约 2.0s
    expect(Math.abs(outInfo.durationSec - 2.0)).toBeLessThan(0.15)
  }, 120_000)
})
