import { describe, expect, it } from 'vitest'
import { erodeTerrainJs } from '../domain/hydrology'
import { prepareTerrainErosion } from './webgpu-terrain'
import { erodeTerrainReference, routeTerrainReference } from './webgpu-terrain-reference'

describe('full GPU landscape independent reference and fallback', () => {
  it('retains the least-transverse13degree drainage objective instead of locking onto raster axes', () => {
    const n = 81, raw = new Float32Array(n * n), tangent = Math.tan(13 * Math.PI / 180)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) raw[y * n + x] = 500 - x - y * tangent
    const result = routeTerrainReference(raw, n, n, 50)
    let i = 15 * n + 5
    while (i % n < 70 && result.flowTo[i]! >= 0) i = result.flowTo[i]!
    expect(Math.abs(Math.floor(i / n) - 15 - (i % n - 5) * tangent)).toBeLessThan(1)
    expect(result.outletArea).toBe(n * n * 2500)
  })

  it('conditions an enclosed pit to its real spill height without filling solid terrain or leaving cycles', () => {
    const n = 17, raw = new Float32Array(n * n).fill(12)
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) raw[y * n + x] = -4
    raw[8 * n] = 3
    const original = raw.slice(), result = routeTerrainReference(raw, n, n, 50), rank = new Int32Array(n * n)
    result.order.forEach((i, k) => { rank[i] = k })
    expect(result.hydroDEM[8 * n + 8]).toBe(3)
    expect(raw).toEqual(original)
    for (let i = 0; i < n * n; i++) { const j = result.flowTo[i]!; if (j >= 0) { expect(rank[j]).toBeGreaterThan(rank[i]!); expect(result.hydroDEM[j]).toBeLessThanOrEqual(result.hydroDEM[i]!) } }
    expect(result.outletArea).toBe(n * n * 2500)
  })

  it('accounts for uplift, detached bedrock, reentrained sediment, deposition and export without inventing a source', () => {
    const n = 19, raw = new Float32Array(n * n), uplift = new Float32Array(n * n).fill(.0002)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) raw[y * n + x] = 18 - y * 1.2 + .08 * (x - 9) ** 2
    const initial = raw.slice(), result = erodeTerrainReference(raw, n, n, 50, { passes: 9, timeStepYears: 4000, uplift, diffusivity: .15, sediment: true })
    expect(raw).toEqual(initial)
    expect(result.sediment.erodedSourceVolume).toBeGreaterThan(0)
    expect(result.sediment.depositedVolume).toBeGreaterThan(0)
    expect(result.sediment.exportedVolume).toBeGreaterThan(0)
    expect(result.sediment.sedimentReentrainedVolume).toBeGreaterThan(0)
    expect(Math.abs(result.sediment.massBalanceError) / result.sediment.erodedSourceVolume).toBeLessThan(1e-12)
    expect(Math.abs(result.erosion.terrainBalanceError) / result.erosion.erodedVolume).toBeLessThan(1e-5)
    expect(result.alluvium64.every(x => Number.isFinite(x) && x >= 0)).toBe(true)
    expect(result.outletArea).toBe(n * n * 2500)
  })

  it('keeps an open boundary at its actual bed when an old downstream interior cell uplifts above it', () => {
    const n = 5, raw = Float32Array.from({ length: n * n }, (_, i) => 10 - Math.floor(i / n)), uplift = new Float32Array(n * n)
    uplift[6] = 100
    for (const sediment of [false, true]) {
      const result = erodeTerrainReference(raw, n, n, 50, { passes: 1, timeStepYears: 1, uplift, erodibility: new Float32Array(n * n), diffusivity: 0, sediment })
      expect(result.rawDEM[1]).toBe(10)
      expect(result.rawDEM[6]).toBe(109)
      expect(result.hydroDEM[1]).toBe(10)
      expect(result.flowTo[1]).toBe(7)
      for (let i = 0; i < raw.length; i++) if (i < n || i >= raw.length - n || i % n === 0 || i % n === n - 1) expect(result.hydroDEM[i]).toBe(result.rawDEM[i])
    }
  })

  it('leaves bedrock/source-free flat terrain unchanged and rejects invalid integration rather than concealing it', async () => {
    const raw = new Float32Array(81).fill(5), settings = { passes: 4, sediment: true, erodibility: new Float32Array(81), diffusivity: 0 }
    const result = erodeTerrainReference(raw, 9, 9, 50, settings)
    expect(result.rawDEM).toEqual(raw)
    expect(result.sediment.erodedSourceVolume).toBe(0)
    expect(result.sediment.massBalanceError).toBe(0)
    await expect(prepareTerrainErosion(raw, 9, 9, 0)).rejects.toThrow(RangeError)
    await expect(prepareTerrainErosion(raw, 9, 9, 50, { erodibility: new Float32Array(81).fill(-1) })).rejects.toThrow(RangeError)
    const controller = new AbortController(); controller.abort()
    await expect(prepareTerrainErosion(raw, 9, 9, 50, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the existing solver available on browsers without WebGPU', async () => {
    const raw = Float32Array.from({ length: 99 }, (_, i) => 30 - Math.floor(i / 9) + Math.sin(i * .3)), settings = { passes: 2, sediment: true }
    const result = await prepareTerrainErosion(raw, 9, 11, 50, settings)
    expect(result.backend).toBe('cpu')
    expect(result.metrics.fallbackReason).toBe('WebGPU compute is unavailable')
    expect(result.rawDEM).toEqual(erodeTerrainJs(raw, 9, 11, 50, settings).rawDEM)
  })
})
