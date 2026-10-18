import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { MediaInfo, JobEvent, JobResult } from '../shared/types'
import { mergeIncompatibility } from '../shared/compat'
import { runFfmpeg } from '../electron/services/ffmpeg-runner'
import { probeMedia } from '../electron/services/probe'
import { CutJobQueue } from '../electron/services/job-queue'

const EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_DIR = join(__dirname, '..', 'resources', 'bin')
const FFMPEG = join(BIN_DIR, `ffmpeg${EXT}`)
const FFPROBE = join(BIN_DIR, `ffprobe${EXT}`)
const hasBinaries = existsSync(FFMPEG) && existsSync(FFPROBE)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function mkInfo(
  o: {
    noVideo?: boolean
    codec?: string
    fps?: number
    w?: number
    h?: number
    pixFmt?: string
    profile?: string | null
    noAudio?: boolean
    aCodec?: string
    aRate?: number
    aCh?: number
    vfr?: boolean
  } = {}
): MediaInfo {
  return {
    path: 'p',
    fileName: 'p',
    fileSize: 0,
    durationSec: 10,
    container: 'mp4',
    video: o.noVideo
      ? null
      : {
          index: 0,
          codec: o.codec ?? 'h264',
          width: o.w ?? 1920,
          height: o.h ?? 1080,
          fps: o.fps ?? 30,
          avgFps: o.fps ?? 30,
          pixFmt: o.pixFmt ?? 'yuv420p',
          profile: o.profile ?? 'High',
          level: 40,
          sar: '1:1',
          hasBFrames: false,
          bitrate: 1
        },
    audio: o.noAudio
      ? []
      : [{ index: 1, codec: o.aCodec ?? 'aac', sampleRate: o.aRate ?? 48000, channels: o.aCh ?? 2, bitrate: 1 }],
    isVfr: o.vfr ?? false
  }
}

describe('mergeIncompatibility 纯函数', () => {
  it('单一源 / 参数一致 → null', () => {
    expect(mergeIncompatibility([mkInfo()])).toBeNull()
    expect(mergeIncompatibility([mkInfo(), mkInfo(), mkInfo()])).toBeNull()
    // 同标称帧率（60000/1001 的探测浮点完全一致）
    expect(mergeIncompatibility([mkInfo({ fps: 59.94005994005994 }), mkInfo({ fps: 59.94005994005994 })])).toBeNull()
  })

  it('帧率不同 → 提示帧率（29.97 vs 30 也要判不一致）', () => {
    expect(mergeIncompatibility([mkInfo({ fps: 24 }), mkInfo({ fps: 60 })])).toMatch(/帧率不同/)
    expect(mergeIncompatibility([mkInfo({ fps: 29.97 }), mkInfo({ fps: 30 })])).toMatch(/帧率不同/)
  })

  it('分辨率 / 编码 / 像素格式 / profile / 音轨差异', () => {
    expect(mergeIncompatibility([mkInfo(), mkInfo({ w: 3840, h: 2160 })])).toMatch(/分辨率不同/)
    expect(mergeIncompatibility([mkInfo(), mkInfo({ codec: 'hevc' })])).toMatch(/编码不同/)
    expect(mergeIncompatibility([mkInfo(), mkInfo({ pixFmt: 'yuv420p10le' })])).toMatch(/像素格式不同/)
    expect(mergeIncompatibility([mkInfo(), mkInfo({ profile: 'Main' })])).toMatch(/profile 不同/)
    expect(mergeIncompatibility([mkInfo(), mkInfo({ noAudio: true })])).toMatch(/没有音轨/)
    expect(mergeIncompatibility([mkInfo(), mkInfo({ aRate: 44100 })])).toMatch(/音频参数不同/)
    expect(mergeIncompatibility([mkInfo(), mkInfo({ noVideo: true })])).toMatch(/没有视频轨/)
  })
})

const workDir = join(tmpdir(), `aiov-mixed-${randomUUID().slice(0, 8)}`)
const fx = {
  f24: join(workDir, 'f24.mp4'),
  f60: join(workDir, 'f60.mp4'),
  hevc: join(workDir, 'fhevc.mp4'),
  noaudio: join(workDir, 'fnoaudio.mp4')
}

async function gen(out: string, extra: string[]): Promise<void> {
  await runFfmpeg({
    bin: FFMPEG,
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '6',
      ...extra,
      out
    ]
  })
}

async function runMerge(
  clips: Array<{ path: string; startSec: number; endSec: number }>,
  mode: 'keyframe-snap' | 'smart' = 'keyframe-snap'
): Promise<JobResult | undefined> {
  const events: JobEvent[] = []
  const q = new CutJobQueue({
    ffmpegBin: FFMPEG,
    ffprobeBin: FFPROBE,
    keyframeCacheDir: workDir,
    encoderChoice: { name: 'libx264', isHardware: false, args: ['-preset', 'ultrafast', '-crf', '16'] },
    emit: (e) => events.push(e)
  })
  const jobId = q.submit({ mode, container: 'mp4', clips })
  for (let i = 0; i < 2000; i++) {
    await sleep(150)
    const final = events
      .filter((e): e is JobResult => !('phase' in e) && ['done', 'failed', 'canceled'].includes(e.state))
      .findLast((e) => e.jobId === jobId)
    if (final) return final
  }
  return undefined
}

describe.skipIf(!hasBinaries)('端到端：参数不一致源合并（统一转码）', () => {
  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true })
    await gen(fx.f24, ['-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-c:a', 'aac', '-shortest'])
    await gen(fx.f60, ['-r', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-c:a', 'aac', '-shortest'])
    await gen(fx.hevc, ['-r', '24', '-c:v', 'libx265', '-preset', 'ultrafast', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest'])
    await gen(fx.noaudio, ['-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-an'])
  }, 120_000)

  it('24fps + 60fps 吸附合并 → 统一转码，时长精确（原为必失败场景）', async () => {
    const final = await runMerge([
      { path: fx.f24, startSec: 1.3, endSec: 4.2 },
      { path: fx.f60, startSec: 1.4, endSec: 3.9 }
    ])
    expect(final, JSON.stringify(final)).toBeDefined()
    expect(final!.state).toBe('done')
    expect(final!.notice).toContain('统一转码')
    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(outInfo.durationSec - 5.4)).toBeLessThan(0.3)
  }, 180_000)

  it('h264 + hevc smart 合并 → 统一转码为基准编码，输出可探测', async () => {
    const final = await runMerge(
      [
        { path: fx.f24, startSec: 1.2, endSec: 3.7 },
        { path: fx.hevc, startSec: 2.1, endSec: 4.9 }
      ],
      'smart'
    )
    expect(final, JSON.stringify(final)).toBeDefined()
    expect(final!.state).toBe('done')
    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(outInfo.video!.codec).toBe('h264')
    expect(Math.abs(outInfo.durationSec - 5.3)).toBeLessThan(0.3)
  }, 180_000)

  it('有音轨 + 无音轨合并 → 补静音，输出音轨覆盖全程', async () => {
    const final = await runMerge([
      { path: fx.f24, startSec: 1, endSec: 3 },
      { path: fx.noaudio, startSec: 1, endSec: 3 }
    ])
    expect(final, JSON.stringify(final)).toBeDefined()
    expect(final!.state).toBe('done')
    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(outInfo.audio.length).toBe(1)
    expect(Math.abs(outInfo.durationSec - 4)).toBeLessThan(0.3)
  }, 180_000)

  it('参数一致时仍走无损秒切路径（无转码 notice）', async () => {
    const final = await runMerge([
      { path: fx.f24, startSec: 1, endSec: 3 },
      { path: fx.f24, startSec: 4, endSec: 6 }
    ])
    expect(final, JSON.stringify(final)).toBeDefined()
    expect(final!.state).toBe('done')
    expect(final!.notice ?? '').not.toContain('统一转码')
    const outInfo = await probeMedia(FFPROBE, final!.outputPath!)
    expect(Math.abs(outInfo.durationSec - 4)).toBeLessThan(0.2)
  }, 180_000)
})
