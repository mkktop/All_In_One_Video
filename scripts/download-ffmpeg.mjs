// 跨平台 ffmpeg/ffprobe 下载器：写入 resources/bin
//   win32  : BtbN gpl-shared（ffmpeg/ffprobe 共用 DLL，体积减半，含 NVENC/QSV/AMF + libx264/x265）
//   darwin : martin-riedl 构建服务器（arm64/amd64，含 libx264/x265）
// 用法: node scripts/download-ffmpeg.mjs [--force]
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'resources', 'bin')
const force = process.argv.includes('--force')
const exeExt = process.platform === 'win32' ? '.exe' : ''

if (!force && existsSync(join(binDir, `ffmpeg${exeExt}`)) && existsSync(join(binDir, `ffprobe${exeExt}`))) {
  console.log('resources/bin 已存在，跳过（--force 重新下载）')
  process.exit(0)
}

const work = join(tmpdir(), `aiov-ffmpeg-${Date.now()}`)
mkdirSync(work, { recursive: true })
mkdirSync(binDir, { recursive: true })

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`命令失败: ${cmd} ${args.join(' ')}`)
    process.exit(1)
  }
}

function download(url, out) {
  console.log(`下载 ${url}`)
  run('curl', ['-L', '--retry', '3', '--retry-delay', '2', '-o', out, url])
}

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${dest}" -Force`])
  } else {
    run('unzip', ['-q', '-o', zip, '-d', dest])
  }
}

try {
  if (process.platform === 'win32') {
    const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip'
    const zip = join(work, 'ffmpeg.zip')
    download(url, zip)
    unzip(zip, join(work, 'x'))
    // zip 结构: ffmpeg-master-latest-win64-gpl-shared/bin/{ffmpeg.exe, ffprobe.exe, *.dll}
    const extracted = join(work, 'x', 'ffmpeg-master-latest-win64-gpl-shared', 'bin')
    if (!existsSync(extracted)) throw new Error(`未找到 ${extracted}`)
    for (const f of readdirSync(extracted)) {
      copyFileSync(join(extracted, f), join(binDir, f))
      console.log(`  + ${f}`)
    }
  } else if (process.platform === 'darwin') {
    // 下载 x64 + arm64 两套，lipo 合成 universal 二进制。
    // 否则 universal 打包时两个架构的临时目录里是同一个单架构 ffmpeg，
    // @electron/universal 会拒绝合并（Intel Mac 上也无法运行）。
    for (const name of ['ffmpeg', 'ffprobe']) {
      const slices = []
      for (const arch of ['amd64', 'arm64']) {
        const zip = join(work, `${name}-${arch}.zip`)
        download(`https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/${name}.zip`, zip)
        unzip(zip, join(work, `${name}-${arch}`))
        // zip 内为单个可执行文件（可能在子目录）
        const dir = join(work, `${name}-${arch}`)
        const file = existsSync(join(dir, name)) ? join(dir, name) : join(dir, readdirSync(dir)[0])
        slices.push(file)
      }
      run('lipo', ['-create', '-output', join(binDir, name), ...slices])
      chmodSync(join(binDir, name), 0o755)
      const info = spawnSync('lipo', ['-info', join(binDir, name)], { encoding: 'utf8' })
      const archs = (info.stdout ?? '').replace(`Architectures in the input file ${join(binDir, name)}: `, '').trim()
      if (!archs.includes('x86_64') || !archs.includes('arm64')) {
        throw new Error(`${name} lipo 合成异常：${archs}`)
      }
      console.log(`  + ${name} (universal: ${archs})`)
    }
  } else {
    throw new Error(`暂不支持平台 ${process.platform}（win32/darwin 可用）`)
  }

  // 冒烟验证
  for (const name of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(join(binDir, `${name}${exeExt}`), ['-version'], { encoding: 'utf8' })
    const line = (r.stdout ?? '').split('\n')[0]
    console.log(line || `${name} 验证失败`)
    if (!line.includes('version')) throw new Error(`${name} 无法运行`)
  }
  console.log(`完成：${binDir}（${Math.round(totalSize(binDir) / 1048576)} MB）`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function totalSize(dir) {
  let s = 0
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f))
    s += st.isFile() ? st.size : totalSize(join(dir, f))
  }
  return s
}
