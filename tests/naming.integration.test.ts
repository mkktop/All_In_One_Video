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

describe.skipIf(!hasBinaries)('端到端：自定义命名与导出目录', () => {
  const srcDir = join(tmpdir(), `aiov-name-${randomUUID().slice(0, 8)}`)
  const outDir = join(srcDir, '自定义输出')
  const fixture = join(srcDir, 'fixture.mp4')

  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true })
    await runFfmpeg({
      bin: FFMPEG,
      args: [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
        '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-sc_threshold', '0',
        fixture
      ]
    })
  }, 60_000)

  it('自定义文件名+目录导出，非法字符被清理', async () => {
    const events: JobEvent[] = []
    const q = new CutJobQueue({
      ffmpegBin: FFMPEG, ffprobeBin: FFPROBE, keyframeCacheDir: srcDir,
      emit: (e) => events.push(e)
    })
    const jobId = q.submit({
      inputPath: fixture,
      startSec: 0,
      endSec: 2,
      mode: 'keyframe-snap',
      container: 'mp4',
      outputDir: outDir,
      outputName: '我的剪辑:作品*?<>' // 非法字符应被清理
    })
    let final: JobResult | undefined
    for (let i = 0; i < 400; i++) {
      await sleep(150)
      final = events
        .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
        .findLast((e) => e.jobId === jobId)
      if (final) break
    }
    expect(final).toBeDefined()
    expect(final!.state).toBe('done')
    expect(final!.outputPath!.startsWith(outDir)).toBe(true)
    expect(final!.outputPath!.endsWith('我的剪辑作品.mp4')).toBe(true)
    expect(existsSync(final!.outputPath!)).toBe(true)
    const info = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(info.durationSec - 2)).toBeLessThan(0.15)
  }, 120_000)
})
