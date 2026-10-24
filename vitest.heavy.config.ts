import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Only complete-world regressions initialize the production numeric backend.
// The quick suite keeps its independent JavaScript/WASM differential coverage.
export default mergeConfig(base, defineConfig({
  test: { setupFiles: ['src/domain/test-support/heavy-compute.setup.ts'] },
}))
