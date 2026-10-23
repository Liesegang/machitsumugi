import { describe, expect, it } from 'vitest'
import { erodeTerrain, routeDrainage } from './hydrology'
import { transportSediment } from './sediment-transport'

describe('conservative erosion, transport and deposition', () => {
  const run = (raw: Float32Array, columns: number, rows: number, source: Float64Array) => {
    const drainage = routeDrainage(raw, columns, rows, 50)
    return transportSediment({ elevation: raw, hydroElevation: drainage.hydroDEM, flowTo: drainage.flowTo, order: drainage.order, sourceVolume: source, columns, rows, cellSize: 50 })
  }
  it('creates no sediment or land without a supply, and accounts for boundary export', () => {
    const columns = 19, rows = 29, raw = Float32Array.from({ length: columns * rows }, (_, i) => 80 - Math.floor(i / columns) * 2)
    const zero = run(raw, columns, rows, new Float64Array(raw.length))
    expect(zero.depositedVolume).toBe(0)
    const source = new Float64Array(raw.length); source[3 * columns + 9] = 80_000
    const result = run(raw, columns, rows, source)
    expect(result.depositedVolume).toBeGreaterThan(0)
    expect(result.exportedVolume).toBeGreaterThan(0)
    expect(result.depositedVolume + result.exportedVolume).toBeCloseTo(80_000, 6)
    expect(Math.abs(result.massBalanceError)).toBeLessThan(1e-7)
  })
  it('spreads supplied sediment after a confined valley opens onto a low-gradient plain', () => {
    const columns = 41, rows = 51, raw = new Float32Array(columns * rows), source = new Float64Array(raw.length)
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) raw[y * columns + x] = y < 20 ? 100 + (20 - y) * 3 + Math.abs(x - 20) * 5 : 100 - (y - 20) * .18
    source[17 * columns + 20] = 160_000
    const result = run(raw, columns, rows, source)
    const proximal = new Set<number>(), distal = new Set<number>()
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if (result.deposition[y * columns + x]! > .001) {
      if (y >= 17 && y < 20) proximal.add(x)
      if (y >= 24 && y < 30) distal.add(x)
    }
    expect(proximal.size).toBe(1)
    expect(distal.size).toBeGreaterThan(5)
    expect(result.terrestrialDepositedVolume).toBeGreaterThan(0)
    expect(Math.abs(result.massBalanceError)).toBeLessThan(1e-6)
  })
  it('deposits river-borne material in connected shallow sea; bathymetry changes with real volume', () => {
    const columns = 31, rows = 51, raw = new Float32Array(columns * rows), source = new Float64Array(raw.length)
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) raw[y * columns + x] = y < 25 ? (25 - y) * .8 + Math.abs(x - 15) * 3 : -(y - 24) * .12
    source[23 * columns + 15] = 220_000
    const result = run(raw, columns, rows, source)
    expect(result.marineDepositedVolume).toBeGreaterThan(10_000)
    let submergedRaised = 0
    for (let i = 0; i < raw.length; i++) if (raw[i]! < 0 && result.deposition[i]! > 0) submergedRaised += result.deposition[i]! * 2500
    expect(submergedRaised).toBeCloseTo(result.marineDepositedVolume, 5)
    expect(result.depositedVolume + result.exportedVolume).toBeCloseTo(220_000, 5)
  })
  it('feeds actual incision into sediment, reroutes aggraded terrain and conserves the loose layer', () => {
    const columns = 31, rows = 51, raw = new Float32Array(columns * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) raw[y * columns + x] = y < 25 ? 30 + (25 - y) * 2 + Math.abs(x - 15) * 2 : 30 - (y - 25) * .15
    const result = erodeTerrain(raw, columns, rows, 50, { passes: 16, timeStepYears: 250, sediment: true, diffusivity: 0 })
    expect(result.sediment.erodedSourceVolume).toBeGreaterThan(0)
    expect(result.sediment.storedVolume).toBeGreaterThan(0)
    expect(Math.max(...result.alluvium)).toBeGreaterThan(.1)
    expect(Math.abs(result.sediment.massBalanceError) / result.sediment.erodedSourceVolume).toBeLessThan(1e-10)
    expect(result.sediment.storedVolume + result.sediment.exportedVolume).toBeCloseTo(result.sediment.erodedSourceVolume, 5)
    expect(result.processedCells).toBe(raw.length)
  })
  it('traps supplied sediment in a filled depression without inventing or exceeding its water accommodation', () => {
    const n = 21, raw = new Float32Array(n * n).fill(20), source = new Float64Array(n * n)
    for (let y = 5; y < 16; y++) for (let x = 4; x < 17; x++) raw[y * n + x] = 0
    for (let x = 17; x < n; x++) raw[10 * n + x] = 5
    raw[4 * n + 10] = 8; raw[3 * n + 10] = 10; source[3 * n + 10] = 1_000_000
    const result = run(raw, n, n, source)
    expect(result.lakeDepositedVolume).toBeGreaterThan(50_000)
    for (let y = 5; y < 16; y++) for (let x = 4; x < 17; x++) expect(result.deposition[y * n + x]).toBeLessThanOrEqual(5)
    expect(result.depositedVolume + result.exportedVolume).toBeCloseTo(1_000_000, 6)
    expect(Math.abs(result.massBalanceError)).toBeLessThan(1e-6)
    const zero = run(raw, n, n, new Float64Array(n * n))
    expect(zero.lakeDepositedVolume).toBe(0)
    // Shallow standing water cannot inherit the dry-channel minimum (1.25m at
    // this resolution) and overfill its 0.5m accommodation in a single pass.
    const shallow = new Float32Array(raw)
    for (let y = 5; y < 16; y++) for (let x = 4; x < 17; x++) shallow[y * n + x] = 4.5
    const shallowResult = run(shallow, n, n, source)
    expect(shallowResult.lakeDepositedVolume).toBeGreaterThan(0)
    for (let y = 5; y < 16; y++) for (let x = 4; x < 17; x++) expect(shallowResult.deposition[y * n + x]).toBeLessThanOrEqual(.5)
  })
  it('does not turn a deep offshore drop into a high sediment mound on newly emerged coast', () => {
    const n = 7, cellSize = 100, center = 3 * n + 3, source = new Float64Array(n * n)
    source[center] = 100_000_000
    const cases = [-5, -500].map(depth => {
      const elevation = new Float32Array(n * n).fill(depth); elevation[center] = .15
      const drainage = routeDrainage(elevation, n, n, cellSize)
      return transportSediment({ elevation, hydroElevation: drainage.hydroDEM, flowTo: drainage.flowTo, order: drainage.order, sourceVolume: source, columns: n, rows: n, cellSize })
    })
    for (const result of cases) {
      expect(result.deposition[center]).toBeLessThanOrEqual(2.5)
      expect(result.exportedVolume).toBeGreaterThan(0)
      expect(Math.abs(result.massBalanceError)).toBeLessThan(1e-5)
    }
    expect(cases[1]!.deposition[center]).toBe(cases[0]!.deposition[center])
  })
})
