import { ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/types'

/**
 * GitHub Releases 自动更新（electron-updater，天然支持 blockmap 差量下载）。
 * 流程：启动 3 秒后静默检查 → 有新版顶栏出现提示 → 用户点击才下载 → 就绪后一键重启安装。
 * macOS 未签名无法走 Squirrel 更新（需要 Apple 开发者账号），仅在 Windows/Linux 启用。
 */
export function setupAutoUpdate(send: (s: UpdateState) => void): void {
  if (process.platform === 'darwin') return

  autoUpdater.autoDownload = false
  // 用户点了"重启更新"但先手动退出：下次退出时自动装上
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  let version = ''
  autoUpdater.on('update-available', (info) => {
    version = info.version
    send({ phase: 'available', version, percent: null })
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

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error(`[aiov:update] ${(err as Error).message}`))
  }, 3000)
}
