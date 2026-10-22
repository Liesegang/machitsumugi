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
})
