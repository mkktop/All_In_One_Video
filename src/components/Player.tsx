import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useEditor } from '@/stores/editor'
import { videoEl } from '@/lib/playerRef'
import { mediaSrc } from '@/ipc'
import { formatTimecode, formatShort, frameNumber } from '@/lib/timecode'

const MEDIA_ERR: Record<number, string> = {
  1: '加载中止',
  2: '网络错误',
  3: '解码失败（编码不支持或文件损坏）',
  4: '格式/解码器不受支持'
}

type RVFCMetadata = { mediaTime: number; presentedFrames: number }
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: RVFCMetadata) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded text-zinc-300 transition-colors hover:bg-zinc-700"
    >
      {children}
    </button>
  )
}

const svgProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor' } as const

function PlayIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PauseIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  )
}

function StepBackIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M6 6h2v12H6zM20 6l-10 6 10 6z" />
    </svg>
  )
}

function StepFwdIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M16 6h2v12h-2zM4 6l10 6-10 6z" />
    </svg>
  )
}

function VolumeIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M3 10v4h4l5 5V5L7 10H3z" />
      <path d="M14.5 8.5a4.5 4.5 0 0 1 0 7v-1.7a2.8 2.8 0 0 0 0-3.6V8.5z" />
    </svg>
  )
}

function MuteIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M3 10v4h4l5 5V5L7 10H3z" />
      <path d="M15 9.5l1.2-1.2 1.8 1.8 1.8-1.8L21 9.5 19.2 11.3 21 13.1l-1.2 1.2-1.8-1.8-1.8 1.8-1.2-1.2 1.8-1.8L15 9.5z" />
    </svg>
  )
}

export function Player(): ReactNode {
  const info = useEditor((s) => s.media.info)
  const playing = useEditor((s) => s.playback.playing)
  const currentTime = useEditor((s) => s.playback.currentTime)
  const rate = useEditor((s) => s.playback.rate)
  const volume = useEditor((s) => s.playback.volume)
  const muted = useEditor((s) => s.playback.muted)
  const containerRef = useRef<HTMLDivElement>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const fps = info?.video?.fps ?? 25

  // 预检：本机 Chromium 声明不支持该容器/编码组合时提前提示（HEVC 常见）
  const codecWarning = useMemo(() => {
    if (!info?.video) return null
    const probe = document.createElement('video')
    const codecMap: Record<string, string> = {
      hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
      av1: 'video/mp4; codecs="av01.0.05M.08"',
      vp9: 'video/webm; codecs="vp9"',
      h264: 'video/mp4; codecs="avc1.42E01E"'
    }
    const type = codecMap[info.video.codec]
    if (type && probe.canPlayType(type) === '') {
      return `本机缺少 ${info.video.codec.toUpperCase()} 解码器，预览可能不可用；剪切导出不受影响`
    }
    return null
  }, [info?.video?.codec])

  // 元素事件 → store（rVFC 提供帧精确的当前时间）
  useEffect(() => {
    const v = videoEl.current as RVFCVideo | null
    if (!v) return
    setPreviewError(null)
    const onPlay = () => useEditor.getState().setPlaying(true)
    const onPause = () => useEditor.getState().setPlaying(false)
    const onLoaded = () => {
      setPreviewError(null)
      console.info(`[aiov:player] 预览就绪 ${v.videoWidth}x${v.videoHeight} dur=${v.duration}`)
    }
    const onErr = () => {
      const code = v.error?.code ?? 0
      setPreviewError(`${MEDIA_ERR[code] ?? `未知错误(${code})`}（错误码 ${code}）`)
      console.info(`[aiov:player] 预览失败 code=${code} codec=${useEditor.getState().media.info?.video?.codec ?? '?'}`)
    }
    let handle = 0
    const tick = (_now: number, meta: RVFCMetadata): void => {
      useEditor.getState().setCurrentTime(meta.mediaTime)
      handle = v.requestVideoFrameCallback!(tick)
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onPause)
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('error', onErr)
    if (v.requestVideoFrameCallback) handle = v.requestVideoFrameCallback(tick)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onPause)
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('error', onErr)
      v.cancelVideoFrameCallback?.(handle)
    }
  }, [info?.path])

  // store → 元素
  useEffect(() => {
    const v = videoEl.current
    if (!v) return
    v.playbackRate = rate
    v.volume = volume
    v.muted = muted
  }, [rate, volume, muted, info?.path])

  if (!info) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-[#0c0c0c] text-zinc-500">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
          <path d="M10.5 10.5l3 1.5-3 1.5z" fill="currentColor" stroke="none" />
        </svg>
        <p className="text-sm">打开一个视频文件开始剪辑</p>
        <button
          onClick={() => void useEditor.getState().openMedia()}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500"
        >
          打开文件
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0c0c0c]">
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onDoubleClick={() => containerRef.current?.requestFullscreen?.().catch(() => {})}
      >
        <video
          ref={(el) => {
            videoEl.current = el
          }}
          src={mediaSrc(info.path)}
          className="max-h-full max-w-full"
          onClick={() => useEditor.getState().togglePlay()}
        />
        {previewError && (
          <div className="absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[80%] rounded-md border border-red-500/40 bg-red-950/90 px-3 py-2 text-center text-xs leading-5 text-red-300">
            无法预览：{previewError}
            <br />
            <span className="text-red-400/80">常见于 HEVC 等本机缺少解码器的视频。时间轴与导出不受影响，仍可正常剪切。</span>
          </div>
        )}
        {!previewError && codecWarning && (
          <div className="absolute inset-x-0 top-3 mx-auto w-fit max-w-[80%] rounded-md border border-amber-500/40 bg-amber-950/90 px-3 py-1.5 text-center text-xs text-amber-300">
            {codecWarning}
          </div>
        )}
      </div>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-t border-zinc-800 bg-[#181818] px-3 text-xs">
        <IconButton title={playing ? '暂停（空格）' : '播放（空格）'} onClick={() => useEditor.getState().togglePlay()}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton title="上一帧（←）" onClick={() => useEditor.getState().stepFrames(-1)}>
          <StepBackIcon />
        </IconButton>
        <IconButton title="下一帧（→）" onClick={() => useEditor.getState().stepFrames(1)}>
          <StepFwdIcon />
        </IconButton>
        <span className="ml-1 font-mono text tabular-nums text-zinc-300">
          {formatTimecode(currentTime, fps)}
          <span className="text-zinc-600"> / {formatShort(info.durationSec)}</span>
        </span>
        <span className="text-zinc-600">帧 {frameNumber(currentTime, fps)}</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-zinc-400">
          倍速
          <select
            value={rate}
            onChange={(e) => useEditor.getState().setRate(Number(e.target.value))}
            className="rounded bg-zinc-800 px-1.5 py-1 text-xs outline-none"
          >
            {[0.5, 0.75, 1, 1.5, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        <IconButton title={muted ? '取消静音' : '静音'} onClick={() => useEditor.getState().toggleMute()}>
          {muted ? <MuteIcon /> : <VolumeIcon />}
        </IconButton>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => useEditor.getState().setVolume(Number(e.target.value))}
          className="w-20 accent-sky-500"
        />
      </div>
    </div>
  )
}
