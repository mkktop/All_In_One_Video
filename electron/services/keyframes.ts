import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface KeyframeScanOptions {
  cacheDir?: string
  durationSec?: number
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

export interface KeyframeScanResult {
  keyframes: number[]
  fromCache: boolean
}

function cacheKey(filePath: string, size: number, mtimeMs: number): string {
  return createHash('sha1').update(`${filePath}|${size}|${mtimeMs}`).digest('hex')
}

/**
 * 扫描视频流关键帧时间点（升序）。
 * 用 compact 格式逐行流式解析，避免长视频 JSON 全量输出撑爆内存；
 * 结果按 path+size+mtime 缓存，同一文件重复打开零成本。
 */
export function scanKeyframes(
  ffprobeBin: string,
  filePath: string,
  opts: KeyframeScanOptions = {}
): Promise<KeyframeScanResult> {
  const { cacheDir, durationSec = 0, onProgress, signal } = opts
  const stat = statSync(filePath)
  const key = cacheKey(filePath, stat.size, stat.mtimeMs)
  const cacheFile = cacheDir ? join(cacheDir, `${key}.json`) : null

  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { keyframes: number[] }
      if (Array.isArray(cached.keyframes)) {
        onProgress?.(100)
        return Promise.resolve({ keyframes: cached.keyframes, fromCache: true })
      }
    } catch {
      // 缓存损坏则重新扫描
    }
  }

  return new Promise<KeyframeScanResult>((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'compact=p=0',
      filePath
    ]
    const child = spawn(ffprobeBin, args, { windowsHide: true })
    const keyframes: number[] = []
    let lastPct = -1
    let canceled = false

    const onAbort = () => {
      canceled = true
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line: string) => {
      // 命名字段: "pts_time=1.000000|flags=K__"；裸字段(旧构建): "1.000000|K__"
      const parts = line.split('|')
      let t = NaN
      let isKey = false
      if (line.includes('=')) {
        for (const part of parts) {
          const eq = part.indexOf('=')
          if (eq < 0) continue
          const k = part.slice(0, eq)
          const v = part.slice(eq + 1)
          if (k === 'pts_time') t = Number(v)
          else if (k === 'flags' && v.includes('K')) isKey = true
        }
      } else if (parts.length >= 2) {
        t = Number(parts[0])
        isKey = parts[1].includes('K')
      }
      if (!Number.isFinite(t)) return
      if (durationSec > 0) {
        const pct = Math.min(99, Math.floor((t / durationSec) * 100))
        if (pct > lastPct) {
          lastPct = pct
          onProgress?.(pct)
        }
      }
      if (isKey) keyframes.push(t)
    })

    const stderrChunks: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => stderrChunks.push(c))

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`无法启动 ffprobe: ${err.message}`))
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (canceled) {
        reject(new Error('已取消'))
        return
      }
      if (code !== 0) {
        reject(new Error(`ffprobe 关键帧扫描失败(退出码 ${code}): ${stderrChunks.join('').slice(-400)}`))
        return
      }
      keyframes.sort((a, b) => a - b)
      if (cacheFile) {
        try {
          mkdirSync(cacheDir!, { recursive: true })
          writeFileSync(cacheFile, JSON.stringify({ key: cacheKey(filePath, stat.size, stat.mtimeMs), keyframes }))
        } catch {
          // 缓存写入失败不影响结果
        }
      }
      onProgress?.(100)
      resolve({ keyframes, fromCache: false })
    })
  })
}
