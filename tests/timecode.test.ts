import { describe, expect, it } from 'vitest'
import { formatShort, formatTimecode, frameNumber } from '../src/lib/timecode'

describe('timecode', () => {
  it('formatTimecode', () => {
    expect(formatTimecode(0)).toBe('00:00:00.000')
    expect(formatTimecode(83.5)).toBe('00:01:23.500')
    expect(formatTimecode(3661.25)).toBe('01:01:01.250')
    expect(formatTimecode(-1)).toBe('00:00:00.000')
  })

  it('formatShort', () => {
    expect(formatShort(0)).toBe('0:00.0')
    expect(formatShort(83.45)).toBe('1:23.5')
    expect(formatShort(600)).toBe('10:00.0')
  })

  it('frameNumber', () => {
    expect(frameNumber(0, 30)).toBe(0)
    expect(frameNumber(10, 30)).toBe(300)
    expect(frameNumber(10.0167, 30)).toBe(301)
  })
})
