import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { join, basename } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import type { AppSettings, CutRequest, MultiCutRequest, TranscodeItemRequest, WaveformResult } from '../shared/types'
import { binaryPaths, getCapabilities, resolveBinDir } from './services/binaries'
import { probeMedia } from './services/probe'
import { scanKeyframes } from './services/keyframes'
import { runFfmpeg } from './services/ffmpeg-runner'
import { CutJobQueue } from './services/job-queue'
import { TranscodeQueue } from './services/transcode-queue'

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

const transcodeQueue = new TranscodeQueue({
  ffmpegBin: bins.ffmpeg,
  ffprobeBin: bins.ffprobe,
  emit: (e) => {
    win?.webContents.send('job:event', e)
    if (e.state === 'done' && e.outputPath && (!win || !win.isFocused())) {
      new Notification({ title: '转码完成', body: basename(e.outputPath) }).show()
    }
  }
})

const VIDEO_FILE_RE = /\.(mp4|mkv|mov|webm|avi|ts|flv|m4v|wmv|mpg|mpeg|3gp)$/i

// —— 应用设置（userData/settings.json 持久化）——
const settingsFile = join(app.getPath('userData'), 'settings.json')

function loadSettings(): AppSettings {
  try {
    const s = JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<AppSettings>
    return {
      exportDir: typeof s.exportDir === 'string' ? s.exportDir : null,
      container: s.container === 'mkv' ? 'mkv' : 'mp4',
      transcodeConcurrency:
        typeof s.transcodeConcurrency === 'number' ? Math.min(4, Math.max(1, s.transcodeConcurrency)) : 2
    }
  } catch {
    return { exportDir: null, container: 'mp4', transcodeConcurrency: 2 }
  }
}

function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  try {
    writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 持久化失败不影响当次使用
  }
  return next
}

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

  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win!, { title: '选择导出目录', properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // 自定义标题栏的窗口控制
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('win:close', () => win?.close())

  // —— 批量转码 ——
  ipcMain.handle('transcode:submit', (_e, items: TranscodeItemRequest[]) => {
    const outputDir = loadSettings().exportDir ?? undefined
    return { jobIds: items.map((it) => transcodeQueue.submit({ ...it, outputDir: it.outputDir ?? outputDir })) }
  })

  ipcMain.handle('transcode:cancel', (_e, jobId: string) => {
    transcodeQueue.cancel(jobId)
  })

  ipcMain.handle('transcode:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择视频文件',
      filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'ts', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('transcode:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { title: '选择文件夹', properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return []
    try {
      // 递归列出文件夹内视频（上限 500）
      const all = readdirSync(r.filePaths[0], { recursive: true, encoding: 'utf8' }) as string[]
      return all
        .filter((f) => VIDEO_FILE_RE.test(f))
        .slice(0, 500)
        .map((f) => join(r.filePaths[0], f))
    } catch {
      return []
    }
  })

  ipcMain.handle('transcode:setConcurrency', (_e, n: number) => {
    const clamped = Math.min(4, Math.max(1, Math.floor(n) || 2))
    transcodeQueue.setConcurrency(clamped)
    saveSettings({ transcodeConcurrency: clamped })
    return clamped
  })

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
    // Windows/Linux：完全无边框，自绘标题栏；macOS：hiddenInset 保留系统红绿灯（左侧）
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
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
  win.on('maximize', () => win?.webContents.send('win:maximizedChanged', true))
  win.on('unmaximize', () => win?.webContents.send('win:maximizedChanged', false))
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
  // 去掉默认英文菜单栏（File/Edit/View…），快捷键由渲染进程自行处理
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  transcodeQueue.setConcurrency(loadSettings().transcodeConcurrency)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
