import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { JobEvent, JobResult } from '../shared/types'
import { runFfmpeg } from '../electron/services/ffmpeg-runner'
import { probeMedia } from '../electron/services/probe'
import { CutJobQueue } from '../electron/services/job-queue'
import { pickEncoder } from '../electron/services/encoders'

const execFileP = promisify(execFile)

const EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_DIR = join(__dirname, '..', 'resources', 'bin')
const FFMPEG = join(BIN_DIR, `ffmpeg${EXT}`)
const FFPROBE = join(BIN_DIR, `ffprobe${EXT}`)
const hasBinaries = existsSync(FFMPEG) && existsSync(FFPROBE)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFinal(events: JobEvent[], jobId: string): Promise<JobResult | undefined> {
  for (let i = 0; i < 600; i++) {
    await sleep(150)
    const final = events
      .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
      .findLast((e) => e.jobId === jobId)
    if (final) return final
  }
  return undefined
}

/** SSIM 对比 source 的 [start, start+dur) 窗口与 output 全片（时间戳归零后按帧序配对） */
async function ssimCompare(source: string, output: string, start: number, dur: number): Promise<number> {
  const { stderr } = await execFileP(
    FFMPEG,
    [
      '-hide_banner',
      '-ss', start.toFixed(3),
      '-t', dur.toFixed(3),
      '-i', source,
      '-i', output,
      '-lavfi', '[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim',
      '-f', 'null',
      '-'
    ],
    { windowsHide: true }
  )
  const m = [...stderr.matchAll(/SSIM Y:([\d.]+)/g)]
  if (m.length === 0) throw new Error(`SSIM 未输出: ${stderr.slice(-300)}`)
  return Number.parseFloat(m[m.length - 1][1])
}

describe.skipIf(!hasBinaries)('端到端：smart cut 帧级精确', () => {
  const workDir = join(tmpdir(), `aiov-smart-${randomUUID().slice(0, 8)}`)
  const fixture = join(workDir, 'fixture.mp4')

  // 测试注入 libx264，保证断言不依赖本机硬件
  const encoderChoice = { name: 'libx264', isHardware: false, args: ['-preset', 'ultrafast', '-crf', '16'] }

  function makeQueue(events: JobEvent[]): CutJobQueue {
    return new CutJobQueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      keyframeCacheDir: workDir,
      encoderChoice,
      emit: (e) => events.push(e)
    })
  }

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

  it('编码器探测返回可用编码器', async () => {
    const enc = await pickEncoder(FFMPEG, 'h264')
    expect(enc.name.length).toBeGreaterThan(0)
    expect(enc.args.length).toBeGreaterThan(0)
  })

  it('非关键帧起点 1.5s→4.2s：输出时长精确 2.7s 且画面逐帧吻合', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    const jobId = q.submit({
      inputPath: fixture,
      startSec: 1.5,
      endSec: 4.2,
      mode: 'smart',
      container: 'mp4'
    })
    const final = await waitFinal(events, jobId)
    expect(final, `事件: ${JSON.stringify(events.slice(-4))}`).toBeDefined()
    expect(final!.state).toBe('done')
    expect(final!.notice).toBeUndefined()

    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(outInfo.durationSec - 2.7)).toBeLessThan(0.12)

    // 帧级验证：源窗口与输出逐帧 SSIM；头部为 crf16 转码（>0.9），复制段=1，整体应很高
    const ssim = await ssimCompare(fixture, final!.outputPath!, 1.5, 2.7)
    expect(ssim).toBeGreaterThan(0.9)

    // 结构验证：经历 copy + encode + concat 三个阶段
    const phases = [...new Set(events.filter((e) => 'phase' in e).map((e) => (e as { phase: string }).phase))]
    expect(phases).toContain('encode')
    expect(phases).toContain('concat')
  }, 120_000)

  it('起点恰在关键帧（2.0s→5.0s）：走纯复制路径，时长精确 3.0s', async () => {
    const events: JobEvent[] = []
    const q = makeQueue(events)
    const jobId = q.submit({
      inputPath: fixture,
      startSec: 2.0,
      endSec: 5.0,
      mode: 'smart',
      container: 'mp4'
    })
    const final = await waitFinal(events, jobId)
    expect(final).toBeDefined()
    expect(final!.state).toBe('done')

    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(outInfo.durationSec - 3.0)).toBeLessThan(0.12)

    // 起点在关键帧 → 不应出现转码阶段
    const phases = [...new Set(events.filter((e) => 'phase' in e).map((e) => (e as { phase: string }).phase))]
    expect(phases).not.toContain('encode')

    // 纯复制 → 与源逐帧一致（SSIM ≈ 1）
    const ssim = await ssimCompare(fixture, final!.outputPath!, 2.0, 3.0)
    expect(ssim).toBeGreaterThan(0.99)
  }, 120_000)
})
