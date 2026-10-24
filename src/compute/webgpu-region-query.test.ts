import { afterEach, describe, expect, it, vi } from 'vitest'
import { regionQuery } from '../domain/region-query'
import { fillRegionGridCPU, prepareRegionGrid, regionGridIndex } from './webgpu-region-grid'
import { prepareWebGpuRegionQuery } from './webgpu-region-query'
import type { ComputeRegion } from './webgpu-region-grid'

const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const bounds = { minX: -30, minY: -30, maxX: 130, maxY: 130, cellSize: 6 }
const regions: ComputeRegion[] = [
  { polygon: rectangle(0, 0, 100, 100), holes: [rectangle(30, 30, 40, 40)] },
  { polygon: rectangle(42, 42, 12, 12) },
  { polygon: [{ x: -20, y: 10 }, { x: 120, y: 110 }, { x: 120, y: 116 }, { x: -20, y: 16 }] },
]

afterEach(() => vi.unstubAllGlobals())

describe('conservative region grids', () => {
  it('preserves holes, overlapping regions and arbitrary positions with negative origins', async () => {
    const prepared = await prepareWebGpuRegionQuery(regions, { ...bounds, mode: 'cpu', diagnostics: true })
    const exact = regionQuery(regions)
    let state = 7131
    for (let i = 0; i < 12000; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const x = -40 + state / 2 ** 32 * 180
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const point = { x, y: -40 + state / 2 ** 32 * 180 }
      expect(prepared.query(point)).toBe(exact(point))
    }
    expect(prepared.query({ x: 45, y: 45 })).toBe(true)
    expect(prepared.query({ x: 36, y: 60 })).toBe(false)
    expect(prepared.metrics.fastQueries).toBeGreaterThan(100)
    expect(prepared.metrics.exactQueries).toBeGreaterThan(100)
  })

  it('does not quantize a water channel narrower than one grid cell', async () => {
    const thin = [{ polygon: [{ x: 0, y: .01 }, { x: 100, y: 20.01 }, { x: 100, y: 20.06 }, { x: 0, y: .06 }] }]
    const prepared = await prepareWebGpuRegionQuery(thin, { ...bounds, mode: 'cpu', diagnostics: true })
    for (let x = 1; x < 99; x += .5) {
      expect(prepared.query({ x, y: x * .2 + .035 })).toBe(true)
      expect(prepared.query({ x, y: x * .2 + .075 })).toBe(false)
    }
    expect(prepared.metrics.exactQueries).toBeGreaterThan(300)
  })

  it('uses a linear supercover for long diagonal boundaries rather than their entire bounding box', () => {
    const ring = [{ x: -1000, y: -1000 }, { x: 2000, y: 2000 }, { x: 2000, y: 2020 }, { x: -1000, y: -980 }]
    const grid = prepareRegionGrid([{ polygon: ring }], { minX: 0, minY: 0, maxX: 1000, maxY: 1000, cellSize: 5 })
    expect(grid.boundaryCells).toBeLessThan(grid.mask.length / 12)
    for (let n = 0; n < 1000; n++) {
      const point = { x: n + .1, y: n + .1 }
      expect(grid.mask[regionGridIndex(grid, point)]).toBe(2)
    }
    fillRegionGridCPU(grid)
    expect(grid.mask[regionGridIndex(grid, { x: 100, y: 900 })]).toBe(0)
  })

  it('does not turn the entire grid into fallback when a clipped edge terminates on a grid line', () => {
    for (const epsilon of [-1e-11, 0, 1e-11]) {
      const ring = [{ x: -100, y: 11.9 }, { x: 1200, y: 900 + epsilon }, { x: 1200, y: 903 + epsilon }, { x: -100, y: 14.9 }]
      const grid = prepareRegionGrid([{ polygon: ring }], { minX: 0, minY: 0, maxX: 1000, maxY: 900, cellSize: 6 })
      expect(grid.boundaryCells).toBeLessThan(grid.mask.length / 8)
    }
  })

  it('returns exact geometry outside the grid and after disposal', async () => {
    const prepared = await prepareWebGpuRegionQuery(regions, { ...bounds, mode: 'cpu' })
    const exact = regionQuery(regions)
    prepared.dispose()
    for (const point of [{ x: 10, y: 10 }, { x: 36, y: 60 }, { x: -40, y: 100 }, { x: 130, y: 100 }]) expect(prepared.query(point)).toBe(exact(point))
    expect(prepared.metrics.disposed).toBe(true)
  })

  it('keeps production query counters completely disabled unless requested', async () => {
    const prepared = await prepareWebGpuRegionQuery(regions, { ...bounds, mode: 'cpu' })
    for (let x = -30; x < 130; x++) prepared.query({ x, y: 42 })
    expect(prepared.metrics.scope).toBe('preparation-only')
    expect(prepared.metrics.fastQueries).toBe(0)
    expect(prepared.metrics.exactQueries).toBe(0)
  })

  it('falls back without allocating a giant grid', async () => {
    const prepared = await prepareWebGpuRegionQuery(regions, { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6, cellSize: 1, mode: 'gpu' })
    expect(prepared.backend).toBe('cpu')
    expect(prepared.metrics.fallbackReason).toContain('limited')
    expect(prepared.query({ x: 10, y: 10 })).toBe(true)
  })

  it('keeps empty geometry zero-filled without requesting a compute adapter', async () => {
    const requestAdapter = vi.fn()
    const prepared = await prepareWebGpuRegionQuery([], { ...bounds, mode: 'gpu', gpu: { requestAdapter } as unknown as GPU })
    expect(prepared.query({ x: 20, y: 20 })).toBe(false)
    expect(prepared.metrics.boundaryCells).toBe(0)
    expect(prepared.metrics.uncertainCells).toBe(0)
    expect(requestAdapter).not.toHaveBeenCalled()
  })

  it('falls back on an unavailable adapter and a bounded initialization timeout', async () => {
    const unavailable = await prepareWebGpuRegionQuery(regions, { ...bounds, mode: 'gpu', gpu: null })
    expect(unavailable.backend).toBe('cpu')
    expect(unavailable.metrics.fallbackReason).toContain('unavailable')
    const pending = { requestAdapter: () => new Promise(() => {}) } as unknown as GPU
    const timeout = await prepareWebGpuRegionQuery(regions, { ...bounds, mode: 'gpu', gpu: pending, timeoutMs: 5 })
    expect(timeout.backend).toBe('cpu')
    expect(timeout.metrics.fallbackReason).toContain('timed out')
    expect(timeout.query({ x: 10, y: 10 })).toBe(true)
  })

  it('destroys every allocated buffer and the owned device after GPU preparation fails', async () => {
    vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4, MAP_READ: 1 })
    const allocated: { mapState: string; destroy: ReturnType<typeof vi.fn> }[] = []
    const destroy = vi.fn()
    const device = {
      lost: new Promise(() => {}), destroy,
      limits: { maxStorageBufferBindingSize: 128 * 1024 ** 2, maxComputeWorkgroupsPerDimension: 65535 },
      pushErrorScope() {}, queue: { writeBuffer() {} },
      createBuffer() { const value = { mapState: 'unmapped', destroy: vi.fn() }; allocated.push(value); return value },
      createShaderModule() { return {} },
      createComputePipelineAsync() { return Promise.reject(new Error('Simulated device loss')) },
    }
    const gpu = { requestAdapter: async () => ({ info: {}, requestDevice: async () => device }) } as unknown as GPU
    const prepared = await prepareWebGpuRegionQuery(regions, { ...bounds, mode: 'gpu', gpu })
    expect(prepared.backend).toBe('cpu')
    expect(prepared.metrics.fallbackReason).toContain('device loss')
    expect(prepared.query({ x: 10, y: 10 })).toBe(true)
    expect(allocated.length).toBeGreaterThan(5)
    expect(allocated.every(buffer => buffer.destroy.mock.calls.length > 0)).toBe(true)
    expect(destroy).toHaveBeenCalled()
  })

  it('rejects explicit cancellation instead of doing unwanted CPU work', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(prepareWebGpuRegionQuery(regions, { ...bounds, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
