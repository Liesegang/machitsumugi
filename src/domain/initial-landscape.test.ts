import { describe, expect, it } from 'vitest'
import { coastalBedProfile, coastalLandform } from './coastal-landform'
import { initialLandscape } from './initial-landscape'
import { terrainNoise } from './regional-terrain'

describe('geological relief scenarios', () => {
  const input = { columns: 49, resolution: 500, extent: 24000, noise: terrainNoise, seed: 1234, coastType: 'bay' as const }
  it('changes tectonic uplift before erosion without multiplying a finished height map', () => {
    const low = initialLandscape({ ...input, relief: 'lowland' }), hills = initialLandscape({ ...input, relief: 'hills' }), high = initialLandscape({ ...input, relief: 'mountains' })
    const landform = coastalLandform(input)
    expect(low.elevation).toEqual(hills.elevation)
    let mainlandCells = 0, deeperOceanCells = 0
    for (let i = 0; i < hills.elevation.length; i++) {
      const distance = landform.distance({ x: i % input.columns * input.resolution, y: Math.floor(i / input.columns) * input.resolution })
      // Inland initial rock is the same. The more active mountain scenario
      // starts with a deeper outer receiving basin for its sediment supply.
      if (distance >= 0) { expect(high.elevation[i]).toBe(hills.elevation[i]); mainlandCells++ }
      if (distance < -4500) { expect(high.elevation[i]).toBeLessThan(hills.elevation[i]!); deeperOceanCells++ }
      expect(low.uplift[i]).toBeCloseTo(hills.uplift[i]! * .4, 8)
      expect(high.uplift[i]).toBeCloseTo(hills.uplift[i]! * 4, 8)
    }
    expect(mainlandCells).toBeGreaterThan(200)
    expect(deeperOceanCells).toBeGreaterThan(200)
    expect(high.erodibility).toEqual(hills.erodibility)
  })
  it('retains the hills default and a broad open receiving ocean', () => {
    const baseline = initialLandscape(input)
    expect(baseline).toEqual(initialLandscape({ ...input, relief: 'hills' }))
    const land = baseline.elevation.filter(z => z > 0).length
    expect(land / baseline.elevation.length).toBeGreaterThan(.1)
    expect(land / baseline.elevation.length).toBeLessThan(.9)
    const south = baseline.elevation.slice(-input.columns)
    expect(south.every(z => z < 0)).toBe(true)
    expect(Math.min(...south)).toBeLessThan(-200)
    expect(south.filter(z => z < -50).length).toBeGreaterThan(input.columns / 2)
  })
  it('uses the same two-dimensional coast for submerged geology and uplift taper', () => {
    for (const coastType of ['bay', 'ria', 'delta', 'peninsula'] as const) {
      const flat = { ...input, coastType, noise: () => .5 }, field = initialLandscape(flat), landform = coastalLandform(flat)
      let offshoreCells = 0, shoreCells = 0
      for (let i = 0; i < field.elevation.length; i++) {
        const distance = landform.distance({ x: i % input.columns * input.resolution, y: Math.floor(i / input.columns) * input.resolution })
        const profile = coastalBedProfile(distance, coastType)
        if (distance <= 0) {
          // Inland texture and inherited mountain provinces cannot add an
          // unrelated bump to the shelf, a bay centre or the outer slope.
          expect(field.elevation[i]).toBe(Math.fround(profile.elevation)); offshoreCells++
        }
        if (distance < -1200) expect(field.uplift[i]).toBe(0)
        if (Math.abs(distance) < 1000) {
          const rate = .0001 + Math.pow(.5, 2.2) * .0018 + .25 * .0006
          expect(field.uplift[i]).toBe(Math.fround(rate * profile.upliftWeight)); shoreCells++
        }
      }
      expect(offshoreCells).toBeGreaterThan(200); expect(shoreCells).toBeGreaterThan(20)
    }
  })
  it('inherits oblique structural divides and leaves the receiving shelf unchanged', () => {
    const baseline = initialLandscape({ ...input, noise: () => .5 }), landform = coastalLandform({ ...input, noise: () => .5 })
    const shaped = initialLandscape({ ...input, noise: (seed, x, y) => {
      if (seed === input.seed + 17) return .5 + .35 * Math.sin(x * 3 + y * 2)
      if (seed === input.seed + 7) return .5 + .25 * Math.cos(x * 2 - y * 3)
      return .5
    } })
    const inherited = Array.from(shaped.elevation, (z, i) => z - baseline.elevation[i]!)
    expect(Math.max(...inherited)).toBeGreaterThan(40)
    expect(Math.min(...inherited)).toBeLessThan(-40)
    let greatestCrosswiseVariation = 0, unchangedShelfCells = 0
    for (let y = 0; y < input.columns; y++) {
      const row: number[] = []
      for (let x = 0; x < input.columns; x++) {
        const i = y * input.columns + x, distance = landform.distance({ x: x * input.resolution, y: y * input.resolution })
        if (distance > 4000) row.push(inherited[i]!)
        if (distance <= 0) { expect(shaped.elevation[i]).toBe(baseline.elevation[i]); unchangedShelfCells++ }
      }
      if (row.length) greatestCrosswiseVariation = Math.max(greatestCrosswiseVariation, Math.max(...row) - Math.min(...row))
    }
    expect(greatestCrosswiseVariation).toBeGreaterThan(80)
    expect(unchangedShelfCells).toBeGreaterThan(200)
    expect(shaped.elevation.every(Number.isFinite)).toBe(true)
  })
})
