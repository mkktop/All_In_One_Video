import type { MediaInfo } from './types'

/** 帧率比较的相对容差：同标称帧率（如 60000/1001）探测值完全一致；
 *  29.97 vs 30（0.1%）这类真实差异要判不一致，容差须小于 0.05% */
const FPS_REL_TOL = 0.0005

function fmtFps(n: number): string {
  return n >= 100 ? n.toFixed(1) : n.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * 多段合并预检：各片段源的视频/音频参数是否一致到可以流复制（concat copy）拼接。
 * concat demuxer 假设所有输入流参数一致，帧率不同时时间戳会被按比例拉伸、
 * 编码不同会产出损坏文件，必须在拼接前发现并统一转码。
 *
 * @returns null = 参数一致，可走无损路径；否则返回给用户看的差异描述。
 */
export function mergeIncompatibility(infos: MediaInfo[]): string | null {
  if (infos.length <= 1) return null
  const ref = infos[0]!
  const refV = ref.video
  const refA = ref.audio[0]
  for (const cur of infos.slice(1)) {
    const v = cur.video
    if ((v != null) !== (refV != null)) return '部分素材没有视频轨'
    if (v && refV) {
      if (v.codec !== refV.codec) return `编码不同（${refV.codec} / ${v.codec}）`
      if (v.width !== refV.width || v.height !== refV.height)
        return `分辨率不同（${refV.width}×${refV.height} / ${v.width}×${v.height}）`
      if (v.pixFmt !== refV.pixFmt) return `像素格式不同（${refV.pixFmt} / ${v.pixFmt}）`
      if (v.profile !== refV.profile) return `profile 不同（${refV.profile ?? '未知'} / ${v.profile ?? '未知'}）`
      if (refV.fps > 0 && v.fps > 0 && Math.abs(v.fps - refV.fps) / Math.max(refV.fps, 1) > FPS_REL_TOL)
        return `帧率不同（${fmtFps(refV.fps)} / ${fmtFps(v.fps)}）`
    }
    const a = cur.audio[0]
    if ((a != null) !== (refA != null)) return '部分素材没有音轨'
    if (a && refA && (a.codec !== refA.codec || a.sampleRate !== refA.sampleRate || a.channels !== refA.channels))
      return '音频参数不同'
  }
  return null
}
