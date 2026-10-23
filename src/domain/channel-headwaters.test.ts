import { describe, expect, it } from 'vitest'
import { extendHeadwaterPath, runoffSourceModel } from './channel-headwaters'

describe('runoff-fed mapped channel sources', () => {
  it('follows connected upslope feeder cells to a smaller catchment rather than stamping a tail', () => {
    const flowTo = new Int32Array(25).fill(-1), area = new Float64Array(25)
    for (const [a, b] of [[1, 6], [5, 6], [6, 12], [12, 18], [18, 24]]) flowTo[a!] = b!
    for (const [cell, value] of [[1, 100_000], [5, 75_000], [6, 200_000], [12, 1_000_000], [18, 4_000_000], [24, 7_000_000]]) area[cell!] = value!
    const result = extendHeadwaterPath({ cells: [18, 24], flowTo, accumulatedArea: area, ocean: new Uint8Array(25), columns: 5, rows: 5, sourceArea: 150_000 })
    expect(result).toEqual([1, 6, 12, 18, 24])
    for (let i = 1; i < result.length; i++) expect(flowTo[result[i - 1]!]).toBe(result[i])
    expect(area[result[0]!]).toBeLessThanOrEqual(150_000)
  })
  it('conserves uniform runoff at a confluence and removes the former 5m width floor', () => {
    const model = runoffSourceModel()
    expect(model.baseflow(2_000_000 + 500_000 + 2500)).toBeCloseTo(model.baseflow(2_000_000) + model.baseflow(500_000) + model.baseflow(2500), 12)
    expect(model.width(model.sourceArea)).toBe(0)
    expect(model.width(model.sourceArea * 1.001)).toBeLessThan(.1)
    expect(model.width(500_000)).toBeLessThan(4)
    expect(model.width(4_000_000)).toBeGreaterThan(model.width(500_000))
  })
  it('does not invent an upstream cell beyond the regional boundary or leave the drainage graph', () => {
    expect(extendHeadwaterPath({ cells: [0, 3], flowTo: new Int32Array([3, -1, -1, -1]), accumulatedArea: new Float64Array([4e6, 0, 0, 5e6]), ocean: new Uint8Array(4), columns: 2, rows: 2, sourceArea: 1e5 })).toEqual([0, 3])
  })
})
