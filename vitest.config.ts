import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared')
    }
  }
})
