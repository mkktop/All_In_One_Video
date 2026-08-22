import { spawn, type ChildProcess } from 'child_process'

export interface FfmpegRunOptions {
  bin: string
  args: string[]
  signal?: AbortSignal
  onProgress?: (p: { outTimeSec: number; speed: number | null }) => void
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly canceled: boolean,
    public readonly stderrTail: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

/** 解析 -progress pipe:1 输出的一行 key=value */
function applyProgressLine(line: string, kv: Record<string, string>): void {
  const eq = line.indexOf('=')
  if (eq <= 0) return
  kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
}

function outTimeToSec(kv: Record<string, string>): number {
  // 优先 out_time_us（微秒整数）；ffmpeg 的 out_time_ms 历史上也是微秒
  if (kv.out_time_us && !kv.out_time_us.startsWith('-')) return Number(kv.out_time_us) / 1e6
  if (kv.out_time_ms && !kv.out_time_ms.startsWith('-')) return Number(kv.out_time_ms) / 1e6
  if (kv.out_time && !kv.out_time.startsWith('-')) {
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(kv.out_time)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return 0
}

/**
 * 运行一次 ffmpeg。args 中应包含 `-progress pipe:1` 才会有进度回调。
 * 非 0 退出码抛 FfmpegError；signal 中止时抛 canceled 的 FfmpegError。
 */
export function runFfmpeg(opts: FfmpegRunOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, { windowsHide: true })
    let canceled = false
    const stderrChunks: string[] = []

    const onAbort = () => {
      canceled = true
      killTree(child)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    let stdoutBuf = ''
    const kv: Record<string, string> = {}
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        applyProgressLine(line, kv)
        if (/^progress=/.test(line)) {
          const speed = kv.speed ? Number.parseFloat(kv.speed) : null
          opts.onProgress?.({
            outTimeSec: outTimeToSec(kv),
            speed: Number.isFinite(speed) ? speed : null
          })
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderrChunks.push(c)
      if (stderrChunks.length > 30) stderrChunks.shift()
    })

    const stderrTail = () => stderrChunks.join('').split('\n').slice(-8).join('\n')

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new FfmpegError(`无法启动 ffmpeg: ${err.message}`, null, false, ''))
    })

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (canceled) {
        reject(new FfmpegError('已取消', null, true, stderrTail()))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new FfmpegError(`ffmpeg 退出码 ${code}`, code, false, stderrTail()))
      }
    })
  })
}
