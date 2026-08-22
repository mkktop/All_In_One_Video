import { spawn } from 'child_process'

export interface EncoderChoice {
  /** ffmpeg 编码器名，如 h264_nvenc / libx264 */
  name: string
  isHardware: boolean
  /** 质量/速度档参数 */
  args: string[]
}

const H264_CANDIDATES: EncoderChoice[] = [
  { name: 'h264_nvenc', isHardware: true, args: ['-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '16'] },
  { name: 'h264_qsv', isHardware: true, args: ['-preset', 'veryfast', '-global_quality', '16'] },
  { name: 'h264_amf', isHardware: true, args: ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '16', '-qp_p', '20'] },
  { name: 'libx264', isHardware: false, args: ['-preset', 'ultrafast', '-crf', '16'] }
]

const HEVC_CANDIDATES: EncoderChoice[] = [
  { name: 'hevc_nvenc', isHardware: true, args: ['-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '19'] },
  { name: 'hevc_qsv', isHardware: true, args: ['-preset', 'veryfast', '-global_quality', '19'] },
  { name: 'hevc_amf', isHardware: true, args: ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '23'] },
  { name: 'libx265', isHardware: false, args: ['-preset', 'ultrafast', '-crf', '22'] }
]

const cache = new Map<string, EncoderChoice>()

/** 试编码 3 帧纯色：encoders 列表里存在 ≠ 驱动可用，跑一遍才算数 */
function tryEncode(ffmpegBin: string, enc: EncoderChoice): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegBin,
      [
        '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=25:d=0.2',
        '-frames:v', '3',
        '-c:v', enc.name,
        ...enc.args,
        '-f', 'null',
        '-'
      ],
      { windowsHide: true }
    )
    const timer = setTimeout(() => {
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
      resolve(false)
    }, 8000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** 按 nvenc → qsv → amf → libx264/x265 顺序选出第一个真实可用的编码器（结果缓存） */
export async function pickEncoder(ffmpegBin: string, codec: 'h264' | 'hevc'): Promise<EncoderChoice> {
  const key = `${ffmpegBin}|${codec}`
  const hit = cache.get(key)
  if (hit) return hit
  const list = codec === 'h264' ? H264_CANDIDATES : HEVC_CANDIDATES
  for (const c of list) {
    if (await tryEncode(ffmpegBin, c)) {
      cache.set(key, c)
      return c
    }
  }
  const fallback = list[list.length - 1]
  cache.set(key, fallback)
  return fallback
}
