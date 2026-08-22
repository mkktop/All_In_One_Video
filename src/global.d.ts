import type { AiovApi } from '../electron/preload'

declare global {
  interface Window {
    aiov: AiovApi
  }
}

export {}
