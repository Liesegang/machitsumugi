import { describe, expect, it } from 'vitest'
import { initialLandscape } from './initial-landscape'
import { terrainNoise } from './regional-terrain'

describe('geological relief scenarios', () => {
  const input = { columns: 25, resolution: 1000, extent: 24000, noise: terrainNoise, seed: 1234, coastType: 'bay' as const }
  it('changes tectonic uplift before erosion without multiplying a finished height map', () => {
    const low = initialLandscape({ ...input, relief: 'lowland' }), hills = initialLandscape({ ...input, relief: 'hills' }), high = initialLandscape({ ...input, relief: 'mountains' })
    expect(low.elevation).toEqual(hills.elevation)
    // Inland initial relief is unchanged; the active-margin scenario has a
    // deeper offshore receiving basin for its larger sediment supply.
    for (let i = 0; i < 16 * 25; i++) expect(high.elevation[i]).toBe(hills.elevation[i])
    expect(high.elevation[600]).toBeLessThan(hills.elevation[600]!)
    expect(high.erodibility).toEqual(hills.erodibility)
    for (let i = 0; i < hills.uplift.length; i++) {
      expect(low.uplift[i]).toBeCloseTo(hills.uplift[i]! * .4, 8)
      expect(high.uplift[i]).toBeCloseTo(hills.uplift[i]! * 4, 8)
    }
  })
  it('retains the hills default and an open receiving shelf and slope', () => {
    const baseline = initialLandscape(input)
    expect(baseline).toEqual(initialLandscape({ ...input, relief: 'hills' }))
    for (let x = 0; x < input.columns; x++) expect(baseline.elevation[24 * 25 + x]).toBeLessThan(-200)
  })
  it('has a resolved shallow shelf before the outer slope, with narrower ria shelves', () => {
    const flat = { ...input, columns: 241, resolution: 100, noise: () => .5 }
    const bay = initialLandscape(flat), ria = initialLandscape({ ...flat, coastType: 'ria' }), delta = initialLandscape({ ...flat, coastType: 'delta' })
    const z = (field: Float32Array, row: number) => field[row * 241 + 120]!
    const grade = (field: Float32Array, a: number, b: number) => (z(field, a) - z(field, b)) / ((b - a) * 100)
    expect(z(bay.elevation, 170)).toBeLessThan(-20)
    expect(z(bay.elevation, 170)).toBeGreaterThan(-60)
    expect(grade(bay.elevation, 180, 195)).toBeLessThan(grade(bay.elevation, 225, 235) / 3)
    expect(z(ria.elevation, 220)).toBeLessThan(z(bay.elevation, 220))
    expect(z(delta.elevation, 220)).toBeGreaterThan(z(bay.elevation, 220))
    // Offshore rock does not keep rising at a mountain's continental rate.
    expect(z(bay.uplift, 210)).toBe(0)
  })
})
