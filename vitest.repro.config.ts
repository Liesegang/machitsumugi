import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Exactly one full independent world per matrix job; production WASM is loaded
// before any terrain module is collected, just as in the other heavy suites.
export default mergeConfig(base, defineConfig({
  test: {
    include: ['scripts/ci-world-repro.case.ts'],
    setupFiles: ['src/domain/test-support/heavy-compute.setup.ts'],
    maxWorkers: 1,
    testTimeout: 1_200_000,
  },
}))
