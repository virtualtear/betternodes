import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vite.config.ts'

// Benchmarks run in the same headless Chromium as the tests, but only via `npm run bench`.
export default mergeConfig(base, defineConfig({
  test: { include: ['bench/**/*.bench.ts'], testTimeout: 180_000, fileParallelism: false },
}))
