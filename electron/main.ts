import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { join, basename } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import type { CutRequest, MultiCutRequest, WaveformResult } from '../shared/types'
import { binaryPaths, getCapabilities, resolveBinDir } from './services/binaries'
import { probeMedia } from './services/probe'
import { scanKeyframes } from './services/keyframes'
import { runFfmpeg } from './services/ffmpeg-runner'
import { CutJobQueue } from './services/job-queue'

let win: BrowserWindow | null = null

const binDir = resolveBinDir(app.getAppPath(), app.isPackaged, process.resourcesPath)
const bins = binaryPaths(binDir)
const keyframeCacheDir = join(app.getPath('userData'), 'keyframe-cache')

const queue = new CutJobQueue({
  ffmpegBin: bins.ffmpeg,
  ffprobeBin: bins.ffprobe,
  keyframeCacheDir,
  emit: (e) => {
    win?.webContents.send('job:event', e)
    // 窗口不在前台时弹系统通知
    if (e.state === 'done' && e.outputPath && (!win || !win.isFocused())) {
      new Notification({ title: '导出完成', body: basename(e.outputPath) }).show()
    }
  }
})

// —— 最近文件（持久化，最多 10 条）——
const recentFile = join(app.getPath('userData'), 'recent.json')

function loadRecent(): string[] {
  try {
    const arr = JSON.parse(readFileSync(recentFile, 'utf8'))
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string').slice(0, 10) : []
  } catch {
    return []
  }
}

function pushRecent(path: string): void {
  const list = [path, ...loadRecent().filter((p) => p !== path)].slice(0, 10)
  try {
    writeFileSync(recentFile, JSON.stringify(list, null, 2), 'utf8')
  } catch {
    // 持久化失败不影响使用
  }
}

// —— 波形图（整条音频 showwavespic，按文件哈希缓存）——
const waveformDir = join(app.getPath('userData'), 'waveforms')

function waveformCacheKey(filePath: string): string {
  const st = statSync(filePath)
  return createHash('sha1').update(`${filePath}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
}

function fireAndForgetWaveform(info: Awaited<ReturnType<typeof probeMedia>>): void {
  if (info.audio.length === 0) return
  const png = join(waveformDir, `${waveformCacheKey(info.path)}.png`)
  const send = (ok: boolean): void => {
    win?.webContents.send('media:waveform', { path: info.path, pngPath: ok ? png : null } satisfies WaveformResult)
  }
  if (existsSync(png)) {
    send(true)
    return
  }
  mkdirSync(waveformDir, { recursive: true })
  runFfmpeg({
    bin: bins.ffmpeg,
    args: [
      '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-i', info.path,
      '-filter_complex', 'showwavespic=s=1600x80:colors=#4f83c9',
      '-frames:v', '1',
      png
    ]
  })
    .then(() => send(true))
    .catch(() => send(false))
}

async function openMedia(filePath: string): Promise<{ info: Awaited<ReturnType<typeof probeMedia>>; keyframes: number[] }> {
  const info = await probeMedia(bins.ffprobe, filePath)
  console.log(
    `[aiov:media] ${filePath} container=${info.container} v=${info.video?.codec ?? '无'}/${info.video?.profile ?? ''}/${info.video?.pixFmt ?? ''} ` +
      `${info.video?.width ?? 0}x${info.video?.height ?? 0} dur=${info.durationSec.toFixed(2)}`
  )
  let keyframes: number[] = []
  if (info.video) {
    keyframes = (
      await scanKeyframes(bins.ffprobe, filePath, {
        cacheDir: keyframeCacheDir,
        durationSec: info.durationSec,
        onProgress: (percent) => {
          win?.webContents.send('media:keyframeProgress', { path: filePath, percent, done: false })
        }
      })
    ).keyframes
    win?.webContents.send('media:keyframeProgress', { path: filePath, percent: 100, done: true })
  }
  pushRecent(filePath)
  fireAndForgetWaveform(info)
  return { info, keyframes }
}

function registerIpc(): void {
  ipcMain.handle('app:capabilities', () => getCapabilities(binDir))

  ipcMain.handle('media:open', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '打开视频文件',
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'ts', 'flv', 'm4v', 'wmv'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return openMedia(r.filePaths[0])
  })

  ipcMain.handle('media:openPath', (_e, p: string) => openMedia(p))

  ipcMain.handle('app:recentFiles', () => loadRecent())

  ipcMain.handle('cut:submit', (_e, req: CutRequest | MultiCutRequest) => ({ jobId: queue.submit(req) }))

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    queue.cancel(jobId)
  })

  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:showInFolder', (_e, p: string) => shell.showItemInFolder(p))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#141414',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 允许 <video> 直接用 file:// 源播放本地视频：Chromium 原生文件加载器
      // 自带 Range/尾部 moov 索引处理（Game Bar 录屏等），自定义协议均不可靠。
      // 本应用为纯本地单用户工具，不加载远程内容，风险可控。
      webSecurity: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })

  // 渲染进程 [aiov] 前缀日志转发到主进程 stdout，便于诊断
  win.webContents.on('console-message', (e) => {
    if (e.message.startsWith('[aiov')) console.log(`[renderer] ${e.message}`)
  })

  // 测试/自动化用：AIOV_OPEN_PATH 指定的文件在启动后自动打开
  win.webContents.once('did-finish-load', () => {
    const p = process.env['AIOV_OPEN_PATH']
    if (!p) return
    openMedia(p)
      .then((r) => win?.webContents.send('media:auto-opened', r))
      .catch((err) => console.error('[auto-open]', err))
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
