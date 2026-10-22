import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Hydrology/rail fixtures exercise complete numeric grids. Keep concurrent
    // worlds bounded on two-core CI runners rather than timing them out at 5s.
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
