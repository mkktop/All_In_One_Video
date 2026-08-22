import { describe, expect, it } from 'vitest'
import {
  firstKeyframeAtOrAfter,
  isOnKeyframe,
  lastKeyframeAtOrBefore,
  planSegments,
  planSnapCut
} from '../shared/planner'

const KFS = [1, 2, 3.5, 5, 8]
const FD = 1 / 30

describe('关键帧二分查找', () => {
  it('找 <= t 的最近关键帧', () => {
    expect(lastKeyframeAtOrBefore(KFS, 2.4)).toBe(2)
    expect(lastKeyframeAtOrBefore(KFS, 3.5)).toBe(3.5)
    expect(lastKeyframeAtOrBefore(KFS, 0.5)).toBeNull()
    expect(lastKeyframeAtOrBefore(KFS, 100)).toBe(8)
    expect(lastKeyframeAtOrBefore([], 1)).toBeNull()
  })

  it('找 >= t 的最近关键帧', () => {
    expect(firstKeyframeAtOrAfter(KFS, 2.4)).toBe(3.5)
    expect(firstKeyframeAtOrAfter(KFS, 8)).toBe(8)
    expect(firstKeyframeAtOrAfter(KFS, 9)).toBeNull()
    expect(firstKeyframeAtOrAfter([], 1)).toBeNull()
  })

  it('isOnKeyframe 半帧容差', () => {
    expect(isOnKeyframe(KFS, 3.5, FD / 2)).toBe(true)
    expect(isOnKeyframe(KFS, 3.5 + FD / 4, FD / 2)).toBe(true)
    expect(isOnKeyframe(KFS, 3.0, FD / 2)).toBe(false)
    expect(isOnKeyframe([], 0, FD / 2)).toBe(false)
  })
})

describe('planSnapCut 吸附规划', () => {
  it('非关键帧起点吸附到前一关键帧', () => {
    const p = planSnapCut({ startSec: 2.4, endSec: 6, keyframes: KFS, frameDurSec: FD })
    expect(p).not.toBeNull()
    expect(p!.copyStart).toBe(2)
    expect(p!.copyEnd).toBe(6)
    expect(p!.snapOffset).toBeCloseTo(0.4, 6)
  })

  it('起点恰在关键帧', () => {
    const p = planSnapCut({ startSec: 3.5, endSec: 6, keyframes: KFS, frameDurSec: FD })
    expect(p!.copyStart).toBe(3.5)
    expect(p!.snapOffset).toBe(0)
  })

  it('keyframes 为空回退到 0', () => {
    const p = planSnapCut({ startSec: 1.2, endSec: 4, keyframes: [], frameDurSec: FD })
    expect(p!.copyStart).toBe(0)
  })

  it('起点早于首个关键帧时从 0 开始（文件开头本身可解码）', () => {
    const p = planSnapCut({ startSec: 0.5, endSec: 4, keyframes: KFS, frameDurSec: FD })
    expect(p!.copyStart).toBe(0)
  })

  it('出点超出时长被钳制', () => {
    const p = planSnapCut({ startSec: 2, endSec: 100, keyframes: KFS, frameDurSec: FD, maxSec: 10 })
    expect(p!.copyEnd).toBe(10)
  })

  it('非法区间返回 null', () => {
    expect(planSnapCut({ startSec: 5, endSec: 5, keyframes: KFS, frameDurSec: FD })).toBeNull()
    expect(planSnapCut({ startSec: 6, endSec: 5, keyframes: KFS, frameDurSec: FD })).toBeNull()
    // 入点已在时长尽头，钳制后区间为空
    expect(planSnapCut({ startSec: 10, endSec: 12, keyframes: KFS, frameDurSec: FD, maxSec: 10 })).toBeNull()
  })
})

describe('planSegments smart cut 段规划', () => {
  it('起点在关键帧 → 单复制段', () => {
    const segs = planSegments({ mode: 'smart', startSec: 3.5, endSec: 6, keyframes: KFS, frameDurSec: FD })
    expect(segs).toEqual([{ kind: 'copy', startSec: 3.5, endSec: 6 }])
  })

  it('非关键帧起点 → 转码头段 + 复制段', () => {
    const segs = planSegments({ mode: 'smart', startSec: 2.4, endSec: 6, keyframes: KFS, frameDurSec: FD })
    expect(segs).toEqual([
      { kind: 'encode', startSec: 2.4, endSec: 3.5 },
      { kind: 'copy', startSec: 3.5, endSec: 6 }
    ])
  })

  it('吸附模式始终单复制段', () => {
    const segs = planSegments({ mode: 'keyframe-snap', startSec: 2.4, endSec: 6, keyframes: KFS, frameDurSec: FD })
    expect(segs).toEqual([{ kind: 'copy', startSec: 2, endSec: 6 }])
  })

  it('起点之后无关键帧 → 整段转码', () => {
    const segs = planSegments({ mode: 'smart', startSec: 8.5, endSec: 9.5, keyframes: KFS, frameDurSec: FD, maxSec: 10 })
    expect(segs).toEqual([{ kind: 'encode', startSec: 8.5, endSec: 9.5 }])
  })

  it('选区完全落在关键帧之前 → 单转码段', () => {
    const segs = planSegments({ mode: 'smart', startSec: 0.2, endSec: 0.8, keyframes: [1, 2], frameDurSec: FD })
    expect(segs).toEqual([{ kind: 'encode', startSec: 0.2, endSec: 0.8 }])
  })
})
