import { describe, expect, it } from 'vitest'
import { erodeTerrainJs, routeDrainageJs } from './hydrology'
import { transportHillslope } from './hillslope-transport'

describe('landscape numerical stability', () => {
  it('keeps large implicit incision between its old elevation and the updated receiver', () => {
    const n = 17, raw = Float32Array.from({ length: n * n }, (_, i) => 100 + (n - Math.floor(i / n)) * 40 + Math.abs(i % n - 8) * 70)
    const old = routeDrainageJs(raw, n, n, 50)
    const result = erodeTerrainJs(raw, n, n, 50, { passes: 1, timeStepYears: 1_000_000, erodibility: new Float32Array(raw.length).fill(.001), diffusivity: 0, sediment: false })
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x, receiver = old.flowTo[i]!
      expect(result.rawDEM[i]).toBeLessThanOrEqual(raw[i]!)
      if (receiver >= 0) expect(result.rawDEM[i]).toBeGreaterThanOrEqual(result.rawDEM[receiver]!)
    }
  })

  it('respects the discrete maximum principle at the capped four-face diffusion coefficient', () => {
    const n = 23, raw = Float32Array.from({ length: n * n }, (_, i) => 240 * Math.sin(i * 17.31) - 120 * Math.cos(i * 3.15))
    const result = transportHillslope({ elevation: raw, alluvium: new Float64Array(raw.length), columns: n, rows: n, cellSize: 50, coefficient: 10, seaLevel: 0 })
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x, neighbors = [raw[i]!]
      if (x) neighbors.push(raw[i - 1]!)
      if (x + 1 < n) neighbors.push(raw[i + 1]!)
      if (y) neighbors.push(raw[i - n]!)
      if (y + 1 < n) neighbors.push(raw[i + n]!)
      expect(result.elevation[i]).toBeGreaterThanOrEqual(Math.min(...neighbors))
      expect(result.elevation[i]).toBeLessThanOrEqual(Math.max(...neighbors))
      expect(result.alluvium[i]).toBeGreaterThanOrEqual(0)
    }
    // Perimeter cells exchange through their real interior faces. Only the
    // domain's exterior has zero flux; it cannot create a reservoir or drain.
    expect(result.elevation[0]).not.toBe(raw[0])
    const cellArea = 50 ** 2, initialVolume = raw.reduce((sum, z) => sum + z * cellArea, 0), finalVolume = result.elevation.reduce((sum, z) => sum + z * cellArea, 0)
    const f32Roundoff = raw.length * Math.max(...Array.from(raw, Math.abs)) * 2 ** -23 * cellArea
    expect(Math.abs(finalVolume - initialVolume)).toBeLessThanOrEqual(f32Roundoff)
    expect(result.netTerrainVolume).toBeCloseTo(finalVolume - initialVolume, 5)
    const looseVolume = result.alluvium.reduce((sum, z) => sum + z * cellArea, 0)
    expect(Math.abs(looseVolume - result.bedrockSourceVolume)).toBeLessThan(Math.max(1, result.bedrockSourceVolume) * 1e-12)
  })

  it('preserves a constant surface and its loose layer through every boundary face', () => {
    const columns = 11, rows = 7, elevation = new Float32Array(columns * rows).fill(25), alluvium = new Float64Array(elevation.length).fill(3)
    const result = transportHillslope({ elevation, alluvium, columns, rows, cellSize: 50, coefficient: 10, seaLevel: 0 })
    expect(result.elevation).toEqual(elevation)
    expect(result.alluvium).toEqual(alluvium)
    expect(result.transferredVolume).toBe(0)
    expect(result.bedrockSourceVolume).toBe(0)
    expect(result.netTerrainVolume).toBe(0)
  })

  it('routes f32-quantized near-flats to open boundaries without numerical cycles', () => {
    const n = 31, raw = Float32Array.from({ length: n * n }, (_, i) => 2000 + Math.floor(i / n) * 1e-6)
    const result = routeDrainageJs(raw, n, n, 50), rank = new Int32Array(raw.length)
    result.order.forEach((cell, i) => { rank[cell] = i })
    expect(result.processedCells).toBe(raw.length)
    expect(result.outletArea).toBe(raw.length * 2500)
    for (let i = 0; i < raw.length; i++) if (result.flowTo[i]! >= 0) expect(rank[result.flowTo[i]!]!).toBeGreaterThan(rank[i]!)
  })
})
