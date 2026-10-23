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
  it('retains the legacy hills default and provides deep offshore accommodation', () => {
    const baseline = initialLandscape(input)
    expect(baseline).toEqual(initialLandscape({ ...input, relief: 'hills' }))
    for (let x = 0; x < input.columns; x++) expect(baseline.elevation[24 * 25 + x]).toBeLessThan(-1800)
  })
})
