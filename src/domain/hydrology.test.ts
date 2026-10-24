import { describe, expect, it } from 'vitest'
import { erodeTerrain, routeDrainage } from './hydrology'

describe('Priority-Flood and drainage conservation', () => {
  it('fills a closed depression to its spill level without changing the raw DEM', () => {
    const raw = new Float32Array(49).fill(10)
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) raw[y * 7 + x] = 1
    raw[3 * 7 + 6] = 4; raw[3 * 7 + 3] = -2
    const original = new Float32Array(raw), result = routeDrainage(raw, 7, 7, 25)
    expect(raw).toEqual(original)
    expect(result.hydroDEM[24]).toBe(4)
    expect(result.fillVolume).toBeGreaterThan(0)
    expect(result.processedCells).toBe(49)
    expect(result.outletArea).toBe(49 * 25 ** 2)
    for (let i = 0; i < 49; i++) {
      const next = result.flowTo[i]!
      if (next >= 0) expect(result.hydroDEM[next]).toBeLessThanOrEqual(result.hydroDEM[i]!)
    }
  })
  it('routes completely flat terrain without cycles and preserves every cell area', () => {
    const result = routeDrainage(new Float32Array(19 * 13).fill(8), 19, 13, 50)
    expect(result.processedCells).toBe(19 * 13)
    expect(result.outletArea).toBe(19 * 13 * 2500)
    const rank = new Int32Array(result.order.length)
    result.order.forEach((cell, i) => { rank[cell] = i })
    result.flowTo.forEach((next, i) => { if (next >= 0) expect(rank[next]).toBeGreaterThan(rank[i]!) })
  })
  it('responds to catchment and slope by incising the convergent valley', () => {
    const columns = 31, rows = 41, raw = new Float32Array(columns * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) raw[y * columns + x] = 100 + (rows - y) * .5 + Math.abs(x - 15) * 1.5
    const unchanged = erodeTerrain(raw, columns, rows, 50, 0), relaxed = erodeTerrain(raw, columns, rows, 50, 2)
    expect(unchanged.rawDEM).toEqual(raw)
    const valley = 30 * columns + 15
    expect(relaxed.rawDEM[valley]).toBeLessThan(raw[valley]!)
    expect(relaxed.accumulatedArea[valley]).toBeGreaterThan(2500 * 20)
    expect(relaxed.processedCells).toBe(raw.length)
    expect(relaxed.outletArea).toBe(raw.length * 2500)
  })
  it('uses the implicit receiver-first equation rather than an explicit incision clamp', () => {
    const columns = 7, rows = 9, raw = new Float32Array(columns * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) raw[y * columns + x] = 100 - y * 3 + Math.abs(x - 3) * .3
    const drainage = routeDrainage(raw, columns, rows, 50), expected = new Float32Array(raw), k = new Float32Array(raw.length).fill(.0003), dt = 500
    for (const i of [...drainage.order].reverse()) {
      const x = i % columns, y = Math.floor(i / columns), receiver = drainage.flowTo[i]!
      if (!x || !y || x === columns - 1 || y === rows - 1 || receiver < 0) continue
      const length = Math.hypot(x - receiver % columns, y - Math.floor(receiver / columns)) * 50
      const coefficient = dt * k[i]! * Math.sqrt(drainage.accumulatedArea[i]!) / length
      expected[i] = (raw[i]! + coefficient * expected[receiver]!) / (1 + coefficient)
    }
    const result = erodeTerrain(raw, columns, rows, 50, { passes: 1, timeStepYears: dt, erodibility: k, diffusivity: 0 })
    expect(result.rawDEM).toEqual(expected)
    expect(result.erosion.erodedVolume).toBeGreaterThan(0)
    expect(result.erosion.iterations).toBe(1)
  })
  it('separates uplift, incision and measured initial-to-final displacement', () => {
    const raw = new Float32Array(81).fill(.003), uplift = new Float32Array(81).fill(.001), resistant = new Float32Array(81)
    const preserved = erodeTerrain(raw, 9, 9, 50, { passes: 8, diffusivity: 0, erodibility: resistant })
    expect(preserved.rawDEM).toEqual(raw) // No .01m flattening of low positive land.
    const result = erodeTerrain(raw, 9, 9, 50, { passes: 8, timeStepYears: 100, uplift, diffusivity: 0, erodibility: resistant })
    expect(result.rawDEM[40]).toBeCloseTo(.803, 5)
    // A uniform crust field does not leave its rectangular perimeter behind.
    for (const z of result.rawDEM) expect(z).toBeCloseTo(.803, 5)
    expect(result.erosion.upliftVolume).toBeCloseTo(81 * uplift[0]! * 100 * 8 * 2500, 6)
    expect(result.erosion.upliftVolume).toBeGreaterThan(0)
    expect(result.erosion.erodedVolume).toBe(0)
    expect(result.erosion.rmsHistory).toHaveLength(8)
    expect(result.erosion.rmsElevationChange).toBeGreaterThan(0)
    expect(result.erosion.maxIncision).toBe(0)
  })
  it('balances actual terrain volume against uplift, incision, sediment and boundary creep', () => {
    const n = 31, raw = new Float32Array(n * n), uplift = new Float32Array(n * n).fill(.0008)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) raw[y * n + x] = 60 - y * 3 + Math.abs(x - 15) * .8
    const result = erodeTerrain(raw, n, n, 50, { passes: 12, timeStepYears: 500, sediment: true, uplift })
    expect(result.erosion.upliftVolume).toBeGreaterThan(0)
    expect(result.erosion.erodedVolume).toBeGreaterThan(0)
    expect(Math.abs(result.erosion.terrainBalanceError)).toBeLessThan(result.erosion.erodedVolume * 1e-5)
    expect(Math.abs(result.sediment.massBalanceError)).toBeLessThan(1e-3)
  })
  it('does not carve a drainage path below a lake surface, while retaining bed uplift', () => {
    const n = 9, raw = new Float32Array(n * n).fill(10), uplift = new Float32Array(n * n), k = new Float32Array(n * n)
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) { const i = y * n + x; raw[i] = 1 + (y - 2) * .2; uplift[i] = .001; k[i] = .2 }
    raw[4 * n + 7] = 4; raw[4 * n + 8] = 4
    const result = erodeTerrain(raw, n, n, 50, { passes: 1, timeStepYears: 100, uplift, erodibility: k, diffusivity: 0 })
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) expect(result.rawDEM[y * n + x]).toBeCloseTo(raw[y * n + x]! + .1, 5)
    expect(result.erosion.erodedVolume).toBe(0)
    expect(result.fillVolume).toBeGreaterThan(0) // Water volume is not solid fill.
  })
  it('uses a lake spill level as the tailwater for incoming stream incision', () => {
    const n = 9, raw = new Float32Array(n * n).fill(10), k = new Float32Array(n * n).fill(.2)
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) raw[y * n + x] = 1
    raw[1 * n + 4] = 8; raw[4 * n + 7] = 4; raw[4 * n + 8] = 4
    const result = erodeTerrain(raw, n, n, 50, { passes: 1, timeStepYears: 4000, erodibility: k, diffusivity: 0 })
    expect(result.rawDEM[n + 4]).toBeGreaterThanOrEqual(4)
    expect(result.rawDEM[n + 4]).toBeLessThan(8)
    expect(result.rawDEM[4 * n + 4]).toBe(1)
  })
  it('applies the prescribed crustal uplift below sea level without marine stream incision', () => {
    const n = 9, raw = new Float32Array(n * n).fill(-10), uplift = new Float32Array(n * n).fill(.001)
    const result = erodeTerrain(raw, n, n, 50, { passes: 5, timeStepYears: 100, uplift, diffusivity: 0 })
    expect(result.rawDEM[40]).toBeCloseTo(-9.5, 5)
    expect(result.rawDEM[0]).toBeCloseTo(-9.5, 5)
    expect(result.erosion.erodedVolume).toBe(0)
    expect(result.erosion.upliftVolume).toBeCloseTo(81 * .5 * 2500, 2)
  })
  it('raises a prescribed sloping crust at every open edge while retaining its incision boundary', () => {
    const n = 11, raw = Float32Array.from({ length: n * n }, (_, i) => 200 - Math.floor(i / n) * 12), uplift = new Float32Array(n * n).fill(.002)
    const result = erodeTerrain(raw, n, n, 50, { passes: 4, timeStepYears: 500, uplift, diffusivity: 0, sediment: true })
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!x || !y || x === n - 1 || y === n - 1) expect(result.rawDEM[y * n + x]).toBeCloseTo(raw[y * n + x]! + 4, 4)
    expect(result.erosion.upliftVolume).toBeCloseTo(n * n * uplift[0]! * 500 * 4 * 2500, 6)
    expect(result.erosion.erodedVolume).toBeGreaterThan(0)
    expect(result.processedCells).toBe(raw.length)
    expect(result.outletArea).toBe(raw.length * 2500)
    expect(Math.abs(result.erosion.terrainBalanceError)).toBeLessThan(2)
    expect(Math.abs(result.sediment.massBalanceError)).toBeLessThan(1e-5)
  })
})
