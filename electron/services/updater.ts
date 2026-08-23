import { app, ipcMain, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/types'

/**
 * GitHub Releases 自动更新（electron-updater，天然支持 blockmap 差量下载）。
 * 流程：启动 3 秒后静默检查 → 有新版顶栏出现提示 → 用户点击才下载 → 就绪后一键重启安装。
 * 设置菜单可手动「检查更新」。macOS 未签名无法走 Squirrel 更新，仅 Windows/Linux 启用。
 */
export function setupAutoUpdate(send: (s: UpdateState) => void): void {
  const supported = process.platform !== 'darwin' && app.isPackaged
  let checking = false

  ipcMain.handle('update:check', () => {
    if (!supported) {
      send({ phase: 'none', version: '', percent: null, message: '当前环境不支持自动更新' })
      return
    }
    if (checking) return
    checking = true
    send({ phase: 'checking', version: '', percent: null })
    autoUpdater
      .checkForUpdates()
      .catch((err) => {
        console.error(`[aiov:update] ${(err as Error).message}`)
        send({ phase: 'none', version: '', percent: null, message: '检查失败：网络不可用或被拦截' })
      })
      .finally(() => {
        checking = false
      })
  })

  if (!supported) return

  autoUpdater.autoDownload = false
  // 用户点了"重启更新"但先手动退出：下次退出时自动装上
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  let version = ''
  autoUpdater.on('update-available', (info) => {
    version = info.version
    send({ phase: 'available', version, percent: null, notes: null })
    void fetchNotes(version).then((notes) => send({ phase: 'available', version, percent: null, notes }))
  })
  autoUpdater.on('update-not-available', () => {
    send({ phase: 'none', version: '', percent: null, message: `已是最新版本 v${app.getVersion()}` })
  })
  autoUpdater.on('download-progress', (p) => {
    send({ phase: 'downloading', version, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', () => {
    send({ phase: 'ready', version, percent: null })
  })
  autoUpdater.on('error', (err) => {
    // 网络不通等检查失败很常见，静默即可
    console.error(`[aiov:update] ${err.message}`)
  })

  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true))

  // 启动 3 秒后静默检查
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error(`[aiov:update] ${(err as Error).message}`))
  }, 3000)
}

/** 拉取新版本的 Release 正文，截取目标版本小节作为更新说明（走系统代理；失败返回 null） */
async function fetchNotes(tag: string): Promise<string | null> {
  try {
    const res = await net.fetch(`https://api.github.com/repos/mkktop/All_In_One_Video/releases/tags/v${tag}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aiov-updater' }
    })
    if (!res.ok) return null
    const body = ((await res.json()) as { body?: string }).body?.trim()
    if (!body) return null
    // RELEASE_NOTES.md 按 "## vX.Y.Z" 分节，只取目标版本那一节
    const section =
      body
        .split('\n## ')
        .find((s) => s.startsWith(`v${tag}`))
        ?.slice(`v${tag}`.length) ?? body
    return section
      .split('\n')
      // 去 markdown 标题行，列表符号转圆点，作为纯文本 tooltip 展示
      .filter((l) => !l.startsWith('#'))
      .map((l) => l.replace(/^[-*]\s+/, '• '))
      .join('\n')
      .trim()
      .slice(0, 400)
  } catch {
    return null
  }
}
