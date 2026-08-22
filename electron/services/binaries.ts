import { join } from 'path'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Capabilities } from '../../shared/types'
import { pickEncoder } from './encoders'

const execFileP = promisify(execFile)

export function resolveBinDir(appDir: string, isPackaged: boolean, resourcesPath: string): string {
  return isPackaged ? join(resourcesPath, 'bin') : join(appDir, 'resources', 'bin')
}

export function binaryPaths(binDir: string): { ffmpeg: string; ffprobe: string } {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return {
    ffmpeg: join(binDir, `ffmpeg${ext}`),
    ffprobe: join(binDir, `ffprobe${ext}`)
  }
}

function parseVersion(firstLine: string): string {
  const m = /version\s+(\S+)/.exec(firstLine)
  return m ? m[1] : 'unknown'
}

export async function getCapabilities(binDir: string): Promise<Capabilities> {
  const { ffmpeg, ffprobe } = binaryPaths(binDir)
  const [ffOut, fpOut, h264, hevc] = await Promise.all([
    execFileP(ffmpeg, ['-version']).catch(() => null),
    execFileP(ffprobe, ['-version']).catch(() => null),
    existsSync(ffmpeg) ? pickEncoder(ffmpeg, 'h264') : Promise.resolve(null),
    existsSync(ffmpeg) ? pickEncoder(ffmpeg, 'hevc') : Promise.resolve(null)
  ])
  return {
    platform: process.platform,
    ffmpegVersion: ffOut ? parseVersion(ffOut.stdout.split('\n')[0]) : '未找到',
    ffprobeVersion: fpOut ? parseVersion(fpOut.stdout.split('\n')[0]) : '未找到',
    binaryDir: binDir,
    binariesFound: existsSync(ffmpeg) && existsSync(ffprobe),
    encoder: h264 && hevc ? { h264: h264.name, hevc: hevc.name } : undefined
  }
}
