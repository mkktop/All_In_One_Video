import type { CutMode, Segment } from './types'

/** 最大的 kf <= t；无则 null（二分） */
export function lastKeyframeAtOrBefore(keyframes: number[], t: number): number | null {
  let lo = 0
  let hi = keyframes.length - 1
  let ans: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] <= t) {
      ans = keyframes[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 最小的 kf >= t；无则 null（二分） */
export function firstKeyframeAtOrAfter(keyframes: number[], t: number): number | null {
  let lo = 0
  let hi = keyframes.length - 1
  let ans: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] >= t) {
      ans = keyframes[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

/** t 是否落在某个关键帧的半帧容差内 */
export function isOnKeyframe(keyframes: number[], t: number, halfFrameSec: number): boolean {
  if (keyframes.length === 0) return false
  let lo = 0
  let hi = keyframes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] < t) lo = mid + 1
    else hi = mid
  }
  const candidates = [keyframes[lo]]
  if (lo > 0) candidates.push(keyframes[lo - 1])
  return candidates.some((k) => Math.abs(k - t) <= halfFrameSec)
}

export interface PlanInput {
  startSec: number
  endSec: number
  keyframes: number[]
  frameDurSec: number
  maxSec?: number
}

export interface SnapPlan {
  /** 复制起点（关键帧或 0） */
  copyStart: number
  /** 复制终点（用户出点，closed GOP 内截断安全） */
  copyEnd: number
  /** 实际起点比用户入点提前了多少秒 */
  snapOffset: number
}

/**
 * 吸附模式规划：起点吸附到 <= startSec 的最近关键帧（无则 0），
 * 终点直接用用户出点——closed GOP 内截断尾部是安全的。
 */
export function planSnapCut(input: PlanInput): SnapPlan | null {
  const { startSec, endSec, keyframes, maxSec } = input
  if (!(endSec > startSec)) return null
  const copyEnd = maxSec != null ? Math.min(endSec, maxSec) : endSec
  if (!(copyEnd > startSec)) return null
  const copyStart = lastKeyframeAtOrBefore(keyframes, startSec) ?? 0
  return { copyStart, copyEnd, snapOffset: startSec - copyStart }
}

export interface SegmentPlanInput extends PlanInput {
  mode: CutMode
}

/**
 * smart cut 段规划（P1 实现，P2 执行）：
 * 起点在关键帧 → 纯复制；否则 头部转码段 + 其余复制段。
 */
export function planSegments(input: SegmentPlanInput): Segment[] {
  const { mode, startSec, endSec, keyframes, frameDurSec, maxSec } = input
  if (!(endSec > startSec)) return []
  const hardEnd = maxSec != null ? Math.min(endSec, maxSec) : endSec
  if (!(hardEnd > startSec)) return []

  if (mode === 'keyframe-snap' || isOnKeyframe(keyframes, startSec, frameDurSec / 2)) {
    const p = planSnapCut({ startSec, endSec, keyframes, frameDurSec, maxSec })!
    return [{ kind: 'copy', startSec: p.copyStart, endSec: p.copyEnd }]
  }

  const kfAfter = firstKeyframeAtOrAfter(keyframes, startSec)
  if (kfAfter == null || kfAfter >= hardEnd) {
    // 起点之后没有关键帧了，整段转码
    return [{ kind: 'encode', startSec, endSec: hardEnd }]
  }
  return [
    { kind: 'encode', startSec, endSec: kfAfter },
    { kind: 'copy', startSec: kfAfter, endSec: hardEnd }
  ]
}
